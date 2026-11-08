use super::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;

const POSIX_HOOK_COMMAND: &str = r#"sh "$SORENO_CONVERSATION_HOOK""#;
// Claude and Codex treat exit 2 as a block (prompt refused, Stop resumed): sidecar failures must not stop the agent.
// `( ... ) || exit 0` would disable `set -e` inside the subshell, so the exit is unconditional.
pub(super) const POSIX_HOOK_SCRIPT: &str = r#"#!/bin/sh
(
set -eu
umask 077
payload=$(cat)
if [ "$SORENO_CONVERSATION_PROVIDER" = claude ] && [ -n "${CLAUDE_JOB_DIR-}" ]; then
    exit 0
fi
if [ "$SORENO_CONVERSATION_PROVIDER" = codex ] && printf '%s' "$payload" | grep -Eq '"agent_id"[[:space:]]*:[[:space:]]*"[^"]+"'; then
    exit 0
fi
identity="$SORENO_CONVERSATION_METADATA.identity"
event_data=$(printf '{"version":1,"runId":"%s","provider":"%s","payload":%s}' "$SORENO_CONVERSATION_RUN_ID" "$SORENO_CONVERSATION_PROVIDER" "$payload")
if [ "$1" = end ] && [ -f "$SORENO_CONVERSATION_METADATA" ]; then
    data=$(cat -- "$SORENO_CONVERSATION_METADATA")
elif [ "$1" = start ]; then
    data=$event_data
    if printf '%s' "$payload" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"compact"' && grep -Eq '"working"[[:space:]]*:[[:space:]]*true' "$SORENO_CONVERSATION_METADATA" 2>/dev/null; then
        data=$(printf '{"version":1,"runId":"%s","provider":"%s","working":true,"identity":%s}' "$SORENO_CONVERSATION_RUN_ID" "$SORENO_CONVERSATION_PROVIDER" "$event_data")
    fi
    identity_tmp="$identity.tmp.$$"
    trap 'rm -f -- "$identity_tmp"' EXIT
    printf '%s' "$event_data" > "$identity_tmp"
    mv -f -- "$identity_tmp" "$identity"
    trap - EXIT
elif [ -f "$identity" ]; then
    saved=$(cat -- "$identity")
    working=false
    awaiting=
    case "$1" in
        working) working=true ;;
        # Unique per report: identical bytes would not refresh the SSH copy.
        awaiting) working=true; awaiting=$(printf ',"awaiting":true,"report":"%s-%s"' "$(date +%s)" "$$") ;;
        # Claude's Stop lists in-flight background tasks; agents among them resume the turn when they report.
        idle) if printf '%s' "$payload" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"(subagent|workflow|cloud session)"'; then working=true; fi ;;
    esac
    turn=
    # Bounded: Soreno reads at most 64 KiB of sidecar.
    if [ "$1" = idle ] && [ "$(printf '%s' "$payload" | wc -c | tr -d ' ')" -le 32768 ]; then
        turn=$(printf ',"turn":{"id":"%s-%s-%s","payload":%s}' "$SORENO_CONVERSATION_RUN_ID" "$(date +%s)" "$$" "$payload")
    fi
    data=$(printf '{"version":1,"runId":"%s","provider":"%s","working":%s%s,"identity":%s%s}' "$SORENO_CONVERSATION_RUN_ID" "$SORENO_CONVERSATION_PROVIDER" "$working" "$awaiting" "$saved" "$turn")
elif [ "$1" = awaiting ]; then
    data=$(printf '{"version":1,"runId":"%s","provider":"%s","report":"%s-%s","payload":%s}' "$SORENO_CONVERSATION_RUN_ID" "$SORENO_CONVERSATION_PROVIDER" "$(date +%s)" "$$" "$payload")
else
    data=$event_data
fi
if [ "$1" != end ] || [ ! -f "$SORENO_CONVERSATION_METADATA" ]; then
    tmp="$SORENO_CONVERSATION_METADATA.tmp.$$"
    trap 'rm -f -- "$tmp"' EXIT
    printf '%s' "$data" > "$tmp"
    mv -f -- "$tmp" "$SORENO_CONVERSATION_METADATA"
    trap - EXIT
fi
if [ "$SORENO_CONVERSATION_REMOTE" = 1 ]; then
    encoded=$(printf '%s' "$data" | base64 | tr -d '\r\n')
    output=${SORENO_CONVERSATION_OUTPUT:-/dev/tty}
    printf '\033]777;soreno;%s;%s\007' "$SORENO_CONVERSATION_RUN_ID" "$encoded" > "$output"
fi
)
exit 0
"#;
pub(super) const WINDOWS_HOOK_SCRIPT: &str = r#"param([string]$Event)
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd().TrimEnd([char[]](13, 10))
if (($env:SORENO_CONVERSATION_PROVIDER -eq 'claude' -and $env:CLAUDE_JOB_DIR) -or ($env:SORENO_CONVERSATION_PROVIDER -eq 'codex' -and $payload -match '"agent_id"\s*:\s*"[^"]+"')) {
    return
}
function Write-Atomic([string]$Path, [string]$Data) {
    $tmp = $Path + '.tmp.' + $PID
    try {
        [IO.File]::WriteAllText($tmp, $Data, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($tmp, $Path, [NullString]::Value)
        } else {
            Move-Item -LiteralPath $tmp -Destination $Path
        }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
$identity = $env:SORENO_CONVERSATION_METADATA + '.identity'
$eventData = '{"version":1,"runId":"' + $env:SORENO_CONVERSATION_RUN_ID + '","provider":"' + $env:SORENO_CONVERSATION_PROVIDER + '","payload":' + $payload + '}'
if ($Event -eq 'end' -and [IO.File]::Exists($env:SORENO_CONVERSATION_METADATA)) {
    $data = [IO.File]::ReadAllText($env:SORENO_CONVERSATION_METADATA, [Text.Encoding]::UTF8)
} elseif ($Event -eq 'start') {
    $data = $eventData
    if ($payload -match '"source"\s*:\s*"compact"' -and [IO.File]::Exists($env:SORENO_CONVERSATION_METADATA) -and [IO.File]::ReadAllText($env:SORENO_CONVERSATION_METADATA, [Text.Encoding]::UTF8) -match '"working"\s*:\s*true') {
        $data = '{"version":1,"runId":"' + $env:SORENO_CONVERSATION_RUN_ID + '","provider":"' + $env:SORENO_CONVERSATION_PROVIDER + '","working":true,"identity":' + $eventData + '}'
    }
    Write-Atomic $identity $eventData
} elseif ([IO.File]::Exists($identity)) {
    $saved = [IO.File]::ReadAllText($identity, [Text.Encoding]::UTF8)
    $working = if ($Event -eq 'working' -or $Event -eq 'awaiting' -or ($Event -eq 'idle' -and $payload -cmatch '"type"\s*:\s*"(subagent|workflow|cloud session)"')) { 'true' } else { 'false' }
    $awaiting = if ($Event -eq 'awaiting') { ',"awaiting":true,"report":"' + [guid]::NewGuid().ToString() + '"' } else { '' }
    $turn = ''
    if ($Event -eq 'idle' -and [Text.Encoding]::UTF8.GetByteCount($payload) -le 32768) {
        $turn = ',"turn":{"id":"' + [guid]::NewGuid().ToString() + '","payload":' + $payload + '}'
    }
    $data = '{"version":1,"runId":"' + $env:SORENO_CONVERSATION_RUN_ID + '","provider":"' + $env:SORENO_CONVERSATION_PROVIDER + '","working":' + $working + $awaiting + ',"identity":' + $saved + $turn + '}'
} elseif ($Event -eq 'awaiting') {
    $data = '{"version":1,"runId":"' + $env:SORENO_CONVERSATION_RUN_ID + '","provider":"' + $env:SORENO_CONVERSATION_PROVIDER + '","report":"' + [guid]::NewGuid().ToString() + '","payload":' + $payload + '}'
} else {
    $data = $eventData
}
if ($Event -ne 'end' -or -not [IO.File]::Exists($env:SORENO_CONVERSATION_METADATA)) {
    Write-Atomic $env:SORENO_CONVERSATION_METADATA $data
}
"#;

pub(super) const WINDOWS_HOOK_SCRIPT_VARIABLE: &str = "SORENO_HOOK";

pub(super) fn windows_hook_script() -> String {
    STANDARD.encode(WINDOWS_HOOK_SCRIPT)
}

fn windows_hook_command(event: &str) -> String {
    // Codex repeats every runner in its launch line, under Windows' 32 767-character limit.
    let script = format!(
        "&([scriptblock]::Create([text.encoding]::UTF8.GetString([convert]::FromBase64String($env:{WINDOWS_HOOK_SCRIPT_VARIABLE})))) {event}"
    );
    format!(
        "powershell.exe -NoProfile -EncodedCommand {}",
        crate::agent_sessions::powershell_encoded_command(&script)
    )
}

pub(super) fn hook_commands(windows_local: bool) -> [String; 5] {
    let events = ["start", "end", "working", "idle", "awaiting"];
    events.map(|event| {
        if windows_local {
            windows_hook_command(event)
        } else {
            format!("{POSIX_HOOK_COMMAND} {event}")
        }
    })
}

pub(super) fn hook_settings(commands: &[String; 5]) -> serde_json::Value {
    let hook =
        |command: &String| serde_json::json!({"type": "command", "command": command, "timeout": 5});
    serde_json::json!({
        "hooks": {
            "SessionStart": [{"hooks": [hook(&commands[0])]}],
            "SessionEnd": [{"hooks": [hook(&commands[1])]}],
            "UserPromptSubmit": [{"hooks": [hook(&commands[2])]}],
            "Stop": [{"hooks": [hook(&commands[3])]}],
            "StopFailure": [{"hooks": [hook(&commands[3])]}],
            "PermissionRequest": [{"hooks": [hook(&commands[4])]}],
            // These tools always wait for the user; other tools only through PermissionRequest.
            "PreToolUse": [{"matcher": "AskUserQuestion|ExitPlanMode", "hooks": [hook(&commands[4])]}],
            // Also covers sandbox network prompts, which skip PermissionRequest.
            "Notification": [{"matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog", "hooks": [hook(&commands[4])]}],
        }
    })
}

pub(super) fn write_claude_settings(path: &Path, commands: &[String; 5]) -> Result<()> {
    std::fs::write(path, hook_settings(commands).to_string())
        .map_err(|error| format!("Impossible d’écrire les réglages Claude : {error}"))
}

pub(super) fn codex_hook_args(commands: &[String; 5], windows_local: bool) -> Vec<String> {
    // The `-c` hooks already force embedded mode; this silences Codex's daemon fallback warning.
    let mut args = vec![
        "-c".into(),
        "features.hooks=true".into(),
        "-c".into(),
        "features.daemon_auto_start=false".into(),
    ];
    for (event, command, timeout) in [
        ("SessionStart", &commands[0], 5),
        ("SessionEnd", &commands[1], 3),
        ("UserPromptSubmit", &commands[2], 5),
        ("Stop", &commands[3], 5),
        ("PermissionRequest", &commands[4], 5),
    ] {
        let hook = if windows_local {
            format!(
                "hooks.{event}=[{{hooks=[{{type='command',command='{command}',timeout={timeout}}}]}}]"
            )
        } else {
            let command = serde_json::Value::String(command.into()).to_string();
            format!(
                "hooks.{event}=[{{hooks=[{{type=\"command\",command={command},timeout={timeout}}}]}}]"
            )
        };
        args.extend(["-c".into(), hook]);
    }
    args
}
