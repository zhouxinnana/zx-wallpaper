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

pub fn refresh_remaining_paths(
    remaining: &[String],
    candidates: &[String],
    skipped: &[String],
    current_path: Option<&str>,
) -> Vec<String> {
    let candidate_keys: HashSet<_> = candidates.iter().map(|path| path_key(path)).collect();
    let skipped_keys: HashSet<_> = skipped.iter().map(|path| path_key(path)).collect();
    let current_key = current_path.map(path_key);
    let mut seen = HashSet::new();

    remaining
        .iter()
        .chain(candidates)
        .filter(|path| {
            let key = path_key(path);
            candidate_keys.contains(&key)
                && !skipped_keys.contains(&key)
                && current_key.as_deref() != Some(key.as_str())
                && seen.insert(key)
        })
        .cloned()
        .collect()
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{is_supported_wallpaper, refresh_remaining_paths, take_next_path};
    use std::path::Path;

    #[test]
    fn refresh_discards_skipped_and_missing_paths_without_repeating_current_wallpaper() {
        let refreshed = refresh_remaining_paths(
            &["a.jpg".into(), "b.jpg".into(), "missing.jpg".into()],
            &["a.jpg".into(), "b.jpg".into(), "c.jpg".into()],
            &["b.jpg".into()],
            Some("a.jpg"),
        );

        assert_eq!(refreshed, vec!["c.jpg"]);
    }

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
