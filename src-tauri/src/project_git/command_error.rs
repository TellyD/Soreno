use super::{Captured, GitError};
use std::process::ExitStatus;

pub(super) fn command_failure(
    status: ExitStatus,
    stderr: Captured,
    stdout: Vec<u8>,
    mutation: bool,
) -> GitError {
    let detail = if stderr.bytes.is_empty() {
        String::from_utf8_lossy(&stdout).into_owned()
    } else {
        String::from_utf8_lossy(&stderr.bytes).into_owned()
    };
    let suffix = if stderr.truncated {
        "\n[sortie d’erreur tronquée à 256 Kio]"
    } else {
        ""
    };
    let code = failure_code(&stdout, &stderr.bytes);
    GitError::command(
        code,
        format!("Git a échoué ({status}) : {}{suffix}", detail.trim()),
        mutation,
    )
}

pub(super) fn failure_code(stdout: &[u8], stderr: &[u8]) -> &'static str {
    let stdout = String::from_utf8_lossy(stdout).to_ascii_lowercase();
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    let porcelain_rejection = stdout.lines().any(|line| {
        let mut fields = line.split('\t');
        fields.next() == Some("!")
            && fields.next().is_some_and(|refspec| refspec.contains(':'))
            && fields.next().is_some_and(|summary| {
                matches!(
                    summary,
                    "[rejected] (non-fast-forward)" | "[rejected] (fetch first)"
                )
            })
            && fields.next().is_none()
    });
    if porcelain_rejection
        || stderr.contains("updates were rejected because the tip of your current branch is behind")
        || stderr.contains("updates were rejected because the remote contains work that you do not")
    {
        return "nonFastForward";
    }
    let detail = if stderr.is_empty() { &stdout } else { &stderr };
    if detail.contains("detected dubious ownership") {
        "unsafe"
    } else if detail.contains("not a git repository") {
        "notRepo"
    } else if detail.lines().any(|line| {
        let line = line.trim();
        line.starts_with("fatal: cannot change to")
            && line.ends_with("': no such file or directory")
    }) {
        "missingDirectory"
    } else if detail.contains("permission denied")
        || detail.contains("cannot change to")
        || detail.contains("does not exist")
        || detail.contains("no such file or directory")
    {
        "inaccessible"
    } else {
        "failed"
    }
}
