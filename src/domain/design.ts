import {
  ATTACHMENT_NOTE_COST,
  fitTitle,
  launchCost,
  PROMPT_COST_LIMIT,
} from "./kanbanAgent";

export type DesignBoard = {
  id: string;
  name: string;
  projectId: string | null;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type DesignFrame = {
  boardId: string;
  id: string;
  title: string;
  html: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  updatedAt: string;
};

/** What a canvas gesture changes; html and title belong to the agent. */
export type DesignFrameGeometry = Pick<
  DesignFrame,
  "boardId" | "id" | "x" | "y" | "width" | "height" | "z"
>;

export type DesignTarget =
  | { kind: "board" }
  | { kind: "frame"; frameId: string }
  | { kind: "element"; frameId: string; selector: string; outerHTML: string };

/** The agent message channel's limit, checked in bytes before sending. */
export const DESIGN_PROMPT_MAX_BYTES = 64 * 1024;
export class DesignPromptTooLargeError extends Error {}

export function designPrompt(
  text: string,
  frames: readonly DesignFrame[],
  target: DesignTarget,
): string {
  const frame =
    target.kind === "board"
      ? undefined
      : frames.find((item) => item.id === target.frameId);
  const lines = [
    "Soreno design request:",
    text.trim(),
    "",
    "Frames on the board:",
    ...(frames.length
      ? frames.map(
          (item) =>
            `- ${item.id} "${item.title}" ${Math.round(item.width)}x${Math.round(item.height)}`,
        )
      : ["(none yet)"]),
    "",
    "Change only what is asked and keep everything else identical; for an existing frame, start from its current HTML in <id>.html of the Soreno frames folder named in your instructions and edit a copy.",
  ];
  if (!frame) lines.push("Target: the whole board.");
  else if (target.kind === "element")
    lines.push(
      `Target: the element \`${target.selector}\` in frame ${frame.id} (current HTML in ${frame.id}.html of the Soreno frames folder). Its outerHTML:`,
      "```html",
      target.outerHTML,
      "```",
    );
  else
    lines.push(
      `Target: frame ${frame.id} (current HTML in ${frame.id}.html of the Soreno frames folder).`,
    );
  const body = lines.join("\n");
  if (new TextEncoder().encode(body).length > DESIGN_PROMPT_MAX_BYTES)
    throw new DesignPromptTooLargeError();
  return body;
}

/** Frames attached to an agent's launch as `design-<frameId>.html`, the user's instructions as `instructions.md`. */
export type DesignLaunchFrames = {
  boardId: string;
  frameIds: string[];
  instructions: string | null;
};

export type DesignAgentRequest = {
  board: Pick<DesignBoard, "id" | "name">;
  /** The frames to implement, in reading order. */
  frames: readonly DesignFrame[];
  /** What the user wants done with the design; may be empty. */
  instructions: string;
  projectId: string;
  executable: string;
  presetName: string;
  worktree: boolean;
  /** False keeps the Design board on screen while the session starts in the rail. */
  open: boolean;
};

const BRANCH_SLUG_LIMIT = 60;

/** Like the backend's issue branches: folded ASCII, bounded at a word boundary. */
export function designBranchName(boardName: string): string {
  const slug = boardName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = slug.lastIndexOf("-", BRANCH_SLUG_LIMIT);
  const bounded =
    slug.length > BRANCH_SLUG_LIMIT
      ? slug.slice(0, cut > 0 ? cut : BRANCH_SLUG_LIMIT)
      : slug;
  return bounded ? `design-${bounded}` : "design";
}

// Mirrors `validate_session`, in UTF-8 bytes.
const SESSION_NAME_MAX_BYTES = 256;
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** `<board> · <preset>`, the board name cut on a character so the whole fits the backend's limit. */
export function designAgentSessionName(
  boardName: string,
  presetName: string,
): string {
  const suffix = ` · ${presetName}`;
  let room = SESSION_NAME_MAX_BYTES - utf8Length(suffix);
  let name = "";
  for (const char of boardName.trim()) {
    room -= utf8Length(char);
    if (room < 0) break;
    name += char;
  }
  return `${name.trimEnd()}${suffix}`;
}

// Mirrors the backend's cap on instructions.md, in UTF-8 bytes.
const INSTRUCTIONS_MAX_BYTES = 16 * 1024;

/** Whether the backend will accept these launch instructions; checked before anything is created. */
export function designInstructionsAccepted(instructions: string): boolean {
  const text = instructions.trim();
  return !text.includes("\0") && utf8Length(text) <= INSTRUCTIONS_MAX_BYTES;
}

const DESIGN_LAUNCH_TAIL =
  "The attached design-*.html files are static HTML/CSS mockups: reproduce their layout, styles and content with this project's stack and conventions; do not copy the HTML files into the project.";
const BOARD_NAME_COST_LIMIT = 120;
const SCREEN_TITLE_COST_LIMIT = 80;
// Windows PowerShell launchers reject arguments holding `"` (legacy_powershell_args_safe).
const withoutDoubleQuotes = (text: string) => text.replace(/"/g, "'");

const INSTRUCTIONS_LINE =
  "\nUser instructions: see the attached instructions.md and follow them.";
const moreScreens = (count: number) => `\n- and ${count} more`;

/**
 * Within the Kanban launch budget; screens past it are counted, their files still all attached.
 * The user's instructions travel as `instructions.md`: the prompt only points at the file.
 */
export function designLaunchPrompt(
  boardName: string,
  frames: readonly Pick<DesignFrame, "id" | "title" | "width" | "height">[],
  withInstructions = false,
): string {
  const headWith = (name: string) =>
    `Design board “${name}” from Soreno: implement these screens in this project.${withInstructions ? INSTRUCTIONS_LINE : ""}\nScreens:`;
  const tail = `\n${DESIGN_LAUNCH_TAIL}`;
  // The backend appends "\n\nAttached files in <dir>: [instructions.md, ]<N> design-*.html files (one per screen, …)".
  const note = `${withInstructions ? "instructions.md, " : ""}${frames.length} design-*.html file${frames.length === 1 ? "" : "s"} (one per screen, named design-<frame id>.html)`;
  const fixed =
    PROMPT_COST_LIMIT -
    ATTACHMENT_NOTE_COST -
    launchCost(note) -
    launchCost(headWith("")) -
    launchCost(tail);
  // The name gives way first, so the fixed parts and at least the screen count always fit.
  const nameRoom = Math.min(
    BOARD_NAME_COST_LIMIT,
    fixed - (frames.length ? launchCost(moreScreens(frames.length)) : 0),
  );
  const fitted = fitTitle(withoutDoubleQuotes(boardName.trim()), nameRoom);
  // Below the ellipsis' own cost nothing of the name fits.
  const name = launchCost(fitted) <= nameRoom ? fitted : "";
  const head = headWith(name);
  let room = fixed - launchCost(name);
  const lines: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const title = fitTitle(
      withoutDoubleQuotes(frame.title.trim() || frame.id),
      SCREEN_TITLE_COST_LIMIT,
    );
    const line = `\n- ${title} (${Math.round(frame.width)}x${Math.round(frame.height)})`;
    const remaining = frames.length - index - 1;
    const reserve = remaining ? launchCost(moreScreens(remaining)) : 0;
    if (launchCost(line) + reserve > room) {
      lines.push(moreScreens(frames.length - index));
      break;
    }
    lines.push(line);
    room -= launchCost(line);
  }
  return `${head}${lines.join("")}${tail}`;
}
