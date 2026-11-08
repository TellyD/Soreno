use super::*;
use serde_json::json;

fn normalize(provider: Provider, lines: &str) -> Vec<Value> {
    let mut normalizer = Normalizer::new(provider);
    let mut offset = 0;
    let mut items = Vec::new();
    for line in lines.split_inclusive('\n') {
        items.extend(normalizer.line(line.trim_end().as_bytes(), offset));
        offset += line.len() as u64;
    }
    items
        .iter()
        .map(|item| serde_json::to_value(item).unwrap())
        .collect()
}

const OMP: &str = r#"{"type":"session","version":3,"id":"s1","cwd":"/projet"}
{"type":"message","id":"m1","message":{"role":"developer","content":[{"type":"text","text":"<system-reminder>règle</system-reminder>"}],"attribution":"agent"}}
{"type":"message","id":"m2","message":{"role":"user","content":[{"type":"text","text":"[Image #1] Corrige le titre"},{"type":"image","data":"blob:x","mimeType":"image/png"}],"attribution":"user"}}
{"type":"message","id":"m3","message":{"role":"assistant","content":[{"type":"thinking","thinking":"je réfléchis"},{"type":"text","text":"Je regarde."},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"src/App.tsx","i":"Lecture"}},{"type":"toolCall","id":"call_2","name":"bash","arguments":{"command":"npm test\n  -- --run","i":"Tests"}},{"type":"toolCall","id":"call_3","name":"edit","arguments":{"input":"[src/App.tsx#AB12]\nPUT 1:\n+x","i":"Modification"}}]}}
{"type":"custom","customType":"tool_execution_start","data":{"toolCallId":"call_1"}}
{"type":"message","id":"m4","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"export function App() {}"}],"isError":false}}
pas du json
{"type":"message","id":"m5","message":{"role":"toolResult","toolCallId":"call_2","toolName":"bash","content":[{"type":"text","text":"1 failed\nCommand exited with code 1"}],"isError":true}}
{"type":"message","id":"m6","message":{"role":"toolResult","toolCallId":"call_3","content":[{"type":"image","data":"blob:y"}],"isError":false}}
{"type":"custom_message","customType":"skill-prompt","content":"[IMPORTANT: …]","display":true,"details":{"name":"revue","prompt":"Lance /skill:revue"},"attribution":"user","id":"m7"}
{"type":"custom_message","customType":"async-result","content":"Tâche finie","display":true,"attribution":"agent","id":"m8"}
{"type":"message","id":"m9","message":{"role":"assistant","content":[{"type":"text","text":"C'est corrigé."}]}}
{"type":"message","id":"m10","message":{"role":"user","content":"Goal mode is active. Complete this goal fully:\nobjectif"}}
"#;

#[test]
fn omp_and_pi_keep_the_conversation_and_drop_what_was_injected() {
    let expected = json!([
        {"kind":"user","id":"m2:0","text":"[Image #1] Corrige le titre","images":1},
        {"kind":"assistant","id":"m3:0","text":"Je regarde."},
        {"kind":"tool","id":"call_1","name":"read","action":"read","subject":"src/App.tsx"},
        {"kind":"tool","id":"call_2","name":"bash","action":"run","subject":"npm test -- --run"},
        {"kind":"tool","id":"call_3","name":"edit","action":"edit","subject":"src/App.tsx"},
        {"kind":"toolResult","id":"call_1","error":false,"text":"export function App() {}"},
        {"kind":"toolResult","id":"call_2","error":true,"text":"1 failed\nCommand exited with code 1"},
        {"kind":"toolResult","id":"call_3","error":false,"text":null},
        {"kind":"user","id":"m7:0","text":"Lance /skill:revue","images":0},
        {"kind":"assistant","id":"m9:0","text":"C'est corrigé."},
    ]);
    assert_eq!(Value::Array(normalize(Provider::Omp, OMP)), expected);
    assert_eq!(Value::Array(normalize(Provider::Pi, OMP)), expected);
}

/// Reduced from a Pi history: `/goal` leaves its objective only in its state and its contract.
const PI_GOAL: &str = r#"{"type":"message","id":"m1","message":{"role":"assistant","content":[{"type":"text","text":"Faux positif."}]}}
{"type":"custom","customType":"goal-state","data":{"goal":{"id":"g-1","text":"Passe sur les branches","status":"active","startedAt":1,"updatedAt":1,"iteration":0}},"id":"s1"}
{"type":"custom","customType":"goal-state","data":{"goal":{"id":"g-1","text":"Passe sur les branches","status":"active","startedAt":1,"updatedAt":1,"iteration":0}},"id":"s2"}
{"type":"message","id":"m2","message":{"role":"user","content":[{"type":"text","text":"Goal mode is active. Complete this goal fully:\n\n<goal_objective>\nPasse sur les branches\n</goal_objective>"}]}}
{"type":"custom_message","customType":"goal-contract","content":"This Goal contract supersedes every earlier goal-contract message.\n<goal_objective>\nPasse sur les branches\n</goal_objective>","display":false,"id":"c1"}
{"type":"message","id":"m3","message":{"role":"assistant","content":[{"type":"text","text":"Je commence."}]}}
{"type":"custom","customType":"goal-state","data":{"goal":{"id":"g-1","text":"Passe sur les branches","status":"active","startedAt":1,"updatedAt":5,"iteration":0}},"id":"s3"}
{"type":"message","id":"m4","message":{"role":"user","content":[{"type":"text","text":"Continue the active /goal."}]}}
{"type":"custom","customType":"goal-state","data":{"goal":{"id":"g-1","text":"Passe sur les branches","status":"completed","startedAt":1,"updatedAt":9}},"id":"s4"}
{"type":"custom","customType":"goal-state","data":{"goal":{"id":"g-2","text":"Autre objectif","status":"active","startedAt":10,"updatedAt":10}},"id":"s5"}
"#;

#[test]
fn pi_shows_the_objective_of_a_goal_once() {
    assert_eq!(
        Value::Array(normalize(Provider::Pi, PI_GOAL)),
        json!([
            {"kind":"assistant","id":"m1:0","text":"Faux positif."},
            {"kind":"user","id":"s1:0","text":"Passe sur les branches","images":0},
            {"kind":"assistant","id":"m3:0","text":"Je commence."},
            {"kind":"user","id":"s5:0","text":"Autre objectif","images":0},
        ])
    );
}

/// Reduced from an OMP history: a backgrounded command ends in a later notice.
const OMP_ASYNC: &str = r#"{"type":"message","id":"m1","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"cargo test"}},{"type":"toolCall","id":"call_2","name":"bash","arguments":{"command":"npm test"}}]}}
{"type":"message","id":"m2","message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash","content":[{"type":"text","text":"Backgrounded as job bg_5."}],"details":{"async":{"state":"running","jobId":"bg_5","type":"bash"}},"isError":false}}
{"type":"message","id":"m3","message":{"role":"toolResult","toolCallId":"call_2","toolName":"bash","content":[{"type":"text","text":"Backgrounded as job bg_6."}],"details":{"async":{"state":"running","jobId":"bg_6","type":"bash"}},"isError":false}}
{"type":"custom_message","customType":"async-result","content":"<system-notice>\nBackground job bg_5 has completed. Resume your work using the result below.\nDiff in src/a.rs:\n-x\n+y\nWall time: 1.52 seconds\n\nCommand exited with code 1\n</system-notice>","display":true,"details":{"jobs":[{"jobId":"bg_5","type":"bash","label":"cargo test"}]},"attribution":"agent","id":"r1"}
{"type":"custom_message","customType":"async-result","content":"<system-notice>\n2 background jobs have completed. Resume your work using the results below.\n\n── Job Revue (Revue) ──\nrapport\n── Job bg_6 (npm test) ──\n Tests  12 passed (12)\nWall time: 4.10 seconds\n</system-notice>","display":true,"details":{"jobs":[{"jobId":"Revue","type":"task"},{"jobId":"bg_6","type":"bash"}]},"attribution":"agent","id":"r2"}
{"type":"custom_message","customType":"async-result","content":"<system-notice>\nBackground job bg_5 has completed. Resume your work using the result below.\nencore\n</system-notice>","display":true,"details":{"jobs":[{"jobId":"bg_5","type":"bash"}]},"attribution":"agent","id":"r3"}
"#;

#[test]
fn omp_ends_a_backgrounded_command_with_its_notice() {
    let items = normalize(Provider::Omp, OMP_ASYNC);
    assert_eq!(
        Value::Array(items[2..].to_vec()),
        json!([
            {"kind":"toolResult","id":"call_1","error":false,"text":"Backgrounded as job bg_5."},
            {"kind":"toolResult","id":"call_2","error":false,"text":"Backgrounded as job bg_6."},
            {"kind":"toolResult","id":"call_1","error":true,
             "text":"Diff in src/a.rs:\n-x\n+y\nWall time: 1.52 seconds\n\nCommand exited with code 1"},
            {"kind":"toolResult","id":"call_2","error":false,
             "text":"Tests  12 passed (12)\nWall time: 4.10 seconds"},
        ])
    );
}

#[test]
fn only_the_tool_reports_a_failed_command() {
    let job = |call: &str, job: &str, output: &str| {
        format!(
            "{}\n{}\n",
            json!({"type":"message","id":format!("t{call}"),"message":{"role":"toolResult","toolCallId":call,"content":"Backgrounded","details":{"async":{"state":"running","jobId":job,"type":"bash"}}}}),
            json!({"type":"custom_message","customType":"async-result","id":format!("r{call}"),"details":{"jobs":[{"jobId":job,"type":"bash"}]},
                "content":format!("<system-notice>\nBackground job {job} has completed. Resume your work using the result below.\n{output}\n</system-notice>")}),
        )
    };
    let lines = [
        job("c1", "bg_1", "Exit code: 1\nCommand exited with code 2\nWall time: 0.50 seconds"),
        job("c2", "bg_2", "74 144\nWall time: 305.00 seconds\n\n[Command timed out after 300 seconds]"),
        job("c3", "bg_3", "fini\nWall time: 1.00 seconds\nIgnored ready: service-only, and no service name was given."),
    ]
    .concat();
    let ends: Vec<(String, bool)> = normalize(Provider::Omp, &lines)
        .iter()
        .filter(|item| item["text"] != "Backgrounded")
        .map(|item| {
            (
                item["id"].as_str().unwrap().to_owned(),
                item["error"] == true,
            )
        })
        .collect();
    assert_eq!(
        ends,
        [
            ("c1".into(), false),
            ("c2".into(), true),
            ("c3".into(), false)
        ]
    );

    let output = |call: &str, output: &str| {
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":call,"output":output}}).to_string() + "\n"
    };
    let lines = [
        output("c1", "Exit code: 1\nWall time: 0.1 seconds\nOutput:\nrien"),
        output("c2", "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 2\nOriginal token count: 1\nOutput:\n"),
        output("c3", "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nExit code: 1"),
        output("c4", "Exit code: 1"),
    ]
    .concat();
    let errors: Vec<bool> = normalize(Provider::Codex, &lines)
        .iter()
        .map(|item| item["error"] == true)
        .collect();
    assert_eq!(errors, [true, true, false, false]);
}

#[test]
fn a_crafted_line_stays_bounded() {
    let id = "i".repeat(4096);
    let content: Vec<Value> = (0..1000)
        .flat_map(|index| {
            [
                json!({"type":"text","text":"texte"}),
                json!({"type":"toolCall","id":format!("c{index}"),"name":"read","arguments":{}}),
            ]
        })
        .collect();
    let line = json!({"type":"message","id":id,"message":{"role":"assistant","content":content}});
    let items = Normalizer::new(Provider::Omp).line(line.to_string().as_bytes(), 42);
    assert_eq!(items.len(), LINE_ITEMS_LIMIT);
    let Item::Assistant { id, .. } = &items[0] else {
        panic!("{:?}", items[0]);
    };
    assert_eq!(id, "42:0");
}

const CLAUDE: &str = r#"{"type":"user","uuid":"u1","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat</local-command-caveat>"}}
{"type":"user","uuid":"u2","message":{"role":"user","content":"<command-name>/recap</command-name>\n<command-message>recap</command-message>\n<command-args>court</command-args>"}}
{"type":"user","uuid":"u3","message":{"role":"user","content":"<local-command-stdout>sortie</local-command-stdout>"}}
{"type":"user","uuid":"u4","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>rappel</system-reminder>"},{"type":"text","text":"Lance les tests"},{"type":"image","source":{}}]}}
{"type":"assistant","uuid":"a1","message":{"id":"msg_1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}
{"type":"assistant","uuid":"a2","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"mcp__outils__bash","input":{"command":"cargo test"}}]}}
{"type":"assistant","uuid":"a3","message":{"id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"Grep","input":{"pattern":"fn main","path":"src"}}]}}
{"type":"user","uuid":"u5","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"échec","is_error":true},{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
{"type":"user","uuid":"u6","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_2","content":[{"type":"text","text":"src/main.rs:1"}]}]}}
{"type":"assistant","uuid":"a4","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sous-agent"}]}}
{"type":"user","uuid":"u7","isSidechain":true,"message":{"role":"user","content":"consigne du sous-agent"}}
{"type":"attachment","uuid":"x1"}
{"type":"assistant","uuid":"a5","message":{"role":"assistant","content":[{"type":"text","text":"Les tests échouent."}]}}
"#;

#[test]
fn claude_drops_meta_sidechains_and_local_command_output() {
    assert_eq!(
        Value::Array(normalize(Provider::Claude, CLAUDE)),
        json!([
            {"kind":"user","id":"u2:0","text":"/recap court","images":0},
            {"kind":"user","id":"u4:0","text":"Lance les tests","images":1},
            {"kind":"tool","id":"toolu_1","name":"bash","action":"run","subject":"cargo test"},
            {"kind":"tool","id":"toolu_2","name":"Grep","action":"search","subject":"fn main"},
            {"kind":"toolResult","id":"toolu_1","error":true,"text":"échec"},
            {"kind":"toolResult","id":"toolu_2","error":false,"text":"src/main.rs:1"},
            {"kind":"assistant","id":"a5:0","text":"Les tests échouent."},
        ])
    );
}

const CLAUDE_LOCAL_COMMAND: &str = r###"{"type":"system","subtype":"local_command","uuid":"s1","parentUuid":null,"isMeta":false,"content":"<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>"}
{"type":"system","subtype":"local_command","uuid":"s2","parentUuid":"s1","isMeta":false,"content":"<local-command-stdout> \u001b[1mContext Usage\u001b[22m</local-command-stdout>","commandRun":{"command":"context","args":""}}
{"type":"user","uuid":"u1","parentUuid":"s2","isMeta":true,"message":{"role":"user","content":"## Context Usage\n\n**Tokens:** 1k / 1m"}}
{"type":"system","subtype":"turn_duration","uuid":"s3","durationMs":10}
{"type":"user","uuid":"u2","parentUuid":"u1","message":{"role":"user","content":"Et maintenant ?"}}
"###;

#[test]
fn claude_shows_a_local_command_but_not_its_report() {
    assert_eq!(
        Value::Array(normalize(Provider::Claude, CLAUDE_LOCAL_COMMAND)),
        json!([
            {"kind":"user","id":"s1:0","text":"/context","images":0},
            {"kind":"user","id":"u2:0","text":"Et maintenant ?","images":0},
        ])
    );
}

const CODEX: &str = r##"{"type":"session_meta","payload":{"id":"s1","cwd":"/projet"}}
{"type":"response_item","payload":{"type":"message","id":"msg_d","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>…"}]}}
{"type":"response_item","payload":{"type":"message","id":"msg_u1","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /projet\n\n<INSTRUCTIONS>…"},{"type":"input_text","text":"<environment_context>\n<cwd>/projet</cwd>"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["agents_md.instructions","environments.environment_context"]}}}
{"type":"response_item","payload":{"type":"message","id":"msg_u2","role":"user","content":[{"type":"input_text","text":"Dis bonjour."},{"type":"input_image","image_url":"data:"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text","user.image"]}}}
{"type":"event_msg","payload":{"type":"user_message","message":"Dis bonjour."}}
{"type":"response_item","payload":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"réflexion"}],"encrypted_content":"x"}}
{"type":"response_item","payload":{"type":"message","id":"msg_a1","role":"assistant","content":[{"type":"output_text","text":"Je regarde."}],"phase":"commentary"}}
{"type":"response_item","payload":{"type":"custom_tool_call","id":"ctc_1","call_id":"call_1","name":"exec","input":"text(await tools.exec_command({cmd:\"rg -n \\\"titre\\\" src\",max_output_tokens:2000}));"}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_1","output":[{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{\"exit_code\":2,\"output\":\"rg: src: introuvable\"}"}]}}
{"type":"response_item","payload":{"type":"function_call","call_id":"call_2","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls src\"]}"}}
{"type":"event_msg","payload":{"type":"exec_command_end","call_id":"call_2","exit_code":1}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_2","output":"ls: src: introuvable"}}
{"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_3","name":"apply_patch","input":"*** Begin Patch\n*** Update File: src/titre.ts\n@@\n-a\n+b\n*** End Patch"}}
{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_3","output":"{\"output\":\"Success.\",\"metadata\":{\"exit_code\":0}}"}}
{"type":"response_item","payload":{"type":"web_search_call","id":"ws_1","status":"completed","action":{"type":"search","query":"tauri updater"}}}
{"type":"response_item","payload":{"type":"message","id":"msg_a2","role":"assistant","content":[{"type":"output_text","text":"Bonjour !"}],"phase":"final_answer"}}
{"type":"response_item","payload":{"type":"mystère"
"##;

#[test]
fn codex_follows_calls_outputs_and_reported_failures() {
    assert_eq!(
        Value::Array(normalize(Provider::Codex, CODEX)),
        json!([
            {"kind":"user","id":"msg_u2:0","text":"Dis bonjour.","images":1},
            {"kind":"assistant","id":"msg_a1:0","text":"Je regarde."},
            {"kind":"tool","id":"call_1","name":"exec","action":"run","subject":"rg -n \"titre\" src"},
            {"kind":"toolResult","id":"call_1","error":true,"text":"Script completed\nrg: src: introuvable"},
            {"kind":"tool","id":"call_2","name":"shell","action":"run","subject":"ls src"},
            {"kind":"toolResult","id":"call_2","error":true,"text":"ls: src: introuvable"},
            {"kind":"tool","id":"call_3","name":"apply_patch","action":"edit","subject":"src/titre.ts"},
            {"kind":"toolResult","id":"call_3","error":false,"text":"Success."},
            {"kind":"tool","id":"ws_1","name":"web_search","action":"web","subject":"tauri updater"},
            {"kind":"toolResult","id":"ws_1","error":false,"text":null},
            {"kind":"assistant","id":"msg_a2:0","text":"Bonjour !"},
        ])
    );
}

#[test]
fn long_texts_are_cut_on_a_character_boundary() {
    let text = "é".repeat(TEXT_LIMIT);
    let line = json!({"type":"message","id":"m1","message":{"role":"assistant","content":[{"type":"text","text":text}]}});
    let items = Normalizer::new(Provider::Omp).line(line.to_string().as_bytes(), 0);
    let [Item::Assistant {
        text, truncated, ..
    }] = items.as_slice()
    else {
        panic!("{items:?}");
    };
    assert!(truncated);
    assert_eq!(text.len(), TEXT_LIMIT);

    let output = "x".repeat(RESULT_LIMIT * 2);
    let command = "a ".repeat(SUBJECT_LIMIT);
    let lines = [
        json!({"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"toolCall","id":"c","name":"bash","arguments":{"command":command}}]}}),
        json!({"type":"message","id":"m3","message":{"role":"toolResult","toolCallId":"c","content":[{"type":"text","text":output}]}}),
    ];
    let mut normalizer = Normalizer::new(Provider::Omp);
    let items: Vec<Item> = lines
        .iter()
        .flat_map(|line| normalizer.line(line.to_string().as_bytes(), 0))
        .collect();
    let [Item::Tool {
        subject: Some(subject),
        ..
    }, Item::ToolResult {
        text: Some(output), ..
    }] = items.as_slice()
    else {
        panic!("{items:?}");
    };
    assert_eq!(subject.chars().count(), SUBJECT_LIMIT);
    assert!(subject.ends_with('…'));
    assert_eq!(output.len(), RESULT_LIMIT);
}
