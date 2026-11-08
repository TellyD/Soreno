use super::{
    filesystem_root, git_inventory, media::image_mime_type, read_local, remote_run, resolve_local,
    validate_relative_path, walk_local_files, wsl_filter_error, AgentProject, GitInventoryPath,
    ProjectFileError, GIT_FILTER_COMMAND,
};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    ops::{ControlFlow, Range},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

const LINE_LIMIT: usize = 1_000;
const PREVIEW_CONTEXT_CHARS: usize = 40;
const PREVIEW_CHAR_LIMIT: usize = 200;
const POSIX_INPUT_LIMIT: usize = 4 * 1024 * 1024;
const POSIX_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const WORKER_LIMIT: usize = 8;

static ACTIVE_SEARCHES: Mutex<Vec<(String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());

/// A newer search of the same project cancels this one; dropping the ticket unregisters it.
struct SearchTicket {
    cancelled: Arc<AtomicBool>,
}

impl SearchTicket {
    fn start(project_id: &str) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut active = ACTIVE_SEARCHES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((_, previous)) = active.iter_mut().find(|(id, _)| id == project_id) {
            previous.store(true, Ordering::Relaxed);
            *previous = Arc::clone(&cancelled);
        } else {
            active.push((project_id.to_owned(), Arc::clone(&cancelled)));
        }
        Self { cancelled }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

impl Drop for SearchTicket {
    fn drop(&mut self) {
        ACTIVE_SEARCHES
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|(_, flag)| !Arc::ptr_eq(flag, &self.cancelled));
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSearchLine {
    pub line: usize,
    pub preview: String,
    pub ranges: Vec<[usize; 2]>,
    pub selection: Option<[usize; 2]>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSearchFile {
    pub path: String,
    pub lines: Vec<ProjectTextSearchLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTextSearchResult {
    pub files: Vec<ProjectTextSearchFile>,
    pub line_count: usize,
    pub truncated: bool,
}

struct Matcher {
    regex: Regex,
}

impl Matcher {
    fn new(query: &str, options: ProjectTextSearchOptions) -> Result<Self, ProjectFileError> {
        if query.contains(['\n', '\r', '\0']) {
            return Err(invalid_query());
        }
        let pattern = if options.regex {
            Cow::Borrowed(query)
        } else {
            Cow::Owned(regex::escape(query))
        };
        // Half boundaries match `grep -w` without hiding later matches behind a rejected one.
        let pattern = if options.whole_word {
            Cow::Owned(format!(r"\b{{start-half}}(?:{pattern})\b{{end-half}}"))
        } else {
            pattern
        };
        // Multi-line + CRLF anchors keep the whole-file prefilter consistent with per-line matching.
        RegexBuilder::new(&pattern)
            .case_insensitive(!options.case_sensitive)
            .multi_line(true)
            .crlf(true)
            .build()
            .map(|regex| Self { regex })
            .map_err(|_| invalid_query())
    }

    fn find(&self, line: &str) -> Vec<Range<usize>> {
        self.regex
            .find_iter(line)
            .map(|found| found.range())
            .filter(|range| !range.is_empty())
            .collect()
    }
}

fn invalid_query() -> ProjectFileError {
    ProjectFileError::new("invalidQuery", "Expression régulière invalide.")
}

pub fn search_text(
    project: &AgentProject,
    query: &str,
    options: ProjectTextSearchOptions,
    refresh: bool,
) -> Result<ProjectTextSearchResult, ProjectFileError> {
    let ticket = SearchTicket::start(&project.id);
    if query.is_empty() {
        return Ok(limited(Vec::new(), false));
    }
    let matcher = Matcher::new(query, options)?;
    let inventory = git_inventory(project, refresh)?;
    let candidates = inventory
        .as_ref()
        .map(|(paths, truncated)| (sorted_inventory(paths), *truncated));
    match project.environment.kind.as_str() {
        "ssh" => search_posix(
            &project.path,
            query,
            options,
            &matcher,
            candidates,
            |script, input| {
                remote_run(
                    project,
                    script,
                    (!input.is_empty()).then_some(input),
                    POSIX_OUTPUT_LIMIT + 1,
                )
            },
        ),
        "wsl" => search_posix(
            &project.path,
            query,
            options,
            &matcher,
            candidates,
            |script, input| {
                crate::project_git::run_wsl_readonly(project, script, input)
                    .map_err(wsl_filter_error)
            },
        ),
        _ => search_local_text(project, candidates, &matcher, &ticket),
    }
}

fn sorted_inventory(paths: &[GitInventoryPath]) -> Vec<&str> {
    let mut sorted: Vec<_> = paths
        .iter()
        .filter(|path| image_mime_type(&path.original).is_none())
        .collect();
    sorted.sort_by(|left, right| {
        left.normalized
            .cmp(&right.normalized)
            .then_with(|| left.original.cmp(&right.original))
    });
    sorted
        .into_iter()
        .map(|path| path.original.as_str())
        .collect()
}

fn search_local_text(
    project: &AgentProject,
    inventory: Option<(Vec<&str>, bool)>,
    matcher: &Matcher,
    ticket: &SearchTicket,
) -> Result<ProjectTextSearchResult, ProjectFileError> {
    let root = resolve_local(&filesystem_root(project)?, "")?;
    let walked: Vec<String>;
    let (candidates, truncated) = match inventory {
        Some(inventory) => inventory,
        None => {
            let mut paths = Vec::new();
            let truncated = walk_local_files(root.clone(), |path| {
                if image_mime_type(&path).is_none() {
                    paths.push(path);
                }
                ControlFlow::Continue(())
            })?;
            paths.sort_by_cached_key(|path| (path.to_lowercase(), path.clone()));
            walked = paths;
            (walked.iter().map(String::as_str).collect(), truncated)
        }
    };

    let next = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let hits = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(WORKER_LIMIT)
        .min(candidates.len())
        .max(1);
    // Workers claim indices in order and stop only between files, so the searched files form a prefix.
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                while found.load(Ordering::Relaxed) <= LINE_LIMIT && !ticket.is_cancelled() {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = candidates.get(index) else {
                        break;
                    };
                    if let Some(file) = search_local_file(&root, path, matcher) {
                        found.fetch_add(file.lines.len(), Ordering::Relaxed);
                        hits.lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push((index, file));
                    }
                }
            });
        }
    });
    if ticket.is_cancelled() {
        return Err(ProjectFileError::new(
            "cancelled",
            "Recherche remplacée par une recherche plus récente.",
        ));
    }
    let mut hits = hits
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    hits.sort_unstable_by_key(|(index, _)| *index);
    Ok(limited(
        hits.into_iter().map(|(_, file)| file).collect(),
        truncated,
    ))
}

fn search_local_file(root: &Path, path: &str, matcher: &Matcher) -> Option<ProjectTextSearchFile> {
    let bytes = read_local(root, path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    if !matcher.regex.is_match(text) {
        return None;
    }
    let lines: Vec<_> = text
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let found = matcher.find(line);
            (!found.is_empty()).then(|| preview_line(index + 1, line, &found))
        })
        .take(LINE_LIMIT + 1)
        .collect();
    (!lines.is_empty()).then(|| ProjectTextSearchFile {
        path: path.to_owned(),
        lines,
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PosixSource {
    Inventory,
    Recursive,
}

fn search_posix(
    root: &str,
    query: &str,
    options: ProjectTextSearchOptions,
    matcher: &Matcher,
    inventory: Option<(Vec<&str>, bool)>,
    run: impl FnOnce(&str, &[u8]) -> Result<Vec<u8>, ProjectFileError>,
) -> Result<ProjectTextSearchResult, ProjectFileError> {
    let (source, input, truncated) = match inventory {
        Some((paths, _)) if paths.is_empty() => return Ok(limited(Vec::new(), false)),
        Some((paths, inventory_truncated)) => {
            let (input, complete) = posix_input(&paths);
            (
                PosixSource::Inventory,
                input,
                inventory_truncated || !complete,
            )
        }
        None => (PosixSource::Recursive, Vec::new(), false),
    };
    let output = run(&posix_script(root, query, options, source), &input)?;
    Ok(parse_posix_output(&output, matcher, truncated))
}

fn posix_input(paths: &[&str]) -> (Vec<u8>, bool) {
    let mut input = Vec::new();
    for path in paths {
        if input.len() + path.len() + 1 > POSIX_INPUT_LIMIT {
            return (input, false);
        }
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    (input, true)
}

fn posix_script(
    root: &str,
    query: &str,
    options: ProjectTextSearchOptions,
    source: PosixSource,
) -> String {
    // `-D skip` keeps BSD `grep -r` from blocking on FIFOs.
    let mut flags = String::from("-I -D skip -n -H --null");
    if !options.case_sensitive {
        flags.push_str(" -i");
    }
    if options.whole_word {
        flags.push_str(" -w");
    }
    flags.push_str(if options.regex { " -E" } else { " -F" });
    let search = match source {
        // Cached inventories may predate a link swap, so links are filtered at search time.
        PosixSource::Inventory => {
            format!("{GIT_FILTER_COMMAND} | xargs -0 grep {flags} -e \"$query\" -- /dev/null")
        }
        PosixSource::Recursive => {
            format!("grep -r {flags} --exclude-dir=.git -e \"$query\" .")
        }
    };
    // One byte past the cap tells the parser that `head -c` cut the output.
    format!(
        "set -eu; root={}; query={}; [ -d \"$root\" ] || {{ printf 'SORENO_FILE_NOT_DIRECTORY\\n' >&2; exit 43; }}; cd -P \"$root\"; root=.; {{ {search}; }} 2>/dev/null | head -n {} | head -c {}",
        crate::ssh::quote(root),
        crate::ssh::quote(query),
        LINE_LIMIT + 1,
        POSIX_OUTPUT_LIMIT + 1,
    )
}

fn parse_posix_output(
    output: &[u8],
    matcher: &Matcher,
    mut truncated: bool,
) -> ProjectTextSearchResult {
    let mut rest = output;
    if rest.len() > POSIX_OUTPUT_LIMIT {
        rest = &rest[..POSIX_OUTPUT_LIMIT];
        truncated = true;
    }
    // `head -n` counts raw newlines, including those inside paths, so it may have cut a record.
    if rest.iter().filter(|byte| **byte == b'\n').count() > LINE_LIMIT {
        truncated = true;
    }

    let mut files: Vec<ProjectTextSearchFile> = Vec::new();
    let mut records = 0;
    while !rest.is_empty() {
        // Records are `path\0line:text\n`; paths may themselves contain newlines.
        let Some(separator) = rest.iter().position(|byte| *byte == 0) else {
            truncated = true;
            break;
        };
        let path = &rest[..separator];
        let body = &rest[separator + 1..];
        let Some(end) = body.iter().position(|byte| *byte == b'\n') else {
            truncated = true;
            break;
        };
        rest = &body[end + 1..];
        let body = &body[..end];
        if records == LINE_LIMIT {
            truncated = true;
            break;
        }
        records += 1;

        let Ok(path) = std::str::from_utf8(path) else {
            continue;
        };
        let path = path.strip_prefix("./").unwrap_or(path);
        if validate_relative_path(path, false).is_err() || image_mime_type(path).is_some() {
            continue;
        }
        let Some(colon) = body.iter().position(|byte| *byte == b':') else {
            continue;
        };
        let Some(number) = std::str::from_utf8(&body[..colon])
            .ok()
            .and_then(|number| number.parse::<usize>().ok())
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&body[colon + 1..]);
        let text = text.strip_suffix('\r').unwrap_or(&text);
        // grep decided the match; local highlighting may differ slightly for ERE-specific syntax.
        let line = preview_line(number, text, &matcher.find(text));
        match files.last_mut() {
            Some(file) if file.path == path => file.lines.push(line),
            _ => files.push(ProjectTextSearchFile {
                path: path.to_owned(),
                lines: vec![line],
            }),
        }
    }
    limited(files, truncated)
}

fn limited(files: Vec<ProjectTextSearchFile>, mut truncated: bool) -> ProjectTextSearchResult {
    let mut kept = Vec::new();
    let mut line_count = 0;
    for mut file in files {
        let remaining = LINE_LIMIT - line_count;
        if remaining == 0 {
            truncated = true;
            break;
        }
        if file.lines.len() > remaining {
            file.lines.truncate(remaining);
            truncated = true;
        }
        line_count += file.lines.len();
        kept.push(file);
    }
    ProjectTextSearchResult {
        files: kept,
        line_count,
        truncated,
    }
}

fn chars_before(text: &str, position: usize, count: usize) -> usize {
    text[..position]
        .char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(0, |(index, _)| index)
}

fn chars_after(text: &str, position: usize, count: usize) -> usize {
    text[position..]
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(index, _)| position + index)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `found` must be ascending and non-overlapping; offsets sent to the UI are UTF-16 code units.
fn preview_line(number: usize, line: &str, found: &[Range<usize>]) -> ProjectTextSearchLine {
    let content_start = line.len() - line.trim_start().len();
    let content_end = line.trim_end().len().max(content_start);
    let first = found.first();
    let anchor = first.map_or(content_start, |range| range.start);
    let start = if anchor < content_start {
        anchor
    } else {
        content_start.max(chars_before(line, anchor, PREVIEW_CONTEXT_CHARS))
    };
    let end_limit = content_end.max(first.map_or(0, |range| range.end));
    let end = chars_after(line, start, PREVIEW_CHAR_LIMIT).min(end_limit);
    let prefix = if start > content_start { "…" } else { "" };
    let suffix = if end < content_end { "…" } else { "" };
    let offset = utf16_len(prefix);

    let mut ranges = Vec::new();
    let mut cursor = (start, offset);
    for range in found {
        let (from, to) = (range.start.max(start), range.end.min(end));
        if range.start >= end {
            break;
        }
        if from >= to {
            continue;
        }
        let from_units = cursor.1 + utf16_len(&line[cursor.0..from]);
        let to_units = from_units + utf16_len(&line[from..to]);
        ranges.push([from_units, to_units]);
        cursor = (to, to_units);
    }

    ProjectTextSearchLine {
        line: number,
        preview: format!("{prefix}{}{suffix}", &line[start..end]),
        ranges,
        selection: first.map(|range| {
            let from = utf16_len(&line[..range.start]);
            [from, from + utf16_len(&line[range.clone()])]
        }),
    }
}

#[cfg(test)]
#[path = "text_search_tests.rs"]
mod tests;
