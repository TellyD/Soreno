// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translations } from "../i18n/translations";
import {
  clearNotifications,
  getNotifications,
  notifyError,
  notifyInfo,
  notifyWarning,
} from "../notifications";
import {
  NotificationCenter,
  notificationAutoDismissMs,
} from "./NotificationCenter";

vi.mock("../i18n", () => {
  const value = {
    t: (key: keyof (typeof translations)["fr"]) => translations.fr[key],
  };
  return { useI18n: () => value };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<NotificationCenter />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  act(() => clearNotifications());
  vi.useRealTimers();
});

const items = () => Array.from(container.querySelectorAll(".notification"));

it("presents errors as alerts and warnings or info as status", async () => {
  await act(async () => {
    notifyError("Impossible de créer la tâche.");
    notifyWarning("Opération terminée avec un avertissement.");
    notifyInfo("Issue ACM-2 créée.");
  });

  const [error, warning, info] = items();
  expect(error.getAttribute("role")).toBe("alert");
  expect(error.textContent).toContain("Impossible de créer la tâche.");
  expect(warning.getAttribute("role")).toBe("status");
  expect(info.getAttribute("role")).toBe("status");
});

it("dismisses itself after the delay, paused while hovered", async () => {
  await act(async () => notifyError("Impossible de charger les notes."));
  const item = items()[0];

  await act(async () =>
    vi.advanceTimersByTime(notificationAutoDismissMs - 1000),
  );
  await act(async () =>
    item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  await act(async () => vi.advanceTimersByTime(notificationAutoDismissMs * 2));
  expect(items()).toHaveLength(1);

  await act(async () =>
    item.dispatchEvent(
      new MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: document.body,
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTime(900));
  expect(items()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(200));
  expect(items()).toHaveLength(0);
});

it("restarts the delay and counts a repeated error", async () => {
  await act(async () => notifyError("Impossible de sauvegarder la note."));
  await act(async () =>
    vi.advanceTimersByTime(notificationAutoDismissMs - 100),
  );
  await act(async () => notifyError("Impossible de sauvegarder la note."));

  expect(items()[0].querySelector(".notification-count")?.textContent).toBe(
    "×2",
  );
  await act(async () =>
    vi.advanceTimersByTime(notificationAutoDismissMs - 100),
  );
  expect(items()).toHaveLength(1);
});

it("keeps actionable errors until the action or close button is used", async () => {
  const retry = vi.fn();
  await act(async () =>
    notifyError("Impossible de charger les URL du projet.", {
      action: { label: "Réessayer", onAction: retry },
    }),
  );
  await act(async () => vi.advanceTimersByTime(notificationAutoDismissMs * 3));
  expect(items()).toHaveLength(1);

  await act(async () =>
    container.querySelector<HTMLButtonElement>(".notification-action")!.click(),
  );
  expect(retry).toHaveBeenCalledOnce();
  expect(getNotifications()).toEqual([]);
});

it("auto-dismisses info notifications even with an action", async () => {
  await act(async () =>
    notifyInfo("Ticket SOR-54 mis à jour", {
      action: { label: "Ouvrir", onAction: vi.fn() },
    }),
  );
  await act(async () => vi.advanceTimersByTime(notificationAutoDismissMs));
  expect(items()).toEqual([]);
});

it("closes one notification or all of them", async () => {
  await act(async () => {
    notifyError("A");
    notifyError("B");
    notifyError("C");
  });

  await act(async () =>
    items()[0]
      .querySelector<HTMLButtonElement>(
        '[aria-label="Fermer la notification"]',
      )!
      .click(),
  );
  expect(getNotifications().map(({ message }) => message)).toEqual(["B", "C"]);

  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".notification-dismiss-all")!
      .click(),
  );
  expect(items()).toHaveLength(0);
});
