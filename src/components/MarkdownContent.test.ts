// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import * as markdown from "../domain/markdownContent";

it("does not reparse unchanged messages during unrelated renders", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const parse = vi.spyOn(markdown, "parseMarkdownContent");
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(
        createElement(MarkdownContent, { className: "", content: "**hello**" }),
      ),
    );
    await act(async () =>
      root.render(
        createElement(MarkdownContent, { className: "", content: "**hello**" }),
      ),
    );
    expect(parse).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(
        createElement(MarkdownContent, {
          className: "",
          content: "**hello** world",
        }),
      ),
    );
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    parse.mockRestore();
  }
});

it("makes tables a Tab stop only when they can scroll", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const content = "| a | b |\n| - | - |\n| 1 | 2 |";
  const table = () => container.querySelector(".markdown-table");
  try {
    await act(async () =>
      root.render(createElement(MarkdownContent, { className: "", content })),
    );
    expect(table()?.getAttribute("tabindex")).toBe("0");
    await act(async () =>
      root.render(
        createElement(MarkdownContent, {
          className: "",
          content,
          scrollableTables: false,
        }),
      ),
    );
    expect(table()).not.toBeNull();
    expect(table()?.hasAttribute("tabindex")).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("highlights known fenced languages without altering the code text", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const source = 'const name = text("a");\n// done';
  try {
    await act(async () =>
      root.render(
        createElement(MarkdownContent, {
          className: "",
          content: `\`\`\`ts\n${source}\n\`\`\`\n\n\`\`\`\n${source}\n\`\`\``,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector("pre code span")).not.toBeNull(),
    );
    const tokens = [...container.querySelectorAll("pre code span")].map(
      (span) => span.textContent,
    );
    expect(tokens).toEqual(expect.arrayContaining(["const", '"a"', "// done"]));
    const blocks = container.querySelectorAll("pre code");
    expect(blocks[0].textContent).toBe(source);
    expect(blocks[1].textContent).toBe(source);
    expect(blocks[1].children).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});
