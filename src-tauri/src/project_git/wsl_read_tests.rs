use super::*;
use crate::agent_sessions::AgentEnvironment;

fn project(id: &str, path: &str, distribution: &str) -> AgentProject {
    AgentProject {
        id: id.into(),
        name: "Projet".into(),
        path: path.into(),
        environment: AgentEnvironment {
            kind: "wsl".into(),
            distribution: Some(distribution.into()),
            ssh: None,
        },
        icon_data_url: None,
        icon: None,
        color: None,
    }
}

fn unused_relay_spec() -> RelaySpec {
    RelaySpec {
        program: "unused".into(),
        args: Vec::new(),
        env: Vec::new(),
        current_dir: None,
        source: b"",
    }
}

#[test]
fn relay_command_preserves_literal_prefix_environment_and_git_arguments() {
    let project = project(
        "id",
        "/home/me/a b;$(touch nope)\nline",
        "Ubuntu Test & literal",
    );
    let (spec, args) =
        relay_spec(&project, &["cat-file", "blob", "é;$(touch nope)\nline"]).unwrap();
    assert_eq!(
        &spec.args[..6],
        [
            "--distribution",
            "Ubuntu Test & literal",
            "--cd",
            "/",
            "--exec",
            "env"
        ]
    );
    assert!(spec.args.last().unwrap().to_string_lossy().is_ascii());
    assert_eq!(args[0], "--no-replace-objects");
    assert_eq!(args.last().unwrap(), "é;$(touch nope)\nline");
    assert!(spec.env.iter().any(|(name, _)| name == "LC_ALL"));
}

#[test]
fn relay_command_uses_the_structural_git_boundary() {
    let project = project("id", "/repo", "git");
    let (spec, args) = relay_spec(&project, &["remote", "get-url", "--all", "git"]).unwrap();
    assert_eq!(spec.args[1], "git");
    assert_eq!(spec.args[spec.args.len() - 2], "-c");
    assert_eq!(args[0], "--no-replace-objects");
    assert_eq!(
        &args[args.len() - 4..],
        ["remote", "get-url", "--all", "git"]
    );
}

#[test]
fn bootstrap_source_is_raw_and_complete_before_the_first_protocol_frame() {
    let source = RELAY_SOURCE.to_vec();
    let frame = response_frame(1, "ok");
    let mut stream = Vec::new();
    for payload in [&source, &frame] {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        assert!(write_writer_message(
            &mut stream,
            WriterMessage::Frame(payload.to_vec(), acknowledgement)
        ));
        acknowledged.recv().unwrap().unwrap();
    }
    assert_eq!(&stream[..RELAY_SOURCE.len()], RELAY_SOURCE);
    assert_eq!(&stream[RELAY_SOURCE.len()..], frame);
}

#[test]
fn rooted_foreground_reads_keep_the_original_subdirectory_scope() {
    let configured = project("rooted", "/repo/nested", "Ubuntu");
    let rooted = AgentProject {
        path: "/repo".into(),
        ..configured.clone()
    };
    with_display_scope(&configured, PoolPolicy::Foreground, || {
        let previous =
            super::super::READ_DEADLINE.with(|deadline| deadline.replace(Some(Instant::now())));
        let result = execute_if_enabled(
            &rooted,
            &["ls-files", "--stage", "-z"],
            None,
            super::super::READ_TIMEOUT,
            false,
            || Ok(GitOutput { stdout: Vec::new() }),
        );
        super::super::READ_DEADLINE.with(|deadline| deadline.set(previous));
        assert_eq!(
            DISPLAY_SCOPE.with(|scope| scope.borrow().clone()),
            Some(ScopeKey::from(&configured))
        );
        // The rooted query must reach the deadline check, not fail the scope guard.
        assert_eq!(result.unwrap().unwrap_err().code, "timeout");
        Ok(())
    })
    .unwrap();
}

#[test]
fn scope_key_isolates_every_authorized_dimension() {
    let base = ScopeKey::from(&project("id", "/repo", "Ubuntu"));
    assert_ne!(base, ScopeKey::from(&project("other", "/repo", "Ubuntu")));
    assert_ne!(base, ScopeKey::from(&project("id", "/other", "Ubuntu")));
    assert_ne!(base, ScopeKey::from(&project("id", "/repo", "Debian")));
    let mut local = project("id", "/repo", "Ubuntu");
    local.environment.kind = "local".into();
    assert_ne!(base, ScopeKey::from(&local));
}

#[test]
fn display_scope_priority_and_parent_deadline_are_thread_local_and_restored() {
    let original = project("id", "/repo/subdirectory", "Ubuntu");
    assert!(DISPLAY_SCOPE.with(|scope| scope.borrow().is_none()));
    assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
    with_display_reads(&original, || {
        assert_eq!(
            DISPLAY_SCOPE.with(|scope| scope.borrow().clone()),
            Some(ScopeKey::from(&original))
        );
        assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
        assert!(super::super::read_deadline().is_some());
        let nested = project("nested", "/other", "Debian");
        with_background_display_reads(&nested, || {
            assert_eq!(
                DISPLAY_SCOPE.with(|scope| scope.borrow().clone()),
                Some(ScopeKey::from(&nested))
            );
            assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Background);
            Ok(())
        })?;
        assert_eq!(
            DISPLAY_SCOPE.with(|scope| scope.borrow().clone()),
            Some(ScopeKey::from(&original))
        );
        assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
        std::thread::spawn(|| {
            assert!(DISPLAY_SCOPE.with(|scope| scope.borrow().is_none()));
            assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
            assert!(super::super::read_deadline().is_none());
        })
        .join()
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert!(DISPLAY_SCOPE.with(|scope| scope.borrow().is_none()));
    assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
    assert!(super::super::read_deadline().is_none());

    with_foreground_transport(&original, || {
        assert_eq!(
            DISPLAY_SCOPE.with(|scope| scope.borrow().clone()),
            Some(ScopeKey::from(&original))
        );
        assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
        assert!(super::super::read_deadline().is_none());
        Ok(())
    })
    .unwrap();

    let panic = std::panic::catch_unwind(|| {
        let _ = with_background_display_reads(&original, || -> Result<(), GitError> {
            panic!("panic attendue");
        });
    });
    assert!(panic.is_err());
    assert!(DISPLAY_SCOPE.with(|scope| scope.borrow().is_none()));
    assert_eq!(POOL_POLICY.with(Cell::get), PoolPolicy::Foreground);
}

#[test]
fn frame_reader_refuses_size_before_allocation_and_truncated_payloads() {
    let oversized = ((RESPONSE_FRAME_LIMIT + 1) as u32).to_be_bytes();
    assert!(read_response_frame(&mut std::io::Cursor::new(oversized)).is_err());
    let mut truncated = Vec::from(10_u32.to_be_bytes());
    truncated.extend_from_slice(b"{}");
    assert!(read_response_frame(&mut std::io::Cursor::new(truncated)).is_err());
}

fn response_frame(id: u64, kind: &str) -> Vec<u8> {
    let payload = format!(
        r#"{{"v":1,"id":{id},"kind":"{kind}","status":null,"stdout":"","stderr":"","stderrTruncated":false,"terminated":true,"message":null}}"#
    )
    .into_bytes();
    let mut frame = Vec::from((payload.len() as u32).to_be_bytes());
    frame.extend(payload);
    frame
}

#[test]
fn response_forwarder_breaks_on_surplus_frames_without_blocking() {
    let mut frames = response_frame(1, "ok");
    frames.extend(response_frame(2, "ok"));
    let (sender, receiver) = mpsc::sync_channel(1);
    let broken = AtomicBool::new(false);
    forward_responses(&mut std::io::Cursor::new(frames), &sender, &broken).unwrap();
    assert!(broken.load(Ordering::Acquire));
    assert_eq!(receiver.try_recv().unwrap().unwrap().id, Some(1));
}

#[test]
fn response_forwarder_reports_a_closed_stream() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let broken = AtomicBool::new(false);
    forward_responses(&mut std::io::Cursor::new(Vec::new()), &sender, &broken).unwrap();
    assert!(broken.load(Ordering::Acquire));
    assert!(receiver.try_recv().unwrap().is_err());
}

#[test]
fn admission_limits_a_busy_scope_before_large_input_is_copied() {
    let admission = Arc::new(Admission::default());
    let deadline = Instant::now() + Duration::from_secs(1);
    let permits = (0..MAX_REQUESTS_PER_SCOPE)
        .map(|_| admission.acquire(deadline).unwrap())
        .collect::<Vec<_>>();
    let started = Instant::now();
    assert!(admission
        .acquire(Instant::now() + Duration::from_millis(20))
        .is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(permits);
    assert!(admission.acquire(deadline).is_some());
}

#[test]
fn full_and_disconnected_job_channels_are_distinct() {
    let (sender, receiver) = mpsc::sync_channel(0);
    assert!(matches!(
        send_before(&sender, 1, Instant::now()),
        Err(SendError::Timeout(1))
    ));
    drop(receiver);
    assert!(matches!(
        send_before(&sender, 2, Instant::now() + Duration::from_secs(1)),
        Err(SendError::Disconnected(2))
    ));
}

#[test]
fn pool_eviction_waits_for_active_admissions() {
    let mut pool = Pool {
        entries: HashMap::new(),
    };
    let mut permits = Vec::new();
    for index in 0..MAX_SCOPES {
        let admission = Arc::new(Admission::default());
        permits.push(admission.acquire(Instant::now()).unwrap());
        let (sender, _receiver) = mpsc::sync_channel(1);
        pool.entries.insert(
            ScopeKey::from(&project(&format!("id-{index}"), "/repo", "Ubuntu")),
            Arc::new(PoolEntry {
                sender,
                liveness: Arc::new(Liveness::new()),
                stopping: AtomicBool::new(false),
                admission,
            }),
        );
    }
    assert!(!pool.entries.values().any(pool_entry_evictable));
    permits.pop();
    assert_eq!(
        pool.entries
            .values()
            .filter(|entry| pool_entry_evictable(entry))
            .count(),
        1
    );
}

#[test]
fn background_pool_full_neither_evicts_nor_waits() {
    let state = PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    };
    for index in 0..MAX_SCOPES {
        state.pool.lock().unwrap().entries.insert(
            ScopeKey::from(&project(&format!("background-{index}"), "/repo", "Ubuntu")),
            start_pool_entry(unused_relay_spec(), Arc::new(Admission::default())),
        );
    }
    let started = Instant::now();
    assert!(matches!(
        pool_entry_from(
            &state,
            ScopeKey::from(&project("extra", "/repo", "Ubuntu")),
            unused_relay_spec(),
            Instant::now() + Duration::from_secs(1),
            PoolPolicy::Background,
        ),
        PoolEntryResult::FullUnavailable
    ));
    assert!(started.elapsed() < Duration::from_millis(100));
    let entries = state
        .pool
        .lock()
        .unwrap()
        .entries
        .values()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), MAX_SCOPES);
    assert!(entries
        .iter()
        .all(|entry| !entry.stopping.load(Ordering::Acquire)));
    for entry in entries {
        let _ = entry.sender.try_send(WorkerMessage::Stop);
    }
}

#[test]
fn foreground_pool_full_keeps_the_existing_eviction_policy() {
    let state = PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    };
    for index in 0..MAX_SCOPES {
        state.pool.lock().unwrap().entries.insert(
            ScopeKey::from(&project(&format!("foreground-{index}"), "/repo", "Ubuntu")),
            start_pool_entry(unused_relay_spec(), Arc::new(Admission::default())),
        );
    }
    let key = ScopeKey::from(&project("extra", "/repo", "Ubuntu"));
    let entry = match pool_entry_from(
        &state,
        key.clone(),
        unused_relay_spec(),
        Instant::now() + Duration::from_secs(1),
        PoolPolicy::Foreground,
    ) {
        PoolEntryResult::Entry(entry) => entry,
        _ => panic!("le premier plan doit libérer une entrée inactive"),
    };
    assert!(Arc::ptr_eq(
        state.pool.lock().unwrap().entries.get(&key).unwrap(),
        &entry
    ));
    let entries = state
        .pool
        .lock()
        .unwrap()
        .entries
        .values()
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), MAX_SCOPES);
    for entry in entries {
        let _ = entry.sender.try_send(WorkerMessage::Stop);
    }
}

#[test]
fn background_existing_saturated_scope_does_not_fall_back() {
    let state = PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    };
    let key = ScopeKey::from(&project("shared", "/repo", "Ubuntu"));
    let entry = start_pool_entry(unused_relay_spec(), Arc::new(Admission::default()));
    let permits = (0..MAX_REQUESTS_PER_SCOPE)
        .map(|_| entry.admission.acquire(Instant::now()).unwrap())
        .collect::<Vec<_>>();
    state
        .pool
        .lock()
        .unwrap()
        .entries
        .insert(key.clone(), Arc::clone(&entry));
    for index in 1..MAX_SCOPES {
        state.pool.lock().unwrap().entries.insert(
            ScopeKey::from(&project(&format!("other-{index}"), "/repo", "Ubuntu")),
            start_pool_entry(unused_relay_spec(), Arc::new(Admission::default())),
        );
    }
    let selected = match pool_entry_from(
        &state,
        key,
        unused_relay_spec(),
        Instant::now() + Duration::from_secs(1),
        PoolPolicy::Background,
    ) {
        PoolEntryResult::Entry(selected) => selected,
        _ => panic!("la portée existante doit conserver son admission"),
    };
    assert!(Arc::ptr_eq(&selected, &entry));
    assert!(selected.admission.acquire(Instant::now()).is_none());
    drop(permits);
    let entries = state
        .pool
        .lock()
        .unwrap()
        .entries
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for entry in entries {
        let _ = entry.sender.try_send(WorkerMessage::Stop);
    }
}

#[test]
fn stopping_live_scope_is_not_replaced_early_and_keeps_its_admissions() {
    let state = Arc::new(PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    });
    let key = ScopeKey::from(&project("stopping", "/repo", "Ubuntu"));
    let admission = Arc::new(Admission::default());
    let permits = (0..MAX_REQUESTS_PER_SCOPE)
        .map(|_| admission.acquire(Instant::now()).unwrap())
        .collect::<Vec<_>>();
    let (sender, _receiver) = mpsc::sync_channel(1);
    let old_liveness = Arc::new(Liveness::new());
    let old = Arc::new(PoolEntry {
        sender,
        liveness: Arc::clone(&old_liveness),
        stopping: AtomicBool::new(true),
        admission: Arc::clone(&admission),
    });
    state
        .pool
        .lock()
        .unwrap()
        .entries
        .insert(key.clone(), Arc::clone(&old));

    let alive = old_liveness.alive.lock().unwrap();
    let caller_state = Arc::clone(&state);
    let (result_sender, result_receiver) = mpsc::sync_channel(1);
    let caller = std::thread::spawn(move || {
        let result = pool_entry_from(
            &caller_state,
            key,
            unused_relay_spec(),
            Instant::now() + Duration::from_secs(1),
            PoolPolicy::Background,
        );
        result_sender.send(result).unwrap();
    });
    let observation_deadline = Instant::now() + Duration::from_secs(1);
    while state.pool.try_lock().is_ok() {
        assert!(Instant::now() < observation_deadline);
        std::thread::yield_now();
    }
    drop(alive);

    let pool = state.pool.lock().unwrap();
    assert!(Arc::ptr_eq(
        pool.entries
            .get(&ScopeKey::from(&project("stopping", "/repo", "Ubuntu")))
            .unwrap(),
        &old
    ));
    drop(pool);
    assert!(matches!(
        result_receiver.try_recv(),
        Err(TryRecvError::Empty)
    ));

    *old_liveness.alive.lock().unwrap() = false;
    old_liveness.stopped.notify_all();
    let replacement = match result_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
    {
        PoolEntryResult::Entry(entry) => entry,
        _ => panic!("la portée arrêtée doit être remplacée après sa terminaison"),
    };
    caller.join().unwrap();
    assert!(Arc::ptr_eq(&replacement.admission, &admission));
    assert_eq!(
        usize::from(old_liveness.is_alive()) + usize::from(replacement.liveness.is_alive()),
        1
    );
    assert_eq!(state.pool.lock().unwrap().entries.len(), 1);
    assert!(replacement.admission.acquire(Instant::now()).is_none());
    drop(permits);
    assert!(replacement
        .admission
        .acquire(Instant::now() + Duration::from_secs(1))
        .is_some());
    let _ = send_before(
        &replacement.sender,
        WorkerMessage::Stop,
        Instant::now() + Duration::from_secs(1),
    );
    assert!(replacement
        .liveness
        .wait_stopped(Instant::now() + Duration::from_secs(1)));
}

#[test]
fn unnotified_pool_release_is_rechecked_after_a_bounded_wait() {
    let state = Arc::new(PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    });
    let mut held = Vec::new();
    let mut receivers = Vec::new();
    for index in 0..MAX_SCOPES {
        let (sender, receiver) = mpsc::sync_channel(1);
        receivers.push(receiver);
        let entry = Arc::new(PoolEntry {
            sender,
            liveness: Arc::new(Liveness::new()),
            stopping: AtomicBool::new(false),
            admission: Arc::new(Admission::default()),
        });
        state.pool.lock().unwrap().entries.insert(
            ScopeKey::from(&project(&format!("poll-{index}"), "/repo", "Ubuntu")),
            Arc::clone(&entry),
        );
        held.push(entry);
    }
    let released = held.pop().unwrap();
    let mut pool = state.pool.lock().unwrap();
    assert!(!pool.entries.values().any(pool_entry_evictable));
    let releaser_state = Arc::clone(&state);
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let releaser = std::thread::spawn(move || {
        ready_sender.send(()).unwrap();
        let _pool = releaser_state.pool.lock().unwrap();
        drop(released);
    });
    ready_receiver.recv().unwrap();
    let deadline = Instant::now() + Duration::from_millis(250);
    loop {
        pool = wait_for_pool_change(&state, pool, deadline)
            .expect("la baisse d’Arc sans notification doit être réévaluée avant l’échéance");
        if pool.entries.values().any(pool_entry_evictable) {
            break;
        }
    }
    assert!(Instant::now() < deadline);
    drop(pool);
    releaser.join().unwrap();
    drop((held, receivers));
}

#[test]
fn bounded_pool_waits_do_not_renew_the_original_deadline() {
    let state = PoolState {
        pool: Mutex::new(Pool {
            entries: HashMap::new(),
        }),
        available: Condvar::new(),
    };
    let started = Instant::now();
    let deadline = started + Duration::from_millis(40);
    let mut pool = state.pool.lock().unwrap();
    loop {
        let Some(next_pool) = wait_for_pool_change(&state, pool, deadline) else {
            break;
        };
        pool = next_pool;
    }
    assert!(started.elapsed() < Duration::from_millis(250));
}

#[test]
fn worker_shutdown_notifies_deadline_aware_waiters() {
    let liveness = Arc::new(Liveness::new());
    let worker_liveness = Arc::clone(&liveness);
    let worker = std::thread::spawn(move || drop(WorkerAlive(worker_liveness)));
    assert!(liveness.wait_stopped(Instant::now() + Duration::from_secs(1)));
    worker.join().unwrap();
}

#[test]
fn python_absence_cache_requires_exit_127_and_a_specific_diagnostic() {
    use std::os::windows::process::ExitStatusExt;

    let status = std::process::ExitStatus::from_raw(127);
    let missing = Captured {
        bytes: b"env: 'python3': No such file or directory".to_vec(),
        truncated: false,
    };
    let syntax = Captured {
        bytes: b"python3: SyntaxError".to_vec(),
        truncated: false,
    };
    assert!(python_missing(&status, &missing));
    assert!(!python_missing(&status, &syntax));
    assert!(!python_missing(
        &std::process::ExitStatus::from_raw(1),
        &missing
    ));
}

#[test]
fn fallback_keeps_the_original_command_deadline_and_restores_the_parent() {
    let now = Instant::now();
    let parent = now + DISPLAY_BUDGET;
    super::super::with_read_deadline(parent, || {
        let command = command_deadline(
            super::super::read_deadline(),
            now,
            super::super::READ_TIMEOUT,
        );
        super::super::with_read_deadline(command, || {
            assert_eq!(super::super::read_deadline(), Some(command));
            Ok(())
        })?;
        assert_eq!(super::super::read_deadline(), Some(parent));
        Ok(())
    })
    .unwrap();
    assert!(super::super::read_deadline().is_none());
}

#[test]
fn command_and_wire_deadlines_keep_the_stop_margin() {
    let now = Instant::now();
    assert_eq!(
        command_deadline(Some(now + DISPLAY_BUDGET), now, super::super::READ_TIMEOUT,),
        now + super::super::READ_TIMEOUT
    );
    assert_eq!(
        command_deadline(
            Some(now + Duration::from_secs(3)),
            now,
            super::super::LOCAL_MUTATION_TIMEOUT,
        ),
        now + Duration::from_secs(3)
    );
    assert_eq!(
        wire_timeout_ms(now + super::super::READ_TIMEOUT, now),
        13_000
    );
    assert_eq!(wire_timeout_ms(now + Duration::from_millis(1), now), 1);
}

#[test]
fn cancellation_wins_before_transmission() {
    let state = JobState::new();
    let transmission_possible = state.cancel_and_mutation_uncertain();
    assert!(!transmission_possible);
    assert_eq!(
        mark_mutation_uncertain(read_timeout_error(), transmission_possible).uncertain,
        None
    );
    assert!(!state.transmission_possible());
    assert!(!state.mutation_uncertain());
}

#[test]
fn transmission_wins_before_cancellation() {
    let state = JobState::new();
    assert!(state.transmission_possible());
    let transmission_possible = state.cancel_and_mutation_uncertain();
    assert!(transmission_possible);
    assert_eq!(
        mark_mutation_uncertain(read_timeout_error(), transmission_possible).uncertain,
        Some(true)
    );
    assert_eq!(
        mark_mutation_uncertain(transport_error("déconnexion"), transmission_possible).uncertain,
        Some(true)
    );
    assert!(state.mutation_uncertain());
}

#[test]
fn terminal_job_is_not_made_uncertain_by_cancellation() {
    let state = JobState::new();
    state.terminal();
    assert!(!state.cancel_and_mutation_uncertain());
    assert!(!state.mutation_uncertain());
}

#[test]
fn cancelled_job_is_not_sent_to_the_relay_writer() {
    let state = JobState::new();
    assert!(!state.cancel_and_mutation_uncertain());
    let (writer, receiver) = mpsc::sync_channel(1);
    let (acknowledgement, _acknowledged) = mpsc::sync_channel(1);
    assert!(matches!(
        transmit_job_before(
            &writer,
            WriterMessage::Frame(vec![1], acknowledgement),
            Instant::now() + Duration::from_secs(1),
            &state,
        ),
        JobTransmission::Cancelled
    ));
    assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
}
