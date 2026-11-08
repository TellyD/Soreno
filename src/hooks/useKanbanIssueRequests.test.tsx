// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../data/kanbanApi";
import type { KanbanIssueRequestEvent } from "../domain/kanban";
import { I18nProvider } from "../i18n";
import { clearNotifications, getNotifications } from "../notifications";
import { deferred } from "../testing/deferred";
import { useKanbanIssueRequestNotifications } from "./useKanbanIssueRequests";

vi.mock("../data/kanbanApi", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listenKanbanIssueRequests: vi.fn(),
}));
vi.mock("../settings", () => ({
  useAppSettings: () => ({
    settings: { languagePreference: "fr" },
    updateSettings: vi.fn(),
  }),
}));

const openIssue = vi.fn();

function Announcer() {
  useKanbanIssueRequestNotifications(openIssue);
  return null;
}

let root: Root;
let emit: (event: KanbanIssueRequestEvent) => void;
const request = {
  sessionId: "s1",
  sessionName: "Pi · Soreno",
  title: "Corriger le tri",
  updated: false,
};

async function mountAnnouncer() {
  root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <I18nProvider>
        <Announcer />
      </I18nProvider>,
    ),
  );
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(api.listenKanbanIssueRequests).mockImplementation(
    async (listener) => {
      emit = listener;
      return () => {};
    },
  );
  await mountAnnouncer();
});

afterEach(async () => {
  await act(async () => root.unmount());
  act(() => clearNotifications());
  vi.resetAllMocks();
});

it("announces a created issue with an action opening it in Soreno", () => {
  act(() =>
    emit({
      ...request,
      issue: { id: "issue-12", identifier: "ENG-12", source: "linear" },
      error: null,
    }),
  );

  const [notification] = getNotifications();
  expect(notification).toMatchObject({
    tone: "info",
    action: { label: "Ouvrir" },
  });
  notification.action!.onAction();
  expect(openIssue).toHaveBeenCalledExactlyOnceWith({
    id: "issue-12",
    identifier: "ENG-12",
    source: "linear",
  });
});

it("reports a failed request as an error, translating coded Kanban errors", () => {
  act(() =>
    emit({
      ...request,
      issue: null,
      error: "[Kanban/requestInvalidJson] JSON invalide (EOF).",
    }),
  );

  expect(getNotifications()).toMatchObject([
    {
      message:
        "« Pi · Soreno » n’a pas pu créer l’issue « Corriger le tri » : La demande de l’agent n’est pas un JSON valide.",
      tone: "error",
    },
  ]);
});

it("stops listening when unmounted before the subscription resolves", async () => {
  await act(async () => root.unmount());
  const subscription = deferred<() => void>();
  vi.mocked(api.listenKanbanIssueRequests).mockReturnValue(
    subscription.promise,
  );
  await mountAnnouncer();
  await act(async () => root.unmount());

  const stop = vi.fn();
  await act(async () => subscription.resolve(stop));
  expect(stop).toHaveBeenCalledOnce();
});

it("ignores events reaching a subscription unmounted before it resolves", async () => {
  await act(async () => root.unmount());
  const subscription = deferred<() => void>();
  let staleEmit!: (event: KanbanIssueRequestEvent) => void;
  vi.mocked(api.listenKanbanIssueRequests).mockImplementation((listener) => {
    staleEmit = listener;
    return subscription.promise;
  });
  await mountAnnouncer();
  await act(async () => root.unmount());

  act(() => staleEmit({ ...request, issue: null, error: "Titre vide." }));
  expect(getNotifications()).toEqual([]);
});
