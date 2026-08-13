use std::collections::HashSet;

use rand::seq::SliceRandom;

pub const RANDOM_ORDER: &str = "random";
pub const SEQUENTIAL_ORDER: &str = "sequential";

pub fn normalize_rotation_order(value: &str) -> &'static str {
    if value == SEQUENTIAL_ORDER {
        SEQUENTIAL_ORDER
    } else {
        RANDOM_ORDER
    }
}

pub fn refresh_rotation_queue(
    rotation_order: &str,
    existing: &[String],
    candidates: &[String],
    skipped: &[String],
    current_path: Option<&str>,
) -> Vec<String> {
    let eligible = eligible_paths(candidates, skipped, current_path);
    if normalize_rotation_order(rotation_order) == SEQUENTIAL_ORDER {
        return sequential_queue(eligible, current_path);
    }

    let eligible_keys: HashSet<_> = eligible.iter().map(|path| path_key(path)).collect();
    let mut seen = HashSet::new();
    let mut retained = existing
        .iter()
        .filter(|path| {
            let key = path_key(path);
            eligible_keys.contains(&key) && seen.insert(key)
        })
        .cloned()
        .collect::<Vec<_>>();

    let mut additions = eligible
        .into_iter()
        .filter(|path| seen.insert(path_key(path)))
        .collect::<Vec<_>>();
    additions.shuffle(&mut rand::rng());
    retained.extend(additions);
    retained
}

fn eligible_paths(candidates: &[String], skipped: &[String], current_path: Option<&str>) -> Vec<String> {
    let skipped_keys: HashSet<_> = skipped.iter().map(|path| path_key(path)).collect();
    let current_key = current_path.map(path_key);
    let mut seen = HashSet::new();

    candidates
        .iter()
        .filter(|path| {
            let key = path_key(path);
            !skipped_keys.contains(&key)
                && current_key.as_deref() != Some(key.as_str())
                && seen.insert(key)
        })
        .cloned()
        .collect()
}

fn sequential_queue(mut paths: Vec<String>, current_path: Option<&str>) -> Vec<String> {
    paths.sort_by_cached_key(|path| path_key(path));
    let Some(current_path) = current_path else {
        return paths;
    };
    let current_key = path_key(current_path);
    let split_index = paths
        .iter()
        .position(|path| path_key(path) > current_key)
        .unwrap_or(paths.len());
    paths.rotate_left(split_index);
    paths
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequential_queue_is_stable_and_wraps_after_the_current_path() {
        let queue = refresh_rotation_queue(
            SEQUENTIAL_ORDER,
            &[],
            &["C:\\wallpapers\\b.jpg".into(), "C:\\wallpapers\\a.jpg".into(), "C:\\wallpapers\\c.jpg".into()],
            &[],
            Some("C:\\wallpapers\\b.jpg"),
        );

        assert_eq!(queue, vec!["C:\\wallpapers\\c.jpg", "C:\\wallpapers\\a.jpg"]);
    }

    #[test]
    fn random_queue_keeps_the_active_round_without_duplicates() {
        let queue = refresh_rotation_queue(
            RANDOM_ORDER,
            &["b.jpg".into()],
            &["a.jpg".into(), "b.jpg".into(), "c.jpg".into()],
            &[],
            Some("a.jpg"),
        );

        assert_eq!(queue.len(), 2);
        assert_eq!(queue.first().unwrap(), "b.jpg");
        assert!(queue.contains(&"c.jpg".to_string()));
    }
}
