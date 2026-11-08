import { expect, it } from "vitest";
import { parseToolbarTools } from "./MarkdownToolbar";

it.each(["{broken", "null", "{}", '"bold"', '["bold", 1]', '["unknown"]'])(
  "uses default tools for invalid saved preferences %s",
  (stored) => {
    expect(parseToolbarTools(stored)).toEqual(parseToolbarTools(null));
    expect(parseToolbarTools(null)).toContain("bold");
  },
);

it.each([
  ['["unknown", "image", "bold", "bold"]', ["bold", "image"]],
  ["[]", []],
] as const)(
  "filters unknown and duplicate saved tools without rejecting an empty array: %s",
  (stored, expected) => {
    expect(parseToolbarTools(stored)).toEqual(expected);
  },
);
