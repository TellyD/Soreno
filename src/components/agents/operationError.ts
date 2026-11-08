import { gitErrorCode } from "../../domain/projectGit";
import type { AgentStrings } from "./agentStrings";

export type OperationErrorInput = {
  /** Raw backend text: only used to pick a localized message, never displayed. */
  message: string;
  fileCode?: string | null;
  /** Localized description of the failed operation, completed by the known cause. */
  context?: string;
  warning?: string;
};

const gitCodeMessages = {
  dirty: "operationDirtyRepository",
  worktreeDirty: "operationWorktreeDirty",
  primaryDirty: "operationPrimaryWorktreeDirty",
  primaryWorktree: "operationPrimaryWorktreeProtected",
  missingPrimaryWorktree: "operationMissingPrimaryWorktree",
  worktreeAssociationUnknown: "operationWorktreeAssociationUnknown",
  mergeConflict: "operationGitMergeConflict",
  sourceMergePending: "operationGitSourceMergePending",
  mergeOptions: "operationGitMergeOptions",
  mergeIncomplete: "operationGitMergeIncomplete",
  operation: "operationGitInProgress",
  unavailable: "operationGitUnavailable",
  registrationFailed: "operationRegistrationFailed",
  worktreeSessionsRunning: "operationWorktreeSessionsRunning",
  sessionHasAutomation: "operationSessionHasAutomation",
  invalidProject: "operationFileProject",
  stale: "operationGitStale",
  requestHeadMismatch: "operationForgeRequestHeadMismatch",
  codexMissing: "operationCodexMissing",
  codex: "operationCodexFailed",
  nonFastForward: "operationGitNonFastForward",
  diverged: "operationGitDiverged",
  notMerged: "operationGitBranchNotMerged",
  uncertain: "operationGitUncertain",
  busy: "operationGitBusy",
  timeout: "operationGitTimeout",
  inaccessible: "operationGitInaccessible",
  missingDirectory: "operationGitInaccessible",
  project: "operationFileProject",
  missing: "sshOpenSshMissing",
  malformed: "operationGitMalformed",
  outputTooLarge: "operationGitTooLarge",
} as const satisfies Record<string, keyof AgentStrings>;

const fileCodeMessages = {
  binary: "operationFileBinary",
  encoding: "operationFileEncoding",
  conflict: "operationFileConflict",
  invalidPath: "operationFileInvalidPath",
  tooLarge: "operationFileTooLarge",
  symlink: "operationFileSymlink",
  notDirectory: "operationFileNotDirectory",
  notFile: "operationFileNotFile",
  exists: "operationFileExists",
  notFound: "operationFileNotFound",
  permission: "operationFilePermission",
  malformed: "operationFileMalformed",
  clipboardEmpty: "operationFileClipboardEmpty",
  pastedDirectory: "operationFilePastedDirectory",
  pasteTooLarge: "operationFilePasteTooLarge",
  downloadTooLarge: "operationFileDownloadTooLarge",
  clipboard: "clipboardError",
} as const satisfies Record<string, keyof AgentStrings>;

// Transport codes whose raw output may still reveal a more precise SSH/DNS cause.
const fileTransportCodeMessages = {
  io: "operationFileIo",
  gitIgnore: "operationFileGitIgnore",
  wsl: "operationFileWsl",
  ssh: "operationFileSsh",
  project: "operationFileProject",
} as const satisfies Record<string, keyof AgentStrings>;

function codeMessage<T extends Record<string, keyof AgentStrings>>(
  messages: T,
  code: string | null | undefined,
): T[keyof T] | null {
  return code && Object.prototype.hasOwnProperty.call(messages, code)
    ? messages[code as keyof T]
    : null;
}

export const isSshRemoteStopFailure = (message: string) =>
  message.includes("[SSH/remoteStopFailed]");

/** Carries text already translated for the user, displayed as is. */
export class LocalizedOperationError extends Error {}

export function formatOperationError(
  s: AgentStrings,
  { message, fileCode, context, warning }: OperationErrorInput,
): string {
  const localizedKey =
    codeMessage(fileCodeMessages, fileCode) ??
    codeMessage(gitCodeMessages, gitErrorCode(message));
  const transportKey = codeMessage(fileTransportCodeMessages, fileCode);
  const cause = localizedKey
    ? s[localizedKey]
    : isSshRemoteStopFailure(message)
      ? s.sshRemoteStopFailed
      : message.includes("[SSH/keyRequiresAgent]")
        ? s.sshKeyRequiresAgent
        : message.includes("[Session/hasAutomation]")
          ? s.operationSessionHasAutomation
          : /host key verification failed|host identification has changed|no .* host key is known/i.test(
                message,
              )
            ? s.operationSshHostKeyError
            : /no such host|could not resolve (?:host|hostname)|temporary failure in name resolution|name or service not known/i.test(
                  message,
                )
              ? s.operationDnsError
              : /HTTP Basic: Access denied|Authentication failed/i.test(message)
                ? s.operationAuthError
                : transportKey
                  ? s[transportKey]
                  : null;
  const summary = context
    ? cause
      ? `${context} ${cause}`
      : context
    : (cause ?? s.operationGenericError);
  const detail =
    gitErrorCode(message) === "malformed"
      ? s.operationGitMalformedDetail(
          message.slice("[Git/malformed] ".length).trim(),
        )
      : "";
  const described = detail ? `${summary} ${detail}` : summary;

  return warning ? `${described} ${warning}` : described;
}
