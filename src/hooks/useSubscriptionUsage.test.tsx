// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSubscriptionUsage } from "./useSubscriptionUsage";

const POLL_MS = 300_000;
const desktop = vi.hoisted(() => ({ tauri: false, minimized: false }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => desktop.tauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMinimized: async () => desktop.minimized,
  }),
}));

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState;
const load = vi.fn(async () => []);

function Probe() {
  useSubscriptionUsage(load);
  return null;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function dispatch(target: EventTarget, type: string) {
  await act(async () => {
    target.dispatchEvent(new Event(type));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  desktop.tauri = false;
  desktop.minimized = false;
  visibility = "visible";
  load.mockClear();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

it("starts no reading while the page is hidden and catches up once shown", async () => {
  visibility = "hidden";
  await act(async () => root.render(<Probe />));
  await advance(POLL_MS);
  expect(load).not.toHaveBeenCalled();

  visibility = "visible";
  await dispatch(document, "visibilitychange");
  expect(load).toHaveBeenCalledOnce();
  await dispatch(window, "focus");
  expect(load).toHaveBeenCalledOnce();
});

it("starts no reading while the desktop window is minimized", async () => {
  desktop.tauri = true;
  await act(async () => root.render(<Probe />));
  expect(load).toHaveBeenCalledOnce();

  desktop.minimized = true;
  await advance(POLL_MS * 2);
  expect(load).toHaveBeenCalledOnce();

  desktop.minimized = false;
  await dispatch(window, "focus");
  expect(load).toHaveBeenCalledTimes(2);
  await advance(POLL_MS);
  expect(load).toHaveBeenCalledTimes(3);
});
