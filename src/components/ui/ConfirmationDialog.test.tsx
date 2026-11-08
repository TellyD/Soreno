// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { useDismissibleLayer } from "./useDismissibleLayer";

let container: HTMLDivElement;
let root: Root;
const onDialogCancel = vi.fn();
const onPanelDismiss = vi.fn();

function Harness({ cancelDisabled = false, version = "initial" }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(true);
  const panelRef = useDismissibleLayer<HTMLElement>(panelOpen, () => {
    onPanelDismiss(version);
    setPanelOpen(false);
  });

  if (!panelOpen) {
    return null;
  }

  return (
    <section ref={panelRef} data-testid="panel">
      <button data-testid="outside">Outside dialog</button>
      {dialogOpen ? (
        <ConfirmationDialog
          cancelDisabled={cancelDisabled}
          cancelLabel="Cancel"
          closeLabel="Close"
          confirmLabel="Confirm"
          description="Description"
          onCancel={() => {
            onDialogCancel();
            setDialogOpen(false);
          }}
          onConfirm={() => {}}
          title="Confirmation"
        />
      ) : null}
    </section>
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function escape(preventDefault = false) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    if (preventDefault) event.preventDefault();
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
}

async function pointerDown(target: Element, preventDefault = false) {
  await act(async () => {
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    if (preventDefault) event.preventDefault();
    target.dispatchEvent(event);
  });
}

it("dismisses only the topmost nested layer and keeps callbacks current", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<Harness version="updated" />));

  await escape();
  expect(onDialogCancel).toHaveBeenCalledOnce();
  expect(onPanelDismiss).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.querySelector('[data-testid="panel"]')).not.toBeNull();

  await escape();
  expect(onPanelDismiss).toHaveBeenCalledExactlyOnceWith("updated");
  expect(container.querySelector('[data-testid="panel"]')).toBeNull();
});

it("dismisses one layer per outside pointer event", async () => {
  await act(async () => root.render(<Harness />));
  const outside = container.querySelector('[data-testid="outside"]')!;

  await pointerDown(outside);
  expect(onDialogCancel).toHaveBeenCalledOnce();
  expect(onPanelDismiss).not.toHaveBeenCalled();

  await pointerDown(document.body);
  expect(onPanelDismiss).toHaveBeenCalledOnce();
});

it("ignores already prevented dismissal events", async () => {
  await act(async () => root.render(<Harness />));
  const outside = container.querySelector('[data-testid="outside"]')!;

  await pointerDown(outside, true);
  await escape(true);

  expect(onDialogCancel).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
});

it("keeps a disabled confirmation as the active layer for every cancel path", async () => {
  await act(async () => root.render(<Harness cancelDisabled />));
  const dialog = container.querySelector<HTMLElement>('[role="alertdialog"]')!;
  const outside = container.querySelector('[data-testid="outside"]')!;
  const close = dialog.querySelector<HTMLButtonElement>(
    '[aria-label="Close"]',
  )!;
  const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Cancel",
  )!;

  await act(async () => {
    close.click();
    cancel.click();
  });
  await escape();
  await pointerDown(outside);

  expect(close.disabled).toBe(true);
  expect(cancel.disabled).toBe(true);
  expect(onDialogCancel).not.toHaveBeenCalled();
  expect(onPanelDismiss).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]')).toBe(dialog);
});
