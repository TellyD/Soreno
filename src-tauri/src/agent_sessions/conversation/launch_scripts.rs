use super::{CONFIG, CONFIG_FILENAME, MISSING_EXECUTABLE_EXIT_CODE};

/// `cd`, the 209 exit of a missing `omp`, then `omp` itself; no positional parameters, which
/// fish lacks.
pub(super) fn omp_script(directory: &str, resume: Option<&str>, launch_args: &[String]) -> String {
    let omp: String = launch_args
        .iter()
        .fold("exec omp --mode rpc-ui".into(), |omp, arg| {
            format!("{omp} {}", crate::ssh::quote(arg))
        });
    // OMP writes a conversation's file only with its first message: a conversation left
    // empty has none, and resuming it would fail, so it starts afresh instead.
    let resume = resume
        .map(|file| {
            let file = crate::ssh::quote(file);
            format!(" test -f {file} && {omp} --resume {file};")
        })
        .unwrap_or_default();
    format!(
        "cd -- {} || exit 1; command -v omp >/dev/null 2>&1 || exit {MISSING_EXECUTABLE_EXIT_CODE};{resume} {omp}",
        crate::ssh::quote(directory)
    )
}

pub(super) fn launch_script(
    directory: &str,
    resume: Option<&str>,
    launch_args: &[String],
) -> String {
    crate::ssh::login_shell_script(&omp_script(directory, resume, launch_args))
}

/// `omp_script` in a raw terminal for a dtach run; the config overlay goes into the run's
/// `session` directory, which, unlike a prompt directory, lives as long as the run: OMP rereads
/// it after Soreno detaches.
pub(super) fn detachable_script(
    session: Option<&str>,
    directory: &str,
    resume: Option<&str>,
    launch_args: &[String],
) -> String {
    let mut launch_args = launch_args.to_vec();
    let config = session
        .map(|session| {
            let path = format!("{session}/{CONFIG_FILENAME}");
            let write = format!(
                "printf %s {} > {} || exit 1; ",
                crate::ssh::quote(CONFIG),
                crate::ssh::quote(&path)
            );
            launch_args.extend(["--config".into(), path]);
            write
        })
        .unwrap_or_default();
    // Raw, the terminal passes JSON lines untouched: no echo, line limit or CR.
    format!(
        "stty raw -echo -iexten; {config}{}",
        omp_script(directory, resume, &launch_args)
    )
}
