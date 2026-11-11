import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  KanbanBoard,
  KanbanComment,
  KanbanIssue,
  KanbanIssueCreateInput,
  KanbanIssueDescriptionUpdate,
  KanbanIssueDetail,
  KanbanIssueInput,
  KanbanIssueRequestEvent,
  KanbanIssueUpdate,
  KanbanLabel,
  KanbanSource,
  LinearKanbanBoard,
  LinearProjectSummary,
  LinearWorkspace,
} from "../domain/kanban";

/** Errors raised before reaching the backend, coded like its `[Kanban/<code>]` errors. */
const kanbanErrors = {
  desktopOnly:
    "[Kanban/desktopOnly] The Kanban is only available in the desktop app.",
  imageTooLarge: "[Kanban/imageTooLarge] Images are limited to 25 MB.",
} as const;

// Every issue command exists as `…_kanban_…` (local) and `…_linear_…`.
const commandSource: Record<KanbanSource, string> = {
  local: "kanban",
  linear: "linear",
};

export async function loadKanbanBoard(): Promise<KanbanBoard> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanBoard>("load_kanban_board");
}

/** A null or unknown team loads the first team by name. */
export async function loadLinearKanbanBoard(
  teamId: string | null,
): Promise<LinearKanbanBoard> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<LinearKanbanBoard>("load_linear_board", { teamId });
}

export async function loadKanbanIssue(
  source: KanbanSource,
  issueId: string,
): Promise<KanbanIssueDetail> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanIssueDetail>(`load_${commandSource[source]}_issue`, {
    issueId,
  });
}

export async function updateKanbanIssue(
  source: KanbanSource,
  issueId: string,
  input: KanbanIssueInput,
): Promise<KanbanIssueUpdate> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanIssueUpdate>(`update_${commandSource[source]}_issue`, {
    issueId,
    patch: input,
  });
}

export async function updateKanbanIssueDescription(
  source: KanbanSource,
  issueId: string,
  description: string,
): Promise<KanbanIssueDescriptionUpdate> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanIssueDescriptionUpdate>(
    `update_${commandSource[source]}_issue_description`,
    { issueId, description },
  );
}

export async function createKanbanIssue(
  source: KanbanSource,
  input: KanbanIssueCreateInput,
): Promise<KanbanIssue> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanIssue>(`create_${commandSource[source]}_issue`, {
    input,
  });
}

export async function deleteKanbanIssue(
  source: KanbanSource,
  issueId: string,
): Promise<void> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  await invoke(`delete_${commandSource[source]}_issue`, { issueId });
}

/**
 * Moves a local issue to Linear, deleting it locally; returns the created Linear issue.
 * `comments` are the local comments already copied into the description, `sourceDescription`
 * the local description it was built from: the transfer aborts if either changed meanwhile.
 */
export async function transferKanbanIssueToLinear(
  issueId: string,
  input: KanbanIssueCreateInput,
  comments: { id: string; body: string }[],
  sourceDescription: string | null,
): Promise<KanbanIssue> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanIssue>("transfer_kanban_issue_to_linear", {
    issueId,
    input,
    comments,
    sourceDescription,
  });
}

export async function createKanbanComment(
  source: KanbanSource,
  issueId: string,
  body: string,
): Promise<KanbanComment> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanComment>(`create_${commandSource[source]}_comment`, {
    issueId,
    body,
  });
}

export async function deleteKanbanComment(
  source: KanbanSource,
  issueId: string,
  commentId: string,
): Promise<void> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  await invoke(`delete_${commandSource[source]}_comment`, {
    issueId,
    commentId,
  });
}

export async function createKanbanLabel(
  source: KanbanSource,
  teamId: string,
  name: string,
): Promise<KanbanLabel> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<KanbanLabel>(`create_${commandSource[source]}_label`, {
    teamId,
    name,
  });
}

export async function listLinearWorkspaces(): Promise<LinearWorkspace[]> {
  if (!isTauri()) return [];
  return invoke<LinearWorkspace[]>("list_linear_workspaces");
}

/** Linear validates the key before it is stored; a key of a connected workspace replaces it. */
export async function setLinearApiKey(apiKey: string): Promise<void> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  await invoke("set_linear_api_key", { apiKey });
}

export async function clearLinearApiKey(workspaceId: string): Promise<void> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  await invoke("clear_linear_api_key", { workspaceId });
}

export async function listLinearProjects(): Promise<LinearProjectSummary[]> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<LinearProjectSummary[]>("list_linear_projects");
}

/** Bytes of a Linear upload, which needs the Linear key to be read. */
export async function loadLinearImage(url: string): Promise<ArrayBuffer> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  return invoke<ArrayBuffer>("load_linear_image", { url });
}

const KANBAN_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

/** Stores the image locally and returns its URL for the Markdown description. */
export async function uploadKanbanImage(file: File): Promise<string> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  if (file.size > KANBAN_IMAGE_MAX_BYTES)
    throw new Error(kanbanErrors.imageTooLarge);
  const path = await invoke<string>(
    "upload_kanban_image",
    new Uint8Array(await file.arrayBuffer()),
  );
  return convertFileSrc(path);
}

export async function openKanbanImage(name: string): Promise<void> {
  if (!isTauri()) throw new Error(kanbanErrors.desktopOnly);
  await invoke("open_kanban_image", { name });
}

/** Fires once per issue an agent session asked Soreno to create, successful or not. */
export async function listenKanbanIssueRequests(
  onRequest: (event: KanbanIssueRequestEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined;
  return listen<KanbanIssueRequestEvent>("kanban-issue-request", (event) =>
    onRequest(event.payload),
  );
}
