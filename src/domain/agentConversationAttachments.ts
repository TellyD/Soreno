/** Files and images attached to a conversation message, and how they travel in OMP's prompt. */
import type { AgentConversationImage } from "./agentConversation";

/** Text files are inlined in the prompt: OMP may run on another machine than the file. */
export type AgentConversationFile = { name: string; content: string };

export type AgentConversationAttachment =
  | { kind: "image"; name: string; size: number; image: AgentConversationImage }
  | { kind: "file"; name: string; size: number; file: AgentConversationFile };

export const AGENT_CONVERSATION_ATTACHMENT_LIMIT = 16;
const AGENT_CONVERSATION_TEXT_FILE_BYTES = 256 * 1024;
/** Images travel in base64: 20 MiB stay under Soreno's 32 MiB per record. */
const AGENT_CONVERSATION_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
export const AGENT_CONVERSATION_IMAGE_TYPES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

export type AgentConversationAttachmentRefusal =
  | { reason: "count" }
  | { reason: "size"; name: string }
  | { reason: "images"; name: string };

const FILE_OPEN = '<attached-file name="';
const FILE_CLOSE = "</attached-file>";
/** The line count delimits the content, which may itself contain `</attached-file>`. */
const FILE_HEADER = /<attached-file name="([^"\n]*)" lines="(0|[1-9]\d*)">\n/y;

/** The UTF-8 text of a file, or null for a binary one. */
export function agentConversationFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The prompt text OMP receives: the message, then each file in its own block. */
export function agentConversationPrompt(
  message: string,
  files: AgentConversationFile[],
) {
  const blocks = files.map(({ name, content }) => {
    const lines = content ? content.split("\n").length : 0;
    const body = content ? `${content}\n` : "";
    return `${FILE_OPEN}${name.replace(/["\r\n]/g, "")}" lines="${lines}">\n${body}${FILE_CLOSE}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/** The file block at `start` and the index after it, or null if none is there. */
function readFileBlock(
  prompt: string,
  start: number,
): { file: AgentConversationFile; end: number } | null {
  FILE_HEADER.lastIndex = start;
  const header = FILE_HEADER.exec(prompt);
  if (!header) return null;
  const contentStart = FILE_HEADER.lastIndex;
  let end = contentStart;
  for (let line = Number(header[2]); line > 0; line--) {
    const newline = prompt.indexOf("\n", end);
    if (newline < 0) return null;
    end = newline + 1;
  }
  if (!prompt.startsWith(FILE_CLOSE, end)) return null;
  // The content's last line ends with the newline before the closing tag.
  const content = end > contentStart ? prompt.slice(contentStart, end - 1) : "";
  end += FILE_CLOSE.length;
  if (end < prompt.length) {
    if (!prompt.startsWith("\n\n", end)) return null;
    end += 2;
  }
  return { file: { name: header[1], content }, end };
}

/**
 * Reverses `agentConversationPrompt`; a prompt Soreno did not build stays plain text. Text
 * after the blocks joins the message.
 */
export function splitAgentConversationPrompt(prompt: string): {
  text: string;
  files: AgentConversationFile[];
} {
  const separator = prompt.indexOf(`\n\n${FILE_OPEN}`);
  const start = prompt.startsWith(FILE_OPEN)
    ? 0
    : separator < 0
      ? -1
      : separator + 2;
  if (start < 0) return { text: prompt, files: [] };
  const message = prompt.slice(0, start).trimEnd();
  const files: AgentConversationFile[] = [];
  let end = start;
  while (end < prompt.length) {
    const block = readFileBlock(prompt, end);
    if (!block) {
      if (!files.length) return { text: prompt, files: [] };
      const rest = prompt.slice(end);
      return { text: message ? `${message}\n\n${rest}` : rest, files };
    }
    files.push(block.file);
    end = block.end;
  }
  return { text: message, files };
}

/**
 * Whether `next` (name, size, kind) may join `current` inline; images need a model that reads
 * them. Text files are checked for size here and for content when read.
 */
export function agentConversationAttachmentRefusal(
  current: readonly AgentConversationAttachment[],
  next: { name: string; size: number; image: boolean },
  modelReadsImages: boolean,
): AgentConversationAttachmentRefusal | null {
  if (current.length >= AGENT_CONVERSATION_ATTACHMENT_LIMIT)
    return { reason: "count" };
  if (next.image && !modelReadsImages)
    return { reason: "images", name: next.name };
  const total = current.reduce((sum, { size }) => sum + size, next.size);
  if (
    total > AGENT_CONVERSATION_ATTACHMENTS_BYTES ||
    (!next.image && next.size > AGENT_CONVERSATION_TEXT_FILE_BYTES)
  )
    return { reason: "size", name: next.name };
  return null;
}

/** Splits a draft so that odd indices are image markers. */
export const AGENT_CONVERSATION_IMAGE_MARKERS = /(\[Image #\d+\])/;

export const agentConversationImageCount = (
  attachments: readonly AgentConversationAttachment[],
) => attachments.filter(({ kind }) => kind === "image").length;

/** OMP's marker for a message's nth image: the text says where each image belongs. */
export const agentConversationImageMarker = (n: number) => `[Image #${n}]`;

/** Renumbers image markers; a null number removes the marker and the space before it. */
export function renumberAgentConversationImageMarkers(
  text: string,
  renumber: (n: number) => number | null,
) {
  return text.replace(
    /( ?)\[Image #(\d+)\]/g,
    (_, space: string, n: string) => {
      const next = renumber(Number(n));
      return next === null
        ? ""
        : `${space}${agentConversationImageMarker(next)}`;
    },
  );
}

/** `text` with `token` at `caret`, spaced from the words around it, and the caret after it. */
export function insertAgentConversationToken(
  text: string,
  caret: number,
  token: string,
) {
  const before = text.slice(0, caret);
  const after = text.slice(caret);
  const space = !after || /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  const head = `${before}${/\S$/.test(before) ? " " : ""}${token}${space}`;
  return { text: head + after, caret: head.length };
}
