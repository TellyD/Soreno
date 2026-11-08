//! GitHub pull requests and GitLab merge requests of a project's repository, through `gh` / `glab api`
//! run in the project's environment. Soreno stores no forge token: the CLI owns authentication.
use crate::{
    agent_sessions::{AgentProject, AgentSessions},
    codex_cli::process::{run_command_output, CommandFailure},
    project_git::{
        self, GitCheckoutBranch, GitComparison, GitError, GitRangeChanges, RequestSource,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(90);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// Exit code of the launch script when the CLI is not on PATH, as for agent sessions.
const MISSING_EXIT: i32 = 209;
/// Line the launch script prints right before the CLI, so a login shell banner is skipped.
const OUTPUT_MARKER: &str = "__SORENO_FORGE_OUTPUT__";
const PAGE_SIZE: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    Github,
    Gitlab,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRemote {
    pub kind: ForgeKind,
    pub host: String,
    pub path: String,
    pub remote: String,
    pub web_url: String,
}

impl ForgeRemote {
    /// `<host>/<path>`: the identity the view sends back with its mutations.
    fn repository(&self) -> String {
        format!("{}/{}", self.host, self.path)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestFilter {
    Open,
    Mine,
    Review,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestAction {
    Close,
    Reopen,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestState {
    Open,
    Closed,
    Merged,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChecksState {
    Success,
    Failure,
    Pending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Success,
    Failure,
    Pending,
    Skipped,
    Neutral,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewerState {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeBlocker {
    Draft,
    Conflicts,
    Checks,
    Approvals,
    Behind,
    Unknown,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSummary {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub cross_repository: bool,
    pub draft: bool,
    pub state: RequestState,
    pub checks: Option<ChecksState>,
    pub review: Option<ReviewState>,
    pub conflicts: bool,
    pub created_at: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub name: String,
    pub state: ReviewerState,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub oid: String,
    pub title: String,
    pub author: String,
    pub date: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    #[serde(flatten)]
    pub summary: RequestSummary,
    pub body: String,
    pub head_oid: String,
    pub base_oid: String,
    pub reviewers: Vec<Reviewer>,
    pub labels: Vec<Label>,
    pub check_runs: Vec<Check>,
    pub commits: Vec<Commit>,
    pub merge_blockers: Vec<MergeBlocker>,
    /// Allowed methods, the one the forge preselects first.
    pub merge_methods: Vec<MergeMethod>,
    pub delete_source_branch: bool,
    pub changed_files: u64,
    /// The remote it was read from, sent back by the mutations acting on it.
    pub repository: String,
}

/// Where a request's head lives, for the local Git side; sent back by the view for its files.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestHead {
    source_branch: String,
    cross_repository: bool,
    head_oid: String,
    base_oid: String,
}

pub(crate) fn remote(project: &AgentProject) -> Result<ForgeRemote, GitError> {
    let (name, url) =
        project_git::first_remote_url(project, &["upstream", "origin"])?.ok_or_else(|| {
            GitError::new(
                "noRemote",
                "Le dépôt n’a ni dépôt distant « upstream » ni « origin ».",
            )
        })?;
    let unrecognized = || {
        GitError::new(
            "unrecognizedRemote",
            format!("URL du dépôt distant « {name} » non reconnue."),
        )
    };
    let (host, path) = parse_remote_url(&url).ok_or_else(unrecognized)?;
    let kind = match host.as_str() {
        "github.com" => ForgeKind::Github,
        "gitlab.com" => ForgeKind::Gitlab,
        _ => {
            return Err(GitError::new(
                "unsupportedForge",
                format!("La forge {host} n’est pas prise en charge."),
            ))
        }
    };
    if kind == ForgeKind::Github && path.split('/').count() != 2 {
        return Err(unrecognized());
    }
    Ok(ForgeRemote {
        kind,
        web_url: format!("https://{host}/{path}"),
        host,
        path,
        remote: name,
    })
}

/// The listed remote, refused when it no longer is the repository the view displayed.
fn displayed_remote(project: &AgentProject, repository: &str) -> Result<ForgeRemote, GitError> {
    let remote = remote(project)?;
    if remote.repository() != repository {
        return Err(GitError::new(
            "stale",
            "Le dépôt distant a changé depuis l’affichage : actualisez la liste.",
        ));
    }
    Ok(remote)
}

/// Host and repository path of a GitHub/GitLab-style remote URL (HTTPS, SSH or scp-like).
fn parse_remote_url(url: &str) -> Option<(String, String)> {
    let (authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            if !matches!(
                scheme.to_ascii_lowercase().as_str(),
                "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git"
            ) {
                return None;
            }
            rest.split_once('/')?
        }
        None => {
            let (authority, path) = url.split_once(':')?;
            if authority.contains('/') {
                return None;
            }
            (authority, path)
        }
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    let host = match host.as_str() {
        "ssh.github.com" | "www.github.com" => "github.com".to_owned(),
        "altssh.gitlab.com" | "www.gitlab.com" => "gitlab.com".to_owned(),
        _ => host,
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments = path.split('/').collect::<Vec<_>>();
    let valid = !host.is_empty()
        && segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        });
    valid.then(|| (host, path.to_owned()))
}

pub(crate) fn requests(
    project: &AgentProject,
    filter: RequestFilter,
    search: &str,
) -> Result<Vec<RequestSummary>, GitError> {
    let remote = remote(project)?;
    let cli = Cli::new(project, &remote);
    let search = search.trim();
    if search.len() > 256 || search.chars().any(char::is_control) {
        return Err(GitError::new("invalidSearch", "Recherche invalide."));
    }
    match remote.kind {
        ForgeKind::Github => github::requests(&cli, &remote, filter, search),
        ForgeKind::Gitlab => gitlab::requests(&cli, &remote, filter, search),
    }
}

pub(crate) fn request(project: &AgentProject, number: u64) -> Result<RequestDetail, GitError> {
    let remote = remote(project)?;
    let cli = Cli::new(project, &remote);
    match remote.kind {
        ForgeKind::Github => github::request(&cli, &remote, number),
        ForgeKind::Gitlab => gitlab::request(&cli, &remote, number),
    }
}

pub(crate) fn merge(
    project: &AgentProject,
    repository: &str,
    number: u64,
    method: MergeMethod,
    head_oid: &str,
) -> Result<(), GitError> {
    project_git::validate_oid(head_oid)?;
    let remote = displayed_remote(project, repository)?;
    let cli = Cli::new(project, &remote);
    match remote.kind {
        ForgeKind::Github => github::merge(&cli, &remote, number, method, head_oid),
        ForgeKind::Gitlab => gitlab::merge(&cli, &remote, number, method, head_oid),
    }
}

pub(crate) fn update(
    project: &AgentProject,
    repository: &str,
    number: u64,
    action: RequestAction,
) -> Result<(), GitError> {
    let remote = displayed_remote(project, repository)?;
    let cli = Cli::new(project, &remote);
    match remote.kind {
        ForgeKind::Github => github::update(&cli, &remote, number, action),
        ForgeKind::Gitlab => gitlab::update(&cli, &remote, number, action),
    }
}

/// Files of the displayed request, read from its known head and base without asking the forge.
pub(crate) fn changes(
    sessions: &AgentSessions,
    project_id: &str,
    repository: &str,
    number: u64,
    head: &RequestHead,
) -> Result<GitRangeChanges, GitError> {
    let project = load(sessions, project_id)?;
    let remote = displayed_remote(&project, repository)?;
    let fallback_ref =
        (!head.cross_repository).then(|| format!("refs/heads/{}", head.source_branch));
    project_git::request_changes(
        sessions,
        project_id,
        &RequestSource {
            remote: &remote.remote,
            head_ref: &head_ref(remote.kind, number),
            fallback_ref: fallback_ref.as_deref(),
            head_oid: &head.head_oid,
            base_oid: &head.base_oid,
        },
    )
}

pub(crate) fn comparison(
    project: &AgentProject,
    base: &str,
    head: &str,
    path: &str,
) -> Result<GitComparison, GitError> {
    project_git::range_comparison(project, base, head, path)
}

/// Fork requests get a `pr/<n>` / `mr/<n>` branch: their source branch name may clash with ours.
// shortcut: pushing from that branch targets the listed remote, not the fork; add fork remotes if users push to forks.
// shortcut: `head` comes from the displayed detail over IPC, not re-read from the forge; a forged `crossRepository: false` would fetch the request into the branch's tracking ref (restored by the next fetch).
pub(crate) fn checkout(
    sessions: &AgentSessions,
    project_id: &str,
    repository: &str,
    number: u64,
    version: &str,
    head: RequestHead,
) -> Result<GitCheckoutBranch, GitError> {
    let project = load(sessions, project_id)?;
    let remote = displayed_remote(&project, repository)?;
    let local = if head.cross_repository {
        let prefix = match remote.kind {
            ForgeKind::Github => "pr",
            ForgeKind::Gitlab => "mr",
        };
        format!("{prefix}/{number}")
    } else {
        head.source_branch
    };
    let checkout = |fetched: &str| {
        project_git::request_checkout(
            sessions,
            project_id,
            version,
            &remote.remote,
            fetched,
            &local,
        )
    };
    match checkout(&head_ref(remote.kind, number)) {
        // GitLab deletes `refs/merge-requests/<n>/head` 14 days after merge/close; the branch may remain.
        Err(error)
            if !head.cross_repository
                && error.code == "failed"
                && error.message.contains("couldn't find remote ref") =>
        {
            let branch = checkout(&format!("refs/heads/{local}"))?;
            // A fetched branch may have moved since the request; a local one is reused deliberately.
            if branch.remote && (head.head_oid.is_empty() || branch.oid != head.head_oid) {
                return Err(GitError::new(
                    "requestHeadMismatch",
                    "La branche de la demande ne pointe plus sur son dernier commit : impossible de l'extraire.",
                ));
            }
            Ok(branch)
        }
        result => result,
    }
}

fn load(sessions: &AgentSessions, project_id: &str) -> Result<AgentProject, GitError> {
    sessions
        .project(project_id)
        .map_err(|message| GitError::new("project", message))
}

fn head_ref(kind: ForgeKind, number: u64) -> String {
    match kind {
        ForgeKind::Github => format!("refs/pull/{number}/head"),
        ForgeKind::Gitlab => format!("refs/merge-requests/{number}/head"),
    }
}

#[derive(Clone)]
enum Field {
    Text(String),
    Typed(String),
}

fn text(name: &str, value: impl std::fmt::Display) -> Field {
    Field::Text(format!("{name}={value}"))
}

/// Only for values Soreno formats itself: `-F` reads files from `@…` values.
fn typed(name: &str, value: impl std::fmt::Display) -> Field {
    Field::Typed(format!("{name}={value}"))
}

struct Cli<'a> {
    project: &'a AgentProject,
    kind: ForgeKind,
    host: &'a str,
}

impl<'a> Cli<'a> {
    fn new(project: &'a AgentProject, remote: &'a ForgeRemote) -> Self {
        Self {
            project,
            kind: remote.kind,
            host: &remote.host,
        }
    }

    fn get(&self, endpoint: &str) -> Result<Value, GitError> {
        self.api(None, endpoint, &[], READ_TIMEOUT)
    }

    fn send(&self, method: &str, endpoint: &str, fields: &[Field]) -> Result<Value, GitError> {
        self.api(Some(method), endpoint, fields, WRITE_TIMEOUT)
    }

    fn graphql(&self, query: &str, variables: Vec<Field>) -> Result<Value, GitError> {
        let mut fields = vec![text("query", query)];
        fields.extend(variables);
        let timeout = if query.trim_start().starts_with("mutation") {
            WRITE_TIMEOUT
        } else {
            READ_TIMEOUT
        };
        let response = self.api(None, "graphql", &fields, timeout)?;
        if let Some(errors) = response
            .get("errors")
            .and_then(Value::as_array)
            .filter(|errors| !errors.is_empty())
        {
            return Err(graphql_error(errors));
        }
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }

    fn api(
        &self,
        method: Option<&str>,
        endpoint: &str,
        fields: &[Field],
        timeout: Duration,
    ) -> Result<Value, GitError> {
        let mut args = vec![
            "api".to_owned(),
            "--hostname".to_owned(),
            self.host.to_owned(),
        ];
        if let Some(method) = method {
            args.extend(["--method".to_owned(), method.to_owned()]);
        }
        if self.kind == ForgeKind::Github && endpoint == "graphql" {
            // `mergeStateStatus` sits behind this schema preview.
            args.extend(["--preview".to_owned(), "merge-info".to_owned()]);
        }
        args.push(endpoint.to_owned());
        for field in fields {
            match field {
                Field::Text(value) => args.extend(["--raw-field".to_owned(), value.clone()]),
                Field::Typed(value) => args.extend(["--field".to_owned(), value.clone()]),
            }
        }
        let program = match self.kind {
            ForgeKind::Github => "gh",
            ForgeKind::Gitlab => "glab",
        };
        let (status, stdout, stderr) = run(self.project, program, &args, timeout)?;
        if status == Some(MISSING_EXIT) {
            return Err(GitError::new(
                "cliMissing",
                format!("La commande {program} est introuvable dans l’environnement du projet."),
            ));
        }
        if status != Some(0) {
            return Err(cli_error(self.kind, status, &stdout, &stderr));
        }
        parse_json(&stdout).ok_or_else(|| {
            GitError::new(
                "forge",
                format!(
                    "Réponse illisible de {program} : {}",
                    first_line(cli_output(&stdout))
                ),
            )
        })
    }
}

// shortcut: the CLI runs from the process/home directory, not the project's, so a gh/glab pinned per project (mise shim) is not found; cd into the project if users report it.
fn launch_script(program: &str, args: &[String]) -> String {
    let mut command = format!(
        "command -v {program} >/dev/null 2>&1 || exit {MISSING_EXIT}; export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat GLAB_CHECK_UPDATE=false GLAB_SEND_TELEMETRY=false NO_COLOR=1 CLICOLOR=0 PAGER=cat; echo {OUTPUT_MARKER}; echo {OUTPUT_MARKER} >&2; exec {program}"
    );
    for arg in args {
        command.push(' ');
        command.push_str(&crate::ssh::quote(arg));
    }
    crate::ssh::login_shell_script(&command)
}

fn run(
    project: &AgentProject,
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Result<(Option<i32>, String, String), GitError> {
    let script = launch_script(program, args);
    let inaccessible = |message: String| GitError::new("inaccessible", message);
    if project.environment.kind == "ssh" {
        let connection = project
            .environment
            .ssh
            .as_ref()
            .ok_or_else(|| inaccessible("Connexion SSH absente.".into()))?;
        let _access = crate::ssh::begin_access(connection).map_err(inaccessible)?;
        let output =
            crate::ssh::run_output_with_timeout(connection, &script, None, OUTPUT_LIMIT, timeout)
                .map_err(inaccessible)?;
        return Ok((
            Some(i32::from(output.status)),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ));
    }
    let mut command = local_command(project, program, args, &script)?;
    let output = run_command_output(&mut command, timeout, true, OUTPUT_LIMIT as u64).map_err(
        |failure| match failure {
            CommandFailure::Io(error) => inaccessible(error),
            CommandFailure::Timeout => {
                GitError::new("network", format!("{program} n’a pas répondu à temps."))
            }
        },
    )?;
    Ok((output.status.code(), output.stdout, output.stderr))
}

fn local_command(
    project: &AgentProject,
    program: &str,
    args: &[String],
    script: &str,
) -> Result<std::process::Command, GitError> {
    if project.environment.kind == "wsl" {
        #[cfg(windows)]
        return Ok(crate::subscription_usage::wsl_command(
            project
                .environment
                .distribution
                .as_deref()
                .ok_or_else(|| GitError::new("wsl", "Distribution WSL absente."))?,
            script,
        ));
        #[cfg(not(windows))]
        return Err(GitError::new(
            "wsl",
            "L’exécution WSL est uniquement disponible sous Windows.",
        ));
    }
    #[cfg(unix)]
    {
        let _ = (program, args);
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        Ok(command)
    }
    #[cfg(windows)]
    {
        let _ = script;
        let mut command = std::process::Command::new("powershell.exe");
        // shortcut: -NoProfile hides profile banners from the JSON, but a gh/glab put on PATH only by the PowerShell profile is not found; emit a marker and load the profile if users report it.
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-EncodedCommand",
                &crate::agent_sessions::windows_launcher(program, args, true)
                    .map_err(|message| GitError::new("inaccessible", message))?,
            ])
            .envs([
                ("GH_PROMPT_DISABLED", "1"),
                ("GH_NO_UPDATE_NOTIFIER", "1"),
                ("GH_PAGER", "cat"),
                ("GLAB_CHECK_UPDATE", "false"),
                ("GLAB_SEND_TELEMETRY", "false"),
                ("NO_COLOR", "1"),
            ]);
        Ok(command)
    }
}

/// What the CLI printed on a stream, past any banner or diagnostic the interactive login shell printed before the marker.
fn cli_output(output: &str) -> &str {
    output
        .split_once(OUTPUT_MARKER)
        .map_or(output, |(_, rest)| rest)
}

/// The JSON document of a CLI's output, past any banner an interactive login shell printed.
fn parse_json(output: &str) -> Option<Value> {
    let output = cli_output(output);
    let start = output.find(['{', '['])?;
    serde_json::Deserializer::from_str(&output[start..])
        .into_iter::<Value>()
        .next()?
        .ok()
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    line.strip_prefix("gh: ")
        .or_else(|| line.strip_prefix("glab: "))
        .or_else(|| line.strip_prefix("ERROR: "))
        .unwrap_or(line)
        .chars()
        .take(500)
        .collect()
}

fn cli_error(kind: ForgeKind, status: Option<i32>, stdout: &str, stderr: &str) -> GitError {
    let (stdout, stderr) = (cli_output(stdout), cli_output(stderr));
    let lower = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    let has = |markers: &[&str]| markers.iter().any(|marker| lower.contains(marker));
    if has(&["rate limit", "rate_limited", "http 429", "429 too many"]) {
        GitError::new(
            "rateLimited",
            "Limite de requêtes de la forge atteinte. Réessayez plus tard.",
        )
    } else if (kind == ForgeKind::Github && status == Some(4))
        || has(&[
            "http 401",
            "401 unauthorized",
            "auth login",
            "gh_token",
            "gitlab_token",
            "not logged in",
            "bad credentials",
            "authentication required",
        ])
    {
        GitError::new(
            "unauthenticated",
            "La CLI de la forge n’est pas connectée à ce compte.",
        )
    } else if has(&[
        "http 403",
        "403 forbidden",
        "http 404",
        "404 not found",
        "could not resolve to a",
        "resource not accessible",
    ]) {
        GitError::new(
            "forbidden",
            "Dépôt introuvable ou accès refusé pour le compte connecté.",
        )
    } else if has(&[
        "could not resolve host",
        "no such host",
        "dial tcp",
        "connection refused",
        "connection reset",
        "network is unreachable",
        "i/o timeout",
        "tls handshake",
        "error connecting to",
        "temporary failure in name resolution",
    ]) {
        GitError::new("network", "La forge est injoignable.")
    } else {
        let message = Some(first_line(stderr))
            .filter(|line| !line.is_empty())
            .or_else(|| {
                parse_json(stdout).and_then(|body| {
                    body.get("message")
                        .or_else(|| body.get("error"))
                        .and_then(Value::as_str)
                        .map(first_line)
                })
            })
            .filter(|line| !line.is_empty())
            .unwrap_or_else(|| match status {
                Some(code) => format!("La CLI de la forge a échoué (code {code})."),
                None => "La CLI de la forge a échoué.".into(),
            });
        GitError::new("forge", message)
    }
}

fn graphql_error(errors: &[Value]) -> GitError {
    let types = errors
        .iter()
        .filter_map(|error| error.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>();
    if types.contains(&"RATE_LIMITED") {
        return cli_error(ForgeKind::Github, None, "", "rate limit");
    }
    if types
        .iter()
        .any(|kind| matches!(*kind, "NOT_FOUND" | "FORBIDDEN"))
    {
        return cli_error(ForgeKind::Github, None, "", "http 403");
    }
    let messages = errors
        .iter()
        .filter_map(|error| error.get("message").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    cli_error(ForgeKind::Github, None, "", &messages)
}

fn str_at<'v>(value: &'v Value, pointer: &str) -> &'v str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn string_at(value: &Value, pointer: &str) -> String {
    str_at(value, pointer).to_owned()
}

fn bool_at(value: &Value, pointer: &str) -> bool {
    value
        .pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn nodes<'v>(value: &'v Value, pointer: &str) -> &'v [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn malformed(what: &str) -> GitError {
    GitError::new("forge", format!("Réponse de la forge incomplète : {what}."))
}

#[path = "forge/github.rs"]
mod github;
#[path = "forge/gitlab.rs"]
mod gitlab;

#[cfg(test)]
#[path = "forge_tests.rs"]
mod tests;
