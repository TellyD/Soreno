import { expect, it } from "vitest";
import { designFrameDocument, designFramePick } from "./designFrameDocument";

it("runs only Soreno's picker in the frame, loads nothing and keeps the doctype first", () => {
  const picker = "http://localhost:1420/src/components/design/framePicker.js";
  const document = designFrameDocument(
    '  <!DOCTYPE html>\n<html><img src="https://example.com/x.png"><script>alert(1)</script>',
    picker,
    "dark",
  );
  expect(document).toMatch(
    /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src (\S+);/,
  );
  // The policy names the picker alone: inline scripts, the frame's own, stay blocked.
  expect(document).toContain(`script-src ${picker};`);
  expect(document).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(document).toContain(`<script src="${picker}"`);
  expect(document.match(/<!doctype/gi)).toHaveLength(1);
  expect(document.match(/<base target="_blank">/g)).toHaveLength(1);
});

it("takes only well-formed picker reports", () => {
  expect(
    designFramePick({
      type: "soreno-frame-pick",
      path: "main > button",
      html: "x".repeat(3000),
    }),
  ).toEqual({
    type: "pick",
    target: { selector: "main > button", outerHTML: "x".repeat(2048) },
  });
  // The page itself stands for the whole frame.
  expect(designFramePick({ type: "soreno-frame-pick", path: "" })).toEqual({
    type: "pick",
    target: null,
  });
  expect(designFramePick({ type: "other", path: "a" })).toBeNull();
  expect(designFramePick("soreno-frame-pick")).toBeNull();
  expect(
    designFramePick({ type: "soreno-frame-zoom", deltaY: -3, x: 10, y: 20 }),
  ).toEqual({ type: "zoom", deltaY: -3, x: 10, y: 20 });
  expect(
    designFramePick({ type: "soreno-frame-zoom", deltaY: -3, x: 10, y: "20" }),
  ).toBeNull();
});
