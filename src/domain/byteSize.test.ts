import { expect, it } from "vitest";
import { formatByteSize } from "./byteSize";

it.each([
  [999, "999 bytes"],
  [1000, "1 kB"],
  [999_949, "999.9 kB"],
  [999_950, "1 MB"],
  [1_250_000, "1.3 MB"],
])(
  "formats %i bytes with the unit that keeps rounding below 1000",
  (bytes, text) => {
    expect(formatByteSize(bytes, "en-US")).toBe(text);
  },
);

it("signs size changes and keeps a zero change unsigned", () => {
  expect(formatByteSize(-67_200, "en-US", { signed: true })).toBe("-67.2 kB");
  expect(formatByteSize(1, "en-US", { signed: true })).toBe("+1 byte");
  expect(formatByteSize(0, "en-US", { signed: true })).toBe("0 bytes");
});
