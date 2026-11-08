import { compareDate } from "./dateTime";
import { stripInternalBlockMarkers } from "./markdown";
import type { NoteTypeId } from "./noteTypes";

export type Note = {
  archived: boolean;
  favorite: boolean;
  id: string;
  kind: NoteTypeId;
  pinned: boolean;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** Front-end only: a locked note holds no content, an unlocked one holds its plaintext. */
  encryption?: "locked" | "unlocked";
};

export const noteSortOrders = [
  "updated-desc",
  "updated-asc",
  "created-desc",
  "created-asc",
  "title-asc",
  "title-desc",
] as const;

export type NoteSortOrder = (typeof noteSortOrders)[number];

type NoteComparer = (left: Note, right: Note) => number;
type NoteComparerFactory = (locale: string) => readonly NoteComparer[];

const FALLBACK_TITLE = "Sans titre";
const MAX_TITLE_LENGTH = 80;
const titleFormattingMarkers = "*_`";
const markdownEscapableCharacters = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

const noteSortComparers: Record<NoteSortOrder, NoteComparerFactory> = {
  "updated-desc": (locale) => [
    comparePinned,
    compareNewestUpdated,
    compareNewestCreated,
    compareTitleAsc(locale),
  ],
  "updated-asc": (locale) => [
    comparePinned,
    compareOldestUpdated,
    compareOldestCreated,
    compareTitleAsc(locale),
  ],
  "created-desc": (locale) => [
    comparePinned,
    compareNewestCreated,
    compareNewestUpdated,
    compareTitleAsc(locale),
  ],
  "created-asc": (locale) => [
    comparePinned,
    compareOldestCreated,
    compareOldestUpdated,
    compareTitleAsc(locale),
  ],
  "title-asc": (locale) => [
    comparePinned,
    compareTitleAsc(locale),
    compareNewestUpdated,
    compareNewestCreated,
  ],
  "title-desc": (locale) => [
    comparePinned,
    compareTitleDesc(locale),
    compareNewestUpdated,
    compareNewestCreated,
  ],
};

export function deriveNoteTitle(
  markdown: string,
  fallbackTitle = FALLBACK_TITLE,
): string {
  const firstContentLine = stripInternalBlockMarkers(markdown)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstContentLine) {
    return fallbackTitle;
  }

  const normalized = normalizeTitleLine(firstContentLine);

  return [...(normalized || fallbackTitle)].slice(0, MAX_TITLE_LENGTH).join("");
}

export function sortNotes(
  notes: Note[],
  order: NoteSortOrder,
  locale = "fr-FR",
): Note[] {
  const comparers = noteSortComparers[order](locale);

  return [...notes].sort((left, right) => {
    return compareNotes(left, right, comparers);
  });
}

export function filterNotes(
  notes: Note[],
  query: string,
  locale = "fr-FR",
): Note[] {
  const needle = query.trim().toLocaleLowerCase(locale);

  if (!needle) {
    return notes;
  }

  return notes.filter((note) => {
    const searchableContent = stripInternalBlockMarkers(note.content);

    return (
      note.title.toLocaleLowerCase(locale).includes(needle) ||
      searchableContent.toLocaleLowerCase(locale).includes(needle)
    );
  });
}

function normalizeTitleLine(markdown: string): string {
  return stripFormattingAndUnescapeMarkdown(
    normalizeMarkdownLine(stripMarkdownHardBreakMarker(markdown)),
  ).trim();
}

function normalizeMarkdownLine(markdown: string): string {
  return markdown
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function stripMarkdownHardBreakMarker(markdown: string): string {
  return markdown.replace(/[ \t]*\\$/u, "");
}

function stripFormattingAndUnescapeMarkdown(markdown: string): string {
  let normalized = "";

  for (let index = 0; index < markdown.length; index += 1) {
    const character = markdown[index];
    const nextCharacter = markdown[index + 1];

    if (
      character === "\\" &&
      nextCharacter &&
      markdownEscapableCharacters.includes(nextCharacter)
    ) {
      normalized += nextCharacter;
      index += 1;
      continue;
    }

    if (!titleFormattingMarkers.includes(character)) {
      normalized += character;
    }
  }

  return normalized;
}

function compareNotes(
  left: Note,
  right: Note,
  comparers: readonly NoteComparer[],
): number {
  for (const compare of comparers) {
    const result = compare(left, right);

    if (result !== 0) {
      return result;
    }
  }

  return 0;
}

function comparePinned(left: Note, right: Note): number {
  return Number(right.pinned) - Number(left.pinned);
}

function compareNewestUpdated(left: Note, right: Note): number {
  return compareDate(right.updatedAt, left.updatedAt);
}

function compareOldestUpdated(left: Note, right: Note): number {
  return compareDate(left.updatedAt, right.updatedAt);
}

function compareNewestCreated(left: Note, right: Note): number {
  return compareDate(right.createdAt, left.createdAt);
}

function compareOldestCreated(left: Note, right: Note): number {
  return compareDate(left.createdAt, right.createdAt);
}

function compareTitle(left: Note, right: Note, locale: string): number {
  return left.title.localeCompare(right.title, locale, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareTitleAsc(locale: string): NoteComparer {
  return (left, right) => compareTitle(left, right, locale);
}

function compareTitleDesc(locale: string): NoteComparer {
  return (left, right) => compareTitle(right, left, locale);
}
