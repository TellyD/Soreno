// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

const blocks = (...codes: string[]) =>
  codes.map((code) => `\`\`\`mermaid\n${code}\n\`\`\``).join("\n\n");

let root: Root;
let container: HTMLDivElement;

async function show(content: string) {
  await act(async () =>
    root.render(<MarkdownContent className="prose" content={content} />),
  );
}

// Diagram types load on demand.
async function settle() {
  await act(async () => {
    await vi.runAllTimersAsync();
    await vi.dynamicImportSettled();
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  container = document.createElement("div");
  // jsdom has no canvas: Pele measures labels with its own widths.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("draws agent diagrams as inert pictures, waits for streamed code to settle, and keeps the source of what it cannot draw", async () => {
  const flowchart =
    'flowchart LR\n  A[Front] --> B["<img src=x onerror=alert(1)>"]\n  click A "https://example.com"';
  const gantt =
    "gantt\ndateFormat YYYY-MM-DD\nsection A\nX : 2025-01-01, 50000000d";
  // Mermaid froze the app walking such a chart day by day; Pele gives up instead.
  const excluding = gantt.replace("section", "excludes 1900-01-01\nsection");
  await show(blocks(flowchart, gantt, excluding, "not a diagram"));
  await settle();

  const diagrams = container.querySelectorAll(".markdown-diagram");
  expect([...diagrams].map((d) => d.getAttribute("aria-label"))).toEqual([
    flowchart,
    gantt,
  ]);
  expect(diagrams[0].querySelector("svg")?.textContent).toContain("Front");
  // Agent text stays text, and nothing links or loads.
  expect(container.querySelector("img, a, script, image")).toBeNull();
  const sources = container.querySelectorAll(".markdown-diagram-source");
  expect([...sources].map((s) => s.textContent)).toEqual([
    excluding,
    "not a diagram",
  ]);
  expect(container.querySelector("[aria-busy=true]")).toBeNull();

  const streamed = `${flowchart}\n  B --> C[Back]`;
  await show(blocks(streamed));
  expect(container.querySelector("[aria-busy=true]")?.textContent).toBe(
    streamed,
  );
  await settle();
  expect(container.querySelector("[aria-busy]")).toBeNull();
  expect(
    container.querySelector(".markdown-diagram svg")?.textContent,
  ).toContain("Back");
});
