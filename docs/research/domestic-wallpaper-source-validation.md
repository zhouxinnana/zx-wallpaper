# Domestic Wallpaper Source Validation

Research date: 2026-07-28

## Scope and test method

This note validates the domestic URLs proposed for ZX Wallpaper. Every result below came from a direct Node `fetch` request using the same certificate validation, redirect following, and normal HTTP behaviour used by Electron/Node. A page rendering in a browser, an insecure-TLS request, or a JSON catalog whose image host cannot be downloaded is **not** counted as an end-to-end success.

For each passing source, the probe fetched a real candidate image and read its image header to verify dimensions. Tests used a descriptive normal `User-Agent`; no login, CAPTCHA solving, certificate bypass, proxy, or access-control workaround was used.

## Decision

Implement dedicated adapters, rather than the existing generic HTML image-tag parser, for these four API sources. The Bing domestic mirror homepage is also usable through the existing one-page HTML adapter:

| Source | Verified request and result | Adapter decision |
| --- | --- | --- |
| [wp.upx8](https://wp.upx8.com/api.php) | JSON endpoint and the returned JPEG completed; samples included `1920x1080` and `3840x2160` | Include |
| [远方风景](https://tu.ltyuanfang.cn/api/fengjing.php) | Redirected to a JPEG that downloaded as `8200x5962` | Include |
| [Bing Image Archive](https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN) | JSON contained eight images; generated UHD image downloaded as `3840x2160` | Include |
| [Wallhaven clbug mirror](https://wallhaven.clbug.com/api/v1/search?purity=100&atleast=1920x1080&ratios=16x9&sorting=random) | Search JSON and the mirror-hosted full image both completed as `1920x1080` | Include, with image-host rewrite |
| [Bing domestic mirror homepage](https://bing.ioliu.cn/) | Current homepage exposes three Bing image URLs that the packaged app downloaded as `1920x1080` | Include as a homepage-only static HTML source |

The remaining entries do not meet the required no-login, Electron-compatible, download-verified bar today. Do not present them as built-in usable sources unless they are revalidated.

## Verified adapters

### 1. wp.upx8.com: one random image per JSON call

- Endpoint: <https://wp.upx8.com/api.php?format=json&resolution=3840x2160>
- Response: `200 application/json`, shaped as `{"code":200,"message":"success","data":{"url":"http://...jpg","width":0,"height":0,"title":"","source":"birdpaper","resolution":"1920x1080"},"count":1}` in the probe.
- `data.url` is the only usable image field. The server-reported `width` and `height` are `0`, and the reported resolution can differ from the actual image. The downloader must validate the bytes after download.
- A normal request to <https://wp.upx8.com/api.php> followed a `302` to a public **HTTP** CDN JPEG. The application must deliberately allow a trusted HTTPS source to redirect to that HTTP image URL, or use the JSON response and apply the same controlled exception. The tested output images were JPEGs at `1920x1080` and `3840x2160`.
- `category=nature` and `category=anime` both returned `200`, but this test did not establish that the provider actually applies the category. Treat category as unsupported until the provider documents it or response content is independently verified.

Adapter contract: call `format=json`; take `data.url`; permit this source's redirect to the public CDN; then apply ZX Wallpaper's existing MIME, byte, dimension, landscape, deduplication, and storage checks. Do not trust API dimensions.

### 2. 远方风景: one random image per redirect

- Endpoint: <https://tu.ltyuanfang.cn/api/fengjing.php>
- A direct request returned `302` to `https://tbz.ltyuanfang.cn/fj/...jpg`; following it returned `200 image/jpeg`.
- The downloaded sample was `3,571,758` bytes and `8200x5962`, which satisfies desktop landscape and high-resolution validation.

Adapter contract: issue one request per run, follow the redirect, and validate the final image locally. This endpoint has no listing, stable ID, or source-provided dimensions, so download-URL deduplication and post-download checks are mandatory.

### 3. Bing official archive: eight-item JSON collection

- Endpoint: <https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN>
- The direct request returned `200 application/json` with an `images` array of eight items.
- For each item, construct the full image URL as `https://cn.bing.com` + `urlbase` + `_UHD.jpg`. A tested result was <https://cn.bing.com/th?id=OHR.AdorableOwlet_ZH-CN6929234033_UHD.jpg>, which downloaded as `200 image/jpeg`, `3840x2160`.

Adapter contract: iterate the response `images`, retain the title/copyright/detail metadata that Bing supplies, generate the UHD URL from `urlbase`, then validate each downloaded image. The collection is small and repeatable, so URL deduplication determines whether a scheduled run has new work.

### 4. wallhaven.clbug.com: API catalog plus mirror image host

- Catalog: <https://wallhaven.clbug.com/api/v1/search?purity=100&atleast=1920x1080&ratios=16x9&sorting=random>
- The direct request returned `200 application/json`, with Wallhaven-compatible `data` and `meta` fields. A returned record included `purity`, `dimension_x`, `dimension_y`, `file_type`, `url`, and `path`.
- The API's tested `path` was `https://w.wallhaven.cc/full/ym/wallhaven-ymr5mg.jpg`, which is not the mirror image domain. The matching mirror page at <https://wallhaven.clbug.com/w/ymr5mg> exposes the actual mirror image URL `https://w.wallhaven.clbug.com/full/ym/wallhaven-ymr5mg.jpg` in `img#wallpaper`.
- Downloading that rewritten mirror URL returned `200 image/jpeg`, `727,631` bytes, and `1920x1080`. The same record's thumbnail domain `th.wallhaven.clbug.com` served only `432x243`/`300x169` thumbnails, not wallpapers.

Adapter contract: fetch only SFW results; require the selected dimensions and a static allowed MIME type; rewrite an API `path` whose host is exactly `w.wallhaven.cc` to `w.wallhaven.clbug.com` while retaining its pathname; validate the final bytes. Do not use thumbnail fields. The service exposes pagination metadata and a random `seed`, but this test did not establish a published request quota, so use the product's conservative per-source pacing and existing 10-download cap.

## Bing domestic mirror scope

### bing.ioliu.cn

- Homepage: <https://bing.ioliu.cn/>
- A sampled detail page, <https://bing.ioliu.cn/wallpapers/w2e6va8huu5lml>, returned `200` server-rendered HTML. Its Svelte hydration data contained `imageUrl` set to `https://cn.bing.com/th?id=OHR.AdorableOwlet_ZH-CN6929234033_1920x1200.jpg`; that image downloaded successfully as `1920x1200` JPEG.
- Detail pages are not suitable for the generic parser because their full URL is embedded in framework hydration data. The homepage currently includes three standard image candidates pointing to Bing 1920px files; the packaged ZX Wallpaper app downloaded one of those candidates successfully during end-to-end verification.

Adapter contract: only use the homepage as a one-page static source. Do not crawl detail pages or parse Svelte hydration data. The official Bing JSON adapter remains the preferred comprehensive source.

## Rejected or not currently verified

### 3G壁纸

- Site: <https://www.3gbizhi.com/>
- Direct Node requests to the homepage through `https://www.3gbizhi.com/`, `http://www.3gbizhi.com/`, and `/pc/` each returned `500 text/html` (5,156 bytes), including with a normal Chrome browser `User-Agent`.

No list or detail page could be retrieved in the test environment, so no real image URL or dimensions could be verified. Exclude it for now.

### 彼岸图网（pic.netbian.com）

- Homepage: <https://pic.netbian.com/>
- Detail sample: <https://pic.netbian.com/tupian/43562.html>
- The list and detail HTML are reachable, but the displayed `src`/`data-pic` images are only `850x478` and `450x287` in the tested record. More importantly, its own shipped [common script](https://pic.netbian.com/static/js/common.js) requests `GET /e/extend/netbiandownload.php?id=<id>` to obtain the declared original.
- Calling that download endpoint for the public detail page with no login returned `200 {"msg":0}`. The page's script handles `msg == 0` by opening the login flow. This is explicit evidence that original-image downloading is login-gated. Its declared original image also returns `403` without a same-site `Referer` header.

Do not add it: the required original is not available without login, and using thumbnail URLs would violate the product's resolution rule.

### 轻壁纸（qinggongju.com）

- Site: <https://bz.qinggongju.com/>
- Direct Node/Electron-compatible HTTPS fetch fails before an HTTP response with `DEPTH_ZERO_SELF_SIGNED_CERT`.

Do not weaken TLS (`rejectUnauthorized: false`) to support a wallpaper source. It is not usable by ZX Wallpaper until the site serves a publicly trusted certificate.

### 小歪动漫与风景接口

- Anime: <https://api.ixiaowai.cn/api/api.php>
- Scenery: <https://api.ixiaowai.cn/gqapi/gqapi.php>
- Both names failed DNS resolution (`ENOTFOUND`) from the test machine. No HTTP response or image was available to validate.

Exclude them from the built-in list today. A later revalidation must first establish normal DNS and a successful end-to-end image download.

### wallhaven.icu

- Site: <https://wallhaven.icu/>
- Its claimed Wallhaven-compatible API path, <https://wallhaven.icu/api/v1/search?purity=100&atleast=1920x1080&ratios=16x9&sorting=random>, returned `404`, and a nominal `/w/<id>` detail path also returned `404`.
- The homepage instead points at `/homepics/<id>.png` files. Two sampled files downloaded as `432x243` PNG; another advertised `/wall/...png` file was only `32x29`. These are thumbnails/assets, not wallpaper originals.

It is not a usable Wallhaven mirror for the required adapter and should not be added.

### Pexels and Pixabay

- [Pexels API documentation](https://www.pexels.com/api/documentation/#authorization) states that every API request requires an `Authorization` API key. A direct unauthenticated probe returned JSON in this environment, but that response contradicts the documented contract and is not a stable or permitted basis for a no-key product integration.
- [Pixabay API documentation](https://pixabay.com/api/docs/#api_search_images) marks the `key` parameter as required. A direct request without it returned `400 Invalid or missing API key`.

ZX Wallpaper does not collect or store user API credentials, so neither service belongs in the built-in no-key source list.

## What this does not prove

These are point-in-time direct reachability and download tests, not a promise of unlimited availability, a copyright license audit, or a provider-approved bulk-download policy. The product should preserve source/detail URLs, keep its conservative pace and per-run cap, treat failures as recoverable, and revalidate a source before presenting it as a permanent default.
