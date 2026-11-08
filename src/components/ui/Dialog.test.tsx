// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DialogSurface } from "./Dialog";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function tab(element: HTMLElement, shiftKey = false) {
  element.focus();
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

it("includes native summaries, excludes collapsed content, disabled fields and Base UI guards", async () => {
  await act(async () =>
    root.render(
      <DialogSurface>
        <button id="first">First</button>
        <details>
          <summary>Advanced</summary>
          <textarea />
        </details>
        <fieldset disabled>
          <input tabIndex={0} />
        </fieldset>
        <button disabled tabIndex={0}>
          Disabled
        </button>
        <span tabIndex={0} data-base-ui-focus-guard />
        <span tabIndex={0} aria-hidden="true" />
      </DialogSurface>,
    ),
  );
  const first = container.querySelector<HTMLButtonElement>("#first")!;
  const summary = container.querySelector("summary")!;
  const details = container.querySelector("details")!;
  const textarea = container.querySelector("textarea")!;
  tab(first, true);
  expect(document.activeElement).toBe(summary);
  tab(summary);
  expect(document.activeElement).toBe(first);
  details.open = true;
  // Inner steps are left to native Tab traversal, not redirected to the first control.
  expect(tab(summary).defaultPrevented).toBe(false);
  expect(tab(summary, true).defaultPrevented).toBe(false);
  tab(first, true);
  expect(document.activeElement).toBe(textarea);
  tab(textarea);
  expect(document.activeElement).toBe(first);
});

it.each([false, true])(
  "restores %s explicit focus only on unmount, otherwise the previous control",
  async (explicit) => {
    const previous = document.createElement("button");
    const trigger = document.createElement("button");
    // Keep targets outside the React root so rendering cannot remove them.
    document.body.append(previous, trigger);
    previous.focus();
    const returnFocusRef = explicit ? { current: trigger } : undefined;
    await act(async () =>
      root.render(
        <DialogSurface returnFocusRef={returnFocusRef}>
          <input />
        </DialogSurface>,
      ),
    );
    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    await act(async () =>
      root.render(
        <DialogSurface returnFocusRef={returnFocusRef}>
          <input readOnly />
        </DialogSurface>,
      ),
    );
    expect(document.activeElement).toBe(input);
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(explicit ? trigger : previous);
    previous.remove();
    trigger.remove();
  },
);
