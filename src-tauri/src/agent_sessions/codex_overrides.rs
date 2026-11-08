//! `-c key=value` overrides that Soreno adds to or merges into Codex launch arguments.

const WRITABLE_ROOTS: &str = "sandbox_workspace_write.writable_roots";

/// Grants write access to `directories` without choosing the sandbox mode: `--sandbox` would
/// override the user's configured mode, and Codex exits when `--add-dir` meets a read-only
/// sandbox. These roots only apply when the effective mode is workspace-write.
pub(super) fn add_writable_roots(
    args: &mut Vec<String>,
    directories: impl IntoIterator<Item = String>,
    windows_local: bool,
) {
    let options = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let child = last_override(&args[..options], WRITABLE_ROOTS);
    let table = last_override(&args[..options], "sandbox_workspace_write");
    let (existing, insert_at) = match (child, table) {
        (Some(child), Some((table, _))) if child.0 > table => (Some(child), 0),
        (_, Some((index, value_start))) => {
            if args[index][value_start..].contains("writable_roots") {
                return;
            }
            // A later table override replaces the whole table, so Soreno's roots follow it.
            (None, index + 1)
        }
        (child, None) => (child, 0),
    };
    let mut roots = match existing {
        // An override Soreno cannot decode belongs to the user: Codex keeps it unchanged.
        Some((index, value_start)) => {
            match decode_string_array(args[index][value_start..].trim()) {
                Some(roots) => roots,
                None => return,
            }
        }
        None => Vec::new(),
    };
    let known = roots.len();
    for directory in directories {
        if !roots.contains(&directory) {
            roots.push(directory);
        }
    }
    // A directory this launch path cannot quote stays unwritable: the agent asks to write there.
    let Some(encoded) = roots[..known]
        .iter()
        .map(|root| toml_string(root, windows_local))
        .collect::<Option<Vec<_>>>()
    else {
        return;
    };
    let added = roots[known..]
        .iter()
        .filter_map(|root| toml_string(root, windows_local));
    let encoded: Vec<String> = encoded.into_iter().chain(added).collect();
    if encoded.len() == known {
        return;
    }
    let value = format!("[{}]", encoded.join(","));
    match existing {
        Some((index, value_start)) => {
            args[index].truncate(value_start);
            args[index].push_str(&value);
        }
        None => {
            args.splice(
                insert_at..insert_at,
                ["-c".to_owned(), format!("{WRITABLE_ROOTS}={value}")],
            );
        }
    }
}

/// Codex applies `-c` overrides in order, so `text` joins the last `developer_instructions`
/// override; one it cannot decode is left alone and nothing is added.
pub(super) fn add_developer_instructions(
    args: &mut Vec<String>,
    text: &str,
    windows_local: bool,
) -> bool {
    let options = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let Some((index, value_start)) = last_override(&args[..options], "developer_instructions")
    else {
        let Some(value) = toml_string(text, windows_local) else {
            return false;
        };
        args.splice(
            0..0,
            ["-c".to_owned(), format!("developer_instructions={value}")],
        );
        return true;
    };
    let Some(existing) = decode_toml_string(args[index][value_start..].trim()) else {
        return false;
    };
    // A TOML literal string cannot hold a line break.
    let separator = if windows_local { " " } else { "\n\n" };
    let Some(value) = toml_string(&format!("{existing}{separator}{text}"), windows_local) else {
        return false;
    };
    args[index] = format!("{}{value}", &args[index][..value_start]);
    true
}

/// Index of the last `key` override in `args` and the byte offset of its value.
pub(super) fn last_override(args: &[String], key: &str) -> Option<(usize, usize)> {
    let mut found = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let (target, offset) = if matches!(arg.as_str(), "-c" | "--config") {
            (index + 1, 0)
        } else if arg.starts_with("--config=") {
            (index, "--config=".len())
        } else if arg.starts_with("-c") && !arg.starts_with("--") {
            (index, if arg[2..].starts_with('=') { 3 } else { 2 })
        } else {
            index += 1;
            continue;
        };
        if let Some((name, _)) = args
            .get(target)
            .and_then(|config| config[offset..].split_once('='))
        {
            if name.trim() == key {
                found = Some((target, offset + name.len() + 1));
            }
        }
        index = target + 1;
    }
    found
}

/// Decodes an array of single-line TOML strings; anything else is `None`.
fn decode_string_array(value: &str) -> Option<Vec<String>> {
    let mut rest = value.strip_prefix('[')?.strip_suffix(']')?.trim();
    let mut items = Vec::new();
    while !rest.is_empty() {
        let end = string_end(rest)?;
        items.push(decode_toml_string(&rest[..end])?);
        rest = rest[end..].trim_start();
        if let Some(after) = rest.strip_prefix(',') {
            rest = after.trim_start();
        } else if !rest.is_empty() {
            return None;
        }
    }
    Some(items)
}

/// Byte length of the TOML string that starts `text`.
fn string_end(text: &str) -> Option<usize> {
    let quote = text.chars().next().filter(|ch| matches!(ch, '"' | '\''))?;
    let mut escaped = false;
    for (index, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
        } else if ch == '\\' && quote == '"' {
            escaped = true;
        } else if ch == quote {
            return Some(index + 1);
        }
    }
    None
}

/// Decodes a single-line TOML basic or literal string; anything else is `None`.
pub(super) fn decode_toml_string(value: &str) -> Option<String> {
    let allowed = |ch: char| !ch.is_control() || ch == '\t';
    if let Some(inner) = value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return inner
            .chars()
            .all(|ch| ch != '\'' && allowed(ch))
            .then(|| inner.to_owned());
    }
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut decoded = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return None,
            '\\' => decoded.push(match chars.next()? {
                'b' => '\u{8}',
                't' => '\t',
                'n' => '\n',
                'f' => '\u{c}',
                'r' => '\r',
                '"' => '"',
                '\\' => '\\',
                'u' => unicode_escape(&mut chars, 4)?,
                'U' => unicode_escape(&mut chars, 8)?,
                _ => return None,
            }),
            ch if allowed(ch) => decoded.push(ch),
            _ => return None,
        }
    }
    Some(decoded)
}

fn unicode_escape(chars: &mut std::str::Chars, digits: usize) -> Option<char> {
    let code = chars.by_ref().take(digits).collect::<String>();
    if code.len() != digits || !code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(&code, 16).ok().and_then(char::from_u32)
}

pub(super) fn toml_string(text: &str, windows_local: bool) -> Option<String> {
    if windows_local {
        // Windows PowerShell shims cannot pass `"`: a TOML literal string needs none.
        return (!text
            .chars()
            .any(|ch| matches!(ch, '\'' | '"') || ch.is_control()))
        .then(|| format!("'{text}'"));
    }
    Some(toml_basic_string(text))
}

fn toml_basic_string(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for ch in text.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            ch if ch.is_control() => quoted.push_str(&format!("\\u{:04X}", ch as u32)),
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}
