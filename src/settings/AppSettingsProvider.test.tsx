// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../data/settingsApi";
import type { AppSettings } from "../data/settingsApi";
import { clearNotifications, getNotifications } from "../notifications";
import { AppSettingsProvider, useAppSettings } from "./AppSettingsProvider";
import { deferred } from "../testing/deferred";

vi.mock("../data/settingsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/settingsApi")>()),
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}));

const storedSettings: AppSettings = {
  ...api.defaultAppSettings,
  codexGitModel: "stored-model",
  languagePreference: "fr",
};

let root: Root;
let container: HTMLDivElement;
let context: ReturnType<typeof useAppSettings>;

function Harness() {
  context = useAppSettings();
  return null;
}

async function renderProvider() {
  await act(async () => {
    root.render(
      <StrictMode>
        <AppSettingsProvider>
          <Harness />
        </AppSettingsProvider>
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  vi.mocked(api.updateAppSettings).mockImplementation(
    async (settings) => settings,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("reports an initial failure, reloads before writing and withdraws the report once loaded", async () => {
  vi.mocked(api.getAppSettings)
    .mockRejectedValueOnce(new Error("initial load failed"))
    .mockRejectedValueOnce(new Error("reload failed"))
    .mockResolvedValueOnce(storedSettings);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["fr-FR"]);
  await renderProvider();
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message:
        "Impossible de charger vos paramètres. Les paramètres par défaut sont utilisés.",
      tone: "error",
    }),
  ]);

  await act(async () => {
    await expect(
      context.updateSettings({ themePreference: "dark" }),
    ).rejects.toThrow("reload failed");
  });
  expect(api.updateAppSettings).not.toHaveBeenCalled();

  await act(async () => {
    await context.updateSettings({ themePreference: "dark" });
  });
  expect(api.updateAppSettings).toHaveBeenCalledWith({
    ...storedSettings,
    themePreference: "dark",
  });
  expect(getNotifications()).toEqual([]);
  expect(context.settings).toEqual({
    ...storedSettings,
    themePreference: "dark",
  });
});

it("waits for a slow initial load and serializes concurrent patches", async () => {
  const load = deferred<AppSettings>();
  const firstWrite = deferred<AppSettings>();
  vi.mocked(api.getAppSettings).mockReturnValue(load.promise);
  vi.mocked(api.updateAppSettings)
    .mockReturnValueOnce(firstWrite.promise)
    .mockImplementationOnce(async (settings) => settings);
  await renderProvider();

  let first!: Promise<AppSettings>;
  let second!: Promise<AppSettings>;
  act(() => {
    first = context.updateSettings({ themePreference: "dark" });
    second = context.updateSettings({ languagePreference: "en" });
  });
  expect(api.updateAppSettings).not.toHaveBeenCalled();

  await act(async () => load.resolve(storedSettings));
  expect(api.getAppSettings).toHaveBeenCalledTimes(1);
  expect(api.updateAppSettings).toHaveBeenCalledTimes(1);
  expect(api.updateAppSettings).toHaveBeenNthCalledWith(1, {
    ...storedSettings,
    themePreference: "dark",
  });

  await act(async () => {
    firstWrite.resolve({ ...storedSettings, themePreference: "dark" });
    await Promise.all([first, second]);
  });
  expect(api.updateAppSettings).toHaveBeenNthCalledWith(2, {
    ...storedSettings,
    languagePreference: "en",
    themePreference: "dark",
  });
});

it("resolves functional patches against the queued settings", async () => {
  const firstWrite = deferred<AppSettings>();
  vi.mocked(api.getAppSettings).mockResolvedValue(storedSettings);
  vi.mocked(api.updateAppSettings)
    .mockReturnValueOnce(firstWrite.promise)
    .mockImplementationOnce(async (settings) => settings);
  await renderProvider();

  let first!: Promise<AppSettings>;
  let second!: Promise<AppSettings>;
  await act(async () => {
    first = context.updateSettings((current) => ({
      hiddenAgentPresets: [...current.hiddenAgentPresets, "pi"],
    }));
    second = context.updateSettings((current) => ({
      hiddenAgentPresets: [...current.hiddenAgentPresets, "omp"],
    }));
  });
  expect(api.updateAppSettings).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstWrite.resolve({ ...storedSettings, hiddenAgentPresets: ["pi"] });
    await Promise.all([first, second]);
  });
  expect(api.updateAppSettings).toHaveBeenNthCalledWith(2, {
    ...storedSettings,
    hiddenAgentPresets: ["pi", "omp"],
  });
  expect(context.settings.hiddenAgentPresets).toEqual(["pi", "omp"]);
});

it("recovers the queue from a failed write using the last loaded settings", async () => {
  vi.mocked(api.getAppSettings).mockResolvedValue(storedSettings);
  vi.mocked(api.updateAppSettings)
    .mockRejectedValueOnce(new Error("write failed"))
    .mockImplementationOnce(async (settings) => settings);
  await renderProvider();

  await act(async () => {
    await expect(
      context.updateSettings({ themePreference: "dark" }),
    ).rejects.toThrow("write failed");
  });
  await act(async () => {
    await context.updateSettings({ languagePreference: "en" });
  });

  expect(api.updateAppSettings).toHaveBeenNthCalledWith(2, {
    ...storedSettings,
    languagePreference: "en",
  });
});
