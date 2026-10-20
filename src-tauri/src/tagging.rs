//! 本地 AI 打标（Phase 4）。
//!
//! 架构（design.md 4.1）：只跑 CLIP ViT-B/32 图像编码器（int8 量化 ONNX），
//! 文本侧十分类嵌入离线预计算为 `text-embeds.bin`（10×512 f32，L2 归一化），
//! 运行时零 tokenizer 依赖、零文本推理。模型首次启用时下载（固定 URL + SHA-256 校验），
//! 缓存于 app config dir，不打包进安装包。
//!
//! 本文件当前为 Phase 4a 选型验证骨架：仅钉死模型常量与最小 ort API 验证，
//! 下载/校验/打标队列由 Phase 4b 实现。
#![allow(dead_code)]

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
/// 由离线脚本生成（Python + onnxruntime + tokenizers），随模型一起分发。
pub const TEXT_EMBEDS_DIM_CLASSES: usize = 10;
pub const TEXT_EMBEDS_DIM_FEATURES: usize = 512;

/// 构建图像编码器推理会话（CPU execution provider，单线程，避免抢占 UI）。
/// Phase 4b 由打标队列调用；当前供选型验证测试使用。
#[cfg(test)]
fn shared_env() -> &'static ort::environment::Environment {
    use std::sync::OnceLock;
    static ENV: OnceLock<ort::environment::Environment> = OnceLock::new();
    ENV.get_or_init(|| {
        ort::environment::init()
            .with_name("zx-wallpaper-tagging")
            .build()
            .expect("ort 环境初始化应成功")
    })
}

#[cfg(test)]
pub(crate) fn build_test_session(
    model_path: &std::path::Path,
) -> ort::Result<ort::session::Session> {
    use ort::session::builder::GraphOptimizationLevel;

    ort::session::Session::builder(shared_env())?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(1)?
        .commit_from_file(model_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编译期可行性验证：ort Session builder API 签名正确（MSVC 工具链可编译链接），
    /// 且对不存在的模型路径返回错误而非 panic。
    #[test]
    fn session_builder_api_compiles_and_reports_missing_model() {
        let missing = std::env::temp_dir().join("zx-wallpaper-nonexistent-model.onnx");
        let result = build_test_session(&missing);
        assert!(result.is_err(), "commit_from_file 对缺失文件应返回 Err");
    }

    /// 选型实测（需真实模型文件，环境变量提供路径；无文件时跳过）：
    /// 验证 int8 ONNX 能被 ort 加载，输入 [1,3,224,224] → 输出 [1,512]。
    #[test]
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
        let session = build_test_session(&path).expect("int8 视觉编码器应能被 ort 加载");
        eprintln!("inputs: {:?}", session.inputs());
        eprintln!("outputs: {:?}", session.outputs());
        assert_eq!(session.inputs().len(), 1);
        assert_eq!(session.outputs().len(), 1);
    }

    /// 选型实测（需真实模型文件，环境变量提供路径；无文件时跳过）：
    /// 纯色图跑一轮完整推理，验证输出形状 [1,512] 且数值有限。
    #[test]
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
        let mean = [0.481_454_66f32, 0.457_827_5, 0.408_210_73];
        let std = [0.268_629_54f32, 0.261_302_58, 0.275_777_11];
        let mut data = Vec::with_capacity(3 * 224 * 224);
        for c in 0..3 {
            let v = (1.0 - mean[c]) / std[c];
            data.extend(std::iter::repeat_n(v, 224 * 224));
        }
        let input = Tensor::from_array((vec![1i64, 3, 224, 224], data))
            .expect("输入张量构造应成功");
        let mut session =
            build_test_session(&path).expect("int8 视觉编码器应能被 ort 加载");
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
}
