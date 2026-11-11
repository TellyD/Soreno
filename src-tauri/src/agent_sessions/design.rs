//! Design boards: HTML frames that a hidden agent session writes into its private directory.
use super::{
    agent_local_path,
    attachments::{mirror_directory, MIRROR_SUFFIX},
    conversations::{self, Provider},
    get, id, lock, require_project, require_session, runtime_status, text, validate_project,
    AgentEnvironment, AgentProject, AgentSession, AgentSessionMessage, AgentSessions,
    PromptAttachment, RemoteClipboard, Result,
};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{LazyLock, Mutex},
};

/// Local project of the boards attached to no project.
pub(super) const PROJECT_ID: &str = "design";
pub(super) const FRAME_PREFIX: &str = "design-frame-";
pub(super) const FRAME_SUFFIX: &str = ".html";
pub(super) const FRAME_LIMIT: usize = 512 * 1024;
const FRAME_ID_LIMIT: usize = 100;
pub(super) const FRAME_CAPACITY: i64 = 500;
const BOARD_NAME_LIMIT: usize = 100;
const TITLE_LIMIT: usize = 255;
const MIN_SIZE: f64 = 120.0;
const MAX_SIZE: f64 = 4096.0;
const DEFAULT_SIZE: (f64, f64) = (1280.0, 800.0);
const COORDINATE_LIMIT: f64 = 10_000_000.0;
const FRAME_GAP: f64 = 80.0;
const DUPLICATE_OFFSET: f64 = 40.0;
const INSTRUCTIONS_FILENAME: &str = "instructions.md";
const BOARD_INDEX_FILENAME: &str = "design-board.md";
const INSTRUCTIONS_LIMIT: usize = 16 * 1024;
/// The full design instruction, in the private directory: a native Windows Codex launch line
/// cannot hold it with Codex's hooks and the restriction overrides.
const INSTRUCTION_FILENAME: &str = "design-instructions.md";
const BOARD_NOT_FOUND: &str = "Tableau introuvable.";
const FRAME_NOT_FOUND: &str = "Cadre introuvable.";
static TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap());
static ATTRIBUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap()
});
static DIMENSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(width|height)\s*=\s*(\d+(?:\.\d+)?)").unwrap());

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesignBoard {
    pub id: String,
    pub name: String,
    pub project_id: Option<String>,
    pub session_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesignFrame {
    pub board_id: String,
    pub id: String,
    pub title: String,
    pub html: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: i64,
    #[serde(default)]
    pub updated_at: String,
}

/// A frame file as the agent wrote it.
#[derive(Debug, PartialEq)]
pub(super) struct FrameFile {
    /// A non-empty `<title>`.
    pub title: Option<String>,
    /// The `soreno-frame` meta size, within bounds.
    pub size: Option<(f64, f64)>,
    pub html: String,
}

pub(super) fn instruction(directory: &str) -> String {
    format!(
        "Soreno design board. You design UI as standalone HTML documents (inline CSS, no JavaScript, no external resources: no remote fonts, images or scripts; use inline SVG or CSS for visuals; no meta http-equiv). Soreno renders the frames itself: do not render, screenshot or preview them, and do not run scripts or servers. A frame is the file design-frame-<id>.html in {directory} (id: letters, digits, . - _; an existing id replaces that frame, a new id creates one). Soreno keeps the current HTML of every frame in {directory}{MIRROR_SUFFIX}/<id>.html (read only). To change a frame, copy {directory}{MIRROR_SUFFIX}/<id>.html to a draft in {directory} (for example draft-<id>.tmp; without a copy command, read it and write the draft), edit only what is asked with targeted edits and keep everything else identical, then rename the draft to design-frame-<id>.html (without a rename command, write the finished draft to that name in one write). To create a frame, write the whole document into a draft, then rename it the same way. Every frame is a whole document ending with </html>. Put the frame title in <title>; optionally <meta name=soreno-frame content=width=1440,height=900> for the size of a new frame. Do not modify project files. Soreno replies only on error."
    )
}

/// The launch instruction of a design Codex agent, which reads the full one from its file.
pub(super) fn instruction_pointer(directory: &str) -> String {
    format!(
        "Soreno design board. Before any other step, read {directory}/{INSTRUCTION_FILENAME} and follow it for every request; Soreno rewrites it at each start."
    )
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS design_boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS design_frames (board_id TEXT NOT NULL REFERENCES design_boards(id) ON DELETE CASCADE, id TEXT NOT NULL, title TEXT NOT NULL, html TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, z INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (board_id, id));
        CREATE TABLE IF NOT EXISTS design_board_sessions (board_id TEXT NOT NULL REFERENCES design_boards(id) ON DELETE CASCADE, session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE CASCADE, linked_at TEXT NOT NULL, PRIMARY KEY (board_id, session_id));",
    )
    .map_err(|error| error.to_string())
}

/// A coding agent working from a board; a session follows at most one board.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesignBoardSession {
    pub board_id: String,
    pub session_id: String,
    pub linked_at: String,
}

/// Frames of a board handed to a coding agent at launch, with the user's instructions.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesignFrameSelection {
    pub board_id: String,
    pub frame_ids: Vec<String>,
    #[serde(default)]
    pub instructions: Option<String>,
}

pub(super) fn list_board_sessions(db: &Connection) -> Result<Vec<DesignBoardSession>> {
    let mut statement = db
        .prepare("SELECT board_id, session_id, linked_at FROM design_board_sessions ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(DesignBoardSession {
                board_id: row.get(0)?,
                session_id: row.get(1)?,
                linked_at: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

/// The board and the requested frames in order, else all its frames by `z`.
fn selected_frames(
    db: &Connection,
    board_id: &str,
    frame_ids: Option<&[String]>,
) -> Result<(DesignBoard, Vec<DesignFrame>)> {
    id(board_id)?;
    let found = board(db, board_id)?;
    let frames = match frame_ids {
        Some(frame_ids) => frame_ids
            .iter()
            .map(|frame_id| {
                require_frame_id(frame_id)?;
                frame(db, board_id, frame_id)
            })
            .collect::<Result<Vec<_>>>()?,
        None => query_frames(db, board_id, None)?,
    };
    if frames.is_empty() {
        return Err("Ce tableau ne contient aucun cadre.".into());
    }
    Ok((found, frames))
}

// shortcut: frames differing only by case (home/Home) collide in one launch directory on case-insensitive volumes and fail the launch; suffix colliding names if agents produce such ids.
fn handoff_filename(frame: &DesignFrame) -> String {
    format!("design-{}.html", frame.id)
}

fn screen_title(frame: &DesignFrame) -> &str {
    match frame.title.trim() {
        "" => &frame.id,
        title => title,
    }
}

fn board_index(name: &str, screens: &str) -> String {
    format!("# Design board \"{name}\"\n\nStatic HTML/CSS mockups, one file per screen. Reproduce their layout, styles and content with this project's stack and conventions; do not copy the HTML files into the project.\n\n{screens}")
}

pub(super) fn valid_frame_id(value: &str) -> bool {
    (1..=FRAME_ID_LIMIT).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn require_frame_id(value: &str) -> Result<()> {
    if valid_frame_id(value) {
        Ok(())
    } else {
        Err("Identifiant de cadre invalide.".into())
    }
}

fn board_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > BOARD_NAME_LIMIT {
        return Err("Nommez le tableau (100 caractères au plus).".into());
    }
    text(name, "Nom du tableau", 512)?;
    Ok(name.into())
}

fn decode_entities(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn clamp_size(value: f64) -> f64 {
    value.clamp(MIN_SIZE, MAX_SIZE)
}

fn attribute<'a>(tag: &'a str, key: &str) -> Option<&'a str> {
    ATTRIBUTE.captures_iter(tag).find_map(|attribute| {
        attribute[1]
            .eq_ignore_ascii_case(key)
            .then(|| (2..=4).find_map(|group| attribute.get(group)))
            .flatten()
            .map(|value| value.as_str())
    })
}

fn meta_size(html: &str) -> Option<(f64, f64)> {
    META.find_iter(html).find_map(|tag| {
        if !attribute(tag.as_str(), "name")?.eq_ignore_ascii_case("soreno-frame") {
            return None;
        }
        let (mut width, mut height) = (None, None);
        for dimension in DIMENSION.captures_iter(attribute(tag.as_str(), "content")?) {
            let value = dimension[2].parse::<f64>().ok();
            if dimension[1].eq_ignore_ascii_case("width") {
                width = value;
            } else {
                height = value;
            }
        }
        Some((clamp_size(width?), clamp_size(height?)))
    })
}

/// Errors go to the agent: they are in English.
pub(super) fn parse_frame(bytes: &[u8]) -> Result<FrameFile> {
    if bytes.len() > FRAME_LIMIT {
        return Err("the file is larger than 512 KiB.".into());
    }
    let html = std::str::from_utf8(bytes).map_err(|_| "the file is not valid UTF-8.")?;
    // Also tells a document still being written: the watcher retries it on the next scans.
    let end = html.trim_end().as_bytes();
    if !(end.len() >= 7 && end[end.len() - 7..].eq_ignore_ascii_case(b"</html>")) {
        return Err("the document must end with </html>.".into());
    }
    if html.contains('\0') {
        return Err("the file contains a NUL character.".into());
    }
    // Attribute names cannot be entity-encoded: refusing the name avoids parsing refresh values.
    if html.to_ascii_lowercase().contains("http-equiv") {
        return Err("meta http-equiv is not allowed.".into());
    }
    let title = TITLE
        .captures(html)
        .map(|captures| {
            decode_entities(&captures[1])
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(TITLE_LIMIT)
                .collect::<String>()
        })
        .filter(|title| !title.is_empty());
    Ok(FrameFile {
        title,
        size: meta_size(html),
        html: html.to_owned(),
    })
}

fn touch_board(db: &Connection, board_id: &str) -> Result<()> {
    db.execute(
        "UPDATE design_boards SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [board_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Replaces the frame's content, keeping its geometry, or places a new frame right of the
/// others; returns the board id. Errors go to the agent.
pub(super) fn ingest_frame(
    db: &Connection,
    session_id: &str,
    frame_id: &str,
    frame: FrameFile,
) -> Result<String> {
    let board_id: String = db
        .query_row(
            "SELECT id FROM design_boards WHERE session_id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("this session has no design board.")?;
    let replaced = db
        .execute(
            "UPDATE design_frames SET html=?3, title=COALESCE(?4,title), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE board_id=?1 AND id=?2",
            params![board_id, frame_id, frame.html, frame.title],
        )
        .map_err(|error| error.to_string())?;
    if replaced == 0 {
        ensure_frame_capacity(db, &board_id)?;
        let (width, height) = frame.size.unwrap_or(DEFAULT_SIZE);
        db.execute(
            "INSERT INTO design_frames(board_id,id,title,html,x,y,width,height,z,updated_at)
            SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(x+width)+?7, 0), 0, ?5, ?6, COALESCE(MAX(z), 0)+1, strftime('%Y-%m-%dT%H:%M:%fZ','now')
            FROM design_frames WHERE board_id=?1",
            params![
                board_id,
                frame_id,
                frame.title.as_deref().unwrap_or(frame_id),
                frame.html,
                width,
                height,
                FRAME_GAP
            ],
        )
        .map_err(|error| error.to_string())?;
    }
    touch_board(db, &board_id)?;
    Ok(board_id)
}

fn ensure_frame_capacity(db: &Connection, board_id: &str) -> Result<()> {
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM design_frames WHERE board_id=?1",
            [board_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if count >= FRAME_CAPACITY {
        return Err(format!(
            "the board already holds {FRAME_CAPACITY} frames; reuse an existing id."
        ));
    }
    Ok(())
}

fn validate_geometry(x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    if ![x, y].iter().all(|value| value.abs() <= COORDINATE_LIMIT)
        || ![width, height]
            .iter()
            .all(|value| (MIN_SIZE..=MAX_SIZE).contains(value))
    {
        return Err("Position ou taille de cadre invalide.".into());
    }
    Ok(())
}

fn query_boards(db: &Connection, board_id: Option<&str>) -> Result<Vec<DesignBoard>> {
    let mut statement = db
        .prepare(
            "SELECT b.id, b.name, NULLIF(s.project_id, ?2), b.session_id, b.created_at, b.updated_at
            FROM design_boards b JOIN agent_sessions s ON s.id=b.session_id
            WHERE ?1 IS NULL OR b.id=?1 ORDER BY b.updated_at DESC, b.rowid DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![board_id, PROJECT_ID], |row| {
            Ok(DesignBoard {
                id: row.get(0)?,
                name: row.get(1)?,
                project_id: row.get(2)?,
                session_id: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

fn board(db: &Connection, board_id: &str) -> Result<DesignBoard> {
    query_boards(db, Some(board_id))?
        .pop()
        .ok_or_else(|| BOARD_NOT_FOUND.into())
}

fn query_frames(
    db: &Connection,
    board_id: &str,
    frame_id: Option<&str>,
) -> Result<Vec<DesignFrame>> {
    let mut statement = db
        .prepare(
            "SELECT board_id, id, title, html, x, y, width, height, z, updated_at FROM design_frames
            WHERE board_id=?1 AND (?2 IS NULL OR id=?2) ORDER BY z, rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![board_id, frame_id], |row| {
            Ok(DesignFrame {
                board_id: row.get(0)?,
                id: row.get(1)?,
                title: row.get(2)?,
                html: row.get(3)?,
                x: row.get(4)?,
                y: row.get(5)?,
                width: row.get(6)?,
                height: row.get(7)?,
                z: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

fn frame(db: &Connection, board_id: &str, frame_id: &str) -> Result<DesignFrame> {
    query_frames(db, board_id, Some(frame_id))?
        .pop()
        .ok_or_else(|| FRAME_NOT_FOUND.into())
}

/// `~/.soreno/design`, created when missing.
fn design_directory() -> Result<String> {
    let path = std::env::home_dir()
        .ok_or("Dossier personnel introuvable.")?
        .join(".soreno")
        .join("design");
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Impossible de créer le dossier Design : {error}"))?;
    path.into_os_string()
        .into_string()
        .map_err(|_| "Chemin du dossier Design invalide.".into())
}

impl AgentSessions {
    pub fn design_boards(&self) -> Result<Vec<DesignBoard>> {
        query_boards(&lock(&self.store)?.db, None)
    }

    pub fn create_design_board(
        &self,
        name: &str,
        project_id: Option<&str>,
        executable: &str,
    ) -> Result<DesignBoard> {
        self.create_design_board_with(name, project_id, executable, design_directory)
    }

    /// Saves the board's hidden session through the regular path, without starting it.
    pub(super) fn create_design_board_with(
        &self,
        name: &str,
        project_id: Option<&str>,
        executable: &str,
        directory: impl FnOnce() -> Result<String>,
    ) -> Result<DesignBoard> {
        let name = board_name(name)?;
        if conversations::provider(executable).is_none() {
            return Err("Choisissez Claude Code, Codex, OMP ou Pi.".into());
        }
        let project_id = match project_id {
            Some(PROJECT_ID) => return Err("Projet introuvable.".into()),
            Some(project_id) => {
                id(project_id)?;
                require_project(&*lock(&self.store)?, project_id)?.id
            }
            None => {
                let project = AgentProject {
                    id: PROJECT_ID.into(),
                    name: "Design".into(),
                    path: directory()?,
                    environment: AgentEnvironment {
                        kind: "local".into(),
                        distribution: None,
                        ssh: None,
                    },
                    icon_data_url: None,
                    icon: None,
                    color: None,
                };
                validate_project(&project)?;
                // Rewritten each time: the home directory may have moved since.
                lock(&self.store)?
                    .db
                    .execute(
                        "INSERT INTO agent_projects(id,data) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                        params![project.id, serde_json::to_string(&project).map_err(|e| e.to_string())?],
                    )
                    .map_err(|error| error.to_string())?;
                project.id
            }
        };
        let session_id =
            crate::sqlite::random_id(&lock(&self.store)?.db).map_err(|error| error.to_string())?;
        self.save_session(AgentSession {
            id: session_id.clone(),
            project_id,
            // Session names are capped at 256 bytes, board names at 100 characters.
            name: name
                .char_indices()
                .take_while(|(index, character)| index + character.len_utf8() <= 256)
                .map(|(_, character)| character)
                .collect(),
            custom_name: None,
            kind: "terminal".into(),
            service_id: None,
            working_directory: None,
            executable: executable.into(),
            args: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            favorite: false,
            design: true,
        })?;
        self.insert_design_board(&name, &session_id)
            .inspect_err(|_| {
                let _ = self.delete_session(&session_id);
            })
    }

    fn insert_design_board(&self, name: &str, session_id: &str) -> Result<DesignBoard> {
        let store = lock(&self.store)?;
        let board_id = crate::sqlite::random_id(&store.db).map_err(|error| error.to_string())?;
        store
            .db
            .execute(
                "INSERT INTO design_boards(id,name,session_id,created_at,updated_at) VALUES (?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![board_id, name, session_id],
            )
            .map_err(|error| error.to_string())?;
        board(&store.db, &board_id)
    }

    pub fn rename_design_board(&self, board_id: &str, name: &str) -> Result<DesignBoard> {
        id(board_id)?;
        let name = board_name(name)?;
        let store = lock(&self.store)?;
        board(&store.db, board_id)?;
        store
            .db
            .execute(
                "UPDATE design_boards SET name=?2 WHERE id=?1",
                params![board_id, name],
            )
            .map_err(|error| error.to_string())?;
        board(&store.db, board_id)
    }

    /// Deleting the session cascades to the board and its frames; like any session, it is
    /// refused while the session runs.
    pub fn delete_design_board(&self, board_id: &str) -> Result<()> {
        id(board_id)?;
        let session_id = board(&lock(&self.store)?.db, board_id)?.session_id;
        self.delete_session(&session_id)
    }

    pub fn design_frames(&self, board_id: &str) -> Result<Vec<DesignFrame>> {
        id(board_id)?;
        let store = lock(&self.store)?;
        board(&store.db, board_id)?;
        query_frames(&store.db, board_id, None)
    }

    pub fn update_design_frame(
        &self,
        board_id: &str,
        frame_id: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        z: i64,
    ) -> Result<DesignFrame> {
        id(board_id)?;
        require_frame_id(frame_id)?;
        validate_geometry(x, y, width, height)?;
        self.kanban(|db, _| {
            frame(db, board_id, frame_id)?;
            db.execute(
                "UPDATE design_frames SET x=?3, y=?4, width=?5, height=?6, z=?7 WHERE board_id=?1 AND id=?2",
                params![board_id, frame_id, x, y, width, height, z],
            )
            .map_err(|error| error.to_string())?;
            touch_board(db, board_id)?;
            frame(db, board_id, frame_id)
        })
    }

    /// Puts back a deleted frame exactly as it was, for undo.
    pub fn restore_design_frame(&self, frame: DesignFrame) -> Result<DesignFrame> {
        id(&frame.board_id)?;
        require_frame_id(&frame.id)?;
        validate_geometry(frame.x, frame.y, frame.width, frame.height)?;
        let title = frame.title.trim();
        if title.is_empty() || title.chars().count() > TITLE_LIMIT || title.contains('\0') {
            return Err("Titre de cadre vide ou trop long (255 caractères au plus).".into());
        }
        parse_frame(frame.html.as_bytes())?;
        let restored = self.kanban(|db, _| {
            board(db, &frame.board_id)?;
            if !query_frames(db, &frame.board_id, Some(&frame.id))?.is_empty() {
                return Err("Un cadre porte déjà cet identifiant.".into());
            }
            ensure_frame_capacity(db, &frame.board_id)?;
            db.execute(
                "INSERT INTO design_frames(board_id,id,title,html,x,y,width,height,z,updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![
                    frame.board_id,
                    frame.id,
                    title,
                    frame.html,
                    frame.x,
                    frame.y,
                    frame.width,
                    frame.height,
                    frame.z
                ],
            )
            .map_err(|error| error.to_string())?;
            touch_board(db, &frame.board_id)?;
            self::frame(db, &frame.board_id, &frame.id)
        })?;
        self.sync_design_frame(&restored.board_id, &restored.id);
        Ok(restored)
    }

    /// The copy is named `<id>-copy`, then `<id>-copy-2`…, offset and put on top.
    pub fn duplicate_design_frame(&self, board_id: &str, frame_id: &str) -> Result<DesignFrame> {
        id(board_id)?;
        require_frame_id(frame_id)?;
        let copy = self.kanban(|db, _| {
            let source = frame(db, board_id, frame_id)?;
            ensure_frame_capacity(db, board_id)?;
            let copy_id = (1..)
                .map(|index| {
                    let suffix = if index == 1 {
                        "-copy".to_owned()
                    } else {
                        format!("-copy-{index}")
                    };
                    let base = &frame_id[..frame_id.len().min(FRAME_ID_LIMIT - suffix.len())];
                    format!("{base}{suffix}")
                })
                .find(|candidate| {
                    !query_frames(db, board_id, Some(candidate)).is_ok_and(|found| !found.is_empty())
                })
                .expect("unbounded candidates");
            db.execute(
                "INSERT INTO design_frames(board_id,id,title,html,x,y,width,height,z,updated_at)
                SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, MAX(z)+1, strftime('%Y-%m-%dT%H:%M:%fZ','now')
                FROM design_frames WHERE board_id=?1",
                params![
                    board_id,
                    copy_id,
                    source.title,
                    source.html,
                    source.x + DUPLICATE_OFFSET,
                    source.y + DUPLICATE_OFFSET,
                    source.width,
                    source.height
                ],
            )
            .map_err(|error| error.to_string())?;
            touch_board(db, board_id)?;
            frame(db, board_id, &copy_id)
        })?;
        self.sync_design_frame(board_id, &copy.id);
        Ok(copy)
    }

    /// Returns the frame as it was deleted, for undo.
    pub fn delete_design_frame(&self, board_id: &str, frame_id: &str) -> Result<DesignFrame> {
        id(board_id)?;
        require_frame_id(frame_id)?;
        let deleted = self.kanban(|db, _| {
            let deleted = frame(db, board_id, frame_id)?;
            db.execute(
                "DELETE FROM design_frames WHERE board_id=?1 AND id=?2",
                params![board_id, frame_id],
            )
            .map_err(|error| error.to_string())?;
            touch_board(db, board_id)?;
            Ok(deleted)
        })?;
        self.sync_design_frame(board_id, frame_id);
        Ok(deleted)
    }
}

pub(super) const NOT_RUNNING: &str = "Démarrez l’agent pour lui transmettre le design.";

impl AgentSessions {
    /// Replaces the session's previous board, if any.
    pub fn link_design_session(&self, session_id: &str, board_id: &str) -> Result<()> {
        id(session_id)?;
        id(board_id)?;
        self.kanban(|db, _| {
            let session: AgentSession =
                get(db, "agent_sessions", session_id)?.ok_or("Session introuvable.")?;
            if session.design || session.kind == "service" {
                return Err("Seul un agent de code peut être lié à un tableau Design.".into());
            }
            board(db, board_id)?;
            db.execute(
                "DELETE FROM design_board_sessions WHERE session_id=?1",
                [session_id],
            )
            .map_err(|error| error.to_string())?;
            db.execute(
                "INSERT INTO design_board_sessions(board_id,session_id,linked_at) VALUES (?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![board_id, session_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn unlink_design_session(&self, session_id: &str) -> Result<()> {
        id(session_id)?;
        self.kanban(|db, _| {
            db.execute(
                "DELETE FROM design_board_sessions WHERE session_id=?1",
                [session_id],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
    }

    /// `instructions.md` when the user wrote some, the `design-board.md` index, then one
    /// `design-<frame id>.html` launch attachment per selected frame.
    pub fn design_prompt_attachments(
        &self,
        selection: &DesignFrameSelection,
    ) -> Result<Vec<PromptAttachment>> {
        let instructions = selection
            .instructions
            .as_deref()
            .map(str::trim)
            .filter(|instructions| !instructions.is_empty());
        if instructions.is_some_and(|instructions| {
            instructions.len() > INSTRUCTIONS_LIMIT || instructions.contains('\0')
        }) {
            return Err(
                "Instructions trop longues (16 Kio au plus) ou contenant un caractère nul.".into(),
            );
        }
        let store = lock(&self.store)?;
        let (found, frames) =
            selected_frames(&store.db, &selection.board_id, Some(&selection.frame_ids))?;
        // shortcut: a `]` in a frame title breaks its Markdown link, the file name still shows the frame; escape titles if agents write such titles.
        let screens = frames
            .iter()
            .map(|frame| {
                format!(
                    "- [{}]({}) ({:.0}×{:.0})\n",
                    screen_title(frame),
                    handoff_filename(frame),
                    frame.width,
                    frame.height
                )
            })
            .collect::<String>();
        Ok(instructions
            .map(|instructions| PromptAttachment {
                filename: INSTRUCTIONS_FILENAME.into(),
                bytes: instructions.as_bytes().to_vec(),
            })
            .into_iter()
            .chain([PromptAttachment {
                filename: BOARD_INDEX_FILENAME.into(),
                bytes: board_index(&found.name, &screens).into_bytes(),
            }])
            .chain(frames.into_iter().map(|frame| PromptAttachment {
                filename: handoff_filename(&frame),
                bytes: frame.html.into_bytes(),
            }))
            .collect())
    }

    /// Drops the frames into the running session's private directory and queues a message
    /// naming them; `true` asks the caller to start the session's delivery worker.
    pub fn send_design_to_session(
        &self,
        session_id: &str,
        board_id: &str,
        frame_ids: Option<&[String]>,
        update: bool,
    ) -> Result<(AgentSessionMessage, bool)> {
        id(session_id)?;
        let (found, frames, message_id) = {
            let store = lock(&self.store)?;
            if require_session(&store, session_id)?.design {
                return Err("Seul un agent de code peut recevoir un tableau Design.".into());
            }
            if runtime_status(&store, session_id)?.state != "running" {
                return Err(NOT_RUNNING.into());
            }
            let (found, frames) = selected_frames(&store.db, board_id, frame_ids)?;
            let message_id =
                crate::sqlite::random_id(&store.db).map_err(|error| error.to_string())?;
            (found, frames, message_id)
        };
        let screens = frames
            .iter()
            .map(|frame| {
                let path =
                    self.attach_file(session_id, &handoff_filename(frame), frame.html.as_bytes())?;
                Ok(format!(
                    "- {} ({:.0}×{:.0}): `{path}`\n",
                    screen_title(frame),
                    frame.width,
                    frame.height
                ))
            })
            .collect::<Result<String>>()?;
        let index = board_index(&found.name, &screens);
        let index = self.attach_file(session_id, BOARD_INDEX_FILENAME, index.as_bytes())?;
        let body = if update {
            format!(
                "Soreno: design board \"{}\" was updated; its screens are listed in {index}. Use this version as the reference. Reply with one short acknowledgement; do not read the files or change your work until the user asks.",
                found.name
            )
        } else {
            format!(
                "Soreno: this session is now linked to design board \"{}\"; its screens are listed in {index}. These static HTML/CSS mockups are context for your current work. Reply with one short acknowledgement; do not read the files or start implementing until the user asks.",
                found.name
            )
        };
        // shortcut: a run ending between the deposit and this call queues the message for the next start with paths its cleanup removed; bind both to one run if users get dead paths.
        self.send_message(session_id, &message_id, &body)
    }
}

// shortcut: an id that Windows reserves (con, aux, nul…) cannot be mirrored there and is skipped;
// prefix the mirror names if users create such frames.
fn mirror_name(frame_id: &str) -> String {
    format!("{frame_id}.html")
}

fn windows_reserved(frame_id: &str) -> bool {
    let stem = frame_id
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Writes, or removes without `content`, `name` in a run's private directory, or with `mirror`
/// in its frame mirror beside it, which its confined agent cannot write. A temporary file created
/// exclusively then renamed into place never follows a planted link, and the agent never copies
/// a half-written file.
pub(super) fn write_private(
    local: &Mutex<Option<PathBuf>>,
    remote: Option<&RemoteClipboard>,
    mirror: bool,
    name: &str,
    content: Option<&[u8]>,
) -> Result<()> {
    let Some(directory) = lock(local)?.clone() else {
        return match remote {
            Some(remote) => remote.write_private(mirror, name, content),
            None => Ok(()),
        };
    };
    let parent = if mirror {
        let parent = mirror_directory(&directory);
        match std::fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err("Le miroir des cadres n’est pas un dossier.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if content.is_none() {
                    return Ok(());
                }
                std::fs::create_dir(&parent).map_err(|error| error.to_string())?;
                #[cfg(unix)]
                std::fs::set_permissions(
                    &parent,
                    std::os::unix::fs::PermissionsExt::from_mode(0o700),
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        parent
    } else {
        directory
    };
    let path = parent.join(name);
    let Some(content) = content else {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    };
    let (draft, mut file) = (0..)
        .find_map(|attempt| {
            let draft = parent.join(format!(".soreno-{}-{attempt}.tmp", std::process::id()));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&draft) {
                Ok(file) => Some(Ok((draft, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error.to_string())),
            }
        })
        .expect("unbounded attempts")?;
    let written = std::io::Write::write_all(&mut file, content)
        .map_err(|error| error.to_string())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&draft, &path).map_err(|error| error.to_string())
        });
    if written.is_err() {
        let _ = std::fs::remove_file(&draft);
    }
    written
}

fn clear_mirror(local: &Mutex<Option<PathBuf>>, remote: Option<&RemoteClipboard>) -> Result<()> {
    let Some(directory) = lock(local)?.clone() else {
        return match remote {
            Some(remote) => remote.clear_design_mirror(),
            None => Ok(()),
        };
    };
    let frames = mirror_directory(&directory);
    if !std::fs::symlink_metadata(&frames).is_ok_and(|metadata| metadata.file_type().is_dir()) {
        return Ok(());
    }
    for entry in std::fs::read_dir(&frames).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().ends_with(".html")
            && !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

impl AgentSessions {
    /// Writes the run's design instruction file, then mirrors every frame of the session's board,
    /// dropping the mirror of frames deleted since; any frame left unwritten fails it, after the
    /// others are written, so the caller retries.
    pub(super) fn write_design_mirror(
        &self,
        session_id: &str,
        local: &Mutex<Option<PathBuf>>,
        remote: Option<&RemoteClipboard>,
    ) -> Result<()> {
        let _mirror = lock(&self.design_mirror)?;
        let (frames, environment) = {
            let store = lock(&self.store)?;
            let session = require_session(&store, session_id)?;
            let board_id: String = store
                .db
                .query_row(
                    "SELECT id FROM design_boards WHERE session_id=?1",
                    [session_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            (
                query_frames(&store.db, &board_id, None)?,
                require_project(&store, &session.project_id)?.environment,
            )
        };
        let directory = match lock(local)?.clone() {
            Some(directory) => agent_local_path(
                &environment,
                directory
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Chemin temporaire local non UTF-8.".to_string())?,
            )?,
            None => match remote {
                Some(remote) => remote.ensure_directory()?,
                None => return Ok(()),
            },
        };
        write_private(
            local,
            remote,
            false,
            INSTRUCTION_FILENAME,
            Some(instruction(&directory).as_bytes()),
        )?;
        clear_mirror(local, remote)?;
        let windows_local = cfg!(windows) && lock(local)?.is_some();
        let mut failed = false;
        for frame in frames {
            if windows_local && windows_reserved(&frame.id) {
                continue;
            }
            let name = mirror_name(&frame.id);
            let content = Some(frame.html.as_bytes());
            if let Err(error) = write_private(local, remote, true, &name, content) {
                eprintln!("Miroir du cadre Design {} : {error}", frame.id);
                failed = true;
            }
        }
        if failed {
            return Err(
                "Miroir des cadres Design incomplet, nouvel essai au prochain passage.".into(),
            );
        }
        Ok(())
    }

    /// Mirrors the stored state of one frame into the board session's running run, if any;
    /// a failure is only logged: the next start rewrites the mirror.
    pub(super) fn sync_design_frame(&self, board_id: &str, frame_id: &str) {
        let sync = || -> Result<()> {
            let _mirror = lock(&self.design_mirror)?;
            let (runtime, html) = {
                let store = lock(&self.store)?;
                let session_id = board(&store.db, board_id)?.session_id;
                let Some(runtime) = store.runtimes.get(&session_id).cloned() else {
                    return Ok(());
                };
                let html = query_frames(&store.db, board_id, Some(frame_id))?
                    .pop()
                    .map(|frame| frame.html);
                (runtime, html)
            };
            if lock(&runtime.output)?.exited {
                return Ok(());
            }
            write_private(
                &runtime.local_attachment_directory,
                runtime.remote_clipboard.as_ref(),
                true,
                &mirror_name(frame_id),
                html.as_deref().map(str::as_bytes),
            )
        };
        if let Err(error) = sync() {
            eprintln!("Miroir du cadre Design {frame_id} : {error}");
        }
    }
}

const RESTRICTION_FAILED: &str = "Impossible de restreindre l’agent Design à son dossier privé : le chemin de ce dossier contient un caractère non pris en charge.";

/// Confines a design agent: it reads anything, writes only in its private `directory`, runs no
/// command but copy, move and list, and is never stopped by a permission prompt.
pub(super) fn restrict_launch(
    args: &mut Vec<String>,
    provider: Provider,
    directory: &str,
    windows_local: bool,
) -> Result<()> {
    let restrictions = match provider {
        Provider::Claude => {
            // Claude matches absolute paths as `//path`, Windows ones as `//c/Users/…`.
            let path = match directory.as_bytes() {
                [drive, b':', b'\\' | b'/', ..] if windows_local => format!(
                    "{}/{}",
                    (*drive as char).to_ascii_lowercase(),
                    directory[3..].replace('\\', "/")
                ),
                _ => directory.trim_start_matches('/').to_owned(),
            };
            // Its rule list splits on commas and spaces outside parentheses only.
            if path.contains(['(', ')']) {
                return Err(RESTRICTION_FAILED.into());
            }
            // Rules match gitignore-style patterns: the folder's own name is taken literally.
            let path = path
                .trim_end_matches('/')
                .split('/')
                .map(|segment| {
                    segment
                        .chars()
                        .enumerate()
                        .fold(String::new(), |mut escaped, (index, ch)| {
                            if matches!(ch, '[' | ']' | '*' | '?' | '\\')
                                || (index == 0 && ch == '!')
                            {
                                escaped.push('\\');
                            }
                            escaped.push(ch);
                            escaped
                        })
                })
                .collect::<Vec<_>>()
                .join("/");
            vec![
                // shortcut: allow rules from the user's own Claude settings still apply; isolate
                // permissions without dropping their auth and env if users need a stricter designer.
                "--permission-mode".into(),
                "dontAsk".into(),
                format!("--allowedTools=Read,Glob,Grep,Edit(//{path}/**),Write(//{path}/**),Bash(cp *),Bash(mv *),Bash(ls *)"),
            ]
        }
        Provider::Codex => {
            let encode = |text: &str| {
                super::codex_overrides::toml_string(text, windows_local)
                    .ok_or_else(|| RESTRICTION_FAILED.to_owned())
            };
            vec![
                "--ask-for-approval".into(),
                "never".into(),
                "-c".into(),
                format!("default_permissions={}", encode("soreno_design")?),
                "-c".into(),
                format!(
                    "permissions.soreno_design.filesystem={{{}={},{}={}}}",
                    encode(":root")?,
                    encode("read")?,
                    encode(directory)?,
                    encode("write")?
                ),
            ]
        }
        Provider::Omp => vec![
            "--tools=read,grep,glob,edit,write".into(),
            "--approval-mode=yolo".into(),
        ],
        Provider::Pi => vec!["--tools".into(), "read,grep,find,ls,edit,write".into()],
    };
    args.splice(0..0, restrictions);
    Ok(())
}
