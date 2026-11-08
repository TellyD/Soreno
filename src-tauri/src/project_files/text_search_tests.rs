use super::*;
use crate::project_git::test_fixtures::local_project;
#[cfg(unix)]
use std::process::Stdio;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct TempProject(PathBuf);

impl TempProject {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "soreno-text-search-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn project(&self) -> AgentProject {
        local_project(
            &format!("text-search-{}", self.0.display()),
            "Project",
            &self.0,
        )
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let target = self.0.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }

    fn git_init(&self) -> bool {
        match Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&self.0)
            .status()
        {
            Ok(status) => status.success(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => panic!("git init failed: {error}"),
        }
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn options() -> ProjectTextSearchOptions {
    ProjectTextSearchOptions::default()
}

fn hits(result: &ProjectTextSearchResult) -> Vec<(String, usize)> {
    result
        .files
        .iter()
        .flat_map(|file| file.lines.iter().map(|line| (file.path.clone(), line.line)))
        .collect()
}

#[test]
fn searches_unignored_text_files_in_path_order() {
    let temp = TempProject::new();
    if !temp.git_init() {
        return;
    }
    temp.write(".gitignore", "dist/\n");
    temp.write("dist/bundle.js", "needle\n");
    temp.write("src/b.ts", "first\r\nNeedle here\r\nand needle\r\n");
    temp.write("README.md", "a needle\n");
    temp.write("binary.dat", b"needle\0needle");
    temp.write("logo.png", "needle");

    let result = search_text(&temp.project(), "needle", options(), true).unwrap();

    assert_eq!(
        hits(&result),
        [
            ("README.md".into(), 1),
            ("src/b.ts".into(), 2),
            ("src/b.ts".into(), 3)
        ]
    );
    assert_eq!(result.line_count, 3);
    assert!(!result.truncated);
    let line = &result.files[1].lines[0];
    assert_eq!(line.preview, "Needle here");
    assert_eq!(line.ranges, [[0, 6]]);
    assert_eq!(line.selection, Some([0, 6]));
}

#[test]
fn applies_case_whole_word_and_regex_options() {
    let temp = TempProject::new();
    temp.write("a.txt", "Item\nitem\nitems\nsub_item\nitem-2\n");
    temp.write("b.txt", "foobar\nxaa-aa-aa\n");
    let project = temp.project();
    let lines = |query: &str, options: ProjectTextSearchOptions| {
        hits(&search_text(&project, query, options, true).unwrap())
            .into_iter()
            .map(|(_, line)| line)
            .collect::<Vec<_>>()
    };

    assert_eq!(lines("item", options()), [1, 2, 3, 4, 5]);
    assert_eq!(
        lines(
            "item",
            ProjectTextSearchOptions {
                case_sensitive: true,
                ..options()
            }
        ),
        [2, 3, 4, 5]
    );
    assert_eq!(
        lines(
            "item",
            ProjectTextSearchOptions {
                whole_word: true,
                ..options()
            }
        ),
        [1, 2, 5]
    );
    assert_eq!(
        lines(
            "^item-?\\d*$",
            ProjectTextSearchOptions {
                regex: true,
                ..options()
            }
        ),
        [1, 2, 5]
    );
    let whole_word_regex = ProjectTextSearchOptions {
        whole_word: true,
        regex: true,
        ..options()
    };
    assert_eq!(lines("foo|foobar", whole_word_regex), [1]);
    assert_eq!(
        lines(
            "aa-aa",
            ProjectTextSearchOptions {
                whole_word: true,
                ..options()
            }
        ),
        [2]
    );
    let whole_word = ProjectTextSearchOptions {
        whole_word: true,
        ..options()
    };
    assert_eq!(
        Matcher::new("aa-aa", whole_word).unwrap().find("xaa-aa-aa"),
        [4..9]
    );
    assert_eq!(
        Matcher::new("foo|foobar", whole_word_regex)
            .unwrap()
            .find("foobar"),
        [0..6]
    );
    assert_eq!(lines("item.", options()), Vec::<usize>::new());
    assert_eq!(
        search_text(
            &project,
            "item(",
            ProjectTextSearchOptions {
                regex: true,
                ..options()
            },
            true
        )
        .unwrap_err()
        .code,
        "invalidQuery"
    );
}

#[test]
fn walks_non_git_projects_without_git_metadata_or_links() {
    let temp = TempProject::new();
    temp.write(".git/config", "needle");
    temp.write("z/deep.txt", "needle");
    temp.write("a.txt", "needle");
    #[cfg(unix)]
    std::os::unix::fs::symlink(temp.0.join("a.txt"), temp.0.join("link.txt")).unwrap();

    let result = search_text(&temp.project(), "needle", options(), false).unwrap();

    assert_eq!(
        hits(&result),
        [("a.txt".into(), 1), ("z/deep.txt".into(), 1)]
    );
}

#[test]
fn stops_at_the_line_limit_with_the_first_files_kept() {
    let temp = TempProject::new();
    for index in 0..30 {
        temp.write(&format!("f{index:02}.txt"), "hit\n".repeat(50));
    }

    let result = search_text(&temp.project(), "hit", options(), false).unwrap();

    assert!(result.truncated);
    assert_eq!(result.line_count, LINE_LIMIT);
    let paths: Vec<_> = result.files.iter().map(|file| file.path.as_str()).collect();
    let expected: Vec<_> = (0..20).map(|index| format!("f{index:02}.txt")).collect();
    assert_eq!(paths, expected);
}

#[test]
fn previews_long_lines_around_the_first_match_in_utf16_offsets() {
    let line = format!("    {}é😀 needle tail{}", "x".repeat(60), "y".repeat(300));
    let start = line.find("needle").unwrap();
    let preview = preview_line(7, &line, &[start..start + 6]);

    assert!(preview.preview.starts_with('…'));
    assert!(preview.preview.ends_with('…'));
    let [from, to] = preview.ranges[0];
    let units: Vec<u16> = preview.preview.encode_utf16().collect();
    assert_eq!(String::from_utf16(&units[from..to]).unwrap(), "needle");
    // Full-line selection: 4 spaces + 60 x + é (1 unit) + 😀 (2 units) + space.
    assert_eq!(preview.selection, Some([68, 74]));
    assert_eq!(preview.line, 7);
}

#[test]
fn trims_indentation_and_keeps_every_visible_range() {
    let preview = preview_line(1, "\t\tlet a = a + a;  ", &[6..7, 10..11, 14..15]);

    assert_eq!(preview.preview, "let a = a + a;");
    assert_eq!(preview.ranges, [[4, 5], [8, 9], [12, 13]]);
    assert_eq!(preview.selection, Some([6, 7]));
}

#[test]
fn parses_grep_records_and_flags_a_cut_last_record() {
    let matcher = Matcher::new("needle", options()).unwrap();
    let output =
        b"./src/a.ts\x0012:  a needle\r\nsrc/a.ts\x0014:needle\nb.txt\x003:Needle\nc.txt\x009:nee";

    let result = parse_posix_output(output, &matcher, false);

    assert!(result.truncated);
    assert_eq!(
        hits(&result),
        [
            ("src/a.ts".into(), 12),
            ("src/a.ts".into(), 14),
            ("b.txt".into(), 3)
        ]
    );
    assert_eq!(result.files[0].lines[0].preview, "a needle");
    assert_eq!(result.files[0].lines[0].ranges, [[2, 8]]);
}

#[test]
fn parses_paths_containing_newlines() {
    let matcher = Matcher::new("needle", options()).unwrap();
    let output = b"a\nb.txt\x001:needle\nc.txt\x002:a needle\n";

    let result = parse_posix_output(output, &matcher, false);

    assert!(!result.truncated);
    assert_eq!(hits(&result), [("a\nb.txt".into(), 1), ("c.txt".into(), 2)]);
}

#[test]
fn flags_output_cut_by_the_byte_cap_on_a_record_boundary() {
    let matcher = Matcher::new("needle", options()).unwrap();
    let mut output = b"a.txt\x001:needle ".to_vec();
    output.resize(POSIX_OUTPUT_LIMIT - 1, b'x');
    output.push(b'\n');

    assert!(!parse_posix_output(&output, &matcher, false).truncated);

    output.push(b'b');
    let result = parse_posix_output(&output, &matcher, false);
    assert!(result.truncated);
    assert_eq!(hits(&result), [("a.txt".into(), 1)]);
}

#[cfg(unix)]
fn run_posix(
    root: &Path,
    query: &str,
    options: ProjectTextSearchOptions,
    source: PosixSource,
    input: &[u8],
) -> Vec<u8> {
    use std::io::Write;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(posix_script(root.to_str().unwrap(), query, options, source))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    output.stdout
}

#[cfg(unix)]
#[test]
fn posix_inventory_search_skips_links_and_quotes_the_query() {
    let temp = TempProject::new();
    let query = "a'$(touch pwned)";
    temp.write("src/a.ts", format!("x\n{query}\n"));
    temp.write("-dash.txt", query);
    temp.write("outside/secret.txt", query);
    std::os::unix::fs::symlink(temp.0.join("outside"), temp.0.join("linked")).unwrap();
    let matcher = Matcher::new(query, options()).unwrap();

    let output = run_posix(
        &temp.0,
        query,
        options(),
        PosixSource::Inventory,
        b"-dash.txt\0linked/secret.txt\0src/a.ts\0",
    );
    let result = parse_posix_output(&output, &matcher, false);

    assert_eq!(
        hits(&result),
        [("-dash.txt".into(), 1), ("src/a.ts".into(), 2)]
    );
    assert!(!temp.0.join("pwned").exists());
}

#[cfg(unix)]
#[test]
fn posix_recursive_search_skips_git_metadata_and_honours_options() {
    let temp = TempProject::new();
    temp.write(".git/HEAD", "Needle");
    temp.write("a.txt", "Needle\nneedles\n");
    let whole_word = ProjectTextSearchOptions {
        case_sensitive: true,
        whole_word: true,
        regex: false,
    };
    let matcher = Matcher::new("Needle", whole_word).unwrap();

    let output = run_posix(&temp.0, "Needle", whole_word, PosixSource::Recursive, b"");
    let result = parse_posix_output(&output, &matcher, false);

    assert_eq!(hits(&result), [("a.txt".into(), 1)]);
    assert_eq!(result.files[0].lines[0].ranges, [[0, 6]]);
}

#[cfg(unix)]
#[test]
fn posix_recursive_search_skips_fifos() {
    use std::time::{Duration, Instant};
    let temp = TempProject::new();
    temp.write("a.txt", "needle\n");
    assert!(Command::new("mkfifo")
        .arg(temp.0.join("pipe"))
        .status()
        .unwrap()
        .success());
    let matcher = Matcher::new("needle", options()).unwrap();
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(posix_script(
            temp.0.to_str().unwrap(),
            "needle",
            options(),
            PosixSource::Recursive,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            // Unblock a grep stuck reading the FIFO without blocking when no reader is left.
            use std::os::unix::fs::OpenOptionsExt;
            drop(
                fs::OpenOptions::new()
                    .write(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(temp.0.join("pipe")),
            );
            child.kill().ok();
            child.wait().ok();
            panic!("grep blocked on a FIFO");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let result = parse_posix_output(&output.stdout, &matcher, false);
    assert_eq!(hits(&result), [("a.txt".into(), 1)]);
}
