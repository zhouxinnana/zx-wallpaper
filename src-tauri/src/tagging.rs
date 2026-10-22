//! 本地 AI 打标（Phase 4）。
//!
//! 架构（design.md 4.1）：只跑 CLIP ViT-B/32 图像编码器（int8 量化 ONNX），
//! 文本侧十分类嵌入离线预计算为 `text-embeds.bin`（10×512 f32，L2 归一化），
//! 经 `include_bytes!` 编译期内嵌，运行时零 tokenizer 依赖、零文本推理。
//! 模型首次启用时从固定 URL 下载（SHA-256 边下边校验），缓存于 app config dir
//! 的 `models/` 子目录，不打包进安装包。
//!
//! 队列：全局唯一推理会话（ort 每进程仅允许一个 Environment，OnceLock 持有），
//! 后台单线程逐张处理未打标路径；推理前只取路径快照、推理完短锁写回
//! `AppConfig.image_tags`，不持配置锁做推理。应用退出随进程自然终止。
#![allow(dead_code)]

use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Condvar, Mutex, MutexGuard, OnceLock},
    thread,
    time::Duration,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use image::GenericImageView;

use crate::{
    domain::same_path,
    library::collect_candidates,
    online::{now_rfc3339, UPX8_CATEGORIES},
    state::{lock_config, lock_library_scan, mutate_without_rescan, AppState, ImageTag, RuntimeState},
};

/// CLIP ViT-B/32 图像编码器（int8 量化）下载 URL。
/// 源：Xenova/clip-vit-base-patch32（Transformers.js 官方导出，HF 镜像路径）。
/// 注：huggingface.co 与 hf-mirror.com 路径结构一致，可按需互换。
pub const MODEL_URL: &str =
    "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_int8.onnx";

/// 模型 SHA-256（选型验证时实测，见 design.md 4.1）。
pub const MODEL_SHA256: &str = "0ab0c1b3ace708e539633af1744d5a95247fe4e14d3e08ff197ef82a6cb9bd93";

/// 备选精度档位（fp16，int8 精度不足时启用）。
pub const MODEL_FP16_URL: &str =
    "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_fp16.onnx";

/// text-embeds.bin：十分类文本嵌入，10×512 f32（每类多模板均值后 L2 归一化）。
/// 由离线脚本生成（Python + onnxruntime + tokenizers），编译期内嵌进二进制，
/// 行顺序 = online.rs `UPX8_CATEGORIES` 顺序。
static TEXT_EMBEDS_BIN: &[u8] = include_bytes!("../assets/text-embeds.bin");

pub const TEXT_EMBEDS_DIM_CLASSES: usize = 10;
pub const TEXT_EMBEDS_DIM_FEATURES: usize = 512;

const MODEL_FILE_NAME: &str = "vision_model_int8.onnx";
const MODEL_PART_SUFFIX: &str = ".part";
const INPUT_SIZE: u32 = 224;
const CLIP_MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD: [f32; 3] = [0.268_629_54, 0.261_302_58, 0.275_777_11];

// ---------------------------------------------------------------------------
// 队列与运行时状态
// ---------------------------------------------------------------------------

#[derive(Default)]
struct QueueInner {
    /// 与 `AppConfig.tagging_enabled` 同步；worker 以此决定是否继续消费。
    enabled: bool,
    /// 待打标路径（FIFO）。
    pending: Vec<String>,
    /// 模型下载进度 `(已接收字节, 总字节)`；None 表示当前未在下载。
    downloading: Option<(u64, Option<u64>)>,
    /// 模型就绪状态缓存；None 表示尚未检查。
    model_ready: Option<bool>,
    /// worker 线程是否已启动（每进程只起一次）。
    worker_started: bool,
}

/// 打标任务队列：Mutex 状态 + Condvar 唤醒后台 worker。
/// 不持 AppConfig 锁做推理；仅取路径快照与短锁写结果。
pub(crate) struct TaggingQueue {
    inner: Mutex<QueueInner>,
    signal: Condvar,
}

impl TaggingQueue {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner::default()),
            signal: Condvar::new(),
        }
    }
}

fn lock_queue(state: &RuntimeState) -> Result<MutexGuard<'_, QueueInner>, String> {
    state
        .tagging
        .inner
        .lock()
        .map_err(|_| "打标队列状态不可用。".to_string())
}

// ---------------------------------------------------------------------------
// IPC 命令
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggingDownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggingStatus {
    pub enabled: bool,
    pub model_ready: bool,
    pub downloading: Option<TaggingDownloadProgress>,
    pub pending: usize,
}

/// 启用/停用智能分类。启用即触发模型下载（后台）与队列启动；停用只清空待处理
/// 队列，已打标数据保留。
#[tauri::command]
pub fn set_tagging_enabled(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    enabled: bool,
) -> Result<AppState, String> {
    let snapshot = mutate_without_rescan(&app, &state, |config| {
        config.tagging_enabled = enabled;
        Ok(())
    })?;
    if enabled {
        start_queue(&app, &state);
    } else {
        stop_queue(&state);
    }
    Ok(snapshot)
}

/// 查询打标状态（模型下载进度 / 就绪 / 待打标数）。
#[tauri::command]
pub fn get_tagging_status(state: State<'_, RuntimeState>) -> Result<TaggingStatus, String> {
    tagging_status(&state)
}

/// 重新扫描打标：清掉文件已不存在的旧标签，把剩余未打标路径重新入队。
#[tauri::command]
pub fn rescan_tags(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppState, String> {
    let snapshot = mutate_without_rescan(&app, &state, |config| {
        config.image_tags.retain(|tag| Path::new(&tag.path).is_file());
        Ok(())
    })?;
    enqueue_pending(&state);
    Ok(snapshot)
}

pub(crate) fn tagging_status(state: &RuntimeState) -> Result<TaggingStatus, String> {
    let enabled = lock_config(state)?.tagging_enabled;
    let mut inner = lock_queue(state)?;
    if inner.model_ready.is_none() {
        let ready = models_dir_for(state)
            .map(|dir| model_file_valid(&dir.join(MODEL_FILE_NAME)))
            .unwrap_or(false);
        inner.model_ready = Some(ready);
    }
    Ok(TaggingStatus {
        enabled,
        model_ready: inner.model_ready.unwrap_or(false),
        downloading: inner
            .downloading
            .map(|(received, total)| TaggingDownloadProgress { received, total }),
        pending: inner.pending.len(),
    })
}

fn stop_queue(state: &RuntimeState) {
    if let Ok(mut inner) = lock_queue(state) {
        inner.enabled = false;
        inner.pending.clear();
        inner.downloading = None;
    }
    state.tagging.signal.notify_all();
}

/// 启用队列：打开开关、确保 worker 线程存在、把当前未打标候选入队。
pub(crate) fn start_queue(app: &AppHandle, state: &RuntimeState) {
    if let Ok(mut inner) = lock_queue(state) {
        inner.enabled = true;
    }
    ensure_worker(app.clone(), state);
    enqueue_pending(state);
}

/// 应用启动时：若配置里已启用则恢复队列（续跑未打标路径）。
pub(crate) fn start_if_enabled(app: &AppHandle) {
    let state = app.state::<RuntimeState>();
    let enabled = lock_config(&state)
        .map(|config| config.tagging_enabled)
        .unwrap_or(false);
    if enabled {
        start_queue(app, &state);
    }
}

/// 把所有未打标候选路径入队（跳过已打标与已在队列中的）。
/// 由启用开关、目录监听重扫钩子与 `rescan_tags` 调用。
pub(crate) fn enqueue_pending(state: &RuntimeState) -> usize {
    let enabled = lock_config(state)
        .map(|config| config.tagging_enabled)
        .unwrap_or(false);
    if !enabled {
        return 0;
    }
    let (tagged_keys, candidates) = {
        let Ok(config) = lock_config(state) else {
            return 0;
        };
        let tagged: HashSet<String> = config.image_tags.iter().map(|tag| path_key(&tag.path)).collect();
        let candidates = lock_library_scan(state)
            .ok()
            .and_then(|scan| scan.clone())
            .map(|scan| scan.candidates)
            .unwrap_or_else(|| collect_candidates(&config).candidates);
        (tagged, candidates)
    };
    let queued = {
        let Ok(mut inner) = lock_queue(state) else {
            return 0;
        };
        let mut queued = 0;
        for path in candidates {
            let key = path_key(&path);
            if tagged_keys.contains(&key)
                || inner.pending.iter().any(|pending| path_key(pending) == key)
            {
                continue;
            }
            inner.pending.push(path);
            queued += 1;
        }
        queued
    };
    if queued > 0 {
        state.tagging.signal.notify_all();
    }
    queued
}

/// Windows 路径归一化（`/`→`\` + 小写），与 library.rs 合并候选的去重口径一致。
fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// worker 线程
// ---------------------------------------------------------------------------

fn ensure_worker(app: AppHandle, state: &RuntimeState) {
    let should_start = match lock_queue(state) {
        Ok(mut inner) => {
            if inner.worker_started {
                false
            } else {
                inner.worker_started = true;
                true
            }
        }
        Err(_) => false,
    };
    if !should_start {
        return;
    }
    let _ = thread::Builder::new()
        .name("tagging-worker".into())
        .spawn(move || worker_loop(app));
}

fn worker_loop(app: AppHandle) {
    loop {
        let path = {
            let state = app.state::<RuntimeState>();
            let Ok(mut inner) = lock_queue(&state) else {
                return;
            };
            loop {
                if inner.enabled && !inner.pending.is_empty() {
                    break;
                }
                inner = match state.tagging.signal.wait(inner) {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
            }
            inner.pending.remove(0)
        };
        if let Err(error) = process_path(&app, &path) {
            eprintln!("打标失败 {path}: {error}");
        }
    }
}

/// 处理单张图片：检查已打标 → 确保模型 → 推理 → 短锁写回。
fn process_path(app: &AppHandle, path: &str) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let already_tagged = lock_config(&state)?
        .image_tags
        .iter()
        .any(|tag| same_path(&tag.path, path));
    if already_tagged {
        return Ok(());
    }

    let models_dir = models_dir_for(&state)?;
    let model_path = ensure_model_ready(&models_dir, &state)?;
    let mut session_guard = acquire_session(&model_path)?;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "推理会话未初始化。".to_string())?;
    let (category, confidence) = classify_image(session, path)?;
    record_tag(
        app,
        &state,
        ImageTag {
            path: path.to_string(),
            category,
            confidence,
            tagged_at: now_rfc3339(),
        },
    );
    Ok(())
}

fn record_tag(app: &AppHandle, state: &RuntimeState, tag: ImageTag) {
    let _ = mutate_without_rescan(app, state, |config| {
        config
            .image_tags
            .retain(|existing| !same_path(&existing.path, &tag.path));
        config.image_tags.push(tag);
        Ok(())
    });
}

// ---------------------------------------------------------------------------
// 模型管理：校验 / 下载 / 会话
// ---------------------------------------------------------------------------

fn models_dir_for(state: &RuntimeState) -> Result<PathBuf, String> {
    state
        .state_file
        .parent()
        .map(|dir| dir.join("models"))
        .ok_or_else(|| "无法定位应用配置目录。".to_string())
}

/// 模型文件存在且 SHA-256 匹配。
pub(crate) fn model_file_valid(path: &Path) -> bool {
    path.is_file() && verify_file_sha256(path, MODEL_SHA256)
}

fn ensure_model_ready(models_dir: &Path, state: &RuntimeState) -> Result<PathBuf, String> {
    let model_path = models_dir.join(MODEL_FILE_NAME);
    if model_file_valid(&model_path) {
        if let Ok(mut inner) = lock_queue(state) {
            inner.model_ready = Some(true);
        }
        return Ok(model_path);
    }
    if model_path.is_file() {
        // 内容不符：删掉损坏缓存，重新下载。
        let _ = fs::remove_file(&model_path);
    }
    fs::create_dir_all(models_dir)
        .map_err(|error| format!("无法创建模型缓存目录 {}: {error}", models_dir.display()))?;
    let result = download_model(MODEL_URL, &model_path, state);
    if let Err(error) = result {
        if let Ok(mut inner) = lock_queue(state) {
            inner.downloading = None;
            inner.model_ready = Some(false);
        }
        return Err(error);
    }
    if !verify_file_sha256(&model_path, MODEL_SHA256) {
        let _ = fs::remove_file(&model_path);
        if let Ok(mut inner) = lock_queue(state) {
            inner.downloading = None;
            inner.model_ready = Some(false);
        }
        return Err("模型文件 SHA-256 校验失败，已删除缓存文件，请重试。".to_string());
    }
    if let Ok(mut inner) = lock_queue(state) {
        inner.downloading = None;
        inner.model_ready = Some(true);
    }
    Ok(model_path)
}

/// 流式校验文件 SHA-256（64KB 分块，不整载内存）。
pub(crate) fn verify_file_sha256(path: &Path, expected_hex: &str) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    hex_encode(&hasher.finalize()) == expected_hex.to_ascii_lowercase()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 流式下载模型到 `<dest>.part`，边下边更新下载进度；完成后原子改名，
/// SHA-256 校验由调用方对最终文件整体验证（不通过则删除）。
/// 下载本体不设总超时（大文件），仅限制连接超时。
fn download_model(url: &str, dest: &Path, state: &RuntimeState) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("无法初始化模型下载: {error}"))?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("模型下载请求失败: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("模型下载失败 (HTTP {})。", response.status()));
        }
        let total = response.content_length();
        let part_path = dest.with_extension(format!("onnx{MODEL_PART_SUFFIX}"));
        let mut file = fs::File::create(&part_path)
            .map_err(|error| format!("无法创建模型临时文件 {}: {error}", part_path.display()))?;
        let mut received: u64 = 0;
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("模型下载中断: {error}"))?
        {
            file.write_all(&chunk)
                .map_err(|error| format!("无法写入模型临时文件: {error}"))?;
            received += chunk.len() as u64;
            if let Ok(mut inner) = lock_queue(state) {
                inner.downloading = Some((received, total));
            }
        }
        file.flush()
            .map_err(|error| format!("无法写入模型临时文件: {error}"))?;
        drop(file);
        fs::rename(&part_path, dest)
            .map_err(|error| format!("无法保存模型文件: {error}"))?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// 推理会话（进程唯一）
// ---------------------------------------------------------------------------

fn shared_env() -> &'static ort::environment::Environment {
    static ENV: OnceLock<ort::environment::Environment> = OnceLock::new();
    ENV.get_or_init(|| {
        ort::environment::init()
            .with_name("zx-wallpaper-tagging")
            .build()
            .expect("ort 环境初始化应成功")
    })
}

fn shared_session() -> &'static Mutex<Option<ort::session::Session>> {
    static SESSION: OnceLock<Mutex<Option<ort::session::Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

fn acquire_session(
    model_path: &Path,
) -> Result<MutexGuard<'static, Option<ort::session::Session>>, String> {
    let mut guard = shared_session()
        .lock()
        .map_err(|_| "推理会话状态不可用。".to_string())?;
    if guard.is_none() {
        *guard = Some(build_session_impl(model_path)?);
    }
    Ok(guard)
}

fn build_session_impl(model_path: &Path) -> Result<ort::session::Session, String> {
    use ort::session::builder::GraphOptimizationLevel;

    let result: ort::Result<ort::session::Session> = (|| {
        Ok(ort::session::Session::builder(shared_env())?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(1)?
            .commit_from_file(model_path)?)
    })();
    result.map_err(|error| format!("无法加载视觉模型: {error}"))
}

// ---------------------------------------------------------------------------
// 推理：预处理 → 会话 → 十分类
// ---------------------------------------------------------------------------

fn classify_image(
    session: &mut ort::session::Session,
    image_path: &str,
) -> Result<(String, f32), String> {
    use ort::value::Tensor;

    let input = preprocess_image(Path::new(image_path))?;
    let text_rows = text_embed_rows()?;
    let tensor = Tensor::from_array((vec![1i64, 3, INPUT_SIZE as i64, INPUT_SIZE as i64], input))
        .map_err(|error| format!("无法构造输入张量: {error}"))?;
    let outputs = session
        .run(ort::inputs! {
            "pixel_values" => tensor,
        })
        .map_err(|error| format!("推理失败: {error}"))?;
    let (shape, embeds) = outputs["image_embeds"]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("无法读取推理输出: {error}"))?;
    if shape.to_vec() != vec![1i64, TEXT_EMBEDS_DIM_FEATURES as i64] {
        return Err(format!("推理输出形状异常: {shape:?}"));
    }
    classify_embedding(embeds, &text_rows).ok_or_else(|| "无法确定图片分类。".to_string())
}

/// CLIP 预处理：中心裁剪正方形 → 224×224 → RGB/255、mean/std 归一化 → CHW。
pub(crate) fn preprocess_image(path: &Path) -> Result<Vec<f32>, String> {
    let image = image::open(path).map_err(|error| format!("无法解码图片 {path:?}: {error}"))?;
    Ok(preprocess_dynamic_image(&image))
}

pub(crate) fn preprocess_dynamic_image(image: &image::DynamicImage) -> Vec<f32> {
    let (width, height) = image.dimensions();
    let side = width.min(height).max(1);
    let cropped = image.crop_imm((width - side) / 2, (height - side) / 2, side, side);
    let resized = cropped.resize_exact(INPUT_SIZE, INPUT_SIZE, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let mut data = Vec::with_capacity(3 * (INPUT_SIZE as usize) * (INPUT_SIZE as usize));
    for channel in 0..3 {
        for pixel in rgb.pixels() {
            data.push((f32::from(pixel[channel]) / 255.0 - CLIP_MEAN[channel]) / CLIP_STD[channel]);
        }
    }
    data
}

pub(crate) fn text_embed_rows() -> Result<Vec<Vec<f32>>, String> {
    parse_text_embeds(TEXT_EMBEDS_BIN)
}

/// 解析 text-embeds.bin（10×512 f32 LE）；行顺序 = UPX8_CATEGORIES 顺序。
pub(crate) fn parse_text_embeds(bytes: &[u8]) -> Result<Vec<Vec<f32>>, String> {
    let expected_values = TEXT_EMBEDS_DIM_CLASSES * TEXT_EMBEDS_DIM_FEATURES;
    if bytes.len() != expected_values * 4 {
        return Err(format!(
            "text-embeds.bin 大小异常: {} 字节（应为 {}）",
            bytes.len(),
            expected_values * 4
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| {
            f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        })
        .collect::<Vec<f32>>()
        .chunks(TEXT_EMBEDS_DIM_FEATURES)
        .map(<[f32]>::to_vec)
        .collect())
}

/// 图像嵌入 L2 归一化后与每类文本嵌入做点积，取余弦分数最高的一类。
/// 嵌入为零向量（无法描述内容）时返回 None。
pub(crate) fn classify_embedding(image_embeds: &[f32], text_rows: &[Vec<f32>]) -> Option<(String, f32)> {
    if l2_norm(image_embeds) <= f32::EPSILON {
        return None;
    }
    let scores = cosine_scores(image_embeds, text_rows);
    let best = argmax_index(&scores)?;
    UPX8_CATEGORIES
        .get(best)
        .map(|(key, _)| ((*key).to_string(), scores[best]))
}

pub(crate) fn cosine_scores(image_embeds: &[f32], text_rows: &[Vec<f32>]) -> Vec<f32> {
    let norm = l2_norm(image_embeds);
    if norm <= f32::EPSILON {
        return vec![0.0; text_rows.len()];
    }
    text_rows
        .iter()
        .map(|row| {
            row.iter()
                .zip(image_embeds)
                .map(|(a, b)| a * b)
                .sum::<f32>()
                / norm
        })
        .collect()
}

pub(crate) fn argmax_index(scores: &[f32]) -> Option<usize> {
    scores
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.total_cmp(b))
        .map(|(index, _)| index)
}

fn l2_norm(values: &[f32]) -> f32 {
    values.iter().map(|value| value * value).sum::<f32>().sqrt()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zx-wallpaper-tagging-{}-{label}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// 编译期可行性验证：ort Session builder API 签名正确（MSVC 工具链可编译链接），
    /// 且对不存在的模型路径返回错误而非 panic。
    #[test]
    fn session_builder_api_compiles_and_reports_missing_model() {
        let missing = std::env::temp_dir().join("zx-wallpaper-nonexistent-model.onnx");
        let result = build_session_impl(&missing);
        assert!(result.is_err(), "commit_from_file 对缺失文件应返回 Err");
    }

    /// 选型实测（需真实模型文件，环境变量提供路径；无文件时跳过）：
    /// 验证 int8 ONNX 能被 ort 加载，输入 [1,3,224,224] → 输出 [1,512]。
    ///
    /// 默认忽略：每次约 2-3 分钟。需要时显式执行
    /// `CLIP_TEST_MODEL=<path> cargo test -- --ignored loads_int8_vision_model_when_provided`
    #[test]
    #[ignore = "需真实 CLIP 模型，人工显式触发"]
    fn loads_int8_vision_model_when_provided() {
        let Ok(path) = std::env::var("CLIP_TEST_MODEL") else {
            eprintln!("跳过：未设置 CLIP_TEST_MODEL");
            return;
        };
        let path = std::path::PathBuf::from(path);
        if !path.exists() {
            eprintln!("跳过：模型文件不存在 {path:?}");
            return;
        }
        let session = build_session_impl(&path).expect("int8 视觉编码器应能被 ort 加载");
        eprintln!("inputs: {:?}", session.inputs());
        eprintln!("outputs: {:?}", session.outputs());
        assert_eq!(session.inputs().len(), 1);
        assert_eq!(session.outputs().len(), 1);
    }

    /// 选型实测（需真实模型文件，环境变量提供路径；无文件时跳过）：
    /// 纯色图跑一轮完整推理，验证输出形状 [1,512] 且数值有限。
    ///
    /// 默认忽略：每次约 2-3 分钟。需要时显式执行
    /// `CLIP_TEST_MODEL=<path> cargo test -- --ignored runs_int8_inference_when_provided`
    #[test]
    #[ignore = "需真实 CLIP 模型，人工显式触发"]
    fn runs_int8_inference_when_provided() {
        let Ok(path) = std::env::var("CLIP_TEST_MODEL") else {
            eprintln!("跳过：未设置 CLIP_TEST_MODEL");
            return;
        };
        let path = std::path::PathBuf::from(path);
        if !path.exists() {
            eprintln!("跳过：模型文件不存在 {path:?}");
            return;
        }
        use ort::value::Tensor;

        // CLIP 预处理：纯白图归一化后 (1-μ)/σ，逐通道填充。
        let mut data = Vec::with_capacity(3 * 224 * 224);
        for c in 0..3 {
            let v = (1.0 - CLIP_MEAN[c]) / CLIP_STD[c];
            data.extend(std::iter::repeat_n(v, 224 * 224));
        }
        let input = Tensor::from_array((vec![1i64, 3, 224, 224], data))
            .expect("输入张量构造应成功");
        let mut session =
            build_session_impl(&path).expect("int8 视觉编码器应能被 ort 加载");
        let outputs = session
            .run(ort::inputs! {
                "pixel_values" => input,
            })
            .expect("推理应成功");
        let (shape, embeds) = outputs["image_embeds"]
            .try_extract_tensor::<f32>()
            .expect("输出应可提取为 f32 张量");
        eprintln!("output shape: {shape:?}");
        assert_eq!(shape.to_vec(), vec![1i64, 512], "输出应为 [1,512]");
        assert!(embeds.iter().all(|v| v.is_finite()), "输出应全部有限");
    }

    #[test]
    fn sha256_verification_accepts_exact_content_and_rejects_mismatch() {
        let dir = unique_temp_dir("sha256");
        let file = dir.join("model.bin");
        fs::write(&file, b"zx-wallpaper").expect("write test file");

        let mut hasher = Sha256::new();
        hasher.update(b"zx-wallpaper");
        let correct = hex_encode(&hasher.finalize());
        assert!(verify_file_sha256(&file, &correct), "内容匹配应通过");
        assert!(
            verify_file_sha256(&file, &correct.to_ascii_uppercase()),
            "期望 hash 大小写不敏感"
        );
        assert!(!verify_file_sha256(&file, "deadbeef"), "错误 hash 应拒绝");
        assert!(
            !verify_file_sha256(&dir.join("missing.bin"), &correct),
            "缺失文件应拒绝"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn text_embeds_asset_contains_ten_normalized_rows() {
        let rows = text_embed_rows().expect("内置 text-embeds.bin 应可解析");
        assert_eq!(rows.len(), TEXT_EMBEDS_DIM_CLASSES);
        for row in &rows {
            assert_eq!(row.len(), TEXT_EMBEDS_DIM_FEATURES);
            let norm = l2_norm(row);
            assert!(
                (norm - 1.0).abs() < 1e-3,
                "每行应已 L2 归一化（实测 {norm}）"
            );
        }
    }

    #[test]
    fn parse_text_embeds_rejects_wrong_sized_payload() {
        assert!(parse_text_embeds(&[0u8; 16]).is_err());
        assert!(parse_text_embeds(&[0u8; TEXT_EMBEDS_DIM_CLASSES * TEXT_EMBEDS_DIM_FEATURES * 4]).is_ok());
    }

    #[test]
    fn preprocess_produces_clip_normalized_channel_data() {
        let dir = unique_temp_dir("preprocess");
        let path = dir.join("gradient.png");
        // 300×200 渐变图：非正方形，触发中心裁剪路径。
        let image =
            image::RgbImage::from_fn(300, 200, |x, y| image::Rgb([x as u8, y as u8, 128]));
        image
            .save_with_format(&path, image::ImageFormat::Png)
            .expect("save test image");

        let data = preprocess_image(&path).expect("preprocess should succeed");

        assert_eq!(data.len(), 3 * 224 * 224, "输出应为 [1,3,224,224] 展平");
        assert!(data.iter().all(|value| value.is_finite()));
        // (0-μ)/σ ≈ -1.79，(1-μ)/σ ≈ 2.15，留裕量断言范围。
        assert!(
            data.iter().all(|value| (-2.5..=2.5).contains(value)),
            "CLIP 归一化后取值应在 [-2.5, 2.5] 内"
        );
        // 红色通道首像素来自原图 (50, 0)（300×200 中心裁剪后左上角）：
        // R=50 → (50/255 − 0.481) / 0.2686 ≈ −1.06。
        assert!(
            (data[0] - (-1.062)).abs() < 0.05,
            "首像素归一化值应与手算一致: {}",
            data[0]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_embedding_picks_the_closest_text_row() {
        // 两行假嵌入即可验证打分与 argmax；类别名按 UPX8_CATEGORIES 顺序取。
        let rows = vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]];

        let scores = cosine_scores(&[0.8, 0.6, 0.0], &rows);
        assert_eq!(argmax_index(&scores), Some(0));

        let (key, confidence) = classify_embedding(&[0.0, 5.0, 0.0], &rows)
            .expect("应能选出类别");
        assert_eq!(key, "anime", "index 1 对应 UPX8_CATEGORIES 的动漫");
        assert!((confidence - 1.0).abs() < 1e-4, "同向单位向量余弦应为 1");

        let (key, _) = classify_embedding(&[3.0, 0.0, 0.0], &rows).expect("应能选出类别");
        assert_eq!(key, "nature", "index 0 对应 UPX8_CATEGORIES 的风景");
        assert!(classify_embedding(&[0.0, 0.0, 0.0], &rows).is_none(), "全零嵌入应无法分类");
    }
}
