// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../data/settingsApi";
import { I18nProvider } from "../i18n";
import { AppErrorBoundary } from "./AppErrorBoundary";

vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: { ...defaultAppSettings, languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container, { onCaughtError: () => {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Broken(): never {
  throw new Error("render failed");
}

it("replaces a crashed interface with a recoverable alert", async () => {
  await act(async () =>
    root.render(
      <I18nProvider>
        <AppErrorBoundary>
          <Broken />
        </AppErrorBoundary>
      </I18nProvider>,
    ),
  );

  const alert = container.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert?.querySelector("button")).not.toBeNull();
});
