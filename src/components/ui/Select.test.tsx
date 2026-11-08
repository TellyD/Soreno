// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DialogOverlay, DialogSurface } from "./Dialog";
import { Select } from "./Select";
import { stubModalSelector } from "./testTopLayer";
import { useDismissibleLayer } from "./useDismissibleLayer";

let container: HTMLDivElement;
let root: Root;
const onDismiss = vi.fn();
const onChange = vi.fn();
const options = [
  { value: "astra", label: "GPT-6-Astra" },
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "sol", label: "GPT-5.6-Sol" },
];

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("astra");
  const ref = useDismissibleLayer<HTMLElement>(true, onDismiss);
  return (
    <DialogOverlay>
      <DialogSurface ref={ref}>
        <button id="before">Before</button>
        <label htmlFor="model">Model</label>
        <Select
          id="model"
          value={value}
          options={options}
          disabled={disabled}
          onValueChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      </DialogSurface>
    </DialogOverlay>
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  stubModalSelector();
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trigger() {
  return container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}

async function key(element: Element, key: string, shiftKey = false) {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

it("shows the label and selects a portalled option without dismissing the dialog", async () => {
  expect(trigger().textContent).toBe("GPT-6-Astra");
  await act(async () => trigger().click());
  const list = document.getElementById(
    trigger().getAttribute("aria-controls")!,
  )!;
  expect(list).not.toBeNull();
  expect(container.contains(list)).toBe(false);
  expect(list.querySelector('[aria-selected="true"]')?.textContent).toBe(
    "GPT-6-Astra",
  );
  const sol = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === "GPT-5.6-Sol",
  )!;
  await act(async () => {
    sol.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    sol.click();
  });
  expect(onDismiss).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith("sol");
  expect(trigger().textContent).toBe("GPT-5.6-Sol");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("shows an option's full text as tooltip only when it is clipped", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.textContent === "GPT-5.6-Sol" ? 100 : 0;
    },
  );
  await act(async () => trigger().click());
  const option = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === label,
    )!;
  for (const label of ["GPT-6-Astra", "GPT-5.6-Sol"])
    await act(async () =>
      option(label).dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
  expect(option("GPT-6-Astra").title).toBe("");
  expect(option("GPT-5.6-Sol").title).toBe("GPT-5.6-Sol");
});

it("supports keyboard navigation, rejects disabled options and closes only the select on Escape", async () => {
  await act(async () => trigger().focus());
  await key(trigger(), "ArrowDown");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  const selected = document.querySelector<HTMLElement>(
    '[role="option"][aria-selected="true"]',
  )!;
  await act(async () => selected.focus());
  await key(selected, "ArrowDown");
  expect(document.activeElement?.getAttribute("aria-disabled")).toBe("true");
  await key(document.activeElement!, "Enter");
  expect(onChange).not.toHaveBeenCalled();
  await key(document.activeElement!, "ArrowDown");
  expect(document.activeElement?.textContent).toBe("GPT-5.6-Sol");
  await key(document.activeElement!, "Enter");
  expect(onChange).toHaveBeenCalledWith("sol");
  await act(async () => trigger().click());
  await key(
    document.querySelector('[role="option"][aria-selected="true"]')!,
    "Escape",
  );
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(onDismiss).not.toHaveBeenCalled();
  await key(trigger(), "Escape");
  expect(onDismiss).toHaveBeenCalledOnce();
});

it.each([
  { shift: false, fromTrigger: false },
  { shift: true, fromTrigger: false },
  { shift: false, fromTrigger: true },
  { shift: true, fromTrigger: true },
])(
  "closes the popup and resumes dialog Tab navigation (%j)",
  async ({ shift, fromTrigger }) => {
    await act(async () => trigger().click());
    const target = fromTrigger
      ? trigger()
      : document.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => target.focus());
    await key(target, "Tab", shift);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // jsdom does not perform native Tab traversal. Forward Tab wraps at the last control;
    // Shift+Tab leaves focus at its trigger so the browser can move to the previous control.
    expect(document.activeElement).toBe(
      shift ? trigger() : container.querySelector("#before"),
    );
    expect(onDismiss).not.toHaveBeenCalled();
  },
);

it("does not open a disabled select", async () => {
  await act(async () => root.render(<Harness disabled />));
  await act(async () => trigger().click());
  expect(trigger().disabled).toBe(true);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(onChange).not.toHaveBeenCalled();
});
