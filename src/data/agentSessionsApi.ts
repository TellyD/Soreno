import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentEnvironment,
  AgentEnvironments,
  AgentGridConfig,
  AgentGridFrame,
  AgentGridScroll,
  AgentGridSelect,
  AgentProject,
  AgentProjectAppearance,
  AgentProjectBranch,
  AgentProjectDirectory,
  AgentProjectWorktreeSnapshot,
  AgentServiceBranch,
  AgentServiceDirectory,
  AgentSession,
  AgentSessionMessage,
  AgentSessionStatus,
  AgentWorkspace,
  SshBrowseResult,
  SshConnection,
  SshHostKey,
  SshMobilePairing,
  SshMobileStatus,
  SshPortForward,
  SshPortForwardStart,
} from "../domain/agentSessions";
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AgentAttachmentTooLargeError,
} from "../domain/agentSessions";
import type { DesignLaunchFrames } from "../domain/design";
import type {
  KanbanIssueCompletion,
  KanbanIssueSelection,
} from "../domain/kanban";

export const loadAgentWorkspace = () =>
  invoke<AgentWorkspace>("agent_workspace");
export const discoverAgentEnvironments = () =>
  invoke<AgentEnvironments>("agent_environments");
export const pickAgentProjectDirectory = (
  environment: AgentEnvironment,
  currentPath: string | null,
  title: string,
) =>
  invoke<AgentProjectDirectory | null>("agent_pick_project_directory", {
    environment,
    currentPath,
    title,
  });
export const scanAgentSshHost = (connection: SshConnection) =>
  invoke<SshHostKey[]>("agent_ssh_scan", { connection });
export const browseAgentSsh = (
  connection: SshConnection,
  path: string | null,
) => invoke<SshBrowseResult>("agent_ssh_browse", { connection, path });
export const pickAgentSshIdentity = () =>
  invoke<string | null>("agent_ssh_pick_identity");
export const saveAgentProject = (project: AgentProject) =>
  invoke<void>("agent_save_project", { project });
export const updateAgentProjectAppearance = (
  projectId: string,
  appearance: AgentProjectAppearance,
) =>
  invoke<AgentProject>("agent_update_project_appearance", {
    projectId,
    appearance,
  });
export const updateAgentProjectGroupAppearance = (
  groupId: string,
  appearance: AgentProjectAppearance,
) =>
  invoke<AgentProjectAppearance>("agent_update_project_group_appearance", {
    groupId,
    appearance,
  });
export const deleteAgentProject = (projectId: string) =>
  invoke<void>("agent_delete_project", { projectId });
export const setAgentProjectLinearLink = (
  projectId: string,
  linearProjectId: string | null,
) =>
  invoke<void>("agent_set_project_linear_link", {
    projectId,
    linearProjectId,
  });
export const linkAgentSessionKanbanIssue = (
  sessionId: string,
  issue: KanbanIssueSelection,
) =>
  issue.source === "local"
    ? invoke<void>("agent_link_session_kanban_issue", {
        sessionId,
        issueId: issue.id,
      })
    : invoke<void>("agent_link_session_linear_issue", {
        sessionId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
      });
export const unlinkAgentSessionIssue = (sessionId: string) =>
  invoke<void>("agent_unlink_session_issue", { sessionId });
export const setAgentSessionClosed = (sessionId: string, closed: boolean) =>
  invoke<void>("agent_set_session_closed", { sessionId, closed });
/** Resolves to null when the summary was already claimed by an earlier call. */
export const completeAgentKanbanIssue = (
  sessionId: string,
  summaryId: string,
  summary: string,
) =>
  invoke<KanbanIssueCompletion | null>("agent_complete_kanban_issue", {
    sessionId,
    summaryId,
    summary,
  });
type AgentProjectGroupInput = {
  id: string;
  name: string;
  projectIds: string[];
};
export const saveAgentProjectGroup = (group: AgentProjectGroupInput) =>
  invoke<void>("agent_save_project_group", { group });
export const importAgentProjectGroups = (groups: AgentProjectGroupInput[]) =>
  invoke<{ ungroupedProjectIds: string[]; groupIds: string[] }>(
    "agent_import_project_groups",
    { groups },
  );
export const prepareAgentGroupProject = (groupId: string) =>
  invoke<AgentProject>("agent_prepare_group_project", { groupId });
export const deleteAgentProjectGroup = (
  groupId: string,
  deleteProjects: boolean,
) =>
  invoke<{ retainedFolder: string | null }>("agent_delete_project_group", {
    groupId,
    deleteProjects,
  });
export const setAgentProjectConnected = (
  projectId: string,
  connected: boolean,
) => invoke<void>("agent_set_project_connected", { projectId, connected });
export const listAgentSshPortForwards = (projectId: string) =>
  invoke<SshPortForward[]>("agent_ssh_forward_list", { projectId });
export const startAgentSshPortForward = (projectId: string, ports: string) =>
  invoke<SshPortForwardStart>("agent_ssh_forward_start", { projectId, ports });
export const stopAgentSshPortForward = (projectId: string) =>
  invoke<void>("agent_ssh_forward_stop", { projectId });
export const loadAgentSshMobileStatus = (projectId: string) =>
  invoke<SshMobileStatus>("agent_ssh_mobile_status", { projectId });
export const enableAgentSshMobile = (projectId: string) =>
  invoke<SshMobileStatus>("agent_ssh_mobile_enable", { projectId });
export const pairAgentSshMobile = (projectId: string) =>
  invoke<SshMobilePairing>("agent_ssh_mobile_pair", { projectId });
export const revokeAgentSshMobile = (projectId: string, deviceId: string) =>
  invoke<SshMobileStatus>("agent_ssh_mobile_revoke", { projectId, deviceId });
export const disableAgentSshMobile = (projectId: string) =>
  invoke<SshMobileStatus>("agent_ssh_mobile_disable", { projectId });
export const saveAgentSession = (session: AgentSession) =>
  invoke<void>("agent_save_session", { session });
export const deleteAgentSession = (sessionId: string) =>
  invoke<void>("agent_delete_session", { sessionId });
export const startAgentSession = (
  sessionId: string,
  cols = 100,
  rows = 30,
  initialPrompt: string | null = null,
  issueImageNames: readonly string[] = [],
  issueFile: string | null = null,
  issueImageUrls: readonly string[] = [],
  issueImageTargets: readonly string[] = [],
  designFrames: DesignLaunchFrames | null = null,
) =>
  invoke<void>("agent_start", {
    sessionId,
    cols,
    rows,
    initialPrompt,
    issueImageNames,
    issueFile,
    issueImageUrls,
    issueImageTargets,
    designFrames,
  });
export const stopAgentSession = (sessionId: string) =>
  invoke<void>("agent_stop", { sessionId });
export const listAgentStatuses = () =>
  invoke<AgentSessionStatus[]>("agent_statuses");
export const listAgentSessionMessages = (sessionId: string) =>
  invoke<AgentSessionMessage[]>("agent_session_messages", { sessionId });
export const sendAgentSessionMessage = (
  sessionId: string,
  messageId: string,
  body: string,
) =>
  invoke<AgentSessionMessage>("agent_send_message", {
    sessionId,
    messageId,
    body,
  });
/** Fires with the session ID whenever the backend delivers or fails queued messages. */
export const listenAgentSessionMessages = (
  onChange: (sessionId: string) => void,
) =>
  listen<string>("agent-session-messages", (event) => onChange(event.payload));
export const listAgentBranches = () =>
  invoke<AgentProjectBranch[]>("agent_branches");
export const listAgentServiceBranches = (
  projectId: string,
  services: AgentServiceDirectory[],
) =>
  invoke<AgentServiceBranch[]>("agent_service_branches", {
    projectId,
    services,
  });
export const listAgentWorktrees = () =>
  invoke<AgentProjectWorktreeSnapshot>("agent_worktrees");

const agentSubscriptionQueues = new Map<string, Promise<void>>();

function enqueueAgentSubscriptionOperation<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = agentSubscriptionQueues.get(sessionId);
  let result: Promise<T>;
  try {
    result = previous ? previous.then(operation) : operation();
  } catch (reason) {
    result = Promise.reject(reason);
  }
  const tail = result.then(
    () => {},
    () => {},
  );
  agentSubscriptionQueues.set(sessionId, tail);
  void tail.then(() => {
    if (agentSubscriptionQueues.get(sessionId) === tail)
      agentSubscriptionQueues.delete(sessionId);
  });
  return result;
}

export type AgentGridSubscription = {
  unsubscribe: () => void;
  scroll: (scroll: AgentGridScroll) => Promise<void>;
  select: (select: AgentGridSelect) => Promise<void>;
  configure: (config: AgentGridConfig) => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  // Selected text, scrollback included.
  text: () => Promise<string>;
};

export function subscribeAgentGrid(
  sessionId: string,
  config: AgentGridConfig,
  // Hidden subscriptions keep the terminal state but receive no frames.
  visible: boolean,
  // Resolves with the milliseconds spent applying the frame.
  onFrame: (frame: AgentGridFrame) => Promise<number>,
  onError: (reason: unknown) => void,
): AgentGridSubscription {
  let disposed = false;
  const channel = new Channel<AgentGridFrame>();
  const channelId = channel.id;
  channel.onmessage = (frame) => {
    if (disposed) return;
    void (async () => {
      const applyMs = await onFrame(frame);
      // One frame in flight: the backend coalesces everything newer into the next one.
      if (!disposed)
        await invoke("agent_grid_ack", {
          sessionId,
          channelId,
          applyMicros: Math.max(0, Math.round(applyMs * 1000)),
        });
    })().catch((reason) => {
      if (!disposed) onError(reason);
    });
  };
  const subscribing = enqueueAgentSubscriptionOperation(sessionId, () =>
    invoke<void>("agent_grid_subscribe", {
      sessionId,
      config,
      visible,
      onFrame: channel,
    }),
  );
  void subscribing.catch((reason) => {
    if (!disposed) onError(reason);
  });
  const whenSubscribed = async <T = void>(
    command: string,
    args: Record<string, unknown>,
    disposedValue: T,
  ): Promise<T> => {
    await subscribing;
    if (disposed) return disposedValue;
    return invoke<T>(command, { sessionId, channelId, ...args });
  };
  return {
    unsubscribe: () => {
      if (disposed) return;
      disposed = true;
      channel.onmessage = () => {};
      void enqueueAgentSubscriptionOperation(sessionId, async () => {
        try {
          await subscribing;
        } catch {
          return;
        }
        await invoke("agent_grid_unsubscribe", { sessionId, channelId });
      }).catch(() => {});
    },
    scroll: (scroll) =>
      disposed
        ? Promise.resolve()
        : whenSubscribed("agent_grid_scroll", { scroll }, undefined),
    select: (select) =>
      disposed
        ? Promise.resolve()
        : whenSubscribed("agent_grid_select", { select }, undefined),
    configure: (config) =>
      disposed
        ? Promise.resolve()
        : whenSubscribed("agent_grid_configure", { config }, undefined),
    setVisible: (visible) =>
      disposed
        ? Promise.resolve()
        : whenSubscribed("agent_grid_visibility", { visible }, undefined),
    text: () =>
      disposed
        ? Promise.resolve("")
        : whenSubscribed("agent_grid_text", {}, ""),
  };
}

export function agentGridLogPath() {
  return invoke<string>("agent_grid_log_path");
}

export function sendAgentGridDiagnostic(sessionId: string, message: string) {
  return invoke<void>("agent_grid_diagnostic", { sessionId, message });
}

const AGENT_WRITE_MAX_BYTES = 64 * 1024;

export async function writeAgentTerminal(sessionId: string, data: string) {
  let chunkStart = 0;
  let chunkBytes = 0;

  for (let index = 0; index < data.length;) {
    const codePoint = data.codePointAt(index)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;

    if (chunkBytes + codePointBytes > AGENT_WRITE_MAX_BYTES) {
      await invoke<void>("agent_write", {
        sessionId,
        data: data.slice(chunkStart, index),
      });
      chunkStart = index;
      chunkBytes = 0;
    }

    chunkBytes += codePointBytes;
    index += codeUnits;
  }

  await invoke<void>("agent_write", {
    sessionId,
    data: data.slice(chunkStart),
  });
}
export const uploadAgentClipboardImage = (
  sessionId: string,
  mimeType: string,
  dataBase64: string,
) =>
  invoke<string>("agent_upload_clipboard_image", {
    sessionId,
    mimeType,
    dataBase64,
  });
export const agentAttachCommand = (sessionId: string) =>
  invoke<string>("agent_attach_command", { sessionId });
export const setAgentRemoteLabel = (sessionId: string, label: string) =>
  invoke<void>("agent_set_remote_label", { sessionId, label });
export const attachAgentFile = async (sessionId: string, file: File) => {
  if (file.size > AGENT_ATTACHMENT_MAX_BYTES)
    throw new AgentAttachmentTooLargeError();
  const filename = new TextEncoder().encode(file.name);
  return invoke<string>(
    "agent_attach_file",
    new Uint8Array(await file.arrayBuffer()),
    {
      headers: {
        "x-soreno-session-id": sessionId,
        "x-soreno-file-name": btoa(String.fromCharCode(...filename)),
      },
    },
  );
};
export const resizeAgentTerminal = (
  sessionId: string,
  cols: number,
  rows: number,
) => invoke<void>("agent_resize", { sessionId, cols, rows });
