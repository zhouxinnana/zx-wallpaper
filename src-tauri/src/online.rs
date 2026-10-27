use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::{Duration as StdDuration, Instant},
};

use image::GenericImageView;
use reqwest::{
    header::{CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
    Client, Response, Url,
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use tokio::net::lookup_host;
use uuid::Uuid;

use crate::domain::same_path;
use crate::library::rescan_config;
use crate::state::{
    get_state, lock_config, mutate, mutate_without_rescan, AppState, AppConfig,
    LibraryScan, OnlineDownloadFailure, OnlineImage, OnlineSource, OnlineSourceCategoryStatus,
    OnlineSyncLog, RuntimeState,
};
use crate::wallpaper::{record_wallpaper_history, set_desktop_wallpaper};

const MAX_REDIRECTS: usize = 5;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const HTTP_REQUEST_TIMEOUT: StdDuration = StdDuration::from_secs(30);

#[derive(Clone, Debug)]
pub struct Candidate {
    pub image_url: String,
    pub source_page_url: String,
    pub category_key: Option<String>,
    pub allow_upx8_cdn_http: bool,
}

#[derive(Clone, Debug)]
pub struct CategoryResult {
    pub key: String,
    pub request_url: String,
    pub response_status: Option<u16>,
    pub response_image_urls: Vec<String>,
    pub discovered: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SourceFetchResult {
    pub candidates: Vec<Candidate>,
    pub categories: Vec<CategoryResult>,
}

#[derive(Clone, Debug)]
pub struct Upx8CategoryFetch {
    pub request_url: String,
    pub response_status: u16,
    pub image_urls: Vec<String>,
    pub candidates: Vec<Candidate>,
}

#[derive(Clone, Debug)]
pub struct DownloadedImage {
    pub local_path: PathBuf,
    pub image_url: String,
    pub source_page_url: String,
    pub downloaded_at: String,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug)]
pub struct DownloadFailure {
    pub image_url: String,
    pub resolved_url: Option<String>,
    pub response_status: Option<u16>,
    pub content_type: Option<String>,
    pub reason: String,
}

impl DownloadFailure {
    fn new(image_url: &str, reason: impl Into<String>) -> Self {
        Self {
            image_url: image_url.to_string(),
            resolved_url: None,
            response_status: None,
            content_type: None,
            reason: reason.into(),
        }
    }

    fn from_response(
        image_url: &str,
        resolved_url: &Url,
        response: &Response,
        reason: impl Into<String>,
    ) -> Self {
        let content_type = response_content_type(response);
        Self {
            image_url: image_url.to_string(),
            resolved_url: Some(resolved_url.to_string()),
            response_status: Some(response.status().as_u16()),
            content_type: (!content_type.is_empty()).then_some(content_type),
            reason: reason.into(),
        }
    }
}

pub fn is_public_host(host: &str) -> bool {
    let normalized = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized.is_empty() || normalized == "localhost" || normalized.ends_with(".local") {
        return false;
    }

    match normalized.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_broadcast()
        }
        Ok(IpAddr::V6(address)) => {
            !address.is_loopback() && !address.is_unspecified() && !address.is_unique_local()
        }
        Err(_) => true,
    }
}

pub async fn validate_public_https_url(value: &str) -> Result<Url, String> {
    validate_public_url(value, false).await
}

async fn validate_public_download_url(
    value: &str,
    allow_upx8_cdn_http: bool,
) -> Result<Url, String> {
    validate_public_url(value, allow_upx8_cdn_http).await
}

async fn validate_public_url(value: &str, allow_upx8_cdn_http: bool) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "来源地址不是有效的 URL。".to_string())?;
    if url.scheme() != "https" && !(allow_upx8_cdn_http && is_upx8_cdn_url(value)) {
        return Err("只允许公开 HTTPS 地址。".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "来源地址缺少主机名。".to_string())?;
    if !is_public_host(host) {
        return Err("来源不能指向本机或私有网络。".to_string());
    }

    let port =
        url.port_or_known_default().unwrap_or_else(
            || {
                if url.scheme() == "http" {
                    80
                } else {
                    443
                }
            },
        );
    let addresses: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|_| "来源主机无法解析。".to_string())?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("来源不能解析到私有网络。".to_string());
    }
    Ok(url)
}

pub const UPX8_CATEGORIES: [(&str, &str); 10] = [
    ("nature", "风景"),
    ("anime", "动漫"),
    ("game", "游戏"),
    ("animal", "动物"),
    ("city", "城市"),
    ("abstract", "抽象"),
    ("space", "宇宙"),
    ("car", "汽车"),
    ("girl", "美女"),
    ("sport", "运动"),
];

pub fn upx8_category_label(key: &str) -> Option<&'static str> {
    UPX8_CATEGORIES
        .iter()
        .find_map(|(candidate, label)| (*candidate == key).then_some(*label))
}

pub fn upx8_request_url(value: &str, key: &str, minimum: u16) -> Result<Url, String> {
    if upx8_category_label(key).is_none() {
        return Err("UPX8 分类不存在。".to_string());
    }
    let mut url = Url::parse(value).map_err(|_| "来源地址不是有效的 URL。".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("format", "json");
        query.append_pair("category", key);
        query.append_pair(
            "resolution",
            match minimum {
                3840 => "3840x2160",
                2560 => "2560x1440",
                _ => "1920x1080",
            },
        );
        query.append_pair("count", "10");
    }
    Ok(url)
}

pub async fn fetch_upx8_category(
    value: &str,
    key: &str,
    minimum: u16,
) -> Result<Upx8CategoryFetch, String> {
    let url = upx8_request_url(value, key, minimum)?;
    let url = validate_public_https_url(url.as_str()).await?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("无法初始化网络请求: {error}"))?;
    let (page_url, response) = request_with_checked_redirects(&client, url, false).await?;
    if !response.status().is_success() {
        return Err(format!("UPX8 请求失败 ({})。", response.status()));
    }
    let response_status = response.status().as_u16();
    let payload: serde_json::Value = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|error| format!("无法读取 UPX8 响应: {error}"))?,
    )
    .map_err(|error| format!("无法解析 UPX8 响应: {error}"))?;
    let items = payload
        .get("data")
        .map(|value| {
            value
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![value.clone()])
        })
        .unwrap_or_default();
    let image_urls: Vec<String> = items
        .into_iter()
        .filter_map(|item| {
            item.get("url")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|url| url.starts_with("https://") || is_upx8_cdn_url(url))
        .collect();
    let candidates = image_urls
        .iter()
        .cloned()
        .map(|image_url| Candidate {
            allow_upx8_cdn_http: is_upx8_cdn_url(&image_url),
            image_url,
            source_page_url: page_url.to_string(),
            category_key: Some(key.to_string()),
        })
        .collect();
    Ok(Upx8CategoryFetch {
        request_url: page_url.to_string(),
        response_status,
        image_urls,
        candidates,
    })
}

pub async fn download_candidate(
    candidate: Candidate,
    directory: &Path,
) -> Result<DownloadedImage, DownloadFailure> {
    let requested =
        validate_public_download_url(&candidate.image_url, candidate.allow_upx8_cdn_http)
            .await
            .map_err(|reason| DownloadFailure::new(&candidate.image_url, reason))?;
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(HTTP_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| DownloadFailure::new(&candidate.image_url, format!("无法初始化图片下载: {error}")))?;
    let (resolved_url, response) = request_with_checked_redirects(
        &client,
        requested,
        candidate.allow_upx8_cdn_http,
    )
    .await
    .map_err(|reason| DownloadFailure::new(&candidate.image_url, reason))?;
    if !response.status().is_success() {
        return Err(DownloadFailure::from_response(
            &candidate.image_url,
            &resolved_url,
            &response,
            format!("图片下载失败 ({})。", response.status()),
        ));
    }

    let mime_type = response_content_type(&response);
    let response_status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES)
    {
        return Err(DownloadFailure::from_response(
            &candidate.image_url,
            &resolved_url,
            &response,
            "图片超过 25 MB 下载限制。",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| {
            DownloadFailure::new(&candidate.image_url, format!("无法读取图片内容: {error}"))
        })?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(DownloadFailure {
            image_url: candidate.image_url.clone(),
            resolved_url: Some(resolved_url.to_string()),
            response_status: Some(response_status),
            content_type: (!mime_type.is_empty()).then_some(mime_type.clone()),
            reason: "图片超过 25 MB 下载限制。".to_string(),
        });
    }
    let (width, height) = decode_image_dimensions(&bytes).map_err(|_| DownloadFailure {
        image_url: candidate.image_url.clone(),
        resolved_url: Some(resolved_url.to_string()),
        response_status: Some(response_status),
        content_type: (!mime_type.is_empty()).then_some(mime_type.clone()),
        reason: "响应内容无法解码为受支持的图片格式。".to_string(),
    })?;

    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| DownloadFailure::new(&candidate.image_url, format!("无法创建在线壁纸目录: {error}")))?;
    let extension = extension_for_mime(&mime_type);
    let local_path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    tokio::fs::write(&local_path, &bytes)
        .await
        .map_err(|error| DownloadFailure::new(&candidate.image_url, format!("无法保存下载的图片: {error}")))?;

    Ok(DownloadedImage {
        local_path,
        image_url: candidate.image_url,
        source_page_url: candidate.source_page_url,
        downloaded_at: now_rfc3339(),
        width,
        height,
        mime_type,
        byte_length: bytes.len() as u64,
    })
}

fn decode_image_dimensions(bytes: &[u8]) -> Result<(u32, u32), image::ImageError> {
    Ok(image::load_from_memory(bytes)?.dimensions())
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

pub fn next_run_at(interval_hours: u8) -> String {
    (OffsetDateTime::now_utc() + Duration::hours(i64::from(interval_hours)))
        .format(&Rfc3339)
        .unwrap_or_default()
}

async fn request_with_checked_redirects(
    client: &Client,
    mut url: Url,
    allow_upx8_cdn_http: bool,
) -> Result<(Url, Response), String> {
    for _ in 0..=MAX_REDIRECTS {
        url = validate_public_download_url(url.as_str(), allow_upx8_cdn_http).await?;
        let response = client
            .get(url.clone())
            .header(USER_AGENT, "ZX-Wallpaper/0.1")
            .send()
            .await
            .map_err(|error| format!("网络请求失败: {error}"))?;
        if !response.status().is_redirection() {
            return Ok((url, response));
        }

        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|location| location.to_str().ok())
            .ok_or_else(|| "来源重定向缺少目标地址。".to_string())?;
        url = url
            .join(location)
            .map_err(|_| "来源重定向地址无效。".to_string())?;
    }
    Err("来源重定向次数超过限制。".to_string())
}

fn is_upx8_cdn_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };

    url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("cdn-hsyq-static.shanhutech.cn") | Some("cdn-hsyq-static-bak.shanhutech.cn")
        )
        && url.port_or_known_default() == Some(80)
        && url.path().starts_with("/bizhi/staticwp/")
        && url.username().is_empty()
        && url.password().is_none()
}

fn response_content_type(response: &Response) -> String {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/bmp" => "bmp",
        "image/webp" => "webp",
        _ => "jpg",
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !address.is_broadcast()
        }
        IpAddr::V6(address) => {
            !address.is_loopback() && !address.is_unspecified() && !address.is_unique_local()
        }
    }
}

const ONLINE_SYNC_LOG_CAPACITY: usize = 40;

pub(crate) fn built_in_sources() -> Vec<OnlineSource> {
    vec![OnlineSource {
        id: "upx8-4k".to_string(),
        name: "UPX8 综合壁纸 4K".to_string(),
        url: "https://wp.upx8.com/api.php".to_string(),
        enabled: false,
        interval_hours: 24,
        sync_categories: Vec::new(),
        last_run_at: None,
        next_run_at: None,
        last_discovered: 0,
        last_downloaded: 0,
        last_error: None,
        category_statuses: default_upx8_category_statuses(),
    }]
}

fn default_upx8_category_statuses() -> Vec<OnlineSourceCategoryStatus> {
    UPX8_CATEGORIES
        .iter()
        .map(|(key, label)| OnlineSourceCategoryStatus {
            key: (*key).to_string(),
            label: (*label).to_string(),
            discovered: 0,
            downloaded: 0,
            last_error: None,
        })
        .collect()
}

fn normalize_upx8_category_statuses(
    statuses: &[OnlineSourceCategoryStatus],
) -> Vec<OnlineSourceCategoryStatus> {
    default_upx8_category_statuses()
        .into_iter()
        .map(|mut status| {
            if let Some(saved) = statuses.iter().find(|saved| saved.key == status.key) {
                status.discovered = saved.discovered;
                status.downloaded = saved.downloaded;
                status.last_error = saved.last_error.clone();
            }
            status
        })
        .collect()
}

/// 全部分类 key，按 `UPX8_CATEGORIES` 顺序。
pub(crate) fn all_upx8_category_keys() -> Vec<String> {
    UPX8_CATEGORIES
        .iter()
        .map(|(key, _)| (*key).to_string())
        .collect()
}

/// 宽容归一化：丢弃未知 key、去重、按 `UPX8_CATEGORIES` 顺序输出。
/// 选择集合等于全集时收敛为空 —— 空即「全部」，保证存储形式唯一。
pub(crate) fn normalize_sync_categories(categories: &[String]) -> Vec<String> {
    let normalized: Vec<String> = UPX8_CATEGORIES
        .iter()
        .map(|(key, _)| *key)
        .filter(|key| categories.iter().any(|candidate| candidate == key))
        .map(str::to_string)
        .collect();
    if normalized.len() >= UPX8_CATEGORIES.len() {
        Vec::new()
    } else {
        normalized
    }
}

/// 严格校验：只用于命令入口，含未知 key 时上报中文错误。
pub(crate) fn validate_sync_categories(categories: &[String]) -> Result<Vec<String>, String> {
    if categories
        .iter()
        .any(|candidate| upx8_category_label(candidate).is_none())
    {
        return Err("UPX8 分类不存在。".to_string());
    }
    Ok(normalize_sync_categories(categories))
}

/// 定时同步实际请求的分类。空配置（未设置或全选）回退为全部。
pub(crate) fn due_sync_category_keys(source: &OnlineSource) -> Vec<String> {
    let selected = normalize_sync_categories(&source.sync_categories);
    if selected.is_empty() {
        all_upx8_category_keys()
    } else {
        selected
    }
}

pub(crate) fn merge_online_sources(saved: Vec<OnlineSource>) -> Vec<OnlineSource> {
    let mut saved_by_id: HashMap<_, _> = saved
        .iter()
        .map(|source| (source.id.as_str(), source))
        .collect();
    let merged: Vec<_> = built_in_sources()
        .into_iter()
        .map(|mut builtin| {
            if let Some(saved) = saved_by_id.remove(builtin.id.as_str()) {
                builtin.enabled = saved.enabled;
                builtin.interval_hours = match saved.interval_hours {
                    1 | 6 | 12 | 24 => saved.interval_hours,
                    _ => 24,
                };
                builtin.last_run_at = saved.last_run_at.clone();
                builtin.next_run_at = saved.next_run_at.clone();
                builtin.last_discovered = saved.last_discovered;
                builtin.last_downloaded = saved.last_downloaded;
                builtin.last_error = saved.last_error.clone();
                builtin.sync_categories = normalize_sync_categories(&saved.sync_categories);
                builtin.category_statuses = normalize_upx8_category_statuses(&saved.category_statuses);
            }
            builtin
        })
        .collect();
    merged
}

/// 把一次来源设置变更落到 config。命令体只做转发，逻辑留在这里以便单测。
///
/// 先校验再赋值：校验失败时 config 必须保持原样，不能留下「enabled 改了、
/// 分类没改」的半截状态。
pub(crate) fn apply_source_settings(
    config: &mut AppConfig,
    source: &OnlineSource,
) -> Result<(), String> {
    if source.id != "upx8-4k" {
        return Err("仅支持 UPX8 综合壁纸 4K 来源。".to_string());
    }
    let sync_categories = validate_sync_categories(&source.sync_categories)?;
    let saved = config
        .online_sources
        .iter_mut()
        .find(|saved| saved.id == source.id)
        .ok_or_else(|| "该在线来源已不存在。".to_string())?;
    saved.enabled = source.enabled;
    saved.interval_hours = match source.interval_hours {
        1 | 6 | 12 | 24 => source.interval_hours,
        _ => 24,
    };
    saved.sync_categories = sync_categories;
    Ok(())
}

#[tauri::command]
pub fn update_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source: OnlineSource,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        apply_source_settings(config, &source)
    })
}

#[tauri::command]
pub async fn run_online_source(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    source_id: String,
) -> Result<AppState, String> {
    run_online_source_impl(&app, &state, source_id, None, true).await
}

#[tauri::command]
pub async fn run_upx8_category(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    category_key: String,
) -> Result<AppState, String> {
    if upx8_category_label(&category_key).is_none() {
        return Err("UPX8 分类不存在。".to_string());
    }
    run_online_source_impl(&app, &state, "upx8-4k".to_string(), Some(category_key), true).await
}

pub(crate) async fn run_online_source_impl(
    app: &AppHandle,
    state: &RuntimeState,
    source_id: String,
    category_key: Option<String>,
    manual: bool,
) -> Result<AppState, String> {
    if source_id != "upx8-4k" {
        return Err("仅支持 UPX8 综合壁纸 4K 来源。".to_string());
    }
    let (source, directory, minimum_resolution, storage_limit, known_urls, storage_bytes) = {
        let config = lock_config(state)?;
        let source = config
            .online_sources
            .iter()
            .find(|source| source.id == source_id)
            .cloned()
            .ok_or_else(|| "该在线来源已不存在。".to_string())?;
        let directory = config
            .online_directory
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_online_directory(state));
        let known_urls = known_online_urls(&config);
        (
            source,
            directory,
            config.online_minimum_resolution,
            u64::from(config.online_storage_limit_gb) * 1024 * 1024 * 1024,
            known_urls,
            online_storage_bytes(&config),
        )
    };
    if !source.enabled && !manual {
        return Err("该在线来源当前已禁用。".to_string());
    }

    let category_keys = match category_key {
        Some(key) => vec![key],
        // 手动「同步全部」不受定时分类选择影响。
        None if manual => all_upx8_category_keys(),
        None => due_sync_category_keys(&source),
    };
    let log_ids = start_online_sync_logs(
        app,
        state,
        &source_id,
        &source.url,
        minimum_resolution,
        &category_keys,
    )?;
    let started = Instant::now();
    let fetched = match fetch_upx8_categories(
        state,
        &source.url,
        minimum_resolution,
        category_keys,
    )
    .await
    {
        Ok(fetched) => fetched,
        Err(error) => {
            let completed_at = now_rfc3339();
            let elapsed = started.elapsed().as_millis() as u64;
            let error_for_log = error.clone();
            mutate_without_rescan(app, state, move |config| {
                complete_online_sync_logs(
                    config,
                    &log_ids,
                    &[],
                    &HashMap::new(),
                    &HashMap::new(),
                    &HashMap::new(),
                    Some(&error_for_log),
                    &completed_at,
                    elapsed,
                );
                Ok(())
            })?;
            return Err(error);
        }
    };

    let candidates = fetched.candidates;
    let category_results = fetched.categories;
    let mut seen = known_urls;
    let mut downloaded = Vec::new();
    let mut downloaded_by_category = HashMap::new();
    let mut skipped_by_category = HashMap::new();
    let mut download_errors: HashMap<String, Vec<DownloadFailure>> = HashMap::new();
    let mut downloaded_bytes = 0;
    for candidate in candidates.iter().cloned() {
        let category_key = candidate.category_key.clone().unwrap_or_default();
        if seen.contains(&candidate.image_url) || storage_bytes + downloaded_bytes >= storage_limit
        {
            *skipped_by_category.entry(category_key).or_insert(0) += 1;
            continue;
        }
        match download_candidate(candidate, &directory).await {
            Ok(image) => {
                downloaded_bytes += image.byte_length;
                seen.insert(image.image_url.clone());
                downloaded.push(image);
                *downloaded_by_category.entry(category_key).or_insert(0) += 1;
            }
            Err(error) => download_errors.entry(category_key).or_default().push(error),
        }
    }

    let discovered = candidates.len();
    let completed_at = now_rfc3339();
    let elapsed = started.elapsed().as_millis() as u64;
    mutate_without_rescan(app, state, move |config| {
        let downloaded_count = downloaded.len();
        config
            .online_images
            .extend(downloaded.into_iter().map(|image| OnlineImage {
                id: Uuid::new_v4().to_string(),
                source_id: source_id.clone(),
                local_path: image.local_path.to_string_lossy().into_owned(),
                source_page_url: image.source_page_url,
                image_url: image.image_url,
                downloaded_at: image.downloaded_at,
                width: image.width,
                height: image.height,
                mime_type: image.mime_type,
            }));
        sort_online_images_by_downloaded_at(&mut config.online_images);
        if source_id == "upx8-4k" {
            let mut statuses = config
                .online_sources
                .iter()
                .find(|source| source.id == source_id)
                .map(|source| normalize_upx8_category_statuses(&source.category_statuses))
                .unwrap_or_else(default_upx8_category_statuses);
            for category in &category_results {
                if let Some(status) = statuses.iter_mut().find(|status| status.key == category.key) {
                    status.discovered = category.discovered;
                    status.downloaded = downloaded_by_category
                        .get(&category.key)
                        .copied()
                        .unwrap_or_default();
                    status.last_error = category.error.clone();
                }
            }
            if let Some(source) = config
                .online_sources
                .iter_mut()
                .find(|source| source.id == source_id)
            {
                source.category_statuses = statuses;
            }
        }
        complete_online_sync_logs(
            config,
            &log_ids,
            &category_results,
            &downloaded_by_category,
            &skipped_by_category,
            &download_errors,
            None,
            &completed_at,
            elapsed,
        );
        update_source_result(config, &source_id, discovered, downloaded_count, None);
        Ok(())
    })
}

fn start_online_sync_logs(
    app: &AppHandle,
    state: &RuntimeState,
    source_id: &str,
    source_url: &str,
    minimum_resolution: u16,
    category_keys: &[String],
) -> Result<HashMap<String, String>, String> {
    let started_at = now_rfc3339();
    let resolution = upx8_resolution(minimum_resolution).to_string();
    let log_ids: HashMap<String, String> = category_keys
        .iter()
        .cloned()
        .map(|key| (key, Uuid::new_v4().to_string()))
        .collect();
    let entries: Vec<OnlineSyncLog> = category_keys
        .iter()
        .map(|key| OnlineSyncLog {
            id: log_ids[key].clone(),
            source_id: source_id.to_string(),
            category_key: key.clone(),
            category_label: upx8_category_label(key)
                .unwrap_or(key.as_str())
                .to_string(),
            request_url: upx8_request_url(source_url, key, minimum_resolution)
                .map(|url| url.to_string())
                .unwrap_or_else(|_| source_url.to_string()),
            format: "json".to_string(),
            resolution: resolution.clone(),
            count: 10,
            started_at: started_at.clone(),
            finished_at: None,
            duration_ms: None,
            status: "running".to_string(),
            response_status: None,
            discovered: 0,
            downloaded: 0,
            skipped: 0,
            response_image_urls: Vec::new(),
            errors: Vec::new(),
            download_failures: Vec::new(),
        })
        .collect();
    mutate_without_rescan(app, state, move |config| {
        config.online_sync_logs.splice(0..0, entries);
        config.online_sync_logs.truncate(ONLINE_SYNC_LOG_CAPACITY);
        Ok(())
    })?;
    Ok(log_ids)
}

#[allow(clippy::too_many_arguments)]
fn complete_online_sync_logs(
    config: &mut AppConfig,
    log_ids: &HashMap<String, String>,
    category_results: &[CategoryResult],
    downloaded_by_category: &HashMap<String, usize>,
    skipped_by_category: &HashMap<String, usize>,
    download_errors: &HashMap<String, Vec<DownloadFailure>>,
    terminal_error: Option<&str>,
    completed_at: &str,
    duration_ms: u64,
) {
    for (category_key, id) in log_ids {
        let category = category_results
            .iter()
            .find(|category| category.key == *category_key);
        let mut errors = category
            .and_then(|category| category.error.clone())
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(download_errors) = download_errors.get(category_key) {
            errors.extend(
                download_errors
                    .iter()
                    .map(|failure| failure.reason.clone()),
            );
        }
        if let Some(error) = terminal_error {
            errors.push(error.to_string());
        }
        let status = if terminal_error.is_some() || category.and_then(|category| category.error.as_ref()).is_some() {
            "failed"
        } else if errors.is_empty() {
            "success"
        } else {
            "partial"
        };
        if let Some(log) = config.online_sync_logs.iter_mut().find(|log| log.id == *id) {
            log.finished_at = Some(completed_at.to_string());
            log.duration_ms = Some(duration_ms);
            log.status = status.to_string();
            log.response_status = category.and_then(|category| category.response_status);
            if let Some(category) = category {
                log.request_url = category.request_url.clone();
            }
            log.discovered = category.map(|category| category.discovered).unwrap_or_default();
            log.downloaded = downloaded_by_category
                .get(category_key)
                .copied()
                .unwrap_or_default();
            log.skipped = skipped_by_category.get(category_key).copied().unwrap_or_default();
            log.response_image_urls = category
                .map(|category| category.response_image_urls.clone())
                .unwrap_or_default();
            log.errors = errors;
            log.download_failures = download_errors
                .get(category_key)
                .map(|failures| {
                    failures
                        .iter()
                        .map(|failure| OnlineDownloadFailure {
                            image_url: failure.image_url.clone(),
                            resolved_url: failure.resolved_url.clone(),
                            response_status: failure.response_status,
                            content_type: failure.content_type.clone(),
                            reason: failure.reason.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
        }
    }
}

fn upx8_resolution(minimum_resolution: u16) -> &'static str {
    match minimum_resolution {
        3840 => "3840x2160",
        2560 => "2560x1440",
        _ => "1920x1080",
    }
}

async fn fetch_upx8_categories(
    state: &RuntimeState,
    source_url: &str,
    minimum_resolution: u16,
    category_keys: Vec<String>,
) -> Result<SourceFetchResult, String> {
    let mut fetched = SourceFetchResult::default();
    for key in category_keys {
        upx8_category_label(&key).ok_or_else(|| "UPX8 分类不存在。".to_string())?;
        wait_for_upx8_request_slot(state).await?;
        match fetch_upx8_category(source_url, &key, minimum_resolution).await {
            Ok(response) => {
                fetched.categories.push(CategoryResult {
                    key,
                    request_url: response.request_url,
                    response_status: Some(response.response_status),
                    response_image_urls: response.image_urls,
                    discovered: response.candidates.len(),
                    error: None,
                });
                fetched.candidates.extend(response.candidates);
            }
            Err(error) => fetched.categories.push(CategoryResult {
                request_url: upx8_request_url(source_url, &key, minimum_resolution)
                    .map(|url| url.to_string())
                    .unwrap_or_else(|_| source_url.to_string()),
                key,
                response_status: None,
                response_image_urls: Vec::new(),
                discovered: 0,
                error: Some(error),
            }),
        }
    }
    Ok(fetched)
}

async fn wait_for_upx8_request_slot(state: &RuntimeState) -> Result<(), String> {
    let wait = {
        let mut next_request_at = state
            .upx8_next_request_at
            .lock()
            .map_err(|_| "无法获取 UPX8 请求限速器。".to_string())?;
        let now = Instant::now();
        let scheduled_at = (*next_request_at).max(now);
        *next_request_at = scheduled_at + StdDuration::from_secs(1);
        scheduled_at.saturating_duration_since(now)
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_online_image_as_wallpaper(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    image_id: String,
) -> Result<AppState, String> {
    let (path, display_mode) = {
        let config = lock_config(&state)?;
        let path = config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.local_path.clone())
            .ok_or_else(|| "该在线图片已不存在。".to_string())?;
        (path, config.display_mode.clone())
    };
    let wallpaper_path = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        set_desktop_wallpaper(&wallpaper_path, &display_mode)
    })
    .await
    .map_err(|error| format!("设置壁纸任务中断: {error}"))??;

    mutate_without_rescan(&app, &state, move |config| {
        select_online_wallpaper(config, &image_id)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn delete_online_image(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    image_id: String,
) -> Result<AppState, String> {
    let (path, image_url) = {
        let config = lock_config(&state)?;
        let image = config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .ok_or_else(|| "该在线图片已不存在。".to_string())?;
        (image.local_path.clone(), image.image_url.clone())
    };
    let path_to_delete = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if Path::new(&path_to_delete).exists() {
            trash::delete(&path_to_delete)
                .map_err(|error| std::io::Error::other(error.to_string()))
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|error| format!("删除在线图片任务中断: {error}"))?
    .map_err(|error| format!("无法删除在线图片: {error}"))?;
    state.image_assets.purge_source(&path);
    mutate_without_rescan(&app, &state, move |config| {
        // 删除即拉黑：记下源 URL，否则下一轮同步会把这张图重新下载回来。
        remember_excluded_urls(config, std::iter::once(image_url));
        config.online_images.retain(|image| image.id != image_id);
        config
            .favorite_paths
            .retain(|favorite| !same_path(favorite, &path));
        Ok(())
    })
}

/// 清空「已排除」黑名单：之后被删过的图可以重新被同步下来。
#[tauri::command]
pub fn clear_excluded_image_urls(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, |config| {
        config.excluded_image_urls.clear();
        Ok(())
    })
}

/// 单条解封：只把这一条移出黑名单，之后同步会重新下载它。
#[tauri::command]
pub fn remove_excluded_image_url(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    url: String,
) -> Result<AppState, String> {
    mutate_without_rescan(&app, &state, move |config| {
        config.excluded_image_urls.retain(|known| known != &url);
        Ok(())
    })
}

#[tauri::command]
pub async fn select_online_directory(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<AppState, String> {
    let Some(directory) = app.dialog().file().blocking_pick_folder() else {
        return get_state(app, state);
    };
    let directory = directory
        .into_path()
        .map_err(|error| format!("所选在线壁纸目录无效: {error}"))?;
    mutate(&app, &state, move |config| {
        migrate_online_directory(config, &directory)
    })
}

#[tauri::command]
pub fn reveal_online_image(state: State<'_, RuntimeState>, image_id: String) -> Result<(), String> {
    let path = {
        let config = lock_config(&state)?;
        config
            .online_images
            .iter()
            .find(|image| image.id == image_id)
            .map(|image| image.local_path.clone())
            .ok_or_else(|| "该在线图片已不存在。".to_string())?
    };
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开图片所在目录: {error}"))?;
    Ok(())
}

fn default_online_directory(state: &RuntimeState) -> PathBuf {
    state
        .state_file
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("online-wallpapers")
}

fn migrate_online_directory(config: &mut AppConfig, directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|error| format!("无法创建在线壁纸目录: {error}"))?;
    let mut moved_paths = Vec::new();

    for image in &config.online_images {
        let source = Path::new(&image.local_path);
        if !source.is_file() || source.parent() == Some(directory) {
            continue;
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| "在线图片缺少文件名。".to_string())?;
        let target = available_online_target_path(directory, file_name);
        match fs::rename(source, &target) {
            Ok(()) => {}
            Err(_) => {
                fs::copy(source, &target).map_err(|error| format!("无法迁移在线图片: {error}"))?;
                fs::remove_file(source)
                    .map_err(|error| format!("无法移除已迁移的在线图片: {error}"))?;
            }
        }
        moved_paths.push((
            image.local_path.clone(),
            target.to_string_lossy().into_owned(),
        ));
    }

    for (source, target) in &moved_paths {
        for image in &mut config.online_images {
            if same_path(&image.local_path, source) {
                image.local_path = target.clone();
            }
        }
        replace_config_path(&mut config.current_path, source, target);
        replace_config_paths(&mut config.remaining_paths, source, target);
        replace_config_paths(&mut config.skipped_paths, source, target);
        replace_config_paths(&mut config.favorite_paths, source, target);
    }
    config.online_directory = Some(directory.to_string_lossy().into_owned());
    rescan_config(config);
    Ok(())
}

fn available_online_target_path(directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let target = directory.join(file_name);
    if !target.exists() {
        return target;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("wallpaper");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    directory.join(format!("{stem}-{}{}", Uuid::new_v4(), extension))
}

fn replace_config_path(path: &mut Option<String>, source: &str, target: &str) {
    if path.as_deref().is_some_and(|path| same_path(path, source)) {
        *path = Some(target.to_string());
    }
}

fn replace_config_paths(paths: &mut [String], source: &str, target: &str) {
    for path in paths {
        if same_path(path, source) {
            *path = target.to_string();
        }
    }
}

pub(crate) fn online_storage_bytes(config: &AppConfig) -> u64 {
    config
        .online_images
        .iter()
        .filter_map(|image| fs::metadata(&image.local_path).ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub(crate) fn sort_online_images_by_downloaded_at(images: &mut [OnlineImage]) {
    images.sort_by(|left, right| {
        let left_time = OffsetDateTime::parse(&left.downloaded_at, &Rfc3339).ok();
        let right_time = OffsetDateTime::parse(&right.downloaded_at, &Rfc3339).ok();
        match (left_time, right_time) {
            (Some(left_time), Some(right_time)) => right_time.cmp(&left_time),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.id.cmp(&right.id))
    });
}

fn update_source_result(
    config: &mut AppConfig,
    source_id: &str,
    discovered: usize,
    downloaded: usize,
    last_error: Option<String>,
) {
    if let Some(source) = config
        .online_sources
        .iter_mut()
        .find(|source| source.id == source_id)
    {
        source.last_run_at = Some(now_rfc3339());
        source.next_run_at = Some(next_run_at(source.interval_hours));
        source.last_discovered = discovered;
        source.last_downloaded = downloaded;
        source.last_error = last_error;
    }
}

pub(crate) fn due_source_ids(config: &AppConfig, now: OffsetDateTime) -> Vec<String> {
    config
        .online_sources
        .iter()
        .filter(|source| source.enabled)
        .filter(|source| {
            source
                .next_run_at
                .as_deref()
                .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
                .map_or(true, |next_run_at| next_run_at <= now)
        })
        .map(|source| source.id.clone())
        .collect()
}

/// 同步时的「已知 URL」集合：库里现有的 + 用户删过的（黑名单）。
/// 黑名单是唯一阻止「删了又被下回来」的机制 —— 删除会同时移除 online_images 记录，
/// 只看 online_images 的话下一轮同步会把同一张图重新拉回来。
pub(crate) fn known_online_urls(config: &AppConfig) -> HashSet<String> {
    let mut known: HashSet<String> = config
        .online_images
        .iter()
        .map(|image| image.image_url.clone())
        .collect();
    known.extend(config.excluded_image_urls.iter().cloned());
    known
}

/// 把被删除图片的源 URL 记进黑名单（去重、保序）。
pub(crate) fn remember_excluded_urls(
    config: &mut AppConfig,
    urls: impl IntoIterator<Item = String>,
) {
    for url in urls {
        if url.is_empty() {
            continue;
        }
        if !config
            .excluded_image_urls
            .iter()
            .any(|known| known == &url)
        {
            config.excluded_image_urls.push(url);
        }
    }
}

pub(crate) fn prune_missing_online_images(config: &mut AppConfig) {
    config
        .online_images
        .retain(|image| Path::new(&image.local_path).is_file());
    if config
        .current_path
        .as_deref()
        .is_some_and(|path| !Path::new(path).is_file())
    {
        config.current_path = None;
    }
}

pub(crate) fn reconcile_online_candidates(
    scan: &mut LibraryScan,
    previous_images: &[OnlineImage],
    next_images: &[OnlineImage],
) {
    let key = |path: &str| path.replace('/', "\\").to_ascii_lowercase();
    let previous_paths: HashSet<_> = previous_images
        .iter()
        .map(|image| key(&image.local_path))
        .collect();
    let next_paths: HashSet<_> = next_images
        .iter()
        .map(|image| key(&image.local_path))
        .collect();
    scan.candidates.retain(|path| {
        let candidate = key(path);
        !previous_paths.contains(&candidate) || next_paths.contains(&candidate)
    });
    let mut candidate_paths: HashSet<_> = scan.candidates.iter().map(|path| key(path)).collect();
    for image in next_images {
        let image_path = Path::new(&image.local_path);
        let image_key = key(&image.local_path);
        if image_path.is_file() && candidate_paths.insert(image_key) {
            scan.candidates.push(image.local_path.clone());
        }
    }
}

fn select_online_wallpaper(config: &mut AppConfig, image_id: &str) -> Result<String, String> {
    let path = config
        .online_images
        .iter()
        .find(|image| image.id == image_id)
        .map(|image| image.local_path.clone())
        .ok_or_else(|| "该在线图片已不存在。".to_string())?;
    record_wallpaper_history(config);
    config.current_path = Some(path.clone());
    config.paused = true;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::{
        all_upx8_category_keys, apply_source_settings, due_source_ids, due_sync_category_keys,
        is_public_host, is_upx8_cdn_url, known_online_urls, merge_online_sources,
        migrate_online_directory, normalize_sync_categories, prune_missing_online_images,
        reconcile_online_candidates, remember_excluded_urls, select_online_wallpaper,
        sort_online_images_by_downloaded_at, upx8_category_label, upx8_request_url,
        validate_sync_categories, OnlineImage, OnlineSource, UPX8_CATEGORIES,
    };
    use crate::domain::same_path;
    use crate::state::{AppConfig, LibraryScan};
    use std::collections::HashMap;

    #[test]
    fn known_urls_include_deleted_images_so_sync_never_downloads_them_again() {
        let mut config = AppConfig {
            online_images: vec![OnlineImage {
                image_url: "https://example.test/kept.jpg".into(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };
        remember_excluded_urls(
            &mut config,
            vec!["https://example.test/deleted.jpg".to_string()],
        );
        // 重复拉黑不应产生重复项。
        remember_excluded_urls(
            &mut config,
            vec!["https://example.test/deleted.jpg".to_string()],
        );

        let known = known_online_urls(&config);
        assert!(known.contains("https://example.test/kept.jpg"));
        assert!(known.contains("https://example.test/deleted.jpg"));
        assert_eq!(config.excluded_image_urls.len(), 1);
    }
    use std::fs;
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn rejects_loopback_and_private_ip_hosts() {
        assert!(!is_public_host("localhost"));
        assert!(!is_public_host("127.0.0.1"));
        assert!(!is_public_host("10.0.0.8"));
        assert!(!is_public_host("192.168.1.10"));
        assert!(is_public_host("images.example.com"));
    }

    #[test]
    fn upx8_categories_follow_the_product_order() {
        let keys: Vec<_> = UPX8_CATEGORIES.iter().map(|(key, _)| *key).collect();
        assert_eq!(
            keys,
            vec![
                "nature",
                "anime",
                "game",
                "animal",
                "city",
                "abstract",
                "space",
                "car",
                "girl",
                "sport"
            ]
        );
        assert_eq!(upx8_category_label("nature"), Some("风景"));
        assert_eq!(upx8_category_label("sport"), Some("运动"));
        assert_eq!(upx8_category_label("fengjing"), None);
    }

    #[test]
    fn builds_documented_upx8_json_request_parameters() {
        let url = upx8_request_url("https://wp.upx8.com/api.php", "nature", 3840).unwrap();
        assert_eq!(
            url.as_str(),
            "https://wp.upx8.com/api.php?format=json&category=nature&resolution=3840x2160&count=10"
        );
    }

    #[test]
    fn accepts_only_the_known_upx8_http_image_cdn() {
        assert!(is_upx8_cdn_url(
            "http://cdn-hsyq-static.shanhutech.cn/bizhi/staticwp/2026/08/wallpaper.jpg"
        ));
        assert!(is_upx8_cdn_url(
            "http://cdn-hsyq-static-bak.shanhutech.cn/bizhi/staticwp/2026/08/wallpaper.jpg"
        ));
        assert!(!is_upx8_cdn_url(
            "http://example.com/bizhi/staticwp/wallpaper.jpg"
        ));
        assert!(!is_upx8_cdn_url(
            "http://cdn-hsyq-static.shanhutech.cn/other/wallpaper.jpg"
        ));
        assert!(!is_upx8_cdn_url(
            "http://127.0.0.1/bizhi/staticwp/wallpaper.jpg"
        ));
        assert!(!is_upx8_cdn_url(
            "https://cdn-hsyq-static.shanhutech.cn/bizhi/staticwp/wallpaper.jpg"
        ));
    }

    #[test]
    fn accepts_decodable_images_without_a_dimension_gate() {
        let image = image::RgbImage::from_pixel(1, 1, image::Rgb([1, 2, 3]));
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();

        assert_eq!(super::decode_image_dimensions(&bytes).unwrap(), (1, 1));
    }

    #[test]
    fn retains_only_upx8_when_migrating_saved_sources() {
        let saved = OnlineSource {
            id: "upx8-4k".into(),
            enabled: true,
            interval_hours: 6,
            last_downloaded: 3,
            ..OnlineSource::default()
        };
        let obsolete = OnlineSource {
            id: "bing-cn-4k".into(),
            enabled: true,
            ..OnlineSource::default()
        };
        let sources = merge_online_sources(vec![saved, obsolete]);
        assert_eq!(sources.len(), 1);
        let upx8 = sources
            .iter()
            .find(|source| source.id == "upx8-4k")
            .unwrap();
        assert!(upx8.enabled);
        assert_eq!(upx8.interval_hours, 6);
        assert_eq!(upx8.last_downloaded, 3);
    }

    #[test]
    fn orders_online_images_by_latest_download_with_a_stable_id_tiebreaker() {
        let mut images = vec![
            OnlineImage {
                id: "same-time-b".into(),
                downloaded_at: "2026-08-10T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "old".into(),
                downloaded_at: "2026-08-09T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "same-time-a".into(),
                downloaded_at: "2026-08-10T01:00:00Z".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "invalid".into(),
                downloaded_at: "not-a-timestamp".into(),
                ..OnlineImage::default()
            },
            OnlineImage {
                id: "new".into(),
                downloaded_at: "2026-08-11T01:00:00Z".into(),
                ..OnlineImage::default()
            },
        ];

        sort_online_images_by_downloaded_at(&mut images);

        assert_eq!(
            images
                .iter()
                .map(|image| image.id.as_str())
                .collect::<Vec<_>>(),
            vec!["new", "same-time-a", "same-time-b", "old", "invalid"]
        );
    }

    #[test]
    fn removes_deleted_online_images_from_the_cached_candidate_set() {
        let deleted = OnlineImage {
            id: "online-image".into(),
            local_path: "D:\\ZX Wallpaper\\Online\\deleted.jpg".into(),
            ..OnlineImage::default()
        };
        let mut scan = LibraryScan {
            folder_statuses: HashMap::new(),
            candidates: vec![deleted.local_path.clone()],
            library_images: Vec::new(),
        };

        reconcile_online_candidates(&mut scan, &[deleted], &[]);

        assert!(scan.candidates.is_empty());
    }

    #[test]
    fn refresh_prunes_missing_online_images_from_the_saved_state() {
        let missing_path = std::env::temp_dir()
            .join(format!("zx-wallpaper-missing-{}.jpg", Uuid::new_v4()));
        let mut config = AppConfig {
            current_path: Some(missing_path.to_string_lossy().into_owned()),
            online_images: vec![OnlineImage {
                id: "missing-online-image".into(),
                local_path: missing_path.to_string_lossy().into_owned(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        prune_missing_online_images(&mut config);

        assert!(config.online_images.is_empty());
        assert!(config.current_path.is_none());
    }

    #[test]
    fn selecting_an_online_image_pauses_automatic_switching() {
        let mut config = AppConfig {
            paused: false,
            online_images: vec![OnlineImage {
                id: "online-1".into(),
                local_path: "D:\\ZX Wallpaper\\Online\\chosen.jpg".into(),
                ..OnlineImage::default()
            }],
            ..AppConfig::default()
        };

        select_online_wallpaper(&mut config, "online-1").unwrap();

        assert!(config.paused);
        assert_eq!(
            config.current_path.as_deref(),
            Some("D:\\ZX Wallpaper\\Online\\chosen.jpg")
        );
    }

    fn sync_categories(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|key| (*key).to_string()).collect()
    }

    #[test]
    fn normalize_sync_categories_drops_unknown_keys_and_dedupes() {
        let normalized = normalize_sync_categories(&sync_categories(&["nature", "nope", "nature"]));

        assert_eq!(normalized, sync_categories(&["nature"]));
    }

    #[test]
    fn normalize_sync_categories_orders_by_catalog() {
        let normalized = normalize_sync_categories(&sync_categories(&["sport", "nature"]));

        assert_eq!(normalized, sync_categories(&["nature", "sport"]));
    }

    #[test]
    fn normalize_sync_categories_collapses_the_full_set_to_empty() {
        let mut keys: Vec<&str> = UPX8_CATEGORIES.iter().map(|(key, _)| *key).collect();
        keys.reverse();

        assert!(normalize_sync_categories(&sync_categories(&keys)).is_empty());
    }

    #[test]
    fn validate_sync_categories_rejects_unknown_keys() {
        assert_eq!(
            validate_sync_categories(&sync_categories(&["nope"])),
            Err("UPX8 分类不存在。".to_string())
        );
    }

    #[test]
    fn due_sync_category_keys_falls_back_to_every_category_when_empty() {
        let source = OnlineSource::default();

        assert_eq!(due_sync_category_keys(&source), all_upx8_category_keys());
        assert_eq!(due_sync_category_keys(&source).len(), 10);
    }

    #[test]
    fn due_sync_category_keys_uses_the_saved_selection() {
        let source = OnlineSource {
            sync_categories: sync_categories(&["game", "anime"]),
            ..OnlineSource::default()
        };

        assert_eq!(
            due_sync_category_keys(&source),
            sync_categories(&["anime", "game"])
        );
    }

    #[test]
    fn merge_online_sources_keeps_the_saved_sync_categories() {
        let saved_source = OnlineSource {
            id: "upx8-4k".into(),
            sync_categories: sync_categories(&["nope", "anime"]),
            ..OnlineSource::default()
        };

        let merged = merge_online_sources(vec![saved_source]);

        assert_eq!(merged[0].sync_categories, sync_categories(&["anime"]));
    }

    #[test]
    fn apply_source_settings_persists_the_sync_categories() {
        let mut config = AppConfig {
            online_sources: merge_online_sources(Vec::new()),
            ..AppConfig::default()
        };
        let source = OnlineSource {
            id: "upx8-4k".into(),
            enabled: true,
            interval_hours: 6,
            sync_categories: sync_categories(&["anime", "game"]),
            ..OnlineSource::default()
        };

        apply_source_settings(&mut config, &source).unwrap();

        let applied = &config.online_sources[0];
        assert!(applied.enabled);
        assert_eq!(applied.interval_hours, 6);
        assert_eq!(applied.sync_categories, sync_categories(&["anime", "game"]));
    }

    #[test]
    fn apply_source_settings_rejects_unknown_category_without_changing_config() {
        let mut config = AppConfig {
            online_sources: merge_online_sources(Vec::new()),
            ..AppConfig::default()
        };
        let source = OnlineSource {
            id: "upx8-4k".into(),
            enabled: true,
            interval_hours: 6,
            sync_categories: sync_categories(&["nope"]),
            ..OnlineSource::default()
        };

        assert!(apply_source_settings(&mut config, &source).is_err());
        assert!(!config.online_sources[0].enabled);
        assert_eq!(config.online_sources[0].interval_hours, 24);
    }

    #[test]
    fn schedules_only_enabled_sources_that_are_due() {
        let now = OffsetDateTime::parse("2026-08-07T10:30:00Z", &Rfc3339).unwrap();
        let config = AppConfig {
            online_sources: vec![
                OnlineSource {
                    id: "due".into(),
                    enabled: true,
                    next_run_at: Some("2026-08-07T10:00:00Z".into()),
                    ..OnlineSource::default()
                },
                OnlineSource {
                    id: "future".into(),
                    enabled: true,
                    next_run_at: Some("2026-08-07T11:00:00Z".into()),
                    ..OnlineSource::default()
                },
                OnlineSource {
                    id: "disabled".into(),
                    enabled: false,
                    next_run_at: Some("2026-08-07T10:00:00Z".into()),
                    ..OnlineSource::default()
                },
            ],
            ..AppConfig::default()
        };

        assert_eq!(due_source_ids(&config, now), vec!["due"]);
    }

    #[test]
    fn migrates_existing_online_images_when_the_managed_directory_changes() {
        let root = std::env::temp_dir().join(format!("zx-wallpaper-{}", Uuid::new_v4()));
        let old_directory = root.join("old");
        let new_directory = root.join("new");
        fs::create_dir_all(&old_directory).unwrap();
        let old_path = old_directory.join("wallpaper.jpg");
        fs::write(&old_path, b"wallpaper").unwrap();
        let mut config = AppConfig {
            online_directory: Some(old_directory.to_string_lossy().into_owned()),
            online_images: vec![OnlineImage {
                id: "online-1".into(),
                local_path: old_path.to_string_lossy().into_owned(),
                ..OnlineImage::default()
            }],
            favorite_paths: vec![old_path.to_string_lossy().into_owned()],
            ..AppConfig::default()
        };

        migrate_online_directory(&mut config, &new_directory).unwrap();

        let migrated_path = new_directory.join("wallpaper.jpg");
        assert!(migrated_path.is_file());
        assert!(!old_path.exists());
        assert_eq!(
            config.online_images[0].local_path,
            migrated_path.to_string_lossy()
        );
        assert!(same_path(
            &config.favorite_paths[0],
            &migrated_path.to_string_lossy()
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
