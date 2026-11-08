// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkForAppUpdate,
  downloadAppUpdate,
  installAppUpdate,
  relaunchApp,
  releaseAppUpdate,
  type AppUpdate,
} from "../data/appUpdater";
import { I18nProvider } from "../i18n";
import {
  clearNotifications,
  closeNotification,
  getNotifications,
} from "../notifications";
import { deferred } from "../testing/deferred";
import { AppUpdateStatus } from "./AppUpdateStatus";

vi.mock("../data/appUpdater", () => ({
  checkForAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  installAppUpdate: vi.fn(),
  relaunchApp: vi.fn(),
  releaseAppUpdate: vi.fn(),
}));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));

const update = { version: "0.2.0" } as AppUpdate;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(checkForAppUpdate).mockResolvedValue(update);
  vi.mocked(downloadAppUpdate).mockResolvedValue(undefined);
  vi.mocked(installAppUpdate).mockResolvedValue(undefined);
  vi.mocked(relaunchApp).mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearNotifications();
  vi.resetAllMocks();
  vi.useRealTimers();
});

async function renderStatus(
  prepareToClose = vi.fn(async () => true),
  cancelPreparedClose = vi.fn(),
) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <AppUpdateStatus
          cancelPreparedClose={cancelPreparedClose}
          prepareToClose={prepareToClose}
        />
      </I18nProvider>,
    ),
  );
  return { prepareToClose, cancelPreparedClose };
}

function updateFailure() {
  return getNotifications().find((item) => item.key === "app-update");
}

async function retryFromNotification() {
  const action = updateFailure()?.action;
  expect(action?.label).toBe("Réessayer");
  await act(async () => action!.onAction());
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () =>
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

it("shows download progress and keeps the downloaded update when closing is blocked", async () => {
  let finishDownload!: () => void;
  vi.mocked(downloadAppUpdate).mockImplementation(async (_update, onEvent) => {
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 50 } });
    await new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
  });
  const prepareToClose = vi.fn(async () => false);
  await renderStatus(prepareToClose);

  const updateButton = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Mettre à jour vers 0.2.0",
  );
  expect(updateButton).toBeDefined();
  act(() =>
    updateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  expect(container.textContent).toContain("Téléchargement… 50 %");
  await act(async () => {
    finishDownload();
    await Promise.resolve();
  });

  expect(prepareToClose).toHaveBeenCalledOnce();
  expect(installAppUpdate).not.toHaveBeenCalled();
  expect(relaunchApp).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Installer et redémarrer");
});

it("downloads, prepares, installs and relaunches", async () => {
  const { prepareToClose, cancelPreparedClose } = await renderStatus();
  await click("Mettre à jour vers 0.2.0");

  expect(downloadAppUpdate).toHaveBeenCalledWith(update, expect.any(Function));
  expect(prepareToClose).toHaveBeenCalledOnce();
  expect(installAppUpdate).toHaveBeenCalledWith(update);
  expect(relaunchApp).toHaveBeenCalledOnce();
  expect(cancelPreparedClose).not.toHaveBeenCalled();
});

it("unlocks the app after an install failure and retries without downloading twice", async () => {
  vi.mocked(installAppUpdate)
    .mockRejectedValueOnce(new Error("installer failed"))
    .mockResolvedValueOnce(undefined);
  const { prepareToClose, cancelPreparedClose } = await renderStatus();

  await click("Mettre à jour vers 0.2.0");
  expect(updateFailure()).toMatchObject({
    message: "La mise à jour de l’application a échoué.",
    tone: "error",
  });
  expect(container.textContent).toBe("");
  expect(cancelPreparedClose).toHaveBeenCalledOnce();

  await retryFromNotification();
  expect(updateFailure()).toBeUndefined();
  expect(downloadAppUpdate).toHaveBeenCalledOnce();
  expect(prepareToClose).toHaveBeenCalledTimes(2);
  expect(installAppUpdate).toHaveBeenCalledTimes(2);
  expect(relaunchApp).toHaveBeenCalledOnce();
});

it("restores the install action when a relaunch failure is dismissed and only relaunches again", async () => {
  vi.mocked(relaunchApp)
    .mockRejectedValueOnce(new Error("relaunch failed"))
    .mockResolvedValueOnce(undefined);
  const { prepareToClose, cancelPreparedClose } = await renderStatus();

  await click("Mettre à jour vers 0.2.0");
  expect(cancelPreparedClose).toHaveBeenCalledOnce();

  await act(async () => closeNotification("app-update"));
  await click("Installer et redémarrer");
  expect(downloadAppUpdate).toHaveBeenCalledOnce();
  expect(prepareToClose).toHaveBeenCalledTimes(2);
  expect(installAppUpdate).toHaveBeenCalledOnce();
  expect(relaunchApp).toHaveBeenCalledTimes(2);
});

const hour = 60 * 60_000;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it("shows an update published after launch at the next hourly check", async () => {
  vi.useFakeTimers();
  vi.mocked(checkForAppUpdate).mockResolvedValueOnce(null);
  await renderStatus();
  expect(container.textContent).toBe("");

  await advance(hour - 1);
  expect(checkForAppUpdate).toHaveBeenCalledOnce();
  await advance(1);
  expect(checkForAppUpdate).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("Mettre à jour vers 0.2.0");
});

it("catches up on focus after the machine slept past a check, without checking on every focus", async () => {
  vi.useFakeTimers();
  vi.mocked(checkForAppUpdate).mockResolvedValueOnce(null);
  await renderStatus();

  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(checkForAppUpdate).toHaveBeenCalledOnce();

  vi.setSystemTime(Date.now() + 2 * hour);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(checkForAppUpdate).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("Mettre à jour vers 0.2.0");
});

it("offers a newer release instead of the pending one and stops checking once the download starts", async () => {
  vi.useFakeTimers();
  const duplicate = { version: "0.2.0" } as AppUpdate;
  const newer = { version: "0.3.0" } as AppUpdate;
  vi.mocked(checkForAppUpdate)
    .mockResolvedValueOnce(update)
    .mockResolvedValueOnce(duplicate)
    .mockResolvedValueOnce(newer);
  vi.mocked(downloadAppUpdate).mockReturnValue(new Promise<void>(() => {}));
  await renderStatus();

  await advance(hour);
  expect(releaseAppUpdate).toHaveBeenCalledWith(duplicate);
  expect(container.textContent).toBe("Mettre à jour vers 0.2.0");

  await advance(hour);
  expect(releaseAppUpdate).toHaveBeenLastCalledWith(update);
  await click("Mettre à jour vers 0.3.0");
  expect(downloadAppUpdate).toHaveBeenCalledWith(newer, expect.any(Function));

  await advance(3 * hour);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(checkForAppUpdate).toHaveBeenCalledTimes(3);
});

it("downloads and installs the offered update when a newer release lands just before the click", async () => {
  vi.useFakeTimers();
  const newer = { version: "0.3.0" } as AppUpdate;
  const resolveCheck = deferred<AppUpdate>();
  vi.mocked(checkForAppUpdate)
    .mockResolvedValueOnce(update)
    .mockReturnValueOnce(resolveCheck.promise);
  await renderStatus();
  await advance(hour);

  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Mettre à jour vers 0.2.0",
  );
  // act defers the commit of the check result, so the click sees the old render.
  await act(async () => {
    resolveCheck.resolve(newer);
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  const downloadedUpdate = vi.mocked(downloadAppUpdate).mock.calls[0]?.[0];
  expect(downloadedUpdate).toBeDefined();
  expect(
    vi.mocked(releaseAppUpdate).mock.calls.map(([released]) => released),
  ).not.toContain(downloadedUpdate);
  expect(vi.mocked(installAppUpdate).mock.calls[0]?.[0]).toBe(downloadedUpdate);
});
