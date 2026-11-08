// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { AgentGridFrame, AgentGridSpan } from "../../domain/agentSessions";
import { agentGridPalette } from "./agentGridPalette";
import { AgentGridAnnouncer, AgentGridRenderer } from "./agentGridRenderer";

const palette = agentGridPalette({
  foreground: "#d7dae0",
  background: "#20242b",
  cursor: "#aabbcc",
  red: "#ff0000",
});
let host: HTMLDivElement;
let openLink: Mock<(url: string) => void>;
let renderer: AgentGridRenderer;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  openLink = vi.fn<(url: string) => void>();
  renderer = new AgentGridRenderer(host, palette, { openLink });
  renderer.setCellSize(10, 20);
});
afterEach(() => {
  renderer.dispose();
  host.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function text(t: string, extra: Partial<AgentGridSpan> = {}): AgentGridSpan {
  return { t, c: t.length, fg: 256, bg: 257, f: 0, ...extra };
}

type TestFrame = Partial<Omit<AgentGridFrame, "lines">> & {
  lines?: [number, AgentGridSpan[], boolean?][];
};

function frame({ lines = [], ...extra }: TestFrame): AgentGridFrame {
  return {
    cols: 20,
    rows: 3,
    full: true,
    shift: 0,
    cursor: { row: 0, col: 0, shape: "block" },
    displayOffset: 0,
    historySize: 0,
    selection: null,
    selectCount: 0,
    modes: 0,
    title: null,
    clipboard: null,
    state: "running",
    parsedBytes: 0,
    parseMicros: 0,
    ...extra,
    lines: lines.map(([row, spans, wrapped = false]) => [row, spans, wrapped]),
  };
}

const rows = () =>
  Array.from(host.querySelectorAll<HTMLElement>(".agent-grid-row"));
const cursor = () => host.querySelector<HTMLElement>(".agent-grid-cursor")!;

const spans = () =>
  Array.from(rows()[0].querySelectorAll<HTMLElement>(".agent-grid-span"));

it("builds every row of a full frame, blank rows included", () => {
  renderer.apply(
    frame({
      lines: [
        [0, [text("$ ls")]],
        [1, []],
        [2, [text("a"), text("b", { fg: 1 })]],
      ],
    }),
  );
  expect(rows().map((row) => row.textContent)).toEqual(["$ ls", "", "ab"]);
  renderer.apply(frame({ rows: 2, lines: [[1, [text("new")]]] }));
  expect(rows().map((row) => row.textContent)).toEqual(["", "new"]);
});

it("replaces only the rows listed by a partial frame", () => {
  renderer.apply(
    frame({
      lines: [
        [0, [text("one")]],
        [1, [text("two")]],
        [2, [text("three")]],
      ],
    }),
  );
  const [first, second, third] = rows();
  const kept = first.firstChild;
  renderer.apply(frame({ full: false, lines: [[1, [text("TWO")]]] }));
  expect(rows()).toEqual([first, second, third]);
  expect(first.firstChild).toBe(kept);
  expect(rows().map((row) => row.textContent)).toEqual(["one", "TWO", "three"]);
});

it("moves rows on a shifted frame and builds only the rows that come in", () => {
  renderer.apply(
    frame({
      lines: [
        [0, [text("one")]],
        [1, [text("two")]],
        [2, [text("three")]],
      ],
    }),
  );
  const [, second, third] = rows();
  const kept = third.firstChild;
  renderer.apply(
    frame({ full: false, shift: 1, lines: [[2, [text("four")]]] }),
  );
  expect(rows().map((row) => row.textContent)).toEqual([
    "two",
    "three",
    "four",
  ]);
  expect(rows().slice(0, 2)).toEqual([second, third]);
  expect(third.firstChild).toBe(kept);
  renderer.apply(
    frame({ full: false, shift: -2, lines: [[0, [text("zero")]]] }),
  );
  expect(rows().map((row) => row.textContent)).toEqual(["zero", "", "two"]);
  expect(rows()[2]).toBe(second);
  expect(renderer.element.children[3]).toBe(cursor());
});

it("sizes every span from its cell count, wide characters included", () => {
  renderer.apply(
    frame({ lines: [[0, [text("ab"), { ...text("字"), c: 2 }, text("é")]]] }),
  );
  const widths = () => Array.from(spans(), (span) => span.style.width);
  expect(widths()).toEqual(["20px", "20px", "10px"]);
  renderer.setCellSize(8, 16);
  expect(widths()).toEqual(["16px", "16px", "8px"]);
});

it("stretches glyph advances to the cell and lifts non-ASCII glyphs over neighbouring backgrounds", () => {
  renderer.setCellSize(7, 17, -0.69);
  renderer.apply(
    frame({
      lines: [[0, [text("  "), text("➜"), text(" Local", { bg: 4 })]]],
    }),
  );
  expect(renderer.element.style.letterSpacing).toBe("-0.69px");
  expect(
    Array.from(spans(), (span) => span.classList.contains("is-glyph")),
  ).toEqual([false, true, false]);
});

it("keeps a merged run in one box unless a character leaves the font's cell advance", () => {
  // Fresh renderer: glyph advances are measured once per character.
  renderer.dispose();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (char: string) => ({ width: char === "⏺" ? 12 : 8 }),
  } as unknown as CanvasRenderingContext2D);
  renderer = new AgentGridRenderer(host, palette, { openLink });
  renderer.setCellSize(10, 20);
  renderer.apply(frame({ lines: [[0, [text("╭──é─⏺ ok─╮")]]] }));
  expect(
    Array.from(spans(), (span) => [
      span.textContent,
      span.style.width,
      span.classList.contains("is-glyph"),
    ]),
  ).toEqual([
    ["╭──é─", "50px", false],
    ["⏺", "10px", true],
    [" ok─╮", "50px", false],
  ]);
});

it("reports painted frames up to the next animation frame and the boxes on screen", async () => {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const now = vi.spyOn(performance, "now");
  const painted = renderer.render(
    frame({ lines: [[0, [text("ab"), { ...text("字"), c: 2, g: true }]]] }),
  );
  now.mockReturnValueOnce(10).mockReturnValueOnce(12);
  callbacks.shift()!(0);
  await painted;
  expect(renderer.takePaintStats()).toMatchObject({ frames: 0, boxes: 2 });
  now.mockReturnValueOnce(45);
  callbacks.shift()!(0);
  expect(renderer.takePaintStats()).toEqual({
    frames: 1,
    paintMsAvg: 35,
    paintMsMax: 35,
    boxes: 2,
  });
  expect(renderer.takePaintStats().frames).toBe(0);
});

describe.each([
  ["honours letter spacing", true, [0], false],
  ["ignores letter spacing", false, [0.69, 0.69, 0.69], true],
] as const)(
  "calibration when the text stack %s",
  (_label, honoured, drifts, perCell) => {
    it("reports once and keeps every character in its cell", () => {
      const advance = 7.69;
      // jsdom has no layout: text is as wide as its glyph advances, boxes as their style.
      const original = Range.prototype.getBoundingClientRect;
      Range.prototype.getBoundingClientRect = function (this: Range) {
        const spacing = honoured
          ? parseFloat(renderer.element.style.letterSpacing)
          : 0;
        const length = this.startContainer.textContent?.length ?? 0;
        return { width: length * (advance + spacing) } as DOMRect;
      };
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        return { width: parseFloat(this.style.width) } as DOMRect;
      });
      try {
        renderer.setCellSize(7, 17, 7 - advance);
        renderer.apply(frame({ lines: [[0, [text("tool output tool")]]] }));
        const outcome = [
          renderer.calibrate(),
          renderer.calibrate(),
          renderer.calibrate(),
        ].find(Boolean);
        expect(outcome?.drifts).toEqual(drifts);
        expect(outcome?.perCell).toBe(perCell);
        expect(renderer.calibrate()).toBeNull();
        expect(Array.from(spans(), (span) => span.style.width)).toEqual(
          perCell ? Array(16).fill("7px") : ["112px"],
        );
      } finally {
        Range.prototype.getBoundingClientRect = original;
      }
    });
  },
);

it("swaps colors for inverse, resolving the defaults", () => {
  renderer.apply(
    frame({
      lines: [[0, [text("x", { f: 8 }), text("y", { f: 8, fg: 1, bg: 257 })]]],
    }),
  );
  const [plain, red] = spans();
  expect(plain.style.color).toBe("rgb(32, 36, 43)");
  expect(plain.style.backgroundColor).toBe("rgb(215, 218, 224)");
  expect(red.style.color).toBe("rgb(32, 36, 43)");
  expect(red.style.backgroundColor).toBe("rgb(255, 0, 0)");
});

it("places the cursor by cell and hides it on request", () => {
  renderer.apply(
    frame({
      lines: [[1, [text("hello")]]],
      cursor: { row: 1, col: 4, shape: "beam" },
    }),
  );
  expect(cursor().dataset.shape).toBe("beam");
  expect(cursor().style.transform).toBe("translate(40px, 20px)");
  renderer.setFocused(true);
  renderer.apply(
    frame({ full: false, cursor: { row: 1, col: 1, shape: "block" } }),
  );
  expect(cursor().textContent).toBe("e");
  renderer.apply(
    frame({ full: false, cursor: { row: 1, col: 1, shape: "hidden" } }),
  );
  expect(cursor().dataset.shape).toBe("hidden");
});

it("restarts the cursor blink only when the cursor moves", () => {
  renderer.setFocused(true);
  renderer.apply(frame({ cursor: { row: 0, col: 2, shape: "block" } }));
  const restarted = () => cursor().classList.contains("is-blink-restarted");
  const before = restarted();
  renderer.apply(
    frame({ full: false, cursor: { row: 0, col: 2, shape: "block" } }),
  );
  expect(restarted()).toBe(before);
  renderer.apply(
    frame({ full: false, cursor: { row: 0, col: 3, shape: "block" } }),
  );
  expect(restarted()).toBe(!before);
});

it("opens OSC 8 links only for http and https", () => {
  renderer.apply(
    frame({
      lines: [
        [
          0,
          [
            text("site", { l: "https://example.com/a b" }),
            text("file", { l: "file:///etc/passwd" }),
            text("js", { l: "javascript:alert(1)" }),
          ],
        ],
      ],
    }),
  );
  for (const span of Array.from(rows()[0].children))
    span.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.com/a%20b");
});

describe("plain URLs", () => {
  // jsdom lays nothing out: the screen sits at 0,0 with 10x20 cells.
  const at = (row: number, col: number) => ({
    clientX: col * 10 + 5,
    clientY: row * 20 + 5,
    bubbles: true,
  });
  const hover = (row: number, col: number) =>
    renderer.element.dispatchEvent(new MouseEvent("mousemove", at(row, col)));
  const click = (row: number, col: number, target: Element = rows()[row]) =>
    target.dispatchEvent(new MouseEvent("click", at(row, col)));
  const underlines = () =>
    Array.from(
      host.querySelectorAll<HTMLElement>(".agent-grid-link-underline"),
      ({ style }) => [style.left, style.top, style.width, style.height],
    );

  it("underlines the hovered URL with an overlay and opens it on click", () => {
    renderer.apply(
      frame({
        cols: 40,
        lines: [[1, [text("see "), text("https://a.io/x ok")]]],
      }),
    );
    const row = rows()[1];
    const kept = row.firstChild;
    hover(1, 6);
    expect(underlines()).toEqual([["40px", "20px", "140px", "20px"]]);
    expect(renderer.element.classList.contains("is-link-hover")).toBe(true);
    expect(row.firstChild).toBe(kept);
    click(1, 17);
    expect(openLink).toHaveBeenCalledExactlyOnceWith("https://a.io/x");
    hover(1, 2);
    expect(underlines()).toEqual([]);
    expect(renderer.element.classList.contains("is-link-hover")).toBe(false);
  });

  it("joins a URL across its wrapped continuation rows", () => {
    renderer.apply(
      frame({
        lines: [
          [0, [text("go https://example.c")], true],
          [1, [text("om/path next")]],
        ],
      }),
    );
    hover(1, 2);
    expect(underlines()).toEqual([
      ["30px", "0px", "170px", "20px"],
      ["0px", "20px", "70px", "20px"],
    ]);
    click(0, 4);
    expect(openLink).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/path",
    );
    renderer.apply(
      frame({
        full: false,
        lines: [[0, [text("go https://example.c")], false]],
      }),
    );
    expect(underlines()).toEqual([]);
    click(1, 2);
    expect(openLink).toHaveBeenCalledOnce();
  });

  it("drops trailing punctuation and unbalanced closers", () => {
    renderer.apply(
      frame({
        cols: 60,
        lines: [[0, [text("(see https://a.io/x_(y)), and https://b.io/z.")]]],
      }),
    );
    for (const col of [6, 23, 24, 31, 44]) click(0, col);
    expect(openLink.mock.calls).toEqual([
      ["https://a.io/x_(y)"],
      ["https://b.io/z"],
    ]);
  });

  it("detects only http and https, and leaves OSC 8 links in charge", () => {
    renderer.apply(
      frame({
        cols: 60,
        lines: [
          [
            0,
            [
              text("ftp://x.io https:// "),
              text("https://plain.io", { l: "https://osc.io/" }),
            ],
          ],
        ],
      }),
    );
    hover(0, 25);
    expect(underlines()).toEqual([]);
    for (const col of [2, 14]) click(0, col);
    click(0, 25, host.querySelector("[data-link]")!);
    expect(openLink).toHaveBeenCalledExactlyOnceWith("https://osc.io/");
  });

  it("ignores clicks ending a drag or extending a selection", () => {
    renderer.apply(frame({ lines: [[0, [text("https://a.io/x")]]] }));
    renderer.element.dispatchEvent(new MouseEvent("mousedown", at(0, 2)));
    click(0, 8);
    expect(openLink).not.toHaveBeenCalled();
    click(0, 8);
    expect(openLink).toHaveBeenCalledOnce();
    rows()[0].dispatchEvent(
      new MouseEvent("click", { ...at(0, 8), shiftKey: true }),
    );
    expect(openLink).toHaveBeenCalledTimes(2);
    renderer.apply(
      frame({
        full: false,
        selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 3 },
      }),
    );
    rows()[0].dispatchEvent(
      new MouseEvent("click", { ...at(0, 8), shiftKey: true }),
    );
    expect(openLink).toHaveBeenCalledTimes(2);
  });
});

it("applies scheduled frames on the next animation frame, resolving each with the whole batch's apply time", async () => {
  let paint!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    paint = callback;
    return 1;
  });
  let applied = false;
  const first = renderer.render(frame({ lines: [[0, [text("sooner")]]] }));
  const rendering = renderer
    .render(frame({ full: false, lines: [[0, [text("later")]]] }))
    .then((ms) => {
      applied = true;
      return ms;
    });
  await Promise.resolve();
  expect(applied).toBe(false);
  expect(rows()).toHaveLength(0);
  vi.spyOn(performance, "now").mockReturnValueOnce(5).mockReturnValueOnce(12);
  paint(0);
  expect(await first).toBe(7);
  expect(await rendering).toBe(7);
  expect(rows()[0].textContent).toBe("later");
});

it("keeps wide emoji in one two-cell box when painting per cell", () => {
  // Text as wide as 7.69px advances in 7px cells: calibration falls back to per-cell boxes.
  const original = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = function (this: Range) {
    return {
      width: (this.startContainer.textContent?.length ?? 0) * 7.69,
    } as DOMRect;
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return { width: parseFloat(this.style.width) } as DOMRect;
    },
  );
  try {
    renderer.setCellSize(7, 17);
    renderer.apply(frame({ lines: [[0, [text("tool output tool")]]] }));
    const outcome = [
      renderer.calibrate(),
      renderer.calibrate(),
      renderer.calibrate(),
    ].find(Boolean);
    expect(outcome?.perCell).toBe(true);
  } finally {
    Range.prototype.getBoundingClientRect = original;
  }
  renderer.setFocused(true);
  renderer.apply(
    frame({
      lines: [[0, [text("ab"), { ...text("😀"), c: 2, g: true }, text("x")]]],
      cursor: { row: 0, col: 2, shape: "block" },
    }),
  );
  expect(
    Array.from(spans(), (span) => [span.textContent, span.style.width]),
  ).toEqual([
    ["a", "7px"],
    ["b", "7px"],
    ["😀", "14px"],
    ["x", "7px"],
  ]);
  expect(cursor().textContent).toBe("😀");
});

it("keeps a wide character and its combining mark in one two-cell glyph", () => {
  renderer.setFocused(true);
  renderer.apply(
    frame({
      lines: [
        [0, [text("ab"), { ...text("漢\u0301"), c: 2, g: true }, text("cd")]],
      ],
      cursor: { row: 0, col: 3, shape: "block" },
    }),
  );
  expect(
    Array.from(spans(), (span) => [span.textContent, span.style.width]),
  ).toEqual([
    ["ab", "20px"],
    ["漢\u0301", "20px"],
    ["cd", "20px"],
  ]);
  expect(cursor().textContent).toBe("漢\u0301");
});

it("highlights only the visible part of a selection that starts in the scrollback", () => {
  const boxes = () =>
    Array.from(
      host.querySelectorAll<HTMLElement>(".agent-grid-selection"),
      ({ style }) => [style.left, style.top, style.width, style.height],
    );
  renderer.apply(
    frame({
      lines: [[0, [text("one")]]],
      selection: { startRow: -4, startCol: 6, endRow: 1, endCol: 2 },
    }),
  );
  expect(boxes()).toEqual([
    ["0px", "0px", "200px", "20px"],
    ["0px", "20px", "30px", "20px"],
  ]);
  renderer.apply(frame({ full: false, selection: null }));
  expect(boxes()).toEqual([]);
});

describe("AgentGridAnnouncer", () => {
  let region: HTMLDivElement;
  let focused: boolean;
  let announcer: AgentGridAnnouncer;
  beforeEach(() => {
    vi.useFakeTimers();
    region = document.createElement("div");
    focused = true;
    announcer = new AgentGridAnnouncer(region, () => focused);
    // The first frame of a subscription paints the screen.
    announcer.frame(frame({ lines: [[0, [text("initial")]]] }), false);
  });
  afterEach(() => {
    announcer.dispose();
    vi.useRealTimers();
  });

  it("announces the latest text of changed rows once output settles", () => {
    announcer.frame(
      frame({
        full: false,
        lines: [
          [2, [text("third"), text("  ")]],
          [0, [text("fir"), text("st", { fg: 1 })]],
        ],
      }),
      false,
    );
    announcer.frame(
      frame({
        full: false,
        lines: [
          [2, [text("THIRD")]],
          [1, []],
        ],
      }),
      false,
    );
    vi.advanceTimersByTime(149);
    expect(region.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe("first\nTHIRD");
  });

  it("announces lines that scrolled up before output settled, in order", () => {
    announcer.frame(frame({ full: false, lines: [[2, [text("one")]]] }), false);
    announcer.frame(
      frame({
        full: false,
        shift: 2,
        lines: [
          [1, [text("two")]],
          [2, [text("three")]],
        ],
      }),
      false,
    );
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("one\ntwo\nthree");
  });

  it("keeps the last 20 lines of a large change", () => {
    announcer.frame(
      frame({
        full: false,
        lines: Array.from({ length: 30 }, (_, row) => [
          row,
          [text(`line ${row}`)],
        ]),
      }),
      false,
    );
    vi.advanceTimersByTime(150);
    const lines = region.textContent!.split("\n");
    expect(lines).toHaveLength(20);
    expect([lines[0], lines[19]]).toEqual(["line 10", "line 29"]);
  });

  it("stays silent unfocused, for repaints, and after a key clears it", () => {
    focused = false;
    announcer.frame(
      frame({ full: false, lines: [[0, [text("hidden")]]] }),
      false,
    );
    focused = true;
    announcer.frame(frame({ lines: [[0, [text("resized")]]] }), true);
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("");
    announcer.frame(
      frame({ full: false, lines: [[0, [text("output")]]] }),
      false,
    );
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("output");
    announcer.frame(
      frame({ full: false, lines: [[0, [text("echo")]]] }),
      false,
    );
    announcer.clear();
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("");
  });

  it("waits for output to pause, but announces continuous output every second", () => {
    for (let at = 0; at <= 400; at += 50) {
      announcer.frame(
        frame({ full: false, lines: [[0, [text(`tick ${at}`)]]] }),
        false,
      );
      vi.advanceTimersByTime(at < 400 ? 50 : 0);
      expect(region.textContent).toBe("");
    }
    vi.advanceTimersByTime(149);
    expect(region.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe("tick 400");

    region.textContent = "";
    for (let at = 0; at < 1000; at += 50) {
      announcer.frame(
        frame({ full: false, lines: [[0, [text(`stream ${at}`)]]] }),
        false,
      );
      vi.advanceTimersByTime(50);
    }
    expect(region.textContent).toBe("stream 950");
  });

  it("does not announce rows revealed by scrolling, even after typing", () => {
    announcer.frame(
      frame({ displayOffset: 12, lines: [[0, [text("history")]]] }),
      false,
    );
    announcer.frame(
      frame({ full: false, displayOffset: 0, lines: [[0, [text("live")]]] }),
      false,
    );
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("");
    announcer.frame(
      frame({ full: false, lines: [[0, [text("echo")]]] }),
      false,
    );
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("echo");
  });

  it("treats the first frame of a new subscription as a repaint", () => {
    announcer.reset();
    announcer.frame(
      frame({ full: false, lines: [[0, [text("reconnected")]]] }),
      false,
    );
    vi.advanceTimersByTime(150);
    expect(region.textContent).toBe("");
  });
});
