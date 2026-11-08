use super::*;
use crate::agent_sessions::{size, BUFFER_LIMIT};
use portable_pty::ChildKiller;
use soreno_terminal_grid::AgentGridConfig;
use std::{fs, sync::Mutex, time::Duration};
use tauri::ipc::InvokeResponseBody;

#[derive(Debug)]
struct NoKiller;
impl ChildKiller for NoKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self)
    }
}

struct Captured(Arc<Mutex<Vec<u8>>>);
impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn runtime(cols: u16, rows: u16, replies: Arc<Mutex<Vec<u8>>>) -> Arc<Runtime> {
    Arc::new(Runtime {
        output: Mutex::new(Output::default()),
        grid: Mutex::new(None),
        writer: Mutex::new(Some(Box::new(Captured(replies)))),
        size: Mutex::new(size(cols, rows).unwrap()),
        master: Mutex::new(None),
        killer: Mutex::new(Box::new(NoKiller)),
        remote_clipboard: None,
        local_attachment_directory: Mutex::new(None),
        remote_sidecar_generation: None,
        #[cfg(windows)]
        wsl: None,
        #[cfg(windows)]
        process_handle: 0,
        #[cfg(unix)]
        run_token: "grid".into(),
    })
}

fn theme() -> GridTheme {
    GridTheme::parse(&AgentGridConfig {
        cell_width: 8,
        cell_height: 16,
        palette: vec!["#000000".into(); 19],
    })
    .unwrap()
}

type Frames = Arc<Mutex<Vec<serde_json::Value>>>;

/// Subscribes a grid engine; returns its channel id and the frames it sent.
fn subscribe(runtime: &Arc<Runtime>, log: Option<PathBuf>) -> (u32, Frames) {
    subscribe_as(runtime, log, true)
}

fn subscribe_as(runtime: &Arc<Runtime>, log: Option<PathBuf>, visible: bool) -> (u32, Frames) {
    let frames = Frames::default();
    let sent = frames.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            sent.lock()
                .unwrap()
                .push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    // The log is off by default; only tests passing a path write to it.
    if log.is_some() {
        grid_log::set_enabled(true);
    }
    let channel_id = channel.id();
    runtime
        .grid_subscribe("grid", theme(), visible, channel, log)
        .unwrap();
    (channel_id, frames)
}

fn wait_until(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
}

fn replies_until(replies: &Mutex<Vec<u8>>, len: usize) -> String {
    wait_until(|| replies.lock().unwrap().len() >= len);
    String::from_utf8_lossy(&replies.lock().unwrap()).into_owned()
}

#[test]
fn bytes_written_before_a_resize_keep_the_old_size_even_when_parsed_after_it() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    subscribe(&runtime, None);
    // The cursor report depends on the width the application drew for.
    let query = b"\x1b[999C\x1b[6n";
    lock(&runtime.output).unwrap().append(query);
    runtime.resize(size(10, 5).unwrap()).unwrap();
    lock(&runtime.output).unwrap().append(query);
    assert_eq!(replies_until(&replies, 14), "\x1b[1;20R\x1b[1;10R");
}

#[test]
fn a_synchronized_frame_open_at_a_resize_is_parsed_at_the_old_size() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    subscribe(&runtime, None);
    let before = b"\x1b[?2026h\x1b[999C\x1b[6n";
    lock(&runtime.output).unwrap().append(before);
    runtime.resize(size(10, 5).unwrap()).unwrap();
    lock(&runtime.output)
        .unwrap()
        .append(b"\x1b[?2026l\x1b[999C\x1b[6n");
    assert_eq!(replies_until(&replies, 14), "\x1b[1;20R\x1b[1;10R");
}

#[test]
fn replayed_history_queries_stay_unanswered_after_an_eviction() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    subscribe(&runtime, None);
    {
        let mut output = lock(&runtime.output).unwrap();
        // The query lands in the first chunk the engine reads once the start is evicted.
        let mut history = vec![b'x'; 16];
        history.extend_from_slice(b"\x1b[6n");
        history.extend(vec![b'x'; BUFFER_LIMIT - 16]);
        output.append_history(&history);
        output.append(b"\x1b[5n");
    }
    assert_eq!(replies_until(&replies, 4), "\x1b[0n");
}

#[test]
fn startup_queries_emitted_before_the_first_subscription_are_answered() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    lock(&runtime.output).unwrap().append(b"\x1b[6n");
    subscribe(&runtime, None);
    assert_eq!(replies_until(&replies, 6), "\x1b[1;1R");
}

#[test]
fn queries_left_unread_past_the_reply_window_stay_unanswered() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    {
        let mut output = lock(&runtime.output).unwrap();
        output.append(b"\x1b[6n");
        output.grid_unclaimed_since = Instant::now().checked_sub(Duration::from_secs(3));
    }
    subscribe(&runtime, None);
    lock(&runtime.output).unwrap().append(b"\x1b[5n");
    assert_eq!(replies_until(&replies, 4), "\x1b[0n");
}

#[test]
fn a_subscription_racing_a_resize_starts_at_the_new_size() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let mut current = lock(&runtime.size).unwrap();
    let subscriber = {
        let runtime = runtime.clone();
        thread::spawn(move || subscribe(&runtime, None))
    };
    // The subscriber holds the grid slot once it waits for the size.
    let waiting = || runtime.grid.try_lock().is_err();
    wait_until(waiting);
    assert!(waiting());
    // A resize holds the size while it queues its offset, and finds no engine yet.
    lock(&runtime.output).unwrap().resize_grid(10, 5);
    *current = size(10, 5).unwrap();
    drop(current);
    subscriber.join().unwrap();
    lock(&runtime.output).unwrap().append(b"\x1b[999C\x1b[6n");
    assert_eq!(replies_until(&replies, 7), "\x1b[1;10R");
}

#[test]
fn a_blocked_pty_writer_never_stalls_frames_or_close() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let log = std::env::temp_dir().join(format!(
        "soreno-grid-writer-{}-{:?}.log",
        std::process::id(),
        thread::current().id()
    ));
    let (channel_id, frames) = subscribe(&runtime, Some(log.clone()));
    let writer = lock(&runtime.writer).unwrap();
    lock(&runtime.output).unwrap().append(b"hello\x1b[6n");
    wait_until(|| !frames.lock().unwrap().is_empty());
    assert!(!frames.lock().unwrap().is_empty());
    runtime.grid_unsubscribe(channel_id).unwrap();
    // Close, or the generation bump when it wins the race to the next read.
    let closed = || {
        fs::read_to_string(&log).is_ok_and(|text| {
            text.contains("unsubscribe reason=closed")
                || text.contains("unsubscribe reason=superseded")
        })
    };
    wait_until(closed);
    assert!(closed());
    drop(writer);
    assert_eq!(replies_until(&replies, 6), "\x1b[1;6R");
    let _ = fs::remove_file(&log);
}

#[test]
fn a_hidden_engine_answers_queries_and_paints_in_full_once_visible() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let (channel_id, frames) = subscribe_as(&runtime, None, false);
    lock(&runtime.output).unwrap().append(b"hello\x1b[6n");
    assert_eq!(replies_until(&replies, 6), "\x1b[1;6R");
    thread::sleep(Duration::from_millis(100));
    assert!(frames.lock().unwrap().is_empty());
    runtime
        .grid_command(channel_id, GridCommand::Visibility(true))
        .unwrap();
    wait_until(|| !frames.lock().unwrap().is_empty());
    thread::sleep(Duration::from_millis(100));
    let frames = frames.lock().unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["full"], true);
    assert_eq!(frames[0]["lines"].as_array().unwrap().len(), 5);
    assert_eq!(frames[0]["lines"][0][1][0]["t"], "hello");
}

#[test]
fn only_a_live_program_status_query_is_answered_ahead_of_the_queries_that_follow_it() {
    use crate::agent_sessions::{dtach_history::HistoryFraming, program_status, OutputPipeline};
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    subscribe(&runtime, None);
    let mut pipeline = OutputPipeline {
        history: Some(HistoryFraming::new(true)),
        metadata: None,
        program_status: Default::default(),
    };
    pipeline.push(
        b"\x1b]5379;dtach-history-begin\x07\x1b]7501;?\x07\x1b]7501;state=blocked\x07\
          \x1b]5379;dtach-history-end\x07",
        &runtime,
    );
    assert_eq!(
        lock(&runtime.output).unwrap().program_state,
        Some(program_status::ProgramState::Blocked),
        "a replayed report still applies"
    );
    pipeline.push(b"\x1b]7501;?\x07\x1b[6n", &runtime);
    assert_eq!(replies_until(&replies, 16), "\x1b]7501;?\x1b\\\x1b[1;1R");
}

/// Whole buffer through the selection, which the engine serves in command order.
fn buffer_text(runtime: &Runtime, channel_id: u32) -> Result<String> {
    runtime.grid_command(channel_id, GridCommand::Select(AgentGridSelect::All))?;
    runtime.grid_text(channel_id)
}

#[test]
fn the_text_command_returns_the_selected_text() {
    let runtime = runtime(20, 5, Arc::new(Mutex::new(Vec::new())));
    let (channel_id, _) = subscribe_as(&runtime, None, false);
    lock(&runtime.output)
        .unwrap()
        .append(b"first\r\nsecond\x1b[5n");
    wait_until(|| buffer_text(&runtime, channel_id).is_ok_and(|text| text.contains("second")));
    assert_eq!(buffer_text(&runtime, channel_id).unwrap(), "first\nsecond");
    runtime
        .grid_command(channel_id, GridCommand::Select(AgentGridSelect::Clear))
        .unwrap();
    assert_eq!(runtime.grid_text(channel_id).unwrap(), "");
    runtime.grid_unsubscribe(channel_id).unwrap();
    assert!(runtime.grid_text(channel_id).is_err());
}

#[test]
fn replies_of_successive_subscriptions_reach_the_pty_in_order() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let (first, _) = subscribe(&runtime, None);
    let writer = lock(&runtime.writer).unwrap();
    lock(&runtime.output).unwrap().append(b"\x1b[6n");
    // The first engine took the query; the writer will block on the PTY with its reply.
    wait_until(|| {
        let output = lock(&runtime.output).unwrap();
        output.grid_claimed == output.end
    });
    // A command round trip ensures the first engine queued its reply before the next subscription.
    let _ = buffer_text(&runtime, first);
    let (second, _) = subscribe(&runtime, None);
    // The engine queues its replies before it serves the next command.
    lock(&runtime.output).unwrap().append(b"\x1b[5nnext");
    let parsed = || buffer_text(&runtime, second).is_ok_and(|text| text.contains("next"));
    wait_until(parsed);
    assert!(parsed());
    drop(writer);
    assert_eq!(replies_until(&replies, 10), "\x1b[1;1R\x1b[0n");
}

#[test]
fn replies_of_a_superseded_engine_never_follow_newer_ones() {
    for (sent, written) in [
        ([(2, "new"), (1, "old")], "new"),
        ([(1, "old"), (2, "new")], "oldnew"),
    ] {
        let replies = Arc::new(Mutex::new(Vec::new()));
        let runtime = runtime(20, 5, replies.clone());
        let (sender, receiver) = mpsc::channel();
        for (generation, bytes) in sent {
            sender
                .send((generation, bytes.as_bytes().to_vec()))
                .unwrap();
        }
        drop(sender);
        write_replies(Arc::downgrade(&runtime), receiver);
        assert_eq!(String::from_utf8_lossy(&replies.lock().unwrap()), written);
    }
}

#[test]
fn a_resize_during_a_subscription_is_never_lost() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let output = lock(&runtime.output).unwrap();
    let subscriber = {
        let runtime = runtime.clone();
        thread::spawn(move || subscribe(&runtime, None))
    };
    thread::sleep(Duration::from_millis(100));
    // The subscription now waits for the output while holding the size.
    let resizer = {
        let runtime = runtime.clone();
        thread::spawn(move || runtime.resize(size(10, 5).unwrap()).unwrap())
    };
    thread::sleep(Duration::from_millis(100));
    drop(output);
    subscriber.join().unwrap();
    resizer.join().unwrap();
    lock(&runtime.output).unwrap().append(b"\x1b[999C\x1b[6n");
    assert_eq!(replies_until(&replies, 7), "\x1b[1;10R");
}

#[test]
fn a_skip_waits_for_the_resize_inside_the_skipped_bytes() {
    let replies = Arc::new(Mutex::new(Vec::new()));
    let runtime = runtime(20, 5, replies.clone());
    let log = std::env::temp_dir().join(format!(
        "soreno-grid-resize-skip-{}-{:?}.log",
        std::process::id(),
        thread::current().id()
    ));
    let (channel_id, _) = subscribe(&runtime, Some(log.clone()));
    let redraw = |body: &str| format!("\x1b[?2026h\x1b[2J\x1b[H\x1b[3J{body}\x1b[?2026l");
    let before = redraw("old");
    let keyframe = before.len() * 2;
    {
        let mut output = lock(&runtime.output).unwrap();
        output.append(before.as_bytes());
        output.resize_grid(10, 5);
        output.append(redraw("mid").as_bytes());
        output.append(redraw("new\x1b[999C\x1b[6n").as_bytes());
    }
    assert_eq!(replies_until(&replies, 7), "\x1b[1;10R");
    let text = fs::read_to_string(&log).unwrap();
    let resize = text.find(&format!("resize cols=10 rows=5 at={}", before.len()));
    let skip = text.find(&format!("skip from={} to={keyframe}", before.len()));
    assert!(resize.is_some() && resize < skip, "{text}");
    runtime.grid_unsubscribe(channel_id).unwrap();
    // The engine logs until it stops; removing the file earlier lets it be recreated.
    wait_until(|| fs::read_to_string(&log).is_ok_and(|text| text.contains("unsubscribe reason=")));
    let _ = fs::remove_file(&log);
}
