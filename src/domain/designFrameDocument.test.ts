// @ts-expect-error jsdom ships no type declarations in this repo.
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import framePicker from "../components/design/framePicker.js?raw";
import { designFrameDocument, designFramePick } from "./designFrameDocument";

it("keeps inline scripts blocked by default, allows them when enabled, and always blocks loads and form actions", () => {
  const picker = "http://localhost:1420/src/components/design/framePicker.js";
  const html =
    '  <!DOCTYPE html>\n<html><img src="https://example.com/x.png"><script>alert(1)</script>';
  const staticDoc = designFrameDocument(html, picker, "dark");
  expect(staticDoc).toMatch(
    /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src (\S+);/,
  );
  // The static policy names the picker alone: inline scripts stay blocked in previews.
  expect(staticDoc).toContain(`script-src ${picker};`);
  expect(staticDoc).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(staticDoc).toContain("form-action 'none'");
  expect(staticDoc).toContain(`<script src="${picker}"`);
  expect(staticDoc).toMatch(/<!doctype/gi);
  expect(staticDoc.match(/<!doctype/gi)).toHaveLength(1);
  expect(staticDoc.match(/<base target="_blank">/g)).toHaveLength(1);

  const interactiveDoc = designFrameDocument(html, picker, "dark", true);
  expect(interactiveDoc).toContain(`script-src ${picker} 'unsafe-inline';`);
  expect(interactiveDoc).not.toContain("'unsafe-eval'");
  expect(interactiveDoc).toContain("default-src 'none';");
  expect(interactiveDoc).toContain("form-action 'none'");
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
  expect(designFramePick({ type: "soreno-frame-escape" })).toEqual({
    type: "escape",
  });
});

it("relays Escape only when the prototype did not cancel it, even from handlers added on DOMContentLoaded", async () => {
  const dom = new JSDOM("<!DOCTYPE html><body><p>proto</p></body>", {
    runScripts: "outside-only",
  });
  const window = dom.window;
  try {
    const posted: unknown[] = [];
    // The top frame is its own parent, so the picker's parent.postMessage lands here.
    window.postMessage = (data: unknown) => posted.push(data);
    // Rendezvous on the real timer: the prototype below swaps window.setTimeout.
    const nativeSetTimeout = window.setTimeout.bind(window);
    Object.assign(window, { RTCPeerConnection: function () {} });
    const loaded = new Promise((resolve) =>
      window.document.addEventListener("DOMContentLoaded", resolve),
    );
    window.eval(framePicker);
    expect(Reflect.get(window, "RTCPeerConnection")).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(window, "RTCPeerConnection")
        ?.configurable,
    ).toBe(false);
    // Same names as the picker's locals: a leak out of its IIFE would throw a redeclaration error.
    window.eval(`
      let mode = "open";
      let selected = 1;
      window.modalOpen = true;
      // A synchronous timer would run the picker's check before this handler cancels Escape.
      window.setTimeout = (fn) => { fn(); return 0; };
      document.addEventListener("DOMContentLoaded", () => {
        addEventListener("keydown", (e) => {
          if (e.key === "Escape" && window.modalOpen) e.preventDefault();
        });
      });
    `);
    await loaded;
    const setMode = (mode: string) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "soreno-frame-mode", mode },
          source: window,
        }),
      );
    const escape = async () => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Escape",
          cancelable: true,
        }),
      );
      await new Promise((resolve) => nativeSetTimeout(resolve, 0));
    };

    setMode("interact");
    await escape();
    expect(posted).toEqual([]);

    window.modalOpen = false;
    await escape();
    expect(posted).toEqual([{ type: "soreno-frame-escape" }]);

    setMode("canvas");
    await escape();
    expect(posted).toHaveLength(1);
  } finally {
    window.close();
  }
});
