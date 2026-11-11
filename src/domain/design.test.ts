import { expect, it } from "vitest";
import {
  designAgentSessionName,
  designInstructionsAccepted,
  designDraftText,
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

it("puts each image's path at its marker, unmarked images after the text", () => {
  expect(
    designDraftText("Comme [Image #2] mais [Image #9] ", [
      "'/a.png'",
      "'/b.png'",
    ]),
  ).toBe("Comme '/b.png' mais [Image #9] '/a.png'");
  expect(designDraftText("", ["'/a.png'"])).toBe("'/a.png'");
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

it("points the launch prompt at the attached index, within the budget even for a long name", () => {
  const prompt = designLaunchPrompt("設計".repeat(50), true);
  // The backend appends this note, its directory within ATTACHMENT_NOTE_COST.
  const note = "instructions.md, design-board.md, 300 design-*.html files";

  expect(prompt.split("\n")[1]).toBe(
    "User instructions: see the attached instructions.md and follow them.",
  );
  expect(prompt).toContain("design-board.md");
  expect(
    launchCost(prompt) + ATTACHMENT_NOTE_COST + launchCost(note),
  ).toBeLessThanOrEqual(PROMPT_COST_LIMIT);
  expect(designLaunchPrompt("Board")).not.toContain("instructions.md");
});

it("keeps double quotes out of the launch prompt, which PowerShell launchers reject", () => {
  const prompt = designLaunchPrompt('Le "grand" écran');

  expect(prompt).not.toContain('"');
  expect(prompt).toContain("Le 'grand' écran");
});

it("bounds the agent session name in UTF-8 bytes without cutting a character", () => {
  const name = designAgentSessionName("設計".repeat(100), "Claude Code");

  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(256);
  expect(name.endsWith(" · Claude Code")).toBe(true);
  expect(name).not.toContain("\uFFFD");
  expect(designAgentSessionName("Accueil", "Codex")).toBe("Accueil · Codex");
});

it("accepts launch instructions only within the backend's 16 KiB, without NUL", () => {
  expect(designInstructionsAccepted(`  ${"a".repeat(16 * 1024)}  `)).toBe(true);
  // 6,000 three-byte characters stay under the field's length but exceed 16 KiB.
  expect(designInstructionsAccepted("設".repeat(6000))).toBe(false);
  expect(designInstructionsAccepted("ok\0")).toBe(false);
});
