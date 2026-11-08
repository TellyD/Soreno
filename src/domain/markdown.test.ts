import { describe, expect, it } from "vitest";
import {
  markdownImage,
  normalizeLegacyMarkdown,
  stripInternalBlockMarkers,
} from "./markdown";

const blankLineMarker = "<!-- telaoi:blank-line -->";
const emptyCheckListItemMarker = "<!-- telaoi:empty-check-list-item -->";
const checkedEmptyCheckListItemMarker =
  "<!-- telaoi:checked-empty-check-list-item -->";

describe("markdown images", () => {
  it("escapes the alt text and encodes unsafe URL characters", () => {
    expect(markdownImage("a [b]\\c\nd", "https://x/y z<1>")).toBe(
      "![a \\[b\\]\\\\c d](<https://x/y%20z%3C1%3E>)",
    );
  });
});

describe("legacy text compatibility", () => {
  it.each([
    [`A\n${blankLineMarker}\nB`, "A\n\nB"],
    [`A\n\n${blankLineMarker}\n\n${blankLineMarker}\n\nB`, "A\n\n\n\n\n\nB"],
    [`${blankLineMarker}\nA`, "\nA"],
    [`A\n${blankLineMarker}`, "A\n"],
    [blankLineMarker, ""],
    [`${blankLineMarker}\n${blankLineMarker}`, "\n"],
    [`A  \r\n  ${blankLineMarker}\t\r\nB\r\n`, "A  \r\n  \t\r\nB\r\n"],
    [
      `${emptyCheckListItemMarker}\n${checkedEmptyCheckListItemMarker}`,
      "- [ ] \n- [x] ",
    ],
    [`  ${emptyCheckListItemMarker}  \r\n`, "  - [ ]   \r\n"],
  ])("converts only reserved comments in %j", (source, expected) => {
    expect(normalizeLegacyMarkdown(source)).toBe(expected);
    expect(normalizeLegacyMarkdown(expected)).toBe(expected);
  });

  it.each([
    "",
    "\n",
    " \t",
    "A\nB",
    "A\n\nB",
    "A\n\n\nB",
    "\n\nA  \nB\n\n\n",
    "A\r\n\r\nB\r\n",
    "A\r\nB\nC",
    "\\\n\\",
    "- [ ] \n- [x] Task",
    "| a | b |\n| - | - |\n| c | d |",
    "[ref][id]\n\n\n[id]: https://example.com",
    `\`\`\`\`md\n\`\`\`\n${blankLineMarker}\n\n\`\`\`\``,
    `~~~~md\n~~~\n${blankLineMarker}\n\n~~~~`,
    `\`\`\`md\n${blankLineMarker}\n\n`,
    `    ${blankLineMarker}\n\n    code`,
    `> ${blankLineMarker}`,
    `- item\n\n  ${blankLineMarker}`,
    `<pre>\n${blankLineMarker}\n</pre>`,
    `\`${blankLineMarker}\``,
    `\\${blankLineMarker}`,
    "<!-- regular comment -->",
    "<!-- telaoi:unknown -->",
  ])("preserves modern or protected source %j", (source) => {
    expect(normalizeLegacyMarkdown(source)).toBe(source);
  });
  it("keeps large whitespace sequences without a paragraph-count protocol", () => {
    const whitespace = "\n".repeat(1000);
    expect(normalizeLegacyMarkdown(`A${whitespace}${blankLineMarker}\nB`)).toBe(
      `A${whitespace}\nB`,
    );
  });
});

describe("stripInternalBlockMarkers for titles and search", () => {
  it("removes legacy markers from display text only", () => {
    expect(
      stripInternalBlockMarkers(
        `A\n${blankLineMarker}\n${emptyCheckListItemMarker}\n${checkedEmptyCheckListItemMarker}\nB`,
      ),
    ).toBe("A\nB");
  });
  it.each(["soreno", "telaoi"])(
    "hides %s image widths in display/search without stripping literal code or changing saved Markdown",
    (prefix) => {
      const marker = `<!-- ${prefix}:image-width=400 -->`;
      const source = `![photo](https://example.com/a.png)${marker}`;
      expect(stripInternalBlockMarkers(source)).toBe(
        "![photo](https://example.com/a.png)",
      );
      expect(normalizeLegacyMarkdown(source)).toBe(source);
      for (const literal of [
        `\`${marker}\``,
        `    ${marker}`,
        `\`\`\`md\n${source}\n\`\`\``,
        `<!-- ${prefix}:image-width=99999 -->`,
      ]) {
        expect(stripInternalBlockMarkers(literal)).toBe(literal);
      }
    },
  );
  it("preserves fenced literal markers", () => {
    const source = `\`\`\`md\n${blankLineMarker}\n\`\`\``;
    expect(stripInternalBlockMarkers(source)).toBe(source);
  });
});
