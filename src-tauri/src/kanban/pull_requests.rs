use super::KanbanPullRequest;
use std::collections::HashSet;

const URL_END: [char; 9] = ['(', ')', '[', ']', '<', '>', '"', '\'', '`'];
const TRAILING_PUNCTUATION: [char; 6] = ['.', ',', ';', ':', '!', '?'];

/// Pull requests linked from `texts` in order, each listed once.
pub(super) fn text_pull_requests<'a>(
    texts: impl IntoIterator<Item = &'a str>,
) -> Vec<KanbanPullRequest> {
    extract_pull_requests(texts.into_iter().flat_map(urls))
}

fn urls(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || loop {
        let start = rest.find("http")?;
        let candidate = &rest[start..];
        let end = candidate
            .find(|letter: char| letter.is_whitespace() || URL_END.contains(&letter))
            .unwrap_or(candidate.len());
        rest = &candidate[end..];
        if candidate.starts_with("https://") || candidate.starts_with("http://") {
            return Some(candidate[..end].trim_end_matches(TRAILING_PUNCTUATION));
        }
    })
}

pub(crate) fn extract_pull_requests<'a>(
    urls: impl IntoIterator<Item = &'a str>,
) -> Vec<KanbanPullRequest> {
    let mut seen = HashSet::new();
    urls.into_iter()
        .filter_map(|url| {
            let (identity, number) = parse_pull_request(url)?;
            seen.insert(identity).then(|| KanbanPullRequest {
                number,
                url: url.to_string(),
            })
        })
        .collect()
}

/// Returns the canonical `host/path…/<number>` identity (host lowercased) and the PR/MR number.
fn parse_pull_request(url: &str) -> Option<(String, u64)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let location = rest.split(['?', '#']).next().unwrap_or_default();
    let mut parts = location.split('/');
    let host = parts.next().filter(|host| !host.is_empty())?;
    let segments = parts.collect::<Vec<_>>();

    let merge_requests_route = segments
        .windows(2)
        .position(|pair| pair == ["-", "merge_requests"]);
    let number_index = match (merge_requests_route, segments.as_slice()) {
        (Some(dash), _) if dash >= 2 && segments[..dash].iter().all(|s| !s.is_empty()) => dash + 2,
        (Some(_), _) => return None,
        (None, [owner, repo, "pull", ..]) if !owner.is_empty() && !repo.is_empty() => 3,
        (None, _) => return None,
    };

    let number = segments.get(number_index)?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let path_len = segments[..=number_index]
        .iter()
        .map(|segment| segment.len() + 1)
        .sum::<usize>();
    let mut identity = host.to_ascii_lowercase();
    identity.push_str(&rest[host.len()..host.len() + path_len]);
    Some((identity, number.parse().ok()?))
}

#[cfg(test)]
#[path = "pull_requests_tests.rs"]
mod tests;
