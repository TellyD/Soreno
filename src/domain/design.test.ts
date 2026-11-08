import { expect, it } from "vitest";
import {
  designAgentSessionName,
  designInstructionsAccepted,
  designLaunchPrompt,
  designPrompt,
  DesignPromptTooLargeError,
  type DesignFrame,
} from "./design";
import {
  DESIGN_HISTORY_LIMIT,
  emptyDesignHistory,
  recordDesignAction,
  settleDesignHistory,
  takeDesignHistory,
  type DesignHistoryEntry,
} from "./designHistory";
import {
  ATTACHMENT_NOTE_COST,
  launchCost,
  PROMPT_COST_LIMIT,
} from "./kanbanAgent";

const frame = (id: string, html = `<p>${id}</p>`): DesignFrame => ({
  boardId: "b",
  id,
  title: `Title ${id}`,
  html,
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  z: 1,
  updatedAt: "",
});
const frames = [frame("home"), frame("login")];

it("lists every frame and targets the whole board without frame HTML", () => {
  const body = designPrompt("  Ajoute un pied de page  ", frames, {
    kind: "board",
  });

  expect(body).toContain("Ajoute un pied de page");
  expect(body).toContain('- home "Title home" 1280x800');
  expect(body).toContain('- login "Title login" 1280x800');
  expect(body).toContain("the whole board");
  expect(body).toContain("keep everything else identical");
  expect(body).not.toContain("<p>home</p>");
});

it("points a frame target at its mirrored file instead of sending its HTML", () => {
  const body = designPrompt("Plus sombre", frames, {
    kind: "frame",
    frameId: "login",
  });

  expect(body).toContain("Target: frame login");
  expect(body).toContain("login.html of the Soreno frames folder");
  expect(body).toContain("keep everything else identical");
  expect(body).not.toContain("<p>login</p>");
});

it("sends an element's selector and outerHTML, its frame by file reference", () => {
  const body = designPrompt("Bouton vert", frames, {
    kind: "element",
    frameId: "home",
    selector: "main > button",
    outerHTML: "<button>Go</button>",
  });

  expect(body).toContain("`main > button` in frame home");
  expect(body).toContain("home.html of the Soreno frames folder");
  expect(body).toContain("<button>Go</button>");
  expect(body).not.toContain("<p>home</p>");
});

it("falls back to the board when the targeted frame is gone", () => {
  expect(
    designPrompt("x", frames, { kind: "frame", frameId: "deleted" }),
  ).toContain("the whole board");
});

it("refuses a message over 64 KiB counted in UTF-8 bytes instead of truncating it", () => {
  // 22,000 three-byte characters stay under 64 Ki characters but exceed 64 KiB.
  const big = "€".repeat(22_000);

  expect(() => designPrompt(big, frames, { kind: "board" })).toThrow(
    DesignPromptTooLargeError,
  );
  expect(() =>
    designPrompt("€".repeat(21_000), frames, { kind: "board" }),
  ).not.toThrow();
});

it("replays history in order, a new action clearing redo and a dropped entry leaving the rest", () => {
  const entry = (id: string): DesignHistoryEntry => ({
    kind: "delete",
    frame: frame(id),
  });
  let history = recordDesignAction(
    recordDesignAction(emptyDesignHistory, entry("a")),
    entry("b"),
  );

  const undone = takeDesignHistory(history, "undo")!;
  expect(undone.entry).toEqual(entry("b"));
  history = settleDesignHistory(undone.history, "undo", undone.entry);
  expect(history).toEqual({ undo: [entry("a")], redo: [entry("b")] });

  const redone = takeDesignHistory(history, "redo")!;
  history = settleDesignHistory(redone.history, "redo", redone.entry);
  expect(history).toEqual({ undo: [entry("a"), entry("b")], redo: [] });

  // A failed replay is never settled: the entry is gone, the others stay.
  history = takeDesignHistory(history, "undo")!.history;
  expect(history).toEqual({ undo: [entry("a")], redo: [] });

  history = settleDesignHistory(history, "undo", entry("x"));
  expect(recordDesignAction(history, entry("c")).redo).toEqual([]);
  expect(takeDesignHistory(emptyDesignHistory, "undo")).toBeNull();
});

it("keeps only the latest actions within the history limit", () => {
  let history = emptyDesignHistory;
  for (let index = 0; index <= DESIGN_HISTORY_LIMIT; index += 1)
    history = recordDesignAction(history, {
      kind: "delete",
      frame: frame(String(index)),
    });

  expect(history.undo).toHaveLength(DESIGN_HISTORY_LIMIT);
  expect(history.undo[0]).toEqual({ kind: "delete", frame: frame("1") });
});

it("lists every screen of a small board in the launch prompt", () => {
  const prompt = designLaunchPrompt("Accueil", [
    frame("home"),
    { ...frame("login"), title: "", width: 390.4, height: 844 },
  ]);

  expect(prompt.split("\n")[0]).toBe(
    "Design board “Accueil” from Soreno: implement these screens in this project.",
  );
  expect(prompt).toContain("- Title home (1280x800)");
  expect(prompt).toContain("- login (390x844)");
  expect(prompt).toContain("do not copy the HTML files into the project");
  expect(prompt).not.toContain("more");
});

it("counts the screens past the launch budget, within it even for a large board", () => {
  const frames = Array.from({ length: 300 }, (_, index) => ({
    ...frame(`screen-${index}`),
    title: `A rather descriptive screen title number ${index}`,
  }));

  const prompt = designLaunchPrompt("Big board", frames);
  const listed = prompt.split("\n").filter((line) => line.startsWith("- A"));
  const more = /- and (\d+) more/.exec(prompt);
  // The backend appends this note, its directory within ATTACHMENT_NOTE_COST.
  const note = `${frames.length} design-*.html files (one per screen, named design-<frame id>.html)`;

  expect(listed[0]).toContain("number 0");
  expect(listed.length + Number(more![1])).toBe(frames.length);
  expect(
    launchCost(prompt) + ATTACHMENT_NOTE_COST + launchCost(note),
  ).toBeLessThanOrEqual(PROMPT_COST_LIMIT);
});

it("keeps double quotes out of the launch prompt, which PowerShell launchers reject", () => {
  const prompt = designLaunchPrompt('Le "grand" écran', [
    { ...frame("home"), title: 'Page "Accueil"' },
  ]);

  expect(prompt).not.toContain('"');
  expect(prompt).toContain("Le 'grand' écran");
  expect(prompt).toContain("- Page 'Accueil' (1280x800)");
});

it("bounds the agent session name in UTF-8 bytes without cutting a character", () => {
  const name = designAgentSessionName("設計".repeat(100), "Claude Code");

  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(256);
  expect(name.endsWith(" · Claude Code")).toBe(true);
  expect(name).not.toContain("\uFFFD");
  expect(designAgentSessionName("Accueil", "Codex")).toBe("Accueil · Codex");
});

it("points the agent at the attached instructions within the budget, the screens shrinking first", () => {
  const frames = Array.from({ length: 300 }, (_, index) => ({
    ...frame(`screen-${index}`),
    title: `A rather descriptive screen title number ${index}`,
  }));

  const prompt = designLaunchPrompt("Board", frames, true);
  // The backend lists instructions.md before the screens in its note.
  const note = `instructions.md, ${frames.length} design-*.html files (one per screen, named design-<frame id>.html)`;

  expect(prompt.split("\n")[1]).toBe(
    "User instructions: see the attached instructions.md and follow them.",
  );
  expect(prompt).toMatch(/- and \d+ more/);
  expect(
    launchCost(prompt) + ATTACHMENT_NOTE_COST + launchCost(note),
  ).toBeLessThanOrEqual(PROMPT_COST_LIMIT);
  expect(designLaunchPrompt("Board", [frame("home")])).not.toContain(
    "instructions.md",
  );

  // A long CJK name gives way so that even a single screen's count fits.
  const one = [{ ...frame("home"), title: "設計".repeat(40) }];
  const cjk = designLaunchPrompt("設計".repeat(20), one, true);
  const oneNote = `instructions.md, 1 design-*.html file (one per screen, named design-<frame id>.html)`;
  expect(
    launchCost(cjk) + ATTACHMENT_NOTE_COST + launchCost(oneNote),
  ).toBeLessThanOrEqual(PROMPT_COST_LIMIT);
  expect(cjk).toContain("Design board “設計");
});

it("accepts launch instructions only within the backend's 16 KiB, without NUL", () => {
  expect(designInstructionsAccepted(`  ${"a".repeat(16 * 1024)}  `)).toBe(true);
  // 6,000 three-byte characters stay under the field's length but exceed 16 KiB.
  expect(designInstructionsAccepted("設".repeat(6000))).toBe(false);
  expect(designInstructionsAccepted("ok\0")).toBe(false);
});
