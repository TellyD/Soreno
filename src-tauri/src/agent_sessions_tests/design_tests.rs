use super::*;

fn board_state() -> (AgentSessions, PathBuf) {
    let state = memory_state();
    state.save_project(project()).unwrap();
    let directory = unique_temp_path("soreno-design");
    std::fs::create_dir_all(&directory).unwrap();
    (state, directory)
}

fn create_board(state: &AgentSessions, project_id: Option<&str>, directory: &Path) -> DesignBoard {
    state
        .create_design_board_with(" Maquettes ", project_id, "claude", || {
            Ok(directory.to_str().unwrap().into())
        })
        .unwrap()
}

fn ingest(
    state: &AgentSessions,
    board: &DesignBoard,
    frame_id: &str,
    html: &str,
) -> Result<String> {
    state.kanban(|db, _| {
        design::ingest_frame(
            db,
            &board.session_id,
            frame_id,
            design::parse_frame(format!("{html}</html>").as_bytes())?,
        )
    })
}

fn geometry(frame: &DesignFrame) -> (f64, f64, f64, f64, i64) {
    (frame.x, frame.y, frame.width, frame.height, frame.z)
}

#[test]
fn a_design_session_is_never_a_service_and_keeps_its_design_flag() {
    let state = memory_state();
    state.save_project(project()).unwrap();
    assert!(state
        .save_session(AgentSession {
            kind: "service".into(),
            service_id: Some("web".into()),
            working_directory: Some("/app".into()),
            design: true,
            ..session()
        })
        .is_err());
    state.save_session(session()).unwrap();
    assert!(state
        .save_session(AgentSession {
            design: true,
            ..session()
        })
        .is_err());
    let (state, directory) = board_state();
    let board = create_board(&state, None, &directory);
    let hidden = require_session(&lock(&state.store).unwrap(), &board.session_id).unwrap();
    assert!(state
        .save_session(AgentSession {
            design: false,
            ..hidden
        })
        .is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_board_owns_its_hidden_session_and_frames_until_deleted() {
    let (state, directory) = board_state();
    assert!(state
        .create_design_board_with("Shell", None, "bash", || unreachable!())
        .is_err());
    let loose = create_board(&state, None, &directory);
    assert_eq!(
        (loose.name.as_str(), loose.project_id.as_deref()),
        ("Maquettes", None)
    );
    let session = require_session(&lock(&state.store).unwrap(), &loose.session_id).unwrap();
    assert!(session.design && session.kind == "terminal" && session.executable == "claude");
    assert_eq!(session.project_id, design::PROJECT_ID);
    let design_project = state.project(design::PROJECT_ID).unwrap();
    assert_eq!(design_project.path, directory.to_str().unwrap());
    assert!(state.save_project(design_project).is_err());
    assert!(state.delete_project(design::PROJECT_ID).is_err());
    let cjk = "設".repeat(100);
    let wide = state
        .create_design_board_with(&cjk, None, "codex", || {
            Ok(directory.to_str().unwrap().into())
        })
        .unwrap();
    assert_eq!(wide.name, cjk);
    let session = require_session(&lock(&state.store).unwrap(), &wide.session_id).unwrap();
    assert_eq!(session.name, "設".repeat(85));
    state.delete_design_board(&wide.id).unwrap();

    let attached = create_board(&state, Some("project"), &directory);
    assert_eq!(attached.project_id.as_deref(), Some("project"));
    ingest(&state, &loose, "home", "<p>Home</p>").unwrap();
    ingest(&state, &attached, "home", "<p>Home</p>").unwrap();
    let renamed = state.rename_design_board(&loose.id, "Accueil").unwrap();
    assert_eq!(renamed.name, "Accueil");

    state.delete_design_board(&loose.id).unwrap();
    assert!(require_session(&lock(&state.store).unwrap(), &loose.session_id).is_err());
    assert!(state.design_frames(&loose.id).is_err());
    let orphan_frames: i64 = lock(&state.store)
        .unwrap()
        .db
        .query_row(
            "SELECT count(*) FROM design_frames WHERE board_id=?1",
            [&loose.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan_frames, 0);
    // Deleting the project deletes its sessions, hence its boards.
    state.delete_project("project").unwrap();
    assert!(state.design_boards().unwrap().is_empty());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn ingested_frames_are_placed_once_then_keep_their_geometry() {
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    ingest(
        &state,
        &board,
        "home",
        "<html><head><title> Home &amp; login </title><meta content=\"width=1440, height=900\" name=\"soreno-frame\"></head>",
    )
    .unwrap();
    ingest(
        &state,
        &board,
        "card",
        "<meta name=soreno-frame content=width=20,height=9000><p>Card</p>",
    )
    .unwrap();
    let frames = state.design_frames(&board.id).unwrap();
    assert_eq!(
        frames
            .iter()
            .map(|frame| (frame.id.as_str(), frame.title.as_str(), geometry(frame)))
            .collect::<Vec<_>>(),
        [
            ("home", "Home & login", (0.0, 0.0, 1440.0, 900.0, 1)),
            ("card", "card", (1520.0, 0.0, 120.0, 4096.0, 2)),
        ]
    );
    state
        .update_design_frame(&board.id, "home", -50.0, 30.0, 800.0, 600.0, 7)
        .unwrap();
    ingest(
        &state,
        &board,
        "home",
        "<title> </title><meta name=\"soreno-frame\" content=\"width=300, height=300\"><p>v2</p>",
    )
    .unwrap();
    let home = state
        .design_frames(&board.id)
        .unwrap()
        .into_iter()
        .find(|frame| frame.id == "home")
        .unwrap();
    assert_eq!(
        (
            home.title.as_str(),
            home.html.contains("v2"),
            geometry(&home)
        ),
        ("Home & login", true, (-50.0, 30.0, 800.0, 600.0, 7))
    );
    assert!(state
        .update_design_frame(&board.id, "home", 0.0, 0.0, 80.0, 600.0, 7)
        .is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn invalid_frame_files_are_refused() {
    for refused in [
        b"\xff\xfe</html>".as_slice(),
        b" \n",
        b"<!DOCTYPE html><title>Half written",
        b"<meta http-equiv=Refresh content=0;url=https://example.com></html>",
        b"<meta content='0' HTTP-EQUIV='refresh'></html>",
        b"<meta title='>' http-equiv=\"refr&#101;sh\" content=0;url=https://example.com></html>",
    ] {
        assert!(design::parse_frame(refused).is_err(), "{refused:?}");
    }
    assert!(design::parse_frame(&vec![b'a'; design::FRAME_LIMIT + 1]).is_err());
    assert!(design::parse_frame(b"<meta charset=utf-8></HTML>\n").is_ok());
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    let other = memory_state();
    other.save_project(project()).unwrap();
    other.save_session(session()).unwrap();
    assert!(other
        .kanban(|db, _| design::ingest_frame(
            db,
            "session",
            "home",
            design::parse_frame(b"<p></html>").unwrap()
        ))
        .is_err());
    assert!(state.design_frames(&board.id).unwrap().is_empty());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_duplicate_takes_the_next_free_copy_id_on_top() {
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    ingest(&state, &board, "home", "<title>Home</title>").unwrap();
    let first = state.duplicate_design_frame(&board.id, "home").unwrap();
    let second = state.duplicate_design_frame(&board.id, "home").unwrap();
    assert_eq!(
        (first.id.as_str(), first.title.as_str(), geometry(&first)),
        ("home-copy", "Home", (40.0, 40.0, 1280.0, 800.0, 2))
    );
    assert_eq!(
        (second.id.as_str(), geometry(&second)),
        ("home-copy-2", (40.0, 40.0, 1280.0, 800.0, 3))
    );
    let long = "a".repeat(100);
    ingest(&state, &board, &long, "<p>").unwrap();
    let copy = state.duplicate_design_frame(&board.id, &long).unwrap();
    assert_eq!(copy.id, format!("{}-copy", "a".repeat(95)));
    state.delete_design_frame(&board.id, "home").unwrap();
    assert!(state.duplicate_design_frame(&board.id, "home").is_err());
    let count = || state.design_frames(&board.id).unwrap().len() as i64;
    let missing = design::FRAME_CAPACITY - count();
    lock(&state.store)
        .unwrap()
        .db
        .execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?2)
            INSERT INTO design_frames(board_id,id,title,html,x,y,width,height,z,updated_at)
            SELECT ?1, 'filler-' || i, 'Filler', '</html>', 0, 0, 120, 120, 0, '' FROM n",
            params![board.id, missing],
        )
        .unwrap();
    assert_eq!(count(), design::FRAME_CAPACITY);
    assert!(state.duplicate_design_frame(&board.id, &long).is_err());
    assert_eq!(count(), design::FRAME_CAPACITY);
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_deleted_frame_is_restored_as_it_was_once() {
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    ingest(&state, &board, "home", "<title>Home</title>").unwrap();
    state
        .update_design_frame(&board.id, "home", -50.0, 30.0, 800.0, 600.0, 7)
        .unwrap();
    // The agent rewrites the frame after the front's last snapshot.
    ingest(&state, &board, "home", "<title>Home</title><p>v2</p>").unwrap();
    let stored = state.design_frames(&board.id).unwrap().pop().unwrap();
    let moved = state.delete_design_frame(&board.id, "home").unwrap();
    assert_eq!(moved, stored);
    assert!(moved.html.contains("v2"));
    let restored = state.restore_design_frame(moved.clone()).unwrap();
    assert_eq!(
        (
            restored.title.as_str(),
            restored.html.as_str(),
            geometry(&restored)
        ),
        ("Home", moved.html.as_str(), geometry(&moved))
    );
    assert_eq!(state.design_frames(&board.id).unwrap(), [restored]);
    assert!(state.restore_design_frame(moved.clone()).is_err());
    assert!(state
        .restore_design_frame(DesignFrame {
            id: "other".into(),
            html: "<meta http-equiv=refresh></html>".into(),
            ..moved
        })
        .is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn a_design_agent_gets_the_design_instruction_and_its_frames_are_ingested() {
    use std::os::unix::fs::PermissionsExt;

    let (state, directory) = board_state();
    std::fs::create_dir_all(&directory).unwrap();
    let executable = directory.join("claude");
    std::fs::write(
        &executable,
        "#!/bin/sh\n: > \"$0.argv\"\nfor arg do printf '%s\\0' \"$arg\" >> \"$0.argv\"; done\n: > \"$0.ready\"\nexec sleep 30\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let board = state
        .create_design_board_with(
            "Maquettes",
            Some("project"),
            executable.to_str().unwrap(),
            || unreachable!(),
        )
        .unwrap();
    state.start(&board.session_id, 80, 24, None).unwrap();
    wait_for(|| directory.join("claude.ready").exists());
    let runtime = state.runtime(&board.session_id).unwrap().unwrap();
    let private = lock(&runtime.local_attachment_directory)
        .unwrap()
        .clone()
        .unwrap();
    let argv = std::fs::read_to_string(directory.join("claude.argv")).unwrap();
    let argv = argv.split_terminator('\0').collect::<Vec<_>>();
    let prompt = argv
        .windows(2)
        .find(|pair| pair[0] == "--append-system-prompt")
        .map(|pair| pair[1])
        .unwrap();
    assert_eq!(prompt, design::instruction(private.to_str().unwrap()));
    assert!(argv
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "dontAsk"]));
    assert!(argv.contains(&format!(
        "--allowedTools=Read,Glob,Grep,Edit(/{0}/**),Write(/{0}/**),Bash(cp *),Bash(mv *),Bash(ls *)",
        private.to_str().unwrap()
    )
    .as_str()));

    std::fs::write(private.join("kanban-issue-a.json"), r#"{"title": "A"}"#).unwrap();
    let frame = private.join("design-frame-home.html");
    std::fs::write(&frame, "<!DOCTYPE html><title>Home</title>").unwrap();
    let mut watcher = state
        .issue_request_watcher(&board.session_id)
        .unwrap()
        .unwrap();
    assert!(matches!(
        state.scan_issue_request(&mut watcher).unwrap(),
        IssueRequestScan::Idle
    ));
    assert!(frame.exists());
    std::fs::write(&frame, "<!DOCTYPE html><title>Home</title></html>\n").unwrap();
    assert!(watcher.is_design());
    let handle = |watcher: &mut IssueRequestWatcher| {
        let IssueRequestScan::Request(found) = state.scan_issue_request(watcher).unwrap() else {
            panic!("frame expected");
        };
        state.handle_design_frame(watcher, found).unwrap().unwrap()
    };
    let outcome = handle(&mut watcher);
    assert_eq!(outcome.board_id.as_deref(), Some(board.id.as_str()));
    assert!(!outcome.queued);
    assert!(!private.join("design-frame-home.html").exists());
    assert_eq!(state.design_frames(&board.id).unwrap()[0].title, "Home");

    std::fs::write(
        private.join("design-frame-big.html"),
        vec![b'a'; design::FRAME_LIMIT + 1],
    )
    .unwrap();
    let outcome = handle(&mut watcher);
    assert!(outcome.board_id.is_none() && outcome.queued);
    let replies = state.session_messages(&board.session_id).unwrap();
    assert!(replies[0]
        .body
        .starts_with("Soreno: the design frame \"big\" was not saved"));
    assert!(matches!(
        state.scan_issue_request(&mut watcher).unwrap(),
        IssueRequestScan::Idle
    ));
    assert!(private.join("kanban-issue-a.json").exists());
    assert_eq!(state.design_frames(&board.id).unwrap().len(), 1);

    state.stop(&board.session_id).unwrap();
    state.shutdown();
    std::fs::remove_dir_all(&directory).unwrap();
}

fn coder(state: &AgentSessions) {
    state
        .save_session(AgentSession {
            id: "coder".into(),
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30".into()],
            ..session()
        })
        .unwrap();
}

fn links(state: &AgentSessions) -> Vec<(String, String)> {
    state
        .workspace()
        .unwrap()
        .design_board_sessions
        .into_iter()
        .map(|link| (link.board_id, link.session_id))
        .collect()
}

#[test]
fn a_coding_session_follows_one_board_until_either_is_deleted() {
    let (state, directory) = board_state();
    let first = create_board(&state, Some("project"), &directory);
    let second = create_board(&state, Some("project"), &directory);
    coder(&state);
    state
        .save_session(AgentSession {
            id: "service".into(),
            kind: "service".into(),
            service_id: Some("web".into()),
            working_directory: Some("/app".into()),
            ..session()
        })
        .unwrap();
    for session_id in [first.session_id.as_str(), "service"] {
        assert!(state.link_design_session(session_id, &first.id).is_err());
    }
    assert!(state.link_design_session("coder", "missing").is_err());

    state.link_design_session("coder", &first.id).unwrap();
    state.link_design_session("coder", &second.id).unwrap();
    assert_eq!(links(&state), [(second.id.clone(), "coder".into())]);
    state.unlink_design_session("coder").unwrap();
    assert!(links(&state).is_empty());

    state.link_design_session("coder", &first.id).unwrap();
    state.delete_design_board(&first.id).unwrap();
    assert!(links(&state).is_empty());
    state.link_design_session("coder", &second.id).unwrap();
    state.delete_session("coder").unwrap();
    assert!(links(&state).is_empty());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn launch_attachments_hold_the_selected_frames_of_the_board_only() {
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    let other = create_board(&state, Some("project"), &directory);
    ingest(&state, &board, "home", "<title>Home</title>").unwrap();
    ingest(&state, &board, "card", "<title>Card</title>").unwrap();
    ingest(&state, &other, "elsewhere", "<p>").unwrap();
    let selection = |frame_ids: &[&str], instructions: Option<&str>| DesignFrameSelection {
        board_id: board.id.clone(),
        frame_ids: frame_ids.iter().map(|id| (*id).into()).collect(),
        instructions: instructions.map(Into::into),
    };
    let attachments = state
        .design_prompt_attachments(&selection(&["card", "home"], Some("  Use Tailwind.\n")))
        .unwrap();
    assert_eq!(
        attachments
            .iter()
            .map(|file| (file.filename.as_str(), String::from_utf8_lossy(&file.bytes)))
            .collect::<Vec<_>>(),
        [
            ("instructions.md", "Use Tailwind.".into()),
            ("design-card.html", "<title>Card</title></html>".into()),
            ("design-home.html", "<title>Home</title></html>".into()),
        ]
    );
    assert_eq!(
        state
            .design_prompt_attachments(&selection(&["home"], Some(" \n")))
            .unwrap()
            .len(),
        1
    );
    assert!(state
        .design_prompt_attachments(&selection(&["home"], Some(&"a".repeat(16 * 1024 + 1))))
        .is_err());
    assert!(state
        .design_prompt_attachments(&selection(&["elsewhere"], None))
        .is_err());
    // A Windows launch line is bounded: many frames still take one short entry.
    let many = std::iter::once(PromptAttachment {
        filename: "instructions.md".into(),
        bytes: Vec::new(),
    })
    .chain((0..100).map(|index| PromptAttachment {
        filename: format!("design-{index:036}.html"),
        bytes: Vec::new(),
    }))
    .collect::<Vec<_>>();
    assert_eq!(
        prompt_with_attachments("Build it.", "/tmp/prompt", &many),
        "Build it.\n\nAttached files in /tmp/prompt: instructions.md, 100 design-*.html files (one per screen, named design-<frame id>.html)"
    );
    std::fs::remove_dir_all(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn a_running_agent_receives_the_frames_and_a_message_naming_them() {
    let (state, directory) = board_state();
    let board = create_board(&state, Some("project"), &directory);
    ingest(&state, &board, "home", "<title>Home</title>").unwrap();
    coder(&state);
    assert!(state
        .send_design_to_session("coder", &board.id, None, false)
        .is_err_and(|error| error == design::NOT_RUNNING));

    state.start("coder", 80, 24, None).unwrap();
    let (message, _) = state
        .send_design_to_session("coder", &board.id, None, false)
        .unwrap();
    let runtime = state.runtime("coder").unwrap().unwrap();
    let private = lock(&runtime.local_attachment_directory)
        .unwrap()
        .clone()
        .unwrap();
    assert!(message.body.starts_with(
        "Soreno: this session is now linked to design board \"Maquettes\". Screens: Home (1280x800): "
    ));
    assert!(message
        .body
        .contains(". These static HTML/CSS mockups are context for your current work. Reply with one short acknowledgement; do not read the files or start implementing until the user asks."));
    let path = message
        .body
        .split_once("Home (1280x800): ")
        .and_then(|(_, rest)| rest.split_once(". These"))
        .map(|(path, _)| PathBuf::from(path.trim_matches('\'')))
        .unwrap();
    assert!(path.starts_with(&private) && path.ends_with("design-home.html"));
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "<title>Home</title></html>"
    );
    let (update, _) = state
        .send_design_to_session("coder", &board.id, None, true)
        .unwrap();
    assert!(update
        .body
        .starts_with("Soreno: design board \"Maquettes\" was updated. Screens: Home (1280x800): "));
    assert!(update.body.ends_with(
        ". Use this version as the reference. Reply with one short acknowledgement; do not read the files or change your work until the user asks."
    ));
    state.stop("coder").unwrap();
    state.shutdown();
    std::fs::remove_dir_all(&directory).unwrap();
}

#[cfg(unix)]
#[test]
fn the_running_design_agent_sees_every_frame_in_its_mirror() {
    use std::os::unix::fs::PermissionsExt;

    let (state, directory) = board_state();
    let executable = directory.join("claude");
    std::fs::write(&executable, "#!/bin/sh\nexec sleep 30\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let board = state
        .create_design_board_with(
            "Maquettes",
            Some("project"),
            executable.to_str().unwrap(),
            || unreachable!(),
        )
        .unwrap();
    ingest(&state, &board, "home", "<title>Home</title>").unwrap();
    // The mirror follows the board only while its agent runs.
    state.duplicate_design_frame(&board.id, "home").unwrap();
    state.delete_design_frame(&board.id, "home-copy").unwrap();

    state.start(&board.session_id, 80, 24, None).unwrap();
    let runtime = state.runtime(&board.session_id).unwrap().unwrap();
    let private = lock(&runtime.local_attachment_directory)
        .unwrap()
        .clone()
        .unwrap();
    // Beside the private directory, which is all a confined agent may write.
    let mirror = PathBuf::from(format!("{}-frames", private.to_str().unwrap()));
    let mirrored =
        |frame_id: &str| std::fs::read_to_string(mirror.join(format!("{frame_id}.html"))).ok();
    let mut watcher = state
        .issue_request_watcher(&board.session_id)
        .unwrap()
        .unwrap();
    // A mirror left by an earlier run loses the frames deleted since, hidden ids included.
    std::fs::create_dir_all(&mirror).unwrap();
    std::fs::write(mirror.join("stale.html"), "old").unwrap();
    std::fs::write(mirror.join(".stale.html"), "old").unwrap();
    // A frame that cannot be written yet keeps the sync pending for the next scan.
    std::fs::create_dir_all(mirror.join("home.html/blocked")).unwrap();
    state.sync_design_mirror(&mut watcher);
    assert_eq!(mirrored("home"), None);
    std::fs::remove_dir_all(mirror.join("home.html")).unwrap();
    state.sync_design_mirror(&mut watcher);
    assert_eq!(
        mirrored("home").as_deref(),
        Some("<title>Home</title></html>")
    );
    assert_eq!((mirrored("stale"), mirrored(".stale")), (None, None));
    assert_eq!(
        std::fs::read_to_string(private.join("design-instructions.md")).unwrap(),
        design::instruction(private.to_str().unwrap())
    );

    std::fs::write(
        private.join("design-frame-card.html"),
        "<title>Card</title></html>",
    )
    .unwrap();
    let IssueRequestScan::Request(found) = state.scan_issue_request(&mut watcher).unwrap() else {
        panic!("frame expected");
    };
    state
        .handle_design_frame(&mut watcher, found)
        .unwrap()
        .unwrap();
    assert_eq!(
        mirrored("card").as_deref(),
        Some("<title>Card</title></html>")
    );

    std::fs::write(mirror.join("home.html"), "kept").unwrap();
    state
        .update_design_frame(&board.id, "home", 10.0, 10.0, 800.0, 600.0, 5)
        .unwrap();
    assert_eq!(mirrored("home").as_deref(), Some("kept"));
    state.duplicate_design_frame(&board.id, "card").unwrap();
    assert_eq!(
        mirrored("card-copy").as_deref(),
        Some("<title>Card</title></html>")
    );
    let deleted = state.delete_design_frame(&board.id, "card").unwrap();
    assert_eq!(mirrored("card"), None);
    state.restore_design_frame(deleted).unwrap();
    assert_eq!(
        mirrored("card").as_deref(),
        Some("<title>Card</title></html>")
    );

    // Links the agent plants are replaced, never written through.
    let outside = directory.join("outside.html");
    std::fs::write(&outside, "project file").unwrap();
    let deleted = state.delete_design_frame(&board.id, "card").unwrap();
    std::os::unix::fs::symlink(&outside, mirror.join("card.html")).unwrap();
    state.restore_design_frame(deleted).unwrap();
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "project file");
    assert!(!std::fs::symlink_metadata(mirror.join("card.html"))
        .unwrap()
        .file_type()
        .is_symlink());
    let elsewhere = directory.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::fs::rename(&mirror, directory.join("frames-before")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &mirror).unwrap();
    state.duplicate_design_frame(&board.id, "home").unwrap();
    let mut restarted = state
        .issue_request_watcher(&board.session_id)
        .unwrap()
        .unwrap();
    state.sync_design_mirror(&mut restarted);
    assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);

    state.stop(&board.session_id).unwrap();
    state.shutdown();
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_design_agent_launches_confined_to_its_private_directory() {
    use conversations::Provider;
    let launch = |provider, directory: &str, design, windows_local| {
        let mut args = vec!["--model".to_owned(), "m".to_owned()];
        issue_requests::add_instruction(&mut args, provider, directory, design, windows_local)
            .map(|()| args)
    };
    let claude = launch(Provider::Claude, "/tmp/soreno/private", true, false).unwrap();
    assert_eq!(
        claude[..3],
        [
            "--permission-mode",
            "dontAsk",
            "--allowedTools=Read,Glob,Grep,Edit(//tmp/soreno/private/**),Write(//tmp/soreno/private/**),Bash(cp *),Bash(mv *),Bash(ls *)",
        ]
    );
    let windows = launch(Provider::Claude, r"C:\Users\Ann[work]\private", true, true).unwrap();
    assert_eq!(
        windows[2],
        r"--allowedTools=Read,Glob,Grep,Edit(//c/Users/Ann\[work\]/private/**),Write(//c/Users/Ann\[work\]/private/**),Bash(cp *),Bash(mv *),Bash(ls *)"
    );
    let posix = launch(Provider::Claude, r"/tmp/!a/b*?\c", true, false).unwrap();
    assert!(
        posix[2].contains(r"Edit(//tmp/\!a/b\*\?\\c/**)"),
        "{posix:?}"
    );
    assert!(launch(Provider::Claude, "/tmp/a (b)", true, false).is_err());

    let codex = launch(Provider::Codex, "/tmp/p", true, false).unwrap();
    assert_eq!(
        codex[..6],
        [
            "--ask-for-approval",
            "never",
            "-c",
            "default_permissions=\"soreno_design\"",
            "-c",
            "permissions.soreno_design.filesystem={\":root\"=\"read\",\"/tmp/p\"=\"write\"}",
        ]
    );
    assert!(codex
        .iter()
        .any(|arg| arg.contains("design-instructions.md")));
    assert!(!codex.iter().any(|arg| arg.contains("frames/<id>.html")));
    let codex = launch(Provider::Codex, r"C:\Users\Ann\p", true, true).unwrap();
    assert_eq!(
        codex[5],
        r"permissions.soreno_design.filesystem={':root'='read','C:\Users\Ann\p'='write'}"
    );

    assert_eq!(
        launch(Provider::Omp, "/tmp/p", true, false).unwrap(),
        [
            "--tools=read,grep,glob,edit,write",
            "--approval-mode=yolo",
            "--model",
            "m"
        ]
    );
    assert_eq!(
        launch(Provider::Pi, "/tmp/p", true, false).unwrap(),
        ["--tools", "read,grep,find,ls,edit,write", "--model", "m"]
    );

    // Coding agents keep their own permissions.
    for provider in [
        Provider::Claude,
        Provider::Codex,
        Provider::Omp,
        Provider::Pi,
    ] {
        let args = launch(provider, "/tmp/p", false, false).unwrap();
        assert!(
            !args.iter().any(|arg| arg.starts_with("--permission-mode")
                || arg.starts_with("--allowedTools")
                || arg.starts_with("--ask-for-approval")
                || arg.starts_with("default_permissions")
                || arg.starts_with("--tools")
                || arg.starts_with("--approval-mode")),
            "{args:?}"
        );
    }
}
