use super::{
    search_entry, validate_relative_path, ProjectFileEntry, ProjectFileListing,
    ProjectFileSearchResult, SEARCH_RESULT_LIMIT,
};

fn fuzzy_score(value: &str, query: &str) -> Option<usize> {
    let mut score = 0usize;
    let mut previous = None;
    let mut value_index = 0usize;
    for query_char in query.chars() {
        let mut matched = None;
        for (offset, value_char) in value[value_index..].char_indices() {
            if value_char == query_char {
                matched = Some(value_index + offset);
                break;
            }
        }
        let index = matched?;
        score += previous.map_or(index, |last| index.saturating_sub(last + 1));
        previous = Some(index);
        value_index = index + query_char.len_utf8();
    }
    Some(score)
}

pub(super) fn search_score(normalized_path: &str, query: &str) -> Option<usize> {
    let name = normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(normalized_path);
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    if name == query || stem == query {
        return Some(0);
    }
    if name.starts_with(query) {
        return Some(1_000 + name.len());
    }
    if let Some(index) = name.find(query) {
        return Some(2_000 + index * 10 + name.len());
    }
    if let Some(gaps) = fuzzy_score(name, query) {
        return Some(3_000 + gaps * 10 + name.len());
    }
    if let Some(index) = normalized_path.find(query) {
        return Some(4_000 + index * 10 + normalized_path.len());
    }
    fuzzy_score(normalized_path, query).map(|gaps| 5_000 + gaps * 10 + normalized_path.len())
}

/// Puts the recent files matching `query` first, ranked like the inventory, and drops their
/// duplicates from `found`. Their existence is not checked: opening a vanished one fails.
pub(super) fn with_recent_files(
    found: ProjectFileListing,
    query: &str,
    recent: &[String],
) -> ProjectFileSearchResult {
    let query = query.to_lowercase();
    let mut matches: Vec<_> = if query.is_empty() {
        Vec::new()
    } else {
        recent
            .iter()
            .enumerate()
            .filter(|(_, path)| validate_relative_path(path, false).is_ok())
            .filter_map(|(order, path)| {
                search_score(&path.to_lowercase(), &query).map(|score| (score, order, path))
            })
            .collect()
    };
    matches.sort_unstable();

    let mut entries: Vec<ProjectFileEntry> = Vec::new();
    for (_, _, path) in matches {
        if entries.len() == SEARCH_RESULT_LIMIT {
            break;
        }
        if !entries.iter().any(|entry| &entry.path == path) {
            entries.push(search_entry(path.clone()));
        }
    }
    let recent_count = entries.len();
    let mut truncated = found.truncated;
    for entry in found.entries {
        if entries[..recent_count]
            .iter()
            .any(|recent| recent.path == entry.path)
        {
            continue;
        }
        if entries.len() == SEARCH_RESULT_LIMIT {
            truncated = true;
            break;
        }
        entries.push(entry);
    }
    ProjectFileSearchResult {
        entries,
        truncated,
        recent_count,
    }
}
