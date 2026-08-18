use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    time::Duration as StdDuration,
};

use image::GenericImageView;
use reqwest::{
    header::{CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
    Client, Response, Url,
};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use tokio::net::lookup_host;
use uuid::Uuid;

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

#[cfg(test)]
mod tests {
    use super::{
        is_public_host, is_upx8_cdn_url, upx8_category_label, upx8_request_url, UPX8_CATEGORIES,
    };

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
}
