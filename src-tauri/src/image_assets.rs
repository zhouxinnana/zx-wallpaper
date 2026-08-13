use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::domain::is_supported_wallpaper;

pub const PROTOCOL_NAME: &str = "wallpaper-asset";
const CACHE_VERSION: &str = "v1";
const CACHE_CAPACITY_BYTES: u64 = 512 * 1024 * 1024;
const GENERATION_CONCURRENCY: usize = 2;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageAssetKind {
    Grid,
    Strip,
    Hero,
    Original,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAsset {
    pub src: String,
    pub width: u32,
    pub height: u32,
    pub status: &'static str,
}

#[derive(Clone)]
struct RegisteredAsset {
    path: PathBuf,
    mime_type: &'static str,
}

#[derive(Clone, Copy)]
struct AssetSpec {
    name: &'static str,
    width: u32,
    height: u32,
    quality: u8,
}

pub struct ImageAssetManager {
    cache_directory: PathBuf,
    registered_assets: Arc<Mutex<HashMap<String, RegisteredAsset>>>,
    generation_slots: Arc<Semaphore>,
}

impl ImageAssetManager {
    pub fn new(cache_directory: PathBuf) -> Self {
        Self {
            cache_directory,
            registered_assets: Arc::new(Mutex::new(HashMap::new())),
            generation_slots: Arc::new(Semaphore::new(GENERATION_CONCURRENCY)),
        }
    }

    pub async fn get(
        &self,
        file_path: String,
        kind: ImageAssetKind,
    ) -> Result<Option<ImageAsset>, String> {
        let path = PathBuf::from(file_path);
        if !path.is_file() || !is_supported_wallpaper(&path) {
            return Ok(None);
        }

        let cache_directory = self.cache_directory.clone();
        let permit = Arc::clone(&self.generation_slots)
            .acquire_owned()
            .await
            .map_err(|_| "图片资源生成器不可用。".to_string())?;
        let prepared = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            prepare_asset(&cache_directory, &path, kind)
        })
        .await
        .map_err(|error| format!("图片资源任务中断: {error}"))?;
        let Some(prepared) = prepared else {
            return Ok(None);
        };

        self.register(prepared)
    }

    pub fn prewarm(&self, file_paths: Vec<String>, kind: ImageAssetKind) {
        for file_path in file_paths.into_iter().take(48) {
            let manager = self.clone_for_task();
            tauri::async_runtime::spawn(async move {
                let _ = manager.get(file_path, kind).await;
            });
        }
    }

    pub fn purge_source(&self, file_path: &str) {
        let prefix = format!("{}-", source_key(Path::new(file_path)));
        if let Ok(entries) = fs::read_dir(&self.cache_directory) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        if let Ok(mut assets) = self.registered_assets.lock() {
            assets.retain(|_, asset| !same_path(&asset.path, Path::new(file_path)));
        }
    }

    pub fn prune_sources(&self, live_paths: &[String]) {
        let live_sources = live_paths
            .iter()
            .map(|path| source_key(Path::new(path)))
            .collect::<Vec<_>>();
        if let Ok(entries) = fs::read_dir(&self.cache_directory) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some((source, _)) = name.split_once('-') {
                    if !live_sources.iter().any(|live| live == source) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    pub fn serve(&self, request_path: &str) -> tauri::http::Response<Vec<u8>> {
        let key = request_path.trim_start_matches('/');
        let asset = self
            .registered_assets
            .lock()
            .ok()
            .and_then(|assets| assets.get(key).cloned());
        let Some(asset) = asset else {
            return response(tauri::http::StatusCode::NOT_FOUND, "text/plain", Vec::new());
        };
        match fs::read(asset.path) {
            Ok(bytes) => response(tauri::http::StatusCode::OK, asset.mime_type, bytes),
            Err(_) => response(tauri::http::StatusCode::NOT_FOUND, "text/plain", Vec::new()),
        }
    }

    fn register(&self, prepared: PreparedAsset) -> Result<Option<ImageAsset>, String> {
        let key = prepared.key;
        self.registered_assets
            .lock()
            .map_err(|_| "图片资源索引不可用。".to_string())?
            .insert(
                key.clone(),
                RegisteredAsset {
                    path: prepared.path,
                    mime_type: prepared.mime_type,
                },
            );
        Ok(Some(ImageAsset {
            src: protocol_url(&key),
            width: prepared.width,
            height: prepared.height,
            status: "ready",
        }))
    }

    fn clone_for_task(&self) -> Self {
        Self {
            cache_directory: self.cache_directory.clone(),
            registered_assets: Arc::clone(&self.registered_assets),
            generation_slots: Arc::clone(&self.generation_slots),
        }
    }
}

struct PreparedAsset {
    key: String,
    path: PathBuf,
    mime_type: &'static str,
    width: u32,
    height: u32,
}

fn prepare_asset(
    cache_directory: &Path,
    source: &Path,
    kind: ImageAssetKind,
) -> Option<PreparedAsset> {
    if matches!(kind, ImageAssetKind::Original) {
        let (width, height) = image::image_dimensions(source).ok()?;
        return Some(PreparedAsset {
            key: format!(
                "original-{}-{}",
                source_key(source),
                source_signature(source)?
            ),
            path: source.to_path_buf(),
            mime_type: mime_type_for_path(source),
            width,
            height,
        });
    }

    let spec = spec_for(kind);
    let signature = source_signature(source)?;
    let cache_name = format!("{}-{signature}-{}.jpg", source_key(source), spec.name);
    let cache_path = cache_directory.join(&cache_name);
    if cache_path.is_file() {
        let (width, height) = image::image_dimensions(&cache_path).ok()?;
        return Some(PreparedAsset {
            key: cache_name,
            path: cache_path,
            mime_type: "image/jpeg",
            width,
            height,
        });
    }

    let image = image::open(source).ok()?.thumbnail(spec.width, spec.height);
    let width = image.width();
    let height = image.height();
    let mut bytes = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, spec.quality)
        .encode_image(&image)
        .ok()?;
    fs::create_dir_all(cache_directory).ok()?;
    let temporary_path = cache_path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    fs::write(&temporary_path, bytes.into_inner()).ok()?;
    let _ = fs::rename(&temporary_path, &cache_path);
    trim_cache(cache_directory);

    Some(PreparedAsset {
        key: cache_name,
        path: cache_path,
        mime_type: "image/jpeg",
        width,
        height,
    })
}

fn spec_for(kind: ImageAssetKind) -> AssetSpec {
    match kind {
        ImageAssetKind::Grid => AssetSpec {
            name: "grid",
            width: 768,
            height: 432,
            quality: 88,
        },
        ImageAssetKind::Strip => AssetSpec {
            name: "strip",
            width: 384,
            height: 216,
            quality: 86,
        },
        ImageAssetKind::Hero => AssetSpec {
            name: "hero",
            width: 1600,
            height: 900,
            quality: 90,
        },
        ImageAssetKind::Original => unreachable!(),
    }
}

fn trim_cache(cache_directory: &Path) {
    let Ok(directory_entries) = fs::read_dir(cache_directory) else {
        return;
    };
    let mut entries = directory_entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok().unwrap_or(SystemTime::UNIX_EPOCH);
            Some((entry.path(), metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    let mut total = entries.iter().map(|(_, length, _)| length).sum::<u64>();
    if total <= CACHE_CAPACITY_BYTES {
        return;
    }
    entries.sort_by_key(|(_, _, modified)| *modified);
    for (path, length, _) in entries {
        if total <= CACHE_CAPACITY_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(length);
        }
    }
}

fn source_signature(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(stable_hash(&format!(
        "{CACHE_VERSION}|{}|{}",
        metadata.len(),
        modified
    )))
}

fn source_key(path: &Path) -> String {
    stable_hash(
        &path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase(),
    )
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

fn protocol_url(key: &str) -> String {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    {
        format!("http://{PROTOCOL_NAME}.localhost/{key}")
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        format!("{PROTOCOL_NAME}://localhost/{key}")
    }
}

fn response(
    status: tauri::http::StatusCode,
    mime_type: &str,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header(tauri::http::header::CONTENT_TYPE, mime_type)
        .header(
            tauri::http::header::CACHE_CONTROL,
            "public, max-age=31536000, immutable",
        )
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .replace('/', "\\")
        .eq_ignore_ascii_case(&right.to_string_lossy().replace('/', "\\"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_signature_changes_when_source_metadata_changes() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-assets-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let image_path = directory.join("wallpaper.png");
        fs::write(&image_path, b"first").unwrap();
        let first = source_signature(&image_path).unwrap();
        fs::write(&image_path, b"second version").unwrap();
        let second = source_signature(&image_path).unwrap();

        assert_ne!(first, second);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn grid_asset_uses_the_requested_quality_and_bounds() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-assets-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let image_path = directory.join("wallpaper.png");
        image::RgbImage::from_pixel(1920, 1080, image::Rgb([32, 64, 128]))
            .save_with_format(&image_path, image::ImageFormat::Png)
            .unwrap();

        let asset =
            prepare_asset(&directory.join("cache"), &image_path, ImageAssetKind::Grid).unwrap();
        let decoded = image::open(&asset.path).unwrap();

        assert_eq!(asset.mime_type, "image/jpeg");
        assert!(decoded.width() <= 768);
        assert!(decoded.height() <= 432);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn registered_grid_assets_are_served_by_the_local_protocol() {
        let directory =
            std::env::temp_dir().join(format!("zx-wallpaper-assets-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let image_path = directory.join("wallpaper.png");
        image::RgbImage::from_pixel(1920, 1080, image::Rgb([32, 64, 128]))
            .save_with_format(&image_path, image::ImageFormat::Png)
            .unwrap();

        let manager = ImageAssetManager::new(directory.join("cache"));
        let prepared =
            prepare_asset(&directory.join("cache"), &image_path, ImageAssetKind::Grid).unwrap();
        let asset = manager.register(prepared).unwrap().unwrap();
        let key = asset.src.rsplit('/').next().unwrap();
        let response = manager.serve(key);

        assert!(asset.src.starts_with("http://wallpaper-asset.localhost/"));
        assert!(!asset.src.starts_with("data:"));
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(tauri::http::header::CONTENT_TYPE)
                .unwrap(),
            "image/jpeg"
        );
        assert_eq!(
            image::guess_format(response.body()).unwrap(),
            image::ImageFormat::Jpeg
        );
        let _ = fs::remove_dir_all(directory);
    }
}
