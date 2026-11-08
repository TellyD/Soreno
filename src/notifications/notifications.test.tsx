// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearNotifications,
  closeNotification,
  dismissNotification,
  getNotifications,
  notifyError,
  notifyWarning,
  useNotification,
  type NotificationInput,
} from "./notifications";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clearNotifications();
});

it("merges repeated messages into one notification and moves it to the front", () => {
  notifyError("Impossible de sauvegarder la note.");
  notifyWarning("Opération terminée avec un avertissement.");
  notifyError("Impossible de sauvegarder la note.");

  expect(getNotifications()).toMatchObject([
    { message: "Opération terminée avec un avertissement.", tone: "warning" },
    {
      message: "Impossible de sauvegarder la note.",
      occurrences: 2,
      tone: "error",
    },
  ]);
});

it("replaces the message of a keyed notification and resets its count", () => {
  notifyError("Nom du type requis.", { key: "note-type-form" });
  notifyError("Nom du type requis.", { key: "note-type-form" });
  notifyError("Un type porte déjà ce nom.", { key: "note-type-form" });

  expect(getNotifications()).toMatchObject([
    { message: "Un type porte déjà ce nom.", occurrences: 1 },
  ]);
  dismissNotification("note-type-form");
  expect(getNotifications()).toEqual([]);
});

it("keeps only the four most recent notifications", () => {
  ["A", "B", "C", "D", "E"].forEach((message) => notifyError(message));

  expect(getNotifications().map(({ message }) => message)).toEqual([
    "B",
    "C",
    "D",
    "E",
  ]);
});

it("evicts transient notifications before actionable ones", () => {
  const action = { label: "Réessayer", onAction: () => undefined };
  notifyError("Lecture Git impossible.", { action });
  ["A", "B", "C", "D"].forEach((message) => notifyError(message));

  expect(getNotifications().map(({ message }) => message)).toEqual([
    "Lecture Git impossible.",
    "B",
    "C",
    "D",
  ]);
});

it("acknowledges only on user close, not on programmatic removal", () => {
  const onDismiss = vi.fn();
  notifyError("Mutation Git incertaine.", { key: "git", onDismiss });
  dismissNotification("git");
  expect(onDismiss).not.toHaveBeenCalled();

  notifyError("Mutation Git incertaine.", { key: "git", onDismiss });
  closeNotification("git");
  notifyError("Mutation Git incertaine.", { key: "git", onDismiss });
  clearNotifications();
  expect(onDismiss).toHaveBeenCalledTimes(2);
});

function Condition({ input }: { input: NotificationInput | null }) {
  useNotification(input);
  return null;
}

it("counts a condition mirrored by several owners once", async () => {
  const input = {
    key: "projects-load",
    message: "Impossible de charger les projets.",
  };
  await act(async () =>
    root.render(
      <>
        <Condition input={input} />
        <Condition input={input} />
      </>,
    ),
  );

  expect(getNotifications()).toMatchObject([{ ...input, occurrences: 1 }]);
});

it("mirrors a persistent condition and withdraws it when resolved or unmounted", async () => {
  const input = {
    key: "tasks-load",
    message: "Impossible de charger les tâches.",
  };
  await act(async () => root.render(<Condition input={input} />));
  expect(getNotifications()).toMatchObject([input]);

  await act(async () => root.render(<Condition input={null} />));
  expect(getNotifications()).toEqual([]);

  await act(async () => root.render(<Condition input={input} />));
  expect(getNotifications()).toHaveLength(1);
  await act(async () => root.render(<></>));
  expect(getNotifications()).toEqual([]);
});

it("does not reopen a dismissed condition until its message changes", async () => {
  const render = (message: string) =>
    act(async () =>
      root.render(<Condition input={{ key: "git-read", message }} />),
    );
  await render("Lecture Git impossible.");
  dismissNotification("git-read");
  await render("Lecture Git impossible.");
  expect(getNotifications()).toEqual([]);

  await render("Dépôt Git introuvable.");
  expect(getNotifications()).toMatchObject([
    { message: "Dépôt Git introuvable." },
  ]);
});

it("runs the latest action callback of a condition", async () => {
  const first = vi.fn();
  const latest = vi.fn();
  const input = (onAction: () => void) => ({
    key: "urls",
    message: "Impossible de charger les URL du projet.",
    action: { label: "Réessayer", onAction },
  });
  await act(async () => root.render(<Condition input={input(first)} />));
  await act(async () => root.render(<Condition input={input(latest)} />));

  getNotifications()[0].action?.onAction();
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});
