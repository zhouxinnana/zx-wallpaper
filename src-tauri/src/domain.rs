use std::{collections::HashSet, path::Path};

pub fn is_supported_wallpaper(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "bmp" | "webp")
    )
}

pub fn take_next_path(
    remaining: &[String],
    skipped: &[String],
    current_path: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let skipped_keys: HashSet<_> = skipped.iter().map(|path| path_key(path)).collect();
    let current_key = current_path.map(path_key);
    let mut candidates = remaining.iter().filter(|path| {
        let key = path_key(path);
        !skipped_keys.contains(&key) && current_key.as_deref() != Some(key.as_str())
    });
    let next_path = candidates.next()?.clone();
    let next_remaining = candidates.cloned().collect();

    Some((next_path, next_remaining))
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{is_supported_wallpaper, take_next_path};
    use std::path::Path;

    #[test]
    fn next_path_discards_skipped_and_current_entries_before_advancing_queue() {
        let next = take_next_path(
            &[
                "current.jpg".into(),
                "skipped.png".into(),
                "next.webp".into(),
            ],
            &["skipped.png".into()],
            Some("current.jpg"),
        );

        assert_eq!(next, Some(("next.webp".into(), vec![])));
    }

    #[test]
    fn only_supported_image_extensions_are_accepted() {
        assert!(is_supported_wallpaper(Path::new("wallpaper.JPEG")));
        assert!(is_supported_wallpaper(Path::new("wallpaper.webp")));
        assert!(!is_supported_wallpaper(Path::new("notes.txt")));
    }
}
