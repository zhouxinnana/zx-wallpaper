use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

use image::GenericImageView;
use reqwest::{
    header::{CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
    Client, Response, Url,
};
use scraper::{Html, Selector};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use tokio::net::lookup_host;
use uuid::Uuid;

const MAX_REDIRECTS: usize = 5;
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_CANDIDATES: usize = 24;

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
    pub label: String,
    pub discovered: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SourceFetchResult {
    pub candidates: Vec<Candidate>,
    pub categories: Vec<CategoryResult>,
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

pub async fn fetch_candidates(value: &str) -> Result<Vec<Candidate>, String> {
    let requested = validate_public_https_url(value).await?;
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化网络请求: {error}"))?;
    let (page_url, response) = request_with_checked_redirects(&client, requested, false).await?;
    if !response.status().is_success() {
        return Err(format!("来源请求失败 ({})。", response.status()));
    }

    let content_type = response_content_type(&response);
    if content_type.starts_with("image/") {
        return Ok(vec![Candidate {
            image_url: page_url.to_string(),
            source_page_url: page_url.to_string(),
            category_key: None,
            allow_upx8_cdn_http: false,
        }]);
    }
    if !content_type.starts_with("text/html") {
        return Err("来源必须是图片地址或包含图片的 HTML 页面。".to_string());
    }

    let html = response
        .text()
        .await
        .map_err(|error| format!("无法读取来源页面: {error}"))?;
    let selector = Selector::parse("img").map_err(|_| "无法解析来源页面。".to_string())?;
    let document = Html::parse_document(&html);
    let mut urls = HashSet::new();
    let mut candidates = Vec::new();

    for image in document.select(&selector) {
        let source = image
            .value()
            .attr("srcset")
            .and_then(|srcset| srcset.split(',').last())
            .and_then(|entry| entry.split_whitespace().next())
            .or_else(|| image.value().attr("src"));
        let Some(source) = source else {
            continue;
        };
        let Ok(image_url) = page_url.join(source) else {
            continue;
        };
        if image_url.scheme() != "https"
            || !is_public_host(image_url.host_str().unwrap_or_default())
        {
            continue;
        }
        let image_url = image_url.to_string();
        if urls.insert(image_url.clone()) {
            candidates.push(Candidate {
                image_url,
                source_page_url: page_url.to_string(),
                category_key: None,
                allow_upx8_cdn_http: false,
            });
        }
        if candidates.len() >= MAX_CANDIDATES {
            break;
        }
    }

    if candidates.is_empty() {
        return Err("来源页面中没有可下载的公开 HTTPS 图片。".to_string());
    }
    Ok(candidates)
}

pub async fn fetch_source_candidates(
    source_id: &str,
    value: &str,
    minimum: u16,
) -> Result<SourceFetchResult, String> {
    if source_id == "upx8-4k" {
        return fetch_upx8(value, minimum).await;
    }
    if source_id == "bing-cn-4k" {
        return fetch_bing_archive(value).await;
    }
    Ok(SourceFetchResult {
        candidates: fetch_candidates(value).await?,
        categories: Vec::new(),
    })
}

async fn fetch_bing_archive(value: &str) -> Result<SourceFetchResult, String> {
    let requested = validate_public_https_url(value).await?;
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化网络请求: {error}"))?;
    let (page_url, response) = request_with_checked_redirects(&client, requested, false).await?;
    if !response.status().is_success() {
        return Err(format!("必应请求失败 ({})。", response.status()));
    }
    let payload: serde_json::Value = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|error| format!("无法读取必应响应: {error}"))?,
    )
    .map_err(|error| format!("无法解析必应响应: {error}"))?;
    let candidates = payload
        .get("images")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|image| image.get("urlbase").and_then(|value| value.as_str()))
        .map(|base| Candidate {
            image_url: format!("https://cn.bing.com{base}_UHD.jpg&rf=LaDigue_UHD.jpg&pid=hp"),
            source_page_url: page_url.to_string(),
            category_key: None,
            allow_upx8_cdn_http: false,
        })
        .collect();
    Ok(SourceFetchResult {
        candidates,
        categories: Vec::new(),
    })
}

const UPX8_CATEGORIES: [(&str, &str); 10] = [
    ("fengjing", "风景"),
    ("dongman", "动漫"),
    ("youxi", "游戏"),
    ("dongwu", "动物"),
    ("chengshi", "城市"),
    ("chouxiang", "抽象"),
    ("yuzhou", "宇宙"),
    ("qiche", "汽车"),
    ("meinv", "美女"),
    ("yundong", "运动"),
];

async fn fetch_upx8(value: &str, minimum: u16) -> Result<SourceFetchResult, String> {
    validate_public_https_url(value).await?;
    let mut result = SourceFetchResult::default();
    for (key, label) in UPX8_CATEGORIES {
        match fetch_upx8_category(value, key, minimum).await {
            Ok(candidates) => {
                result.categories.push(CategoryResult {
                    key: key.into(),
                    label: label.into(),
                    discovered: candidates.len(),
                    error: None,
                });
                result.candidates.extend(candidates);
            }
            Err(error) => result.categories.push(CategoryResult {
                key: key.into(),
                label: label.into(),
                discovered: 0,
                error: Some(error),
            }),
        }
    }
    Ok(result)
}

async fn fetch_upx8_category(
    value: &str,
    key: &str,
    minimum: u16,
) -> Result<Vec<Candidate>, String> {
    let mut url = validate_public_https_url(value).await?;
    {
        let mut query = url.query_pairs_mut();
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
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化网络请求: {error}"))?;
    let (page_url, response) = request_with_checked_redirects(&client, url, false).await?;
    if !response.status().is_success() {
        return Err(format!("UPX8 请求失败 ({})。", response.status()));
    }
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
    Ok(items
        .into_iter()
        .filter_map(|item| {
            item.get("url")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|url| url.starts_with("https://") || is_upx8_cdn_url(url))
        .map(|image_url| Candidate {
            allow_upx8_cdn_http: is_upx8_cdn_url(&image_url),
            image_url,
            source_page_url: page_url.to_string(),
            category_key: Some(key.to_string()),
        })
        .collect())
}

pub async fn download_candidate(
    candidate: Candidate,
    directory: &Path,
    minimum_resolution: u16,
) -> Result<DownloadedImage, String> {
    let requested =
        validate_public_download_url(&candidate.image_url, candidate.allow_upx8_cdn_http).await?;
    let client = Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化图片下载: {error}"))?;
    let (_, response) =
        request_with_checked_redirects(&client, requested, candidate.allow_upx8_cdn_http).await?;
    if !response.status().is_success() {
        return Err(format!("图片下载失败 ({})。", response.status()));
    }

    let mime_type = response_content_type(&response);
    if !mime_type.starts_with("image/") {
        return Err("下载内容不是图片。".to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES)
    {
        return Err("图片超过 25 MB 下载限制。".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取图片内容: {error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 25 MB 下载限制。".to_string());
    }
    let decoded = image::load_from_memory(&bytes)
        .map_err(|_| "下载内容不是受支持的图片格式。".to_string())?;
    let (width, height) = decoded.dimensions();
    if width.max(height) < u32::from(minimum_resolution) {
        return Err(format!("图片分辨率低于 {minimum_resolution}px。"));
    }

    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("无法创建在线壁纸目录: {error}"))?;
    let extension = extension_for_mime(&mime_type);
    let local_path = directory.join(format!("{}.{}", Uuid::new_v4(), extension));
    tokio::fs::write(&local_path, &bytes)
        .await
        .map_err(|error| format!("无法保存下载的图片: {error}"))?;

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
        && url.host_str() == Some("cdn-hsyq-static.shanhutech.cn")
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
    use super::{is_public_host, is_upx8_cdn_url, UPX8_CATEGORIES};

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
                "fengjing",
                "dongman",
                "youxi",
                "dongwu",
                "chengshi",
                "chouxiang",
                "yuzhou",
                "qiche",
                "meinv",
                "yundong"
            ]
        );
    }

    #[test]
    fn accepts_only_the_known_upx8_http_image_cdn() {
        assert!(is_upx8_cdn_url(
            "http://cdn-hsyq-static.shanhutech.cn/bizhi/staticwp/2026/08/wallpaper.jpg"
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
}
