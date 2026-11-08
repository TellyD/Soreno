use super::{
    attach_file_to, conversation, conversations, id, lock, project_disconnected,
    require_project_connected, require_session, runtime_status, session_status, text,
    validate_project, AgentEnvironment, AgentSessions, Result, Runtime, Store,
    AGENT_ATTACHMENT_LIMIT,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    io::Write,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

pub(super) const MESSAGE_LIMIT: usize = 64 * 1024;
const MESSAGE_FILENAME: &str = "soreno-message.md";
/// Leaves time for hooks and the Pi/OMP bridge to report the turn a nudge started.
const DELIVERY_SETTLE: Duration = Duration::from_secs(5);
/// Codex and other TUIs treat an Enter arriving right after fast input as a pasted newline.
const SUBMIT_DELAY: Duration = Duration::from_millis(500);
const STOPPED_BEFORE_DELIVERY: &str = "Session arrêtée avant la livraison.";
const CLOSED_BEFORE_DELIVERY: &str = "Soreno a été fermé avant la livraison.";
/// Shown on queued messages while the user's text in the agent's prompt holds them back.
const DRAFT_PENDING: &str = "saisie en cours dans le terminal de l’agent";
/// Marks messages sent to a stopped session, kept for its next start.
const START_PENDING: &str = "prochain démarrage de la session";
const MESSAGE_SEPARATOR: &str = "\n\n---\n\n";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMessage {
    pub id: String,
    pub session_id: String,
    pub body: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum MessageDelivery {
    /// Messages remain queued until the agent finishes its turn.
    Waiting,
    /// Statuses changed; queued messages may remain.
    Changed,
    /// No queued message remains; the delivery worker must stop.
    Finished { changed: bool },
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_session_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, delivered_at TEXT);
        CREATE INDEX IF NOT EXISTS agent_session_messages_session ON agent_session_messages(session_id, created_at);",
    )
    .map_err(|error| error.to_string())?;
    // Delivery workers do not survive the app: nothing would ever deliver these. Messages
    // waiting for a start get a worker from that start.
    db.execute(
        "UPDATE agent_session_messages SET status='failed', error=?1 WHERE status='queued' AND error IS NOT ?2",
        params![CLOSED_BEFORE_DELIVERY, START_PENDING],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn list(db: &Connection, session_id: &str, queued_only: bool) -> Result<Vec<AgentSessionMessage>> {
    let mut statement = db
        .prepare(
            "SELECT id, session_id, body, status, error, created_at, delivered_at FROM agent_session_messages
            WHERE session_id=?1 AND (?2=0 OR status='queued') ORDER BY created_at, rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![session_id, queued_only], |row| {
            Ok(AgentSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                body: row.get(2)?,
                status: row.get(3)?,
                error: row.get(4)?,
                created_at: row.get(5)?,
                delivered_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(|error| error.to_string())
}

/// Spares messages sent while the session was stopped: they wait for its next start.
fn fail_queued(db: &Connection, session_id: &str, error: &str) -> Result<usize> {
    db.execute(
        "UPDATE agent_session_messages SET status='failed', error=?2 WHERE session_id=?1 AND status='queued' AND error IS NOT ?3",
        params![session_id, error, START_PENDING],
    )
    .map_err(|error| error.to_string())
}

/// Messages sent during a run and still queued when the next one starts belong to the stopped
/// run; the session's worker then reports the change.
pub(super) fn fail_previous_run_messages(store: &mut Store, session_id: &str) -> Result<()> {
    if fail_queued(&store.db, session_id, STOPPED_BEFORE_DELIVERY)? > 0 {
        store.messages_failed_at_start.insert(session_id.into());
    }
    Ok(())
}

/// Releases the session's worker; whether a start failed messages it had not reported yet.
fn end_worker(store: &mut Store, session_id: &str) -> bool {
    store.message_workers.remove(session_id);
    store.messages_failed_at_start.remove(session_id)
}

fn message_file(messages: &[AgentSessionMessage]) -> String {
    messages
        .iter()
        .map(|message| message.body.trim())
        .collect::<Vec<_>>()
        .join(MESSAGE_SEPARATOR)
}

/// Length of the oldest queued prefix whose `message_file` fits `limit`; never zero.
fn batch_len(messages: &[AgentSessionMessage], limit: usize) -> usize {
    let mut size = 0;
    for (index, message) in messages.iter().enumerate() {
        if index > 0 {
            size += MESSAGE_SEPARATOR.len();
        }
        size += message.body.trim().len();
        if index > 0 && size > limit {
            return index;
        }
    }
    messages.len()
}

fn nudge(path: &str) -> String {
    format!("Soreno: new message for you in {path} — read it and act on it.")
}

/// Whether the agent's prompt still holds the user's text after their terminal `input`: Enter
/// and Ctrl+C empty it, key and mouse sequences leave it as is.
/// shortcut: text erased with Backspace still counts until the next Enter; count the
/// characters typed and erased if that blocks messages too often.
pub(super) fn holds_draft(mut draft: bool, input: &str) -> bool {
    let mut chars = input.chars();
    // shortcut: a bracketed paste over 64 KiB spans several writes, so a line break ending it
    // reads as Enter; keep `pasting` in `Output` if such pastes reach a queued message.
    let mut pasting = false;
    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => match chars.next() {
                Some('[') => {
                    let rest = chars.as_str();
                    let end = rest
                        .find(|ch: char| ('@'..='~').contains(&ch))
                        .map_or(rest.len(), |index| index + 1);
                    chars = rest[end..].chars();
                    match &rest[..end] {
                        "200~" => pasting = true,
                        "201~" => pasting = false,
                        // X10 mouse report: three raw characters follow, printable ones included.
                        "M" => {
                            chars.nth(2);
                        }
                        _ => {}
                    }
                }
                Some('O') => {
                    chars.next();
                }
                // Pi's image paste on Windows and WSL.
                Some('v') => draft = true,
                // Other Alt+key, including Alt+Enter, which inserts a line break.
                _ => {}
            },
            '\r' | '\x03' if !pasting => draft = false,
            // Ctrl+V pastes an image into the prompt.
            '\x16' => draft = true,
            ch if pasting || !ch.is_control() => draft = true,
            _ => {}
        }
    }
    draft
}

/// Sets or clears the reason queued messages wait; `true` when it changed.
fn hold_queued(db: &Connection, session_id: &str, reason: Option<&str>) -> Result<bool> {
    db.execute(
        "UPDATE agent_session_messages SET error=?2 WHERE session_id=?1 AND status='queued' AND error IS NOT ?2",
        params![session_id, reason],
    )
    .map(|changed| changed > 0)
    .map_err(|error| error.to_string())
}

fn write_terminal(runtime: &Runtime, writer: &mut dyn Write, data: &str) -> Result<()> {
    if lock(&runtime.output)?.exited {
        return Err("Cette session est terminée.".into());
    }
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

/// Holds the writer throughout so user keystrokes cannot join the line before its Enter;
/// `false` when the user's text is already in the prompt.
fn submit_line(runtime: &Runtime, line: &str) -> Result<bool> {
    let mut writer = lock(&runtime.writer)?;
    let writer = writer.as_mut().ok_or("Terminal fermé.")?;
    if lock(&runtime.output)?.draft {
        return Ok(false);
    }
    write_terminal(runtime, &mut **writer, line)?;
    thread::sleep(SUBMIT_DELAY);
    write_terminal(runtime, &mut **writer, "\r")?;
    Ok(true)
}

fn is_current_run(store: &Store, session_id: &str, runtime: &Arc<Runtime>) -> Result<bool> {
    Ok(store
        .runtimes
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current, runtime))
        && !lock(&runtime.output)?.exited)
}

impl AgentSessions {
    pub fn session_messages(&self, session_id: &str) -> Result<Vec<AgentSessionMessage>> {
        id(session_id)?;
        let store = lock(&self.store)?;
        require_session(&store, session_id)?;
        list(&store.db, session_id, false)
    }

    /// Queues a message, for the next start if the session is stopped; `true` asks the caller
    /// to start the session's delivery worker.
    pub fn send_message(
        &self,
        session_id: &str,
        message_id: &str,
        body: &str,
    ) -> Result<(AgentSessionMessage, bool)> {
        id(session_id)?;
        id(message_id)?;
        text(body, "Message", MESSAGE_LIMIT)?;
        let mut store = lock(&self.store)?;
        require_session(&store, session_id)?;
        let running = runtime_status(&store, session_id)?.state == "running";
        store
            .db
            .execute(
                "INSERT INTO agent_session_messages(id, session_id, body, status, error, created_at)
                VALUES (?1, ?2, ?3, 'queued', ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    message_id,
                    session_id,
                    body,
                    (!running).then_some(START_PENDING)
                ],
            )
            .map_err(|error| error.to_string())?;
        let message = list(&store.db, session_id, true)?
            .into_iter()
            .find(|message| message.id == message_id)
            .ok_or("Message introuvable après enregistrement.")?;
        let start_worker = running && store.message_workers.insert(session_id.into());
        Ok((message, start_worker))
    }

    /// After a start, hands the messages sent while the session was stopped to this run;
    /// `true` asks the caller to start the session's delivery worker.
    pub fn release_start_messages(&self, session_id: &str) -> Result<bool> {
        let mut store = lock(&self.store)?;
        let released = hold_queued(&store.db, session_id, None)?;
        Ok(released && store.message_workers.insert(session_id.into()))
    }

    /// Delivers the oldest queued messages that fit one file when the agent is neither working
    /// nor waiting for a reply: typed into a permission prompt, a message would answer it.
    /// Messages also stay queued until Claude Code or Codex reports its first state, and while
    /// the user's text is in the prompt: the line and its Enter would send it along.
    pub fn deliver_messages(&self, session_id: &str) -> Result<MessageDelivery> {
        let (queued, target, omp) = {
            let mut store = lock(&self.store)?;
            let mut queued = list(&store.db, session_id, true)?;
            if queued.is_empty() {
                let changed = end_worker(&mut store, session_id);
                return Ok(MessageDelivery::Finished { changed });
            }
            let session = require_session(&store, session_id)?;
            let disconnected = project_disconnected(&store.db, &session.project_id)?;
            let status = session_status(&store, &session, disconnected)?;
            if status.state != "running" {
                fail_queued(&store.db, session_id, STOPPED_BEFORE_DELIVERY)?;
                end_worker(&mut store, session_id);
                return Ok(MessageDelivery::Finished { changed: true });
            }
            let (drafting, starting) = match store.runtimes.get(session_id) {
                Some(runtime) => {
                    let output = lock(&runtime.output)?;
                    // Claude Code and Codex report no state while their trust or hooks screen,
                    // which typed keys and Enter would answer, is shown; an outdated one never does.
                    let starting = !output.reports_program_status
                        && conversations::provider(&session.executable)
                            .is_some_and(conversations::Provider::uses_hooks);
                    (output.draft, starting)
                }
                None => (false, false),
            };
            if hold_queued(&store.db, session_id, drafting.then_some(DRAFT_PENDING))? {
                return Ok(MessageDelivery::Changed);
            }
            let settling = store
                .message_deliveries
                .get(session_id)
                .is_some_and(|delivered| delivered.elapsed() < DELIVERY_SETTLE);
            if status.working == Some(true) || status.awaiting || starting || settling || drafting {
                return Ok(MessageDelivery::Waiting);
            }
            let ready = require_project_connected(&store, &session.project_id)
                .and_then(|project| validate_project(&project).map(|()| project.environment));
            let omp = store
                .omp_conversations
                .get(session_id)
                .cloned()
                .map(|omp| ready.as_ref().map(|_| omp).map_err(Clone::clone));
            let limit = if omp.is_some() {
                conversation::DELIVERY_LIMIT
            } else {
                AGENT_ATTACHMENT_LIMIT
            };
            queued.truncate(batch_len(&queued, limit));
            let target = ready.and_then(|environment| {
                store
                    .runtimes
                    .get(session_id)
                    .cloned()
                    .map(|runtime| (runtime, environment))
                    .ok_or_else(|| STOPPED_BEFORE_DELIVERY.to_string())
            });
            (queued, target, omp)
        };
        if let Some(omp) = omp {
            let delivered = omp.and_then(|omp| omp.deliver(&message_file(&queued)));
            let mut store = lock(&self.store)?;
            return record_batch(&mut store, session_id, &queued, &delivered);
        }
        self.deliver_batch(session_id, &queued, target)
    }

    /// Writes the file and nudge to `target`'s run only; they fail if another run replaced it.
    pub(super) fn deliver_batch(
        &self,
        session_id: &str,
        queued: &[AgentSessionMessage],
        target: Result<(Arc<Runtime>, AgentEnvironment)>,
    ) -> Result<MessageDelivery> {
        let delivered = target
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|(runtime, environment)| {
                let path = attach_file_to(
                    runtime,
                    environment,
                    MESSAGE_FILENAME,
                    message_file(queued).as_bytes(),
                )?;
                submit_line(runtime, &nudge(&path))
            });
        let mut store = lock(&self.store)?;
        let delivered = match (&target, delivered) {
            (Ok((runtime, _)), _) if !is_current_run(&store, session_id, runtime)? => {
                Err(STOPPED_BEFORE_DELIVERY.to_string())
            }
            // The user started typing since `deliver_messages` checked.
            (_, Ok(false)) => {
                hold_queued(&store.db, session_id, Some(DRAFT_PENDING))?;
                return Ok(MessageDelivery::Changed);
            }
            (_, delivered) => delivered.map(|_| ()),
        };
        record_batch(&mut store, session_id, queued, &delivered)
    }

    /// Releases the delivery worker after an unexpected error without leaving messages queued.
    pub fn abandon_message_delivery(&self, session_id: &str, error: &str) -> Result<()> {
        let mut store = lock(&self.store)?;
        fail_queued(&store.db, session_id, error)?;
        end_worker(&mut store, session_id);
        Ok(())
    }
}

fn record_batch(
    store: &mut Store,
    session_id: &str,
    queued: &[AgentSessionMessage],
    delivered: &Result<()>,
) -> Result<MessageDelivery> {
    for message in queued {
        match delivered {
            Ok(()) => store.db.execute(
                "UPDATE agent_session_messages SET status='delivered', error=NULL, delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
                [&message.id],
            ),
            Err(error) => store.db.execute(
                "UPDATE agent_session_messages SET status='failed', error=?2 WHERE id=?1",
                params![message.id, error],
            ),
        }
        .map_err(|error| error.to_string())?;
    }
    store
        .message_deliveries
        .insert(session_id.into(), Instant::now());
    Ok(MessageDelivery::Changed)
}
