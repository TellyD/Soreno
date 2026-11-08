/// Stderr line `GROUP_MARKER<nonce>:<group>` of an SSH run: the remote process group to kill on
/// a forced stop.
pub(super) const GROUP_MARKER: &str = "soreno-omp-group=";
/// Longer incomplete lines are not the marker.
const GROUP_LINE_LIMIT: usize = 128;

/// Signals the remote process group `group` of a hung run, TERM then KILL, if its leader
/// still leads it; `ps` rather than `/proc` for macOS servers.
// shortcut: a leader that exited and whose PID was reused as a group leader within that
// second is signalled too; compare the process start time if this ever shows up.
pub(super) fn stop_group_script(group: u32) -> String {
    format!(
        "g={group}; [ \"$(ps -o pgid= -p $g | tr -d ' ')\" = $g ] || exit 0; kill -TERM \"-$g\"; sleep 1; kill -KILL \"-$g\" 2>/dev/null; exit 0"
    )
}

/// Finds an SSH run's group marker in its stderr: SSH or shell diagnostics may precede it, and
/// only the first line bearing the launch's nonce counts, so OMP cannot forge it.
pub(super) struct GroupScan {
    prefix: String,
    /// The incomplete last line, held until it is known not to be the marker.
    pub(super) line: Vec<u8>,
    /// The incomplete last line outgrew the marker: shown as it comes.
    long: bool,
}

impl GroupScan {
    pub(super) fn new(nonce: &str) -> Self {
        Self {
            prefix: format!("{GROUP_MARKER}{nonce}:"),
            line: Vec::new(),
            long: false,
        }
    }

    /// The bytes of `bytes` to show, and `Some` once the nonce's line came: its group, if valid.
    pub(super) fn scan(&mut self, mut bytes: &[u8]) -> (Vec<u8>, Option<Option<u32>>) {
        let mut shown = Vec::new();
        while let Some(end) = bytes.iter().position(|byte| *byte == b'\n') {
            let (line, rest) = bytes.split_at(end + 1);
            bytes = rest;
            if std::mem::take(&mut self.long) {
                shown.extend_from_slice(line);
                continue;
            }
            self.line.extend_from_slice(line);
            let Some(group) = std::str::from_utf8(&self.line)
                .ok()
                .and_then(|line| line.strip_prefix(&self.prefix))
            else {
                shown.append(&mut self.line);
                continue;
            };
            let group = group
                .trim()
                .parse()
                .ok()
                // Groups 0 and 1 would make `kill "-$g"` reach far beyond the run.
                .filter(|group| *group > 1);
            if group.is_some() {
                self.line.clear();
            } else {
                shown.append(&mut self.line);
            }
            shown.extend_from_slice(bytes);
            return (shown, Some(group));
        }
        if self.long {
            shown.extend_from_slice(bytes);
        } else {
            self.line.extend_from_slice(bytes);
            if self.line.len() > GROUP_LINE_LIMIT {
                self.long = true;
                shown.append(&mut self.line);
            }
        }
        (shown, None)
    }
}
