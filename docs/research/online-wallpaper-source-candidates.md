# Online Wallpaper Source Candidates

Research date: 2026-07-28

## Decision

Use **Wallhaven's public API** as the only default online source for the first implementation. It is a wallpaper-specific catalog, supports an unauthenticated SFW-only query, exposes resolution and original-image fields before downloading, and was reachable without login in this research.

Offer **NASA Image and Video Library** and **Wikimedia Commons Featured Pictures** later as opt-in themed sources, not as a generic wallpaper feed. Both expose public machine-readable listings and high-resolution static images, but need stricter provenance handling. Keep **Simple Desktops** on hold: it is technically simple to parse, but this research found no published usage terms that establish a reusable automated-download policy.

This recommendation is limited to publicly reachable URLs and normal HTTP/API use. It does not include logging in, solving challenges, evading rate limits, or bypassing access controls.

## Candidate Summary

| Source | Public, no-login access verified | Static high-resolution image path | Recommendation |
| --- | --- | --- | --- |
| [Wallhaven](https://wallhaven.cc/) | Yes, public API `GET` returned `200` without an API key | API returns original `path`, MIME type, width, height, and a wallpaper detail URL | Default V1 source, SFW-only |
| [NASA Image and Video Library](https://images.nasa.gov/) | Yes, public search and asset JSON returned `200` | Asset endpoint returns an `~orig` original file URL | Opt-in `Space` source |
| [Wikimedia Commons Featured Pictures](https://commons.wikimedia.org/wiki/Category:Featured_pictures_on_Wikimedia_Commons) | Yes, public MediaWiki API returned `200` | `imageinfo` returns original URL, MIME type, pixel dimensions, and description URL | Opt-in `Featured photography` source |
| [Simple Desktops](https://simpledesktops.com/browse/) | Yes, public browse page is server-rendered | Thumbnail URLs and individual detail-page URLs are present in page HTML | Hold pending source-policy confirmation |

## 1. Wallhaven: Default Source

### Source URLs

- API documentation: <https://wallhaven.cc/help/api>
- Default endpoint shape: <https://wallhaven.cc/api/v1/search?purity=100&atleast=1920x1080&ratios=16x9&sorting=random>
- Terms: <https://wallhaven.cc/terms>
- Robots policy: <https://wallhaven.cc/robots.txt>

### Evidence and technical fit

The official API documentation states that version 1 supports basic `GET` requests; an API key is only needed for account-specific settings and NSFW content. The default endpoint above returned JSON without a key during this research. Each result includes `id`, `url` (the attribution/detail page), `path` (original image URL), `dimension_x`, `dimension_y`, `file_type`, and `purity`.

The documented filters directly fit ZX Wallpaper's product rules: `purity=100` selects SFW content; `atleast=1920x1080` enforces the selected minimum; `ratios=16x9` limits to desktop-oriented images; and `sorting=random` returns a random result set. The API documentation specifies a limit of 45 requests per minute and explains that random results return a seed for pagination without repeats.

The public latest page itself shows desktop and 4K/8K resolutions, but it is a community-uploaded catalog. Its terms state that submitters retain their rights and the site can respond to copyright claims. Therefore ZX Wallpaper must record both `url` and `path`, show the source page in metadata, and treat removed/detail-image `404` responses as recoverable source failures rather than retrying aggressively.

### V1 adapter contract

1. Fetch the fixed API endpoint at the configured interval with a descriptive application `User-Agent` and a conservative per-source request budget well below 45 requests per minute.
2. Accept only `purity === "sfw"`, `image/jpeg` or `image/png`, and dimensions at least the user's configured threshold.
3. Download at most the existing per-source limit of 10 previously unseen `path` URLs per run.
4. Persist `sourceId`, detail `url`, final `path`, title/tags when supplied, download time, MIME type, and dimensions.
5. Do not parse its gallery HTML and do not attempt to access NSFW, account-specific, or rate-limited content.

## 2. NASA Image and Video Library: Opt-in Space Source

### Source URLs

- Library: <https://images.nasa.gov/>
- API reference linked by the library: <https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf>
- Search example: <https://images-api.nasa.gov/search?q=nebula&media_type=image&page_size=10>
- Asset example: <https://images-api.nasa.gov/asset/PIA17669>
- Media-use guidelines: <https://www.nasa.gov/nasa-brand-center/images-and-media/>

### Evidence and technical fit

The public search endpoint returned JSON without a key or login. Image search items include a `nasa_id`, title, media type, and thumbnail link. The public asset endpoint returned a list containing an original `~orig.jpg` URL for the tested asset. NASA's library page describes downloadable content in multiple sizes/resolutions and metadata for images.

NASA's media guidelines say NASA content is generally not subject to United States copyright and may be used for educational or informational purposes, but require NASA to be acknowledged as the source. They also state that some third-party images are marked as copyright protected and NASA's use does not grant reuse rights. This means the adapter must retain the item metadata and exclude items identified as third-party-restricted.

### Adapter constraints

1. Expose this as an opt-in `Space` source with a fixed query set, not as a replacement for a broad wallpaper catalog.
2. Query `media_type=image`; resolve each accepted `nasa_id` through `/asset/{nasa_id}` before download.
3. Accept only JPEG/PNG/WebP originals that meet the configured width and height threshold. Skip TIFFs, images with unknown dimensions, portrait-oriented results, and third-party-restricted metadata.
4. Persist the `nasa_id`, source item URL, asset URL, creator/credit, title, and download time so the application can display provenance.

## 3. Wikimedia Commons Featured Pictures: Opt-in Curated Photography

### Source URLs

- Featured Pictures category: <https://commons.wikimedia.org/wiki/Category:Featured_pictures_on_Wikimedia_Commons>
- Public API example: <https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category%3AFeatured_pictures_on_Wikimedia_Commons&gcmtype=file&gcmlimit=10&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json>
- Reuse guidance: <https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia>
- Robots policy: <https://commons.wikimedia.org/robots.txt>

### Evidence and technical fit

The public API request returned JSON without credentials. Sample records provided original file URLs, a file description URL, MIME type, and dimensions, including a `8032 x 5330` JPEG. This supports resolution filtering before downloads and gives a stable link for a user to inspect the source file.

Commons' reuse guidance says content may have different reuse requirements, such as creator attribution, a license link, and share-alike conditions. It also warns that the Foundation does not warrant the accuracy of the displayed copyright status. The crawler-oriented robots policy requests low-speed behavior and disallows generic crawling of `/w/`; therefore this adapter must use the documented API only, identify itself, use conservative request pacing, and avoid HTML gallery crawling.

### Adapter constraints

1. Make this opt-in, fixed to a curated Commons category or a small reviewed category allowlist.
2. Request `imageinfo` with `url`, `size`, `mime`, and `extmetadata`; accept only static JPEG/PNG/WebP files that pass the configured resolution and landscape filters.
3. Persist the original URL, description URL, author, license name/URL, attribution text, and download time. The UI should expose the description URL.
4. Skip records without usable license/attribution metadata; do not present this source as having one uniform license.

## 4. Simple Desktops: Technically Viable, Not Approved

### Source URLs

- Browse page: <https://simpledesktops.com/browse/>
- Example detail page: <https://simpledesktops.com/browse/desktops/2023/feb/23/raspberry-pi/>
- Robots policy: <https://simpledesktops.com/robots.txt>

### Evidence and reason to defer

The browse page is public, server-rendered, and lists individual wallpaper detail pages, creator names, and predictable static thumbnail URLs. It would be straightforward to traverse a small fixed set of browse pages and resolve the full image from each detail page.

However, the site has no published Terms page at `/terms/` (the URL returns the site's "not here" page), and its robots file contains only a generic content-signal preamble rather than a source-specific automated-download policy. Because the artwork is contributed by individual creators, do not make it an automatic built-in source until the operator confirms the intended programmatic-use and attribution rules.

## Explicit Exclusions for the First Implementation

- [Unsplash Terms](https://unsplash.com/terms) and [API Terms](https://unsplash.com/api-terms): do not scrape Unsplash HTML. Its supported API requires application credentials, which conflicts with the current no-user-key/no-shared-key decision.
- [Bing robots policy](https://www.bing.com/robots.txt): do not use `HPImageArchive.aspx` as a built-in endpoint when its robots policy disallows that path.
- Any login-gated page, CAPTCHA/challenge flow, or source that returns access-denied/rate-limit responses: stop that source run and surface a recoverable error. Do not add bypass behavior.

## Implementation Sequence

1. Implement the Wallhaven API adapter and the shared source metadata record.
2. Verify its scheduled run obeys the 10-image cap, URL deduplication, 1920x1080 default, 5 GB user-managed storage warning, and the application's existing static-image validation.
3. Add the NASA adapter behind an explicit opt-in toggle and verify its metadata/provenance display.
4. Add Commons only after the shared UI can show attribution and license links per image.

