import { useI18n } from "../../i18n";
import {
  agentConversationStringsEn,
  agentConversationStringsFr,
} from "./agentConversationStrings";

const en = {
  title: "Agents",
  projects: "Projects",
  kanban: "Kanban",
  addProject: "Add a project",
  onlyProjectsWithAgents: "Only projects with agents",
  hiddenProjects: (count: number) =>
    count === 0
      ? "No hidden projects"
      : count === 1
        ? "1 hidden project"
        : `${count} hidden projects`,
  showAllProjects: "Show all",
  collapseAllProjects: "Collapse all projects",
  expandAllProjects: "Expand all projects",
  newGroup: "Create group",
  editGroup: "Edit group",
  deleteGroup: "Delete group",
  moveGroupUp: "Move group up",
  moveGroupDown: "Move group down",
  moveToGroup: (name: string) => `Move to “${name}”`,
  removeFromGroup: "Remove from group",
  moveToGroupOtherMachine: (
    project: string,
    projectMachine: string,
    group: string,
    groupMachine: string,
  ) =>
    `“${project}” (${projectMachine}) can’t be moved to “${group}” (${groupMachine}): a group can only contain projects from the same machine.`,
  groupName: "Group name",
  groupNameTooLong: "Use 100 characters or fewer.",
  groupProjects: "Projects in this group",
  groupProjectsSelected: (count: number) =>
    count === 1 ? "1 selected" : `${count} selected`,
  groupProjectsHint: "A project can belong to only one group.",
  groupProjectRequired: "Choose at least one project.",
  groupProjectCount: (count: number) =>
    count === 1 ? "1 project" : `${count} projects`,
  collapseGroup: "Collapse group",
  expandGroup: "Expand group",
  groupOverview: "Overview",
  openGroupOverview: "Open overview",
  groupRepositories: "Repositories",
  refreshGroupRepositories: "Refresh repositories",
  groupRepositoriesLoading: "Reading repositories…",
  groupEmpty: "Add a project to the group",
  groupDisconnected: "Disconnected",
  groupNotRepository: "Not a Git repository",
  groupChangeCounts: ({
    conflicts,
    staged,
    unstaged,
    untracked,
  }: Record<"conflicts" | "staged" | "unstaged" | "untracked", number>) =>
    [
      conflicts ? `${conflicts} in conflict` : "",
      staged ? `${staged} staged` : "",
      unstaged ? `${unstaged} modified` : "",
      untracked ? `${untracked} untracked` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  openGroupMember: (name: string) => `Open ${name}`,
  groupActiveAgents: (count: number) =>
    `${count} active agent${count > 1 ? "s" : ""}`,
  groupProjectUnavailable: "This project cannot be added to this group",
  projectGroupLocked:
    "Remove this project from its group to change its machine.",
  deleteGroupTitle: (name: string) => `Delete the group “${name}”?`,
  deleteGroupDescription:
    "Overview sessions and their conversations will be deleted. The group’s projects are kept.",
  deleteGroupWithProjectsDescription:
    "Overview sessions, the group’s projects, their launchers and sessions will be removed from Soreno. The project folders and their files stay on disk. Worktrees outside the group stay in Soreno.",
  deleteGroupProjects: (count: number) =>
    count === 1
      ? "Also remove its project from Soreno"
      : `Also remove its ${count} projects from Soreno`,
  groupFolderRetained: (path: string) =>
    `The group folder is not empty and was kept: ${path}`,
  groupMigrationUngrouped: (names: string) =>
    `These projects were on another machine and left their group: ${names}`,
  openRepository: "Add project",
  cloneRepository: "Clone repository",
  cloneUrl: "Repository URL",
  cloneUrlPlaceholder: "https://… or git@host:repo.git",
  cloneUrlRequired: "Enter a repository URL.",
  cloneFolder: "New folder name",
  cloneFolderInvalid: "Enter one folder name without slashes.",
  pickCloneParentTitle: "Choose a folder",
  cloningElapsed: (seconds: number) => `Cloning… ${seconds}s`,
  clonePreserved: (path: string) =>
    `Clone failed after creating ${path}. The folder was kept.`,
  openPreserved: "Open this folder",
  projectLocked:
    "This project has sessions. Its folder and environment cannot be changed until they are deleted.",
  nameRequired: "Enter a name.",
  externalWorktree: "External worktree · Open",
  openWorktree: "Open worktree",
  worktreeReadError: "Unable to read Git worktrees.",
  branchUnavailable: "Git branch unavailable",
  branchReadError: "Unable to read Git branches.",
  branchLoading: "Reading Git branch…",
  workspaceLoadError: "Unable to load agent projects.",
  statusReadError: "Unable to read session statuses.",
  conversationLinkError: "Unable to link this session to its conversation.",
  outdatedCli:
    "This CLI version does not report its activity: update Claude Code (2.1.295 or later) or Codex (0.163 or later).",
  starting: "Starting process…",
  startingShort: "Starting…",
  working: "Agent working…",
  unread: "Agent finished · unread",
  awaiting: "Agent waiting · reply needed",
  notificationAwaiting: "Waiting for your reply",
  notificationFinished: "Turn finished",
  notificationSeveral: (count: number) => `${count} sessions need you`,
  notificationFailed: (error: string) => `System notification failed: ${error}`,
  editProject: "Edit project",
  customizeProject: "Customize icon and color",
  projectImage: "Custom image",
  resetProjectAppearance: "Reset",
  newSession: "New session",
  splitTerminal: "Split terminal",
  splitTerminalLeft: "Move to left pane",
  splitTerminalRight: "Move to right pane",
  detachSplitTerminal: "Detach secondary pane",
  splitPane: "Split view",
  activity: "Session activity",
  sessionTabs: "Project sessions",
  services: "Services",
  urlOpenError: "Unable to open the URL.",
  startService: (label: string) => `Start ${label}`,
  stopService: (label: string) => `Stop ${label}`,
  restartService: (label: string) => `Restart ${label}`,
  startAllServices: "Start all",
  stopAllServices: "Stop all",
  showServiceLogs: (label: string) => `Show logs for ${label}`,
  serviceReady: "Ready",
  serviceRunning: "Running",
  serviceStopped: "Stopped",
  servicePending: "Operation in progress",
  serviceExitCode: (code: number) => `Exit code ${code}`,
  servicePort: (port: number) => `Port ${port}`,
  serviceLogs: "Service logs",
  serviceNoLogs: "No logs yet",
  serviceNoLogsDescription: "Start this service to open its log stream.",
  servicesDisconnected:
    "This SSH project is disconnected. Latest statuses and logs remain available.",
  resizeServices: "Resize the services panel",
  servicesManifestError: "Unable to load the services manifest.",
  serviceStartError: (label: string) =>
    `Unable to start the “${label}” service.`,
  serviceStopTimeout: (label: string) =>
    `The “${label}” service did not stop in time. Wait a moment, then retry.`,
  trustServicesTitle: "Trust these service commands?",
  trustServicesDescription:
    "Soreno will run these commands on the selected SSH server. Review each working directory and argument before continuing.",
  trustWorkingDirectory: "Working directory",
  trustArguments: "Command and arguments",
  trustAndStart: "Trust and start",
  changes: "Project tools",
  issuePanel: (identifier: string) => `Issue ${identifier}`,
  issuePanelLink: "Link an issue",
  designPanel: "Design board",
  designPanelLink: "Link a design",
  resizeChanges: "Resize project tools",
  emptyBody:
    "Add a project folder, then launch an agent in its own terminal. Sessions keep running when you move elsewhere in Soreno.",
  chooseSession: "Choose a session or launch an agent in this project.",
  desktop: "Agent terminals require the Soreno desktop app.",
  name: "Name",
  displayName: "Display name",
  environment: "Environment",
  local: "Local",
  ssh: "SSH",
  projectCustomization: "Customization",
  importProjectIcon: "Import image…",
  importingProjectIcon: "Importing image…",
  projectIconHint: "PNG, JPEG, WebP or GIF · 5 MB max. Resized automatically.",
  projectIconError:
    "Unable to import this image. Choose a valid PNG, JPEG, WebP or GIF file up to 5 MB.",
  linearProject: "Linear project",
  linearProjectNone: "None",
  linearProjectLinkedTo: (projectName: string) => `linked to ${projectName}`,
  linearProjectUnavailable: "Unavailable Linear project",
  linearProjectLoading: "Loading Linear projects…",
  linearProjectLoadError: "Unable to load Linear projects.",
  linearProjectHint:
    "Kanban issues of this Linear project belong to this Soreno project.",
  issueAgentProjectUnavailable:
    "This project cannot start an agent on an issue.",
  issueAgentProjectDisconnected:
    "Connect this SSH project before starting an agent.",
  issueAgentBusy: "Another operation is in progress. Please try again.",
  chooseFolder: "Choose a folder…",
  pickFolderTitle: "Choose a project folder",
  pickingFolder: "Choosing folder…",
  sshConnection: "SSH connection",
  sshNewConnection: "New SSH connection",
  sshHost: "Host or OpenSSH alias",
  sshUser: "User (optional)",
  sshPort: "Port (optional)",
  sshIdentity: "Private key (optional)",
  sshChooseIdentity: "Choose key…",
  sshIdentityHint: "Choose the private key, not its .pub file.",
  sshPublicKeyInvalid:
    "Choose the private key file. The .pub file cannot authenticate you.",
  sshBrowsing: "Connecting…",
  sshRecheck: "Recheck server identity",
  sshScanning: "Reading server identity…",
  sshCheckingTrust: "Checking the server identity…",
  sshHostRequired: "Enter an SSH host or OpenSSH alias.",
  sshPortInvalid: "Enter an SSH port from 1 to 65535.",
  sshCurrentFolder: "Remote folder",
  sshParentFolder: "Parent folder",
  sshSelectFolder: "Select this folder",
  sshMultipleSelection: "Select multiple projects",
  sshSelectProject: (name: string) => `Select ${name}`,
  sshSelectProjects: (count: number) =>
    count === 1 ? "Select 1 project" : `Select ${count} projects`,
  sshGroupProjects: "Create a group with the selected projects",
  sshTrustTitle: "Confirm the server identity",
  sshTrustTarget: (target: string) => `Server: ${target}`,
  sshTrustWarning:
    "Security check: compare this SHA256 fingerprint with the trusted server console or ask its administrator before continuing.",
  sshTrustAndContinue: "Trust and continue",
  sshTrustKey: "Trust this key",
  sshNoHostKey:
    "OpenSSH did not return a server host key. Check the host and try again.",
  sshVerified: "Server identity confirmed",
  sshKeyRequiresAgent:
    "The selected private key is passphrase-protected, but no unlocked key is available from ssh-agent. Start the agent if needed, load your key with ssh-add, then retry. Soreno cannot ask for the passphrase.",
  sshAuthError:
    "SSH authentication was refused. Check the user and private key, or unlock an encrypted key in ssh-agent, then retry.",
  sshChangedHostError:
    "Security warning: the server host key changed or was revoked. Do not continue until the server administrator confirms the new fingerprint.",
  sshTimeoutError:
    "The SSH connection timed out. Check the host, port, network, VPN or firewall, then retry.",
  sshRefusedError:
    "The SSH connection was refused. Check that the host, port and SSH service are available.",
  sshOpenSshMissing:
    "OpenSSH is unavailable. Install or enable the ssh command on this computer, then retry.",
  refresh: "Refresh environments",
  discovering: "Discovering environments…",
  wslHint: "WSL discovery is unavailable. Local projects still work.",
  absolutePath: "Enter an absolute path for the selected environment.",
  distribution: "Choose a WSL distribution.",
  back: "Back",
  cancel: "Cancel",
  save: "Save",
  rename: "Rename session",
  renameHint:
    "This name replaces the one the agent sets automatically. Leave it empty to use the automatic name again.",
  stop: "Stop",
  restart: "Restart",
  copyAttachCommand: "Copy attach command",
  attachCommandCopied:
    "Command copied: run it from another terminal to follow this session.",
  connect: "Connect",
  connecting: "Connecting…",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  disconnected: "Disconnected",
  disconnectDescription:
    "Disconnect this SSH project? Soreno will suspend this SSH connection and stop agents in every project using it; unsaved work may be lost. Ona keeps running. Files and launchers are kept. Git is suspended until you reconnect.",
  disconnectIncompleteTitle: "Project disconnected with incomplete shutdown",
  disconnectIncompleteDescription:
    "This project is already disconnected, but some shutdown operations failed.",
  sshRemoteStopFailed:
    "Soreno could not stop the agents on the SSH server, which may be unreachable. Disconnecting deletes anyway and disconnects every project using this SSH connection; agents still running on the server may keep running.",
  disconnectAndDelete: "Disconnect and delete",
  dismiss: "Close",
  removeSession: "Delete session",
  removeProject: "Delete project",
  removeWorktree: "Delete worktree",
  mergeWorktree: (base: string) => `Merge into ${base} and delete`,
  ready: "Ready",
  running: "Running",
  stopped: "Stopped",
  resumeLinked: "Click this session to resume its linked conversation.",
  resumeSelect: "Choose the conversation once in the CLI selector.",
  resumeApproval:
    "Approve the Soreno hooks in Codex’s startup review or with /hooks, then relaunch this session.",
  resumeUnsupported:
    "Native resume is not integrated for this CLI; it will launch normally.",
  retry: "Retry",
  loading: "Loading projects…",
  terminal: "Agent terminal",
  terminalError: "Unable to read the terminal output.",
  operationSshHostKeyError:
    "The SSH server identity could not be verified. Verify its host key before retrying.",
  operationDnsError:
    "Server name could not be resolved (DNS). Check your network connection and retry.",
  operationAuthError:
    "Git authentication was refused. Check the Git credentials for this environment.",
  operationDirtyRepository:
    "The working tree must be clean before this Git operation.",
  operationWorktreeDirty:
    "This worktree has uncommitted changes or untracked files. Commit or stash them in this worktree before merging it.",
  operationPrimaryWorktreeDirty:
    "The main worktree has uncommitted changes or untracked files. Commit or stash them there before merging into it.",
  operationPrimaryWorktreeProtected:
    "The main worktree can’t be deleted from Soreno.",
  operationMissingPrimaryWorktree:
    "This bare repository has no main worktree to merge into.",
  operationWorktreeAssociationUnknown:
    "Soreno couldn’t check every project linked to this repository. Reconnect or remove unreachable projects, then try again.",
  operationGitMergeConflict:
    "The merge has conflicts, left in progress in the source worktree. Hand them to an agent, or resolve them in Changes and commit the merge, then try again.",
  resolveConflictsWithAgent: "Resolve with an agent",
  mergeConflictSessionName: (agent: string) => `Conflicts · ${agent}`,
  operationGitSourceMergePending:
    "A merge is still in progress in the source worktree. Commit it in Changes for that worktree, then try again.",
  operationGitMergeOptions:
    "Remove the branch.<branch>.mergeOptions configuration, then try again.",
  operationGitMergeIncomplete:
    "Soreno couldn’t confirm the branch was integrated. The worktree was kept; check the main worktree history.",
  operationGitInProgress:
    "A Git operation (merge, rebase, cherry-pick…) is in progress. Finish or abort it, then try again.",
  operationGitUnavailable:
    "This project’s Git repository can’t be verified or has no working copy.",
  operationRegistrationFailed:
    "The Git operation succeeded, but Soreno couldn’t update its project list. Refresh the projects.",
  operationWorktreeSessionsRunning:
    "Soreno couldn’t stop this worktree’s sessions, so nothing was changed. Stop them or check the SSH connection, then try again.",
  operationCodexMissing:
    "Codex is not installed. Install it from Settings > AI to generate the commit message.",
  operationCodexFailed:
    "Codex could not generate the commit message. Staged changes are kept; try again or commit with your own message.",
  operationGitStale:
    "The repository changed. Refresh it, review the current state, then confirm again.",
  operationForgeRequestHeadMismatch:
    "The request’s ref has expired and its branch no longer points to the request’s last commit: it cannot be checked out.",
  operationGitNonFastForward:
    "The remote branch has advanced. Fetch and integrate its changes before pushing again.",
  operationGitDiverged:
    "The local branch and its upstream have diverged. Use Pull with rebase to integrate the remote changes.",
  operationGitRebaseConflict:
    "Pull with rebase hit a conflict and was cancelled: your branch is unchanged. Resolve it in a terminal with git rebase, or drop the conflicting local commits.",
  operationGitBranchNotMerged:
    "Git refused to delete this branch: some of its commits aren’t merged into the branch’s own upstream, or into the current branch if it has no upstream. Merge or push it first to keep that work.",
  operationGitUncertain:
    "The result of the previous Git operation is uncertain. Check the repository, then restart Soreno before running another Git operation.",
  operationGitBusy:
    "Another Git operation is in progress on this project. Wait for it to finish, then try again.",
  operationGitTimeout:
    "Git didn’t respond in time. Check access to the repository, then try again.",
  operationGitInaccessible:
    "The repository folder can’t be reached. Check that it still exists and is accessible.",
  operationGitMalformed: "Git returned an unexpected response.",
  // Backend details are written in French only.
  operationGitMalformedDetail: (_detail: string) => "",
  operationGitTooLarge: "Git returned too much data to display.",
  operationFileBinary: "This binary file can’t be edited.",
  operationFileEncoding: "This file or path isn’t UTF-8 encoded.",
  operationFileConflict:
    "This file changed since it was opened. Reload it before saving.",
  operationFileInvalidPath: "The path must stay inside the project folder.",
  operationFileTooLarge: "This file exceeds the 1 MiB limit.",
  operationFileSymlink:
    "Symbolic links and junctions can’t be opened from the explorer.",
  operationFileNotDirectory: "The requested path isn’t a folder.",
  operationFileNotFile: "The requested path isn’t a regular file.",
  operationFileExists: "A file or folder with this name already exists.",
  operationFileNotFound: "The requested file or folder couldn’t be found.",
  operationFilePermission: "Access to this file or folder was denied.",
  operationFileMalformed:
    "The remote server sent an invalid response to the explorer.",
  operationFileIo: "Unable to access the file.",
  operationFileGitIgnore: "Unable to apply .gitignore rules.",
  operationFileWsl: "Unable to filter project files through WSL.",
  operationFileSsh:
    "Unable to access the remote project. Check the connection and project permissions.",
  operationFileProject: "The project folder is unavailable.",
  operationFileClipboardEmpty: "The clipboard contains no files.",
  operationFilePastedDirectory: "Only files can be pasted, not folders.",
  operationFilePasteTooLarge:
    "Files pasted into an SSH project are limited to 32 MiB.",
  operationFileDownloadTooLarge:
    "Files downloaded from an SSH project are limited to 8 MiB.",
  operationGenericError: "The operation failed. Please try again.",
  operationSessionHasAutomation:
    "A session still has an automation, even a paused one. Delete it from the Automations view, then try again.",
  terminalWriteError: "Unable to send input to the terminal.",
  terminalResizeError: "Unable to resize the terminal.",
  clipboardError: "The clipboard is unavailable.",
  terminalAttachmentError: "Unable to attach the file.",
  terminalAttachmentCountError: "Drop between 1 and 16 files at a time.",
  terminalAttachmentTooLarge: "Files are limited to 32 MiB.",
  terminalDropFiles: "Drop files into the conversation",
  terminalCopy: "Copy",
  terminalPaste: "Paste",
  terminalSelectAll: "Select all",
  terminalMenu: "Terminal actions",
  missingAgentTitle: (name: string) => `${name} is not installed`,
  missingAgentLocal: "on this computer",
  missingAgentWsl: (distribution: string | null) =>
    distribution ? `in WSL (${distribution})` : "in WSL",
  missingAgentSsh: (host: string) => `on ${host}`,
  missingAgentBody: (command: string, place: string) =>
    `The ${command} command cannot be found ${place}. Install it, then retry.`,
  agentInstallGuide: "Installation guide",
  stopDescription:
    "Stop this process? Unsaved work inside the CLI may be lost. Files in the project are kept.",
  restartDescription:
    "Stop this process and launch it again? This clears the displayed terminal, not the project files. A linked conversation is resumed when supported.",
  deleteSessionDescription:
    "Delete this launcher and its displayed terminal? Project files are kept. Stop the session first if it is running. For an SSH project, a session kept on the server is stopped when the project is connected, but not while offline.",
  closeSession: "Close tab",
  moveTabLeft: "Move left",
  moveTabRight: "Move right",
  pinTab: "Pin tab",
  unpinTab: "Unpin tab",
  addSessionFavorite: "Add to favorites",
  removeSessionFavorite: "Remove from favorites",
  favoriteSessions: "Favorites",
  favoriteSessionsEmpty:
    "No favorite sessions. Add one from a tab’s context menu.",
  pinnedTab: "Pinned",
  unpinFirst: "Unpin the tab before deleting this session.",
  moveProjectUp: "Move up",
  moveProjectDown: "Move down",
  deleteProjectDescription:
    "Delete this project and its launchers from Soreno? Files are kept. All its sessions must be stopped and their automations deleted first.",
  deleteWorktreeDescription: (branch: string | null) =>
    branch
      ? `Delete this worktree folder and the local branch “${branch}”? Uncommitted changes block deletion; unmerged commits will be deleted.`
      : "Delete this detached worktree folder? Uncommitted changes block deletion.",
  mergeWorktreeDescription: (branch: string, base: string) =>
    `Merge the source branch “${branch}” into the target branch “${base}”, then delete this worktree folder and its local branch? Uncommitted changes in either worktree block the merge; resolve any conflict in Changes for the source worktree.`,
  worktreeSessionsWillStop: (count: number) =>
    count === 1
      ? "The session running in this worktree will be stopped first."
      : `The ${count} sessions running in this worktree will be stopped first.`,
  stopSessionsAndMerge: "Stop sessions and merge",
  stopSessionsAndDelete: "Stop sessions and delete",
  stopFirst:
    "Stop the running sessions before deleting this project or session.",
  stopTimeout: "The process has not stopped yet. Wait a moment, then retry.",
  sshStarting: "Starting",
  sshNotConnected: "Not connected",
  sshUnknown: "Status unavailable",
  sshActive: (count: number) =>
    count === 1 ? "1 active session" : `${count} active sessions`,
  sshSessionError: "Session error",
  sshOnDemand: "On demand",
  sshForwardPorts: "Ports",
  sshForwardCount: (count: number) => `Ports · ${count}`,
  sshForwardTitle: "SSH port forwarding",
  sshForwardDescription: (address: string) =>
    `Forward remote ports from ${address} to this computer.`,
  sshForwardInput: "Remote ports",
  sshForwardPlaceholder: "2928 8088:8095",
  sshForwardHint:
    "Separate ports with spaces. Ranges can be entered in either direction.",
  sshForwardStart: "Start forwarding",
  sshForwardStop: "Stop all",
  sshForwardEmpty: "No active port forwarding.",
  sshForwardLocalChanged:
    "The matching local port was unavailable, so Soreno selected a free port.",
  sshForwardOpen: (url: string) => `Open ${url}`,
  sshForwardLoading: "Loading SSH port forwarding…",
  sshForwardLoadError: "Unable to read SSH port forwarding.",
  sshForwardStartError:
    "Unable to start port forwarding. Check the entered ports and the SSH connection.",
  sshForwardStopError: "Unable to stop port forwarding.",
  sshForwardIgnored: (ports: string[]) =>
    ports.length === 1
      ? `Ignored port: ${ports[0]}.`
      : `Ignored ports: ${ports.join(", ")}.`,
  sshForwardOpenError: "Unable to open the local URL.",
  sshMobile: "Mobile",
  sshMobileTitle: "Mobile access",
  sshMobileIntro:
    "Follow this server’s sessions on your phone from any network, after scanning a QR code. Nothing to install on the phone.",
  sshMobilePaused:
    "Mobile access is suspended while its security is being consolidated. The service is still installed on this server but no phone can reach it. You can disable it; nothing else is possible for now.",
  sshMobileLoading: "Reading mobile access…",
  sshMobileOutdated: "Update required",
  sshMobileLegacy:
    "Mobile access no longer goes through Tailscale. After the update, pair your phones again.",
  sshMobileUnsupported: (platform: string) =>
    `Unavailable: mobile access requires a Linux x86_64 or aarch64 server (detected: ${platform}).`,
  sshMobileConnected: "Connected",
  sshMobileConnecting: "Waiting…",
  sshMobileRelayUnreachable:
    "Relay unreachable: phones cannot reach this server for now. The service keeps retrying.",
  sshMobilePair: "Pair a phone",
  sshMobileNewQr: "New QR code",
  sshMobileQrAlt: "Pairing QR code",
  sshMobilePhoneSteps: [
    "Scan the QR code with the phone’s camera.",
    "The page opens and the phone is paired.",
    "Add the page to the home screen.",
  ],
  sshMobilePairingValidity: (expiresAt: number) =>
    `Valid for 10 minutes, once · expires at ${new Intl.DateTimeFormat("en", { timeStyle: "short" }).format(expiresAt)}`,
  sshMobilePaired: "Phone paired.",
  sshMobilePairingExpired: "QR code expired.",
  sshMobileDevices: "Paired devices",
  sshMobileNoDevices: "No paired phone yet.",
  sshMobileDevicesUnknown:
    "Paired devices cannot be read right now; Soreno will try again.",
  sshMobileDeviceDates: (pairedAt: number, lastSeenAt: number | null) => {
    const date = new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `Paired ${date.format(pairedAt)} · ${lastSeenAt === null ? "never used" : `last seen ${date.format(lastSeenAt)}`}`;
  },
  sshMobileRevoke: "Revoke",
  sshMobileEnable: "Enable",
  sshMobileUpdate: "Update",
  sshMobileDisable: "Disable",
  sshMobileDisableTitle: "Disable mobile access?",
  sshMobileDisableDescription:
    "Every paired phone loses access to this server. After enabling it again, you will need to pair them again.",
  sshMobileFailed: "Mobile access operation failed.",
  sshMobileErrors: {
    unsupported: "Mobile access requires a Linux x86_64 or aarch64 server.",
    launch:
      "Unable to launch soreno-remote on this server without systemd: run the activation again.",
    exited:
      "soreno-remote stops right after launch: check `~/.cache/soreno/remote/serve.log` on the server.",
    busy: "Another soreno-remote start is in progress on the server: try again in a moment.",
    kill: "soreno-remote does not stop; its files are kept: stop the process listed in `~/.cache/soreno/remote/pid` on the server, then try again.",
    systemd:
      "User systemd is unavailable for this account: `systemctl --user` must work on the server.",
    linger:
      "Unable to keep the service running after logout: ask an administrator to run `sudo loginctl enable-linger $USER` on the server.",
    start:
      "systemd could not start soreno-remote: check `systemctl --user status soreno-remote` on the server.",
    stopped:
      "The soreno-remote service does not stay active: check `journalctl --user -u soreno-remote` on the server.",
    stop: "systemd could not stop soreno-remote; the service and its files are kept: check `systemctl --user status soreno-remote` on the server, then try again.",
    files:
      "Unable to write or remove the mobile access files on the server (`~/.config/systemd/user`, `~/.cache/soreno/remote`).",
    hash: "The transferred soreno-remote binary does not match its SHA-256 fingerprint (`sha256sum` or `shasum` is required on the server).",
    binary: "The soreno-remote binary does not run on this server.",
    pairing: "Unable to create a pairing QR code on the server.",
    revoke: "Unable to revoke this device on the server.",
    relay:
      "Mobile access is enabled, but the server does not reach the Soreno relay yet: check that it may connect out on TCP port 8790. The service keeps retrying.",
  },
  sshStatusTitle: (address: string, state: string, disconnected = false) =>
    disconnected
      ? `${address} · ${state}. Git is suspended until you reconnect.`
      : `${address} · ${state}. Session activity, not a server health check. Git uses short-lived SSH connections.`,
  collapse: "Collapse project",
  expand: "Expand project",
  conversation: agentConversationStringsEn,
};

const fr: typeof en = {
  title: "Agents",
  projects: "Projets",
  kanban: "Kanban",
  addProject: "Ajouter un projet",
  onlyProjectsWithAgents: "Uniquement les projets avec agents",
  hiddenProjects: (count: number) =>
    count === 0
      ? "Aucun projet masqué"
      : count === 1
        ? "1 projet masqué"
        : `${count} projets masqués`,
  showAllProjects: "Tout afficher",
  collapseAllProjects: "Replier tous les projets",
  expandAllProjects: "Déplier tous les projets",
  newGroup: "Créer un groupe",
  editGroup: "Modifier le groupe",
  deleteGroup: "Supprimer le groupe",
  moveGroupUp: "Déplacer le groupe vers le haut",
  moveGroupDown: "Déplacer le groupe vers le bas",
  moveToGroup: (name: string) => `Déplacer vers « ${name} »`,
  removeFromGroup: "Retirer du groupe",
  moveToGroupOtherMachine: (
    project: string,
    projectMachine: string,
    group: string,
    groupMachine: string,
  ) =>
    `Impossible de déplacer « ${project} » (${projectMachine}) vers « ${group} » (${groupMachine}) : un groupe ne peut contenir que des projets d’une même machine.`,
  groupName: "Nom du groupe",
  groupNameTooLong: "Utilisez 100 caractères maximum.",
  groupProjects: "Projets de ce groupe",
  groupProjectsSelected: (count: number) =>
    count === 1 ? "1 sélectionné" : `${count} sélectionnés`,
  groupProjectsHint: "Un projet ne peut appartenir qu’à un seul groupe.",
  groupProjectRequired: "Choisissez au moins un projet.",
  groupProjectCount: (count: number) =>
    count === 1 ? "1 projet" : `${count} projets`,
  collapseGroup: "Replier le groupe",
  expandGroup: "Déplier le groupe",
  groupOverview: "Vue d’ensemble",
  openGroupOverview: "Ouvrir la vue d’ensemble",
  groupRepositories: "Dépôts",
  refreshGroupRepositories: "Actualiser les dépôts",
  groupRepositoriesLoading: "Lecture des dépôts…",
  groupEmpty: "Ajoutez un projet au groupe",
  groupDisconnected: "Déconnecté",
  groupNotRepository: "Hors dépôt Git",
  groupChangeCounts: ({
    conflicts,
    staged,
    unstaged,
    untracked,
  }: Record<"conflicts" | "staged" | "unstaged" | "untracked", number>) =>
    [
      conflicts ? `${conflicts} en conflit` : "",
      staged ? `${staged} préparé${staged > 1 ? "s" : ""}` : "",
      unstaged ? `${unstaged} modifié${unstaged > 1 ? "s" : ""}` : "",
      untracked ? `${untracked} non suivi${untracked > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  openGroupMember: (name: string) => `Ouvrir ${name}`,
  groupActiveAgents: (count: number) =>
    `${count} agent${count > 1 ? "s" : ""} actif${count > 1 ? "s" : ""}`,
  groupProjectUnavailable: "Ce projet ne peut pas être ajouté à ce groupe",
  projectGroupLocked:
    "Retirez d’abord ce projet du groupe pour changer sa machine.",
  deleteGroupTitle: (name: string) => `Supprimer le groupe « ${name} » ?`,
  deleteGroupDescription:
    "Les sessions de la vue d’ensemble et leurs conversations seront supprimées. Les projets du groupe sont conservés.",
  deleteGroupWithProjectsDescription:
    "Les sessions de la vue d’ensemble, les projets du groupe, leurs lanceurs et leurs sessions seront retirés de Soreno. Les dossiers des projets et leurs fichiers restent sur le disque. Les worktrees hors du groupe restent dans Soreno.",
  deleteGroupProjects: (count: number) =>
    count === 1
      ? "Retirer aussi son projet de Soreno"
      : `Retirer aussi les ${count} projets de Soreno`,
  groupFolderRetained: (path: string) =>
    `Le dossier du groupe n’est pas vide et a été conservé : ${path}`,
  groupMigrationUngrouped: (names: string) =>
    `Ces projets étaient sur une autre machine et ont quitté leur groupe : ${names}`,
  openRepository: "Ajouter un projet",
  cloneRepository: "Cloner un dépôt",
  cloneUrl: "URL du dépôt",
  cloneUrlPlaceholder: "https://… ou git@hôte:depot.git",
  cloneUrlRequired: "Saisissez l’URL du dépôt.",
  cloneFolder: "Nom du nouveau dossier",
  cloneFolderInvalid: "Saisissez un seul nom de dossier, sans barre oblique.",
  pickCloneParentTitle: "Choisir un dossier",
  cloningElapsed: (seconds: number) => `Clonage… ${seconds} s`,
  clonePreserved: (path: string) =>
    `Le clonage a échoué après la création de ${path}. Le dossier a été conservé.`,
  openPreserved: "Ouvrir ce dossier",
  projectLocked:
    "Ce projet contient des sessions. Son dossier et son environnement restent fixes tant qu’elles existent.",
  nameRequired: "Saisissez un nom.",
  externalWorktree: "Worktree externe · Ouvrir",
  openWorktree: "Ouvrir le worktree",
  worktreeReadError: "Lecture des worktrees Git impossible.",
  branchUnavailable: "Branche Git indisponible",
  branchReadError: "Lecture des branches Git impossible.",
  branchLoading: "Lecture de la branche Git…",
  workspaceLoadError: "Chargement des projets agents impossible.",
  statusReadError: "Lecture de l’état des sessions impossible.",
  conversationLinkError:
    "Impossible de relier cette session à sa conversation.",
  outdatedCli:
    "Cette version du CLI ne signale pas son activité : mettez à jour Claude Code (2.1.295 ou plus) ou Codex (0.163 ou plus).",
  starting: "Démarrage du processus…",
  startingShort: "Démarrage…",
  working: "Agent en cours…",
  unread: "Agent terminé · non lu",
  awaiting: "Agent en attente · réponse requise",
  notificationAwaiting: "Attend votre réponse",
  notificationFinished: "Tour terminé",
  notificationSeveral: (count: number) => `${count} sessions vous attendent`,
  notificationFailed: (error: string) =>
    `Notification système impossible : ${error}`,
  editProject: "Modifier le projet",
  customizeProject: "Personnaliser l’icône et la couleur",
  projectImage: "Image personnalisée",
  resetProjectAppearance: "Réinitialiser",
  newSession: "Nouvelle session",
  splitTerminal: "Diviser le terminal",
  splitTerminalLeft: "Déplacer dans le volet gauche",
  splitTerminalRight: "Déplacer dans le volet droit",
  detachSplitTerminal: "Détacher le volet secondaire",
  splitPane: "Vue divisée",
  activity: "Activité des sessions",
  sessionTabs: "Sessions du projet",
  services: "Services",
  urlOpenError: "Ouverture de l’URL impossible.",
  startService: (label: string) => `Démarrer ${label}`,
  stopService: (label: string) => `Arrêter ${label}`,
  restartService: (label: string) => `Redémarrer ${label}`,
  startAllServices: "Tout démarrer",
  stopAllServices: "Tout arrêter",
  showServiceLogs: (label: string) => `Afficher les journaux de ${label}`,
  serviceReady: "Prêt",
  serviceRunning: "En cours",
  serviceStopped: "Arrêté",
  servicePending: "Opération en cours",
  serviceExitCode: (code: number) => `Code de sortie ${code}`,
  servicePort: (port: number) => `Port ${port}`,
  serviceLogs: "Journaux du service",
  serviceNoLogs: "Aucun journal pour le moment",
  serviceNoLogsDescription:
    "Démarrez ce service pour ouvrir son flux de journaux.",
  servicesDisconnected:
    "Ce projet SSH est déconnecté. Les derniers états et journaux restent disponibles.",
  resizeServices: "Redimensionner le panneau des services",
  servicesManifestError: "Chargement du manifeste de services impossible.",
  serviceStartError: (label: string) =>
    `Impossible de démarrer le service « ${label} ».`,
  serviceStopTimeout: (label: string) =>
    `Le service « ${label} » ne s’est pas arrêté à temps. Patientez puis réessayez.`,
  trustServicesTitle: "Faire confiance à ces commandes de services ?",
  trustServicesDescription:
    "Soreno exécutera ces commandes sur le serveur SSH sélectionné. Vérifiez chaque dossier de travail et argument avant de continuer.",
  trustWorkingDirectory: "Dossier de travail",
  trustArguments: "Commande et arguments",
  trustAndStart: "Faire confiance et démarrer",
  changes: "Outils du projet",
  issuePanel: (identifier: string) => `Issue ${identifier}`,
  issuePanelLink: "Lier une issue",
  designPanel: "Tableau Design",
  designPanelLink: "Lier un design",
  resizeChanges: "Redimensionner les outils du projet",
  emptyBody:
    "Ajoutez un dossier de projet, puis lancez un agent dans son terminal. Les sessions continuent quand vous naviguez ailleurs dans Soreno.",
  chooseSession: "Sélectionnez une session ou lancez un agent dans ce projet.",
  desktop: "Les terminaux agents nécessitent l’application de bureau Soreno.",
  name: "Nom",
  displayName: "Nom affiché",
  environment: "Environnement",
  local: "Local",
  ssh: "SSH",
  projectCustomization: "Personnalisation",
  importProjectIcon: "Importer une image…",
  importingProjectIcon: "Import de l’image…",
  projectIconHint:
    "PNG, JPEG, WebP ou GIF · 5 Mo max. Redimensionnement automatique.",
  projectIconError:
    "Impossible d’importer cette image. Choisissez un fichier PNG, JPEG, WebP ou GIF valide de 5 Mo maximum.",
  linearProject: "Projet Linear",
  linearProjectNone: "Aucun",
  linearProjectLinkedTo: (projectName: string) => `lié à ${projectName}`,
  linearProjectUnavailable: "Projet Linear indisponible",
  linearProjectLoading: "Chargement des projets Linear…",
  linearProjectLoadError: "Impossible de charger les projets Linear.",
  linearProjectHint:
    "Les issues Kanban de ce projet Linear appartiennent à ce projet Soreno.",
  issueAgentProjectUnavailable:
    "Ce projet ne peut pas démarrer d’agent sur une issue.",
  issueAgentProjectDisconnected:
    "Connectez ce projet SSH avant de démarrer un agent.",
  issueAgentBusy: "Une autre opération est en cours. Réessayez.",
  chooseFolder: "Choisir un dossier…",
  pickFolderTitle: "Choisir un dossier de projet",
  pickingFolder: "Sélection du dossier…",
  sshConnection: "Connexion SSH",
  sshNewConnection: "Nouvelle connexion SSH",
  sshHost: "Hôte ou alias OpenSSH",
  sshUser: "Utilisateur (facultatif)",
  sshPort: "Port (facultatif)",
  sshIdentity: "Clé privée (facultative)",
  sshChooseIdentity: "Choisir la clé…",
  sshIdentityHint: "Choisissez la clé privée, pas son fichier .pub.",
  sshPublicKeyInvalid:
    "Choisissez le fichier de clé privée. Le fichier .pub ne peut pas vous authentifier.",
  sshBrowsing: "Connexion…",
  sshRecheck: "Revérifier l’identité du serveur",
  sshScanning: "Lecture de l’identité du serveur…",
  sshCheckingTrust: "Vérification de l’identité du serveur…",
  sshHostRequired: "Saisissez un hôte SSH ou un alias OpenSSH.",
  sshPortInvalid: "Saisissez un port SSH compris entre 1 et 65535.",
  sshCurrentFolder: "Dossier distant",
  sshParentFolder: "Dossier parent",
  sshSelectFolder: "Sélectionner ce dossier",
  sshMultipleSelection: "Sélectionner plusieurs projets",
  sshSelectProject: (name: string) => `Sélectionner ${name}`,
  sshSelectProjects: (count: number) =>
    count === 1 ? "Sélectionner 1 projet" : `Sélectionner ${count} projets`,
  sshGroupProjects: "Regrouper les projets sélectionnés",
  sshTrustTitle: "Confirmer l’identité du serveur",
  sshTrustTarget: (target: string) => `Serveur : ${target}`,
  sshTrustWarning:
    "Contrôle de sécurité : comparez cette empreinte SHA256 depuis la console fiable du serveur ou auprès de son administrateur avant de continuer.",
  sshTrustAndContinue: "Faire confiance et continuer",
  sshTrustKey: "Faire confiance à cette clé",
  sshNoHostKey:
    "OpenSSH n’a renvoyé aucune clé d’hôte du serveur. Vérifiez l’hôte puis réessayez.",
  sshVerified: "Identité du serveur confirmée",
  sshKeyRequiresAgent:
    "La clé privée sélectionnée est protégée par une phrase secrète, mais aucune clé déverrouillée n’est disponible via ssh-agent. Démarrez l’agent si nécessaire, chargez votre clé avec ssh-add, puis réessayez. Soreno ne peut pas demander la phrase secrète.",
  sshAuthError:
    "L’authentification SSH a été refusée. Vérifiez l’utilisateur et la clé privée, ou déverrouillez une clé chiffrée dans ssh-agent, puis réessayez.",
  sshChangedHostError:
    "Alerte de sécurité : la clé d’hôte du serveur a changé ou a été révoquée. Ne continuez pas avant confirmation de la nouvelle empreinte par l’administrateur.",
  sshTimeoutError:
    "La connexion SSH a expiré. Vérifiez l’hôte, le port, le réseau, le VPN ou le pare-feu, puis réessayez.",
  sshRefusedError:
    "La connexion SSH a été refusée. Vérifiez que l’hôte, le port et le service SSH sont disponibles.",
  sshOpenSshMissing:
    "OpenSSH est indisponible. Installez ou activez la commande ssh sur cet ordinateur, puis réessayez.",
  refresh: "Actualiser les environnements",
  discovering: "Recherche des environnements…",
  wslHint:
    "La découverte WSL est indisponible. Les projets locaux restent utilisables.",
  absolutePath: "Saisissez un chemin absolu pour l’environnement sélectionné.",
  distribution: "Choisissez une distribution WSL.",
  back: "Retour",
  cancel: "Annuler",
  save: "Enregistrer",
  rename: "Renommer la session",
  renameHint:
    "Ce nom remplace celui que l’agent définit automatiquement. Laissez le champ vide pour revenir au nom automatique.",
  stop: "Arrêter",
  restart: "Redémarrer",
  copyAttachCommand: "Copier la commande de rattachement",
  attachCommandCopied:
    "Commande copiée : lancez-la depuis un autre terminal pour suivre cette session.",
  connect: "Connecter",
  connecting: "Connexion…",
  disconnect: "Déconnecter",
  disconnecting: "Déconnexion…",
  disconnected: "Déconnecté",
  disconnectDescription:
    "Déconnecter ce projet SSH ? Soreno suspendra la connexion SSH de ce projet et arrêtera les agents de tous les projets utilisant la même connexion SSH ; le travail non enregistré peut être perdu. Ona continuera de fonctionner. Les fichiers et les lanceurs sont conservés. Git est suspendu jusqu’à la reconnexion.",
  disconnectIncompleteTitle: "Projet déconnecté, arrêt incomplet",
  disconnectIncompleteDescription:
    "Ce projet est déjà déconnecté, mais certaines opérations d’arrêt ont échoué.",
  sshRemoteStopFailed:
    "Soreno n’a pas pu arrêter les agents sur le serveur SSH, peut-être injoignable. La déconnexion supprime quand même et déconnecte tous les projets utilisant cette connexion SSH ; les agents encore actifs sur le serveur peuvent continuer de tourner.",
  disconnectAndDelete: "Déconnecter et supprimer",
  dismiss: "Fermer",
  removeSession: "Supprimer la session",
  removeProject: "Supprimer le projet",
  removeWorktree: "Supprimer le worktree",
  mergeWorktree: (base: string) => `Fusionner dans ${base} et supprimer`,
  ready: "Prête",
  running: "Active",
  stopped: "Arrêtée",
  resumeLinked:
    "Cliquez sur cette session pour reprendre sa conversation liée.",
  resumeSelect: "Choisissez une fois la conversation dans le sélecteur CLI.",
  resumeApproval:
    "Approuvez les hooks Soreno dans l’écran de démarrage de Codex ou avec /hooks, puis relancez cette session.",
  resumeUnsupported:
    "Reprise native non intégrée pour ce CLI ; il sera lancé normalement.",
  retry: "Réessayer",
  loading: "Chargement des projets…",
  terminal: "Terminal agent",
  terminalError: "Impossible de lire la sortie du terminal.",
  operationSshHostKeyError:
    "L’identité du serveur SSH n’a pas pu être vérifiée. Vérifiez sa clé d’hôte avant de réessayer.",
  operationDnsError:
    "Le nom du serveur n’a pas pu être résolu (DNS). Vérifiez votre connexion réseau puis réessayez.",
  operationAuthError:
    "L’authentification Git a été refusée. Vérifiez les identifiants Git de cet environnement.",
  operationDirtyRepository:
    "La copie de travail doit être propre avant cette opération Git.",
  operationWorktreeDirty:
    "Ce worktree contient des changements non commités ou des fichiers non suivis. Commitez-les ou remisez-les dans ce worktree avant de le fusionner.",
  operationPrimaryWorktreeDirty:
    "Le worktree principal contient des changements non commités ou des fichiers non suivis. Commitez-les ou remisez-les dans celui-ci avant d’y fusionner.",
  operationPrimaryWorktreeProtected:
    "Le worktree principal ne peut pas être supprimé depuis Soreno.",
  operationMissingPrimaryWorktree:
    "Ce dépôt bare n’a pas de worktree principal dans lequel fusionner.",
  operationWorktreeAssociationUnknown:
    "Soreno n’a pas pu vérifier tous les projets liés à ce dépôt. Reconnectez ou retirez les projets injoignables, puis réessayez.",
  operationGitMergeConflict:
    "La fusion comporte des conflits, laissés en cours dans le worktree source. Confiez-les à un agent, ou résolvez-les dans Changements et commitez la fusion, puis réessayez.",
  resolveConflictsWithAgent: "Résoudre avec un agent",
  mergeConflictSessionName: (agent: string) => `Conflits · ${agent}`,
  operationGitSourceMergePending:
    "Une fusion est encore en cours dans le worktree source. Commitez-la dans Changements pour ce worktree, puis réessayez.",
  operationGitMergeOptions:
    "Supprimez la configuration branch.<branch>.mergeOptions, puis réessayez.",
  operationGitMergeIncomplete:
    "Soreno n’a pas pu confirmer l’intégration de la branche. Le worktree est conservé ; vérifiez l’historique du worktree principal.",
  operationGitInProgress:
    "Une opération Git (fusion, rebase, cherry-pick…) est en cours. Terminez-la ou annulez-la, puis réessayez.",
  operationGitUnavailable:
    "Le dépôt Git de ce projet ne peut pas être vérifié ou n’a pas de copie de travail.",
  operationRegistrationFailed:
    "L’opération Git a réussi, mais Soreno n’a pas pu mettre à jour sa liste de projets. Actualisez les projets.",
  operationWorktreeSessionsRunning:
    "Soreno n’a pas pu arrêter les sessions de ce worktree ; rien n’a été modifié. Arrêtez-les ou vérifiez la connexion SSH, puis réessayez.",
  operationCodexMissing:
    "Codex n’est pas installé. Installez-le depuis Paramètres > IA pour générer le message du commit.",
  operationCodexFailed:
    "Codex n’a pas pu générer le message du commit. Les changements préparés sont conservés ; réessayez ou committez avec votre propre message.",
  operationGitStale:
    "Le dépôt a changé. Actualisez-le, vérifiez son état actuel, puis confirmez à nouveau.",
  operationForgeRequestHeadMismatch:
    "La référence de la demande a expiré et sa branche ne pointe plus sur le dernier commit de la demande : impossible de l’extraire.",
  operationGitNonFastForward:
    "La branche distante a avancé. Récupérez et intégrez ses changements avant de pousser à nouveau.",
  operationGitDiverged:
    "La branche locale et sa branche amont ont divergé. Utilisez Pull avec rebase pour intégrer les changements distants.",
  operationGitRebaseConflict:
    "Le pull avec rebase a rencontré un conflit et a été annulé : votre branche est intacte. Résolvez-le dans un terminal avec git rebase, ou abandonnez les commits locaux en conflit.",
  operationGitBranchNotMerged:
    "Git a refusé de supprimer cette branche : certains de ses commits ne sont pas fusionnés dans sa propre branche amont, ou dans la branche courante si elle n’a pas d’amont. Fusionnez-la ou poussez-la d’abord pour conserver ce travail.",
  operationGitUncertain:
    "Le résultat de la précédente opération Git est incertain. Vérifiez le dépôt, puis redémarrez Soreno avant d’effectuer une autre opération Git.",
  operationGitBusy:
    "Une autre opération Git est en cours sur ce projet. Attendez qu’elle se termine, puis réessayez.",
  operationGitTimeout:
    "Git n’a pas répondu à temps. Vérifiez l’accès au dépôt, puis réessayez.",
  operationGitInaccessible:
    "Le dossier du dépôt est inaccessible. Vérifiez qu’il existe toujours et qu’il est accessible.",
  operationGitMalformed: "Git a renvoyé une réponse inattendue.",
  operationGitMalformedDetail: (detail: string) => detail,
  operationGitTooLarge: "Git a renvoyé trop de données pour être affichées.",
  operationFileBinary: "Ce fichier binaire n’est pas éditable.",
  operationFileEncoding: "Ce fichier ou ce chemin n’est pas encodé en UTF-8.",
  operationFileConflict:
    "Ce fichier a été modifié depuis son ouverture. Rechargez-le avant d’enregistrer.",
  operationFileInvalidPath:
    "Le chemin doit rester relatif au dossier du projet.",
  operationFileTooLarge: "Ce fichier dépasse la limite de 1 Mio.",
  operationFileSymlink:
    "Les liens symboliques et jonctions ne sont pas accessibles depuis l’explorateur.",
  operationFileNotDirectory: "Le chemin demandé n’est pas un dossier.",
  operationFileNotFile: "Le chemin demandé n’est pas un fichier régulier.",
  operationFileExists: "Un fichier ou un dossier porte déjà ce nom.",
  operationFileNotFound: "Le fichier ou dossier demandé est introuvable.",
  operationFilePermission: "L’accès à ce fichier ou dossier a été refusé.",
  operationFileMalformed:
    "Le serveur distant a renvoyé une réponse invalide à l’explorateur.",
  operationFileIo: "Impossible d’accéder au fichier.",
  operationFileGitIgnore: "Impossible d’appliquer les règles .gitignore.",
  operationFileWsl: "Impossible de filtrer les fichiers du projet via WSL.",
  operationFileSsh:
    "Impossible d’accéder au projet distant. Vérifiez la connexion et les droits du projet.",
  operationFileProject: "Le dossier du projet est indisponible.",
  operationFileClipboardEmpty: "Le presse-papiers ne contient aucun fichier.",
  operationFilePastedDirectory:
    "Seuls des fichiers peuvent être collés, pas des dossiers.",
  operationFilePasteTooLarge:
    "Les fichiers collés dans un projet SSH sont limités à 32 Mio.",
  operationFileDownloadTooLarge:
    "Les fichiers téléchargés depuis un projet SSH sont limités à 8 Mio.",
  operationGenericError: "L’opération a échoué. Réessayez.",
  operationSessionHasAutomation:
    "Une session a encore une automatisation, même en pause. Supprimez-la depuis la vue Automatisations, puis réessayez.",
  terminalWriteError: "Impossible d’envoyer la saisie au terminal.",
  terminalResizeError: "Impossible de redimensionner le terminal.",
  clipboardError: "Le presse-papiers est indisponible.",
  terminalAttachmentError: "Impossible de joindre le fichier.",
  terminalAttachmentCountError: "Déposez entre 1 et 16 fichiers à la fois.",
  terminalAttachmentTooLarge: "Chaque fichier est limité à 32 Mio.",
  terminalDropFiles: "Déposer dans la conversation",
  terminalCopy: "Copier",
  terminalPaste: "Coller",
  terminalSelectAll: "Sélectionner tout",
  terminalMenu: "Actions du terminal",
  missingAgentTitle: (name: string) => `${name} n’est pas installé`,
  missingAgentLocal: "sur cet ordinateur",
  missingAgentWsl: (distribution: string | null) =>
    distribution ? `dans WSL (${distribution})` : "dans WSL",
  missingAgentSsh: (host: string) => `sur ${host}`,
  missingAgentBody: (command: string, place: string) =>
    `La commande ${command} est introuvable ${place}. Installez-la, puis réessayez.`,
  agentInstallGuide: "Guide d’installation",
  stopDescription:
    "Arrêter ce processus ? Le travail non enregistré dans le CLI peut être perdu. Les fichiers du projet sont conservés.",
  restartDescription:
    "Arrêter ce processus et le relancer ? Le terminal affiché sera vidé, pas les fichiers du projet. Une conversation liée est reprise quand le CLI le permet.",
  deleteSessionDescription:
    "Supprimer ce lanceur et son terminal affiché ? Les fichiers du projet sont conservés. Arrêtez d’abord la session si elle est en cours. Pour un projet SSH, une session conservée sur le serveur est arrêtée lorsque le projet est connecté, mais pas hors connexion.",
  closeSession: "Fermer l’onglet",
  moveTabLeft: "Déplacer à gauche",
  moveTabRight: "Déplacer à droite",
  pinTab: "Épingler l’onglet",
  unpinTab: "Désépingler l’onglet",
  addSessionFavorite: "Ajouter aux favoris",
  removeSessionFavorite: "Retirer des favoris",
  favoriteSessions: "Favoris",
  favoriteSessionsEmpty:
    "Aucune session favorite. Ajoutez-en depuis le menu contextuel d’un onglet.",
  pinnedTab: "Épinglé",
  unpinFirst: "Désépinglez l’onglet avant de supprimer cette session.",
  moveProjectUp: "Déplacer vers le haut",
  moveProjectDown: "Déplacer vers le bas",
  deleteProjectDescription:
    "Supprimer ce projet et ses lanceurs de Soreno ? Les fichiers sont conservés. Toutes ses sessions doivent d’abord être arrêtées et leurs automatisations supprimées.",
  deleteWorktreeDescription: (branch: string | null) =>
    branch
      ? `Supprimer le dossier de ce worktree et la branche locale « ${branch} » ? Les changements non commités bloquent la suppression ; les commits non fusionnés seront supprimés.`
      : "Supprimer le dossier de ce worktree détaché ? Les changements non commités bloquent la suppression.",
  mergeWorktreeDescription: (branch: string, base: string) =>
    `Fusionner la branche source « ${branch} » dans la branche cible « ${base} », puis supprimer le dossier de ce worktree et sa branche locale ? Des changements non commités dans l’un des deux worktrees bloquent la fusion ; résolvez tout conflit dans Changements pour le worktree source.`,
  worktreeSessionsWillStop: (count: number) =>
    count === 1
      ? "La session active de ce worktree sera d’abord arrêtée."
      : `Les ${count} sessions actives de ce worktree seront d’abord arrêtées.`,
  stopSessionsAndMerge: "Arrêter les sessions et fusionner",
  stopSessionsAndDelete: "Arrêter les sessions et supprimer",
  stopFirst:
    "Arrêtez les sessions en cours avant de supprimer ce projet ou cette session.",
  stopTimeout:
    "Le processus n’est pas encore arrêté. Patientez puis réessayez.",
  sshStarting: "Démarrage",
  sshNotConnected: "Non connecté",
  sshUnknown: "État indisponible",
  sshActive: (count: number) =>
    count === 1 ? "1 session active" : `${count} sessions actives`,
  sshSessionError: "Session en erreur",
  sshOnDemand: "À la demande",
  sshForwardPorts: "Ports",
  sshForwardCount: (count: number) => `Ports · ${count}`,
  sshForwardTitle: "Redirections de ports SSH",
  sshForwardDescription: (address: string) =>
    `Redirigez les ports distants de ${address} vers cette machine.`,
  sshForwardInput: "Ports distants",
  sshForwardPlaceholder: "2928 8088:8095",
  sshForwardHint:
    "Séparez les ports par des espaces. Les plages fonctionnent dans les deux sens.",
  sshForwardStart: "Démarrer les redirections",
  sshForwardStop: "Tout arrêter",
  sshForwardEmpty: "Aucune redirection de port active.",
  sshForwardLocalChanged:
    "Le même port local était indisponible ; Soreno en a choisi un de libre.",
  sshForwardOpen: (url: string) => `Ouvrir ${url}`,
  sshForwardLoading: "Chargement des redirections de ports SSH…",
  sshForwardLoadError: "Impossible de lire les redirections de ports SSH.",
  sshForwardStartError:
    "Impossible de démarrer les redirections. Vérifiez les ports saisis et la connexion SSH.",
  sshForwardStopError: "Impossible d’arrêter les redirections de ports.",
  sshForwardIgnored: (ports: string[]) =>
    ports.length === 1
      ? `Port ignoré : ${ports[0]}.`
      : `Ports ignorés : ${ports.join(", ")}.`,
  sshForwardOpenError: "Impossible d’ouvrir l’URL locale.",
  sshMobile: "Mobile",
  sshMobileTitle: "Accès mobile",
  sshMobileIntro:
    "Suivez les sessions de ce serveur sur votre téléphone, depuis n’importe quel réseau, après avoir scanné un QR code. Rien à installer sur le téléphone.",
  sshMobilePaused:
    "L’accès mobile est suspendu le temps d’en consolider la sécurité. Le service reste installé sur ce serveur, mais aucun téléphone ne peut le joindre. Vous pouvez le désactiver ; rien d’autre n’est possible pour l’instant.",
  sshMobileLoading: "Lecture de l’accès mobile…",
  sshMobileOutdated: "Mise à jour nécessaire",
  sshMobileLegacy:
    "L’accès mobile ne passe plus par Tailscale. Après la mise à jour, appairez de nouveau vos téléphones.",
  sshMobileUnsupported: (platform: string) =>
    `Indisponible : l’accès mobile exige un serveur Linux x86_64 ou aarch64 (détecté : ${platform}).`,
  sshMobileConnected: "Connecté",
  sshMobileConnecting: "En attente…",
  sshMobileRelayUnreachable:
    "Relais injoignable : les téléphones ne peuvent pas joindre ce serveur pour l’instant. Le service réessaie tout seul.",
  sshMobilePair: "Appairer un téléphone",
  sshMobileNewQr: "Nouveau QR code",
  sshMobileQrAlt: "QR code d’appairage",
  sshMobilePhoneSteps: [
    "Scannez le QR code avec l’appareil photo du téléphone.",
    "La page s’ouvre et le téléphone est appairé.",
    "Ajoutez la page à l’écran d’accueil.",
  ],
  sshMobilePairingValidity: (expiresAt: number) =>
    `Valable 10 minutes, une seule fois · expire à ${new Intl.DateTimeFormat("fr", { timeStyle: "short" }).format(expiresAt)}`,
  sshMobilePaired: "Téléphone appairé.",
  sshMobilePairingExpired: "QR code expiré.",
  sshMobileDevices: "Appareils appairés",
  sshMobileNoDevices: "Aucun téléphone appairé pour l’instant.",
  sshMobileDevicesUnknown:
    "Les appareils appairés sont illisibles pour l’instant ; Soreno réessaie.",
  sshMobileDeviceDates: (pairedAt: number, lastSeenAt: number | null) => {
    const date = new Intl.DateTimeFormat("fr", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return `Appairé le ${date.format(pairedAt)} · ${lastSeenAt === null ? "jamais utilisé" : `vu le ${date.format(lastSeenAt)}`}`;
  },
  sshMobileRevoke: "Révoquer",
  sshMobileEnable: "Activer",
  sshMobileUpdate: "Mettre à jour",
  sshMobileDisable: "Désactiver",
  sshMobileDisableTitle: "Désactiver l’accès mobile ?",
  sshMobileDisableDescription:
    "Tous les téléphones appairés perdront l’accès à ce serveur. Après une nouvelle activation, il faudra les appairer de nouveau.",
  sshMobileFailed: "L’opération sur l’accès mobile a échoué.",
  sshMobileErrors: {
    unsupported: "L’accès mobile exige un serveur Linux x86_64 ou aarch64.",
    launch:
      "Impossible de lancer soreno-remote sur ce serveur sans systemd : relancez l’activation.",
    exited:
      "soreno-remote s’arrête dès son lancement : consultez `~/.cache/soreno/remote/serve.log` sur le serveur.",
    busy: "Un autre démarrage de soreno-remote est en cours sur le serveur : réessayez dans un instant.",
    kill: "soreno-remote ne s’arrête pas ; ses fichiers sont conservés : arrêtez le processus indiqué dans `~/.cache/soreno/remote/pid` sur le serveur, puis réessayez.",
    systemd:
      "systemd utilisateur est indisponible pour ce compte : `systemctl --user` doit fonctionner sur le serveur.",
    linger:
      "Impossible de maintenir le service après déconnexion : faites lancer `sudo loginctl enable-linger $USER` sur le serveur par un administrateur.",
    start:
      "systemd n’a pas pu démarrer soreno-remote : consultez `systemctl --user status soreno-remote` sur le serveur.",
    stopped:
      "Le service soreno-remote ne reste pas actif : consultez `journalctl --user -u soreno-remote` sur le serveur.",
    stop: "systemd n’a pas pu arrêter soreno-remote ; le service et ses fichiers sont conservés : consultez `systemctl --user status soreno-remote` sur le serveur, puis réessayez.",
    files:
      "Impossible d’écrire ou de supprimer les fichiers de l’accès mobile sur le serveur (`~/.config/systemd/user`, `~/.cache/soreno/remote`).",
    hash: "Le binaire soreno-remote transféré ne correspond pas à son empreinte SHA-256 (`sha256sum` ou `shasum` est requis sur le serveur).",
    binary: "Le binaire soreno-remote ne s’exécute pas sur ce serveur.",
    pairing: "Impossible de créer un QR code d’appairage sur le serveur.",
    revoke: "Impossible de révoquer cet appareil sur le serveur.",
    relay:
      "L’accès mobile est activé, mais le serveur ne joint pas encore le relais Soreno : vérifiez qu’il peut se connecter en sortie sur le port TCP 8790. Le service réessaie tout seul.",
  },
  sshStatusTitle: (address: string, state: string, disconnected = false) =>
    disconnected
      ? `${address} · ${state}. Git est suspendu jusqu’à la reconnexion.`
      : `${address} · ${state}. Activité des sessions, sans test de disponibilité du serveur. Git utilise des connexions SSH ponctuelles.`,
  collapse: "Replier le projet",
  expand: "Déplier le projet",
  conversation: agentConversationStringsFr,
};

export type AgentStrings = typeof en;

export function agentStringsForLocale(locale: string): AgentStrings {
  return locale.startsWith("fr") ? fr : en;
}

export function useAgentStrings(): AgentStrings {
  return agentStringsForLocale(useI18n().locale);
}
