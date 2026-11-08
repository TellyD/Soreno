use super::RELAY_SOURCE;
use crate::{agent_sessions::AgentProject, project_git::command_builder};
use std::{
    ffi::{OsStr, OsString},
    path::{Component, PathBuf, Prefix},
};

#[derive(Clone)]
pub(super) struct RelaySpec {
    pub(super) program: OsString,
    pub(super) args: Vec<OsString>,
    pub(super) env: Vec<(OsString, Option<OsString>)>,
    pub(super) current_dir: Option<PathBuf>,
    pub(super) source: &'static [u8],
}

fn local_temp_dir() -> Option<PathBuf> {
    let path = std::env::temp_dir();
    let local = matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    );
    (local && path.is_dir()).then_some(path)
}

pub(super) fn relay_spec(
    project: &AgentProject,
    args: &[&str],
) -> Option<(RelaySpec, Vec<String>)> {
    let prefix = command_builder::git_program(project);
    let prefix_args = prefix
        .get_args()
        .map(OsStr::to_os_string)
        .collect::<Vec<_>>();
    let marker = prefix_args.len().checked_sub(2)?;
    if prefix_args.get(marker)? != "git" || prefix_args.last()? != "--no-replace-objects" {
        return None;
    }
    let source = command_builder::git_command(project, args).ok()?;
    let argv = source
        .get_args()
        .map(OsStr::to_os_string)
        .collect::<Vec<_>>();
    if !argv.starts_with(&prefix_args) {
        return None;
    }
    let git_args = argv[marker + 1..]
        .iter()
        .map(|value| value.to_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    if argv.first()? != "--distribution" || argv.get(2)? != "--exec" || argv.get(3)? != "env" {
        return None;
    }
    let mut relay_args = argv[..2].to_vec();
    relay_args.extend([OsString::from("--cd"), OsString::from("/")]);
    relay_args.extend_from_slice(&argv[2..marker]);
    relay_args.extend([
        OsString::from("python3"),
        OsString::from("-I"),
        OsString::from("-S"),
        OsString::from("-u"),
        OsString::from("-c"),
        OsString::from(format!(
            "import sys;source=sys.stdin.buffer.read({});assert len(source)=={};exec(compile(source,'soreno-wsl-read.py','exec'))",
            RELAY_SOURCE.len(),
            RELAY_SOURCE.len()
        )),
    ]);
    Some((
        RelaySpec {
            program: source.get_program().to_os_string(),
            args: relay_args,
            env: source
                .get_envs()
                .map(|(name, value)| (name.to_os_string(), value.map(OsStr::to_os_string)))
                .collect(),
            current_dir: local_temp_dir().or_else(|| source.get_current_dir().map(PathBuf::from)),
            source: RELAY_SOURCE,
        },
        git_args,
    ))
}
