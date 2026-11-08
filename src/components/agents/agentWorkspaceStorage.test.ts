// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import {
  collapsedProjectsKey,
  hideProjectsWithoutAgentsKey,
  projectGroupsKey,
  projectOrderKey,
  projectSectionOrderKey,
  readCollapsedProjects,
  readHideProjectsWithoutAgents,
  readLegacyProjectGroups,
  readProjectOrder,
  readProjectSectionOrder,
  readSelection,
  readServiceTrust,
  readServiceViews,
  readServicesPanelHeight,
  readTabOrder,
  readTerminalSplits,
  readTerminalTitles,
  selectionKey,
  serviceTrustKey,
  serviceViewsKey,
  servicesPanelHeightKey,
  tabOrderKey,
  terminalSplitsKey,
  terminalTitlesKey,
} from "./agentWorkspaceStorage";

const storageKeys = [
  selectionKey,
  terminalTitlesKey,
  tabOrderKey,
  terminalSplitsKey,
  projectOrderKey,
  projectSectionOrderKey,
  projectGroupsKey,
  collapsedProjectsKey,
  hideProjectsWithoutAgentsKey,
  serviceViewsKey,
  servicesPanelHeightKey,
  serviceTrustKey,
];

function expectFallbacks() {
  expect(readSelection()).toEqual({ projectId: null, sessionId: null });
  expect(readTerminalTitles()).toEqual({});
  expect(readTabOrder()).toEqual({});
  expect(readTerminalSplits()).toEqual({});
  expect(readProjectOrder()).toEqual([]);
  expect(readProjectSectionOrder()).toEqual([]);
  expect(readLegacyProjectGroups()).toEqual([]);
  expect(readCollapsedProjects()).toEqual(new Set());
  expect(readHideProjectsWithoutAgents()).toBe(false);
  expect(readServiceViews()).toEqual({});
  expect(readServicesPanelHeight()).toBeNull();
  expect(readServiceTrust()).toEqual(new Set());
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("falls back when stored JSON is invalid", () => {
  for (const key of storageKeys) localStorage.setItem(key, "{");
  expectFallbacks();
});

it("falls back when localStorage access is denied", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expectFallbacks();
});

it("validates and deduplicates stored IDs", () => {
  localStorage.setItem(
    projectOrderKey,
    JSON.stringify(["project", "project", "", "bad\n", "x".repeat(257), 1]),
  );
  localStorage.setItem(
    projectSectionOrderKey,
    JSON.stringify([
      "group:archive",
      "project:project",
      "group:archive",
      "bad\n",
      "x".repeat(257),
      1,
    ]),
  );
  localStorage.setItem(
    tabOrderKey,
    JSON.stringify({
      project: ["session", "session", "bad\n", "", 1],
      "bad\n": ["other"],
    }),
  );

  expect(readProjectOrder()).toEqual(["project"]);
  expect(readProjectSectionOrder()).toEqual([
    "group:archive",
    "project:project",
  ]);
  expect(readTabOrder()).toEqual({ project: ["session"] });
});

it("rejects split cycles and reused split IDs", () => {
  localStorage.setItem(
    terminalSplitsKey,
    JSON.stringify({
      parent: "child",
      child: "parent",
      self: "self",
      other: "child",
    }),
  );

  expect(readTerminalSplits()).toEqual({ parent: "child" });
});

it("keeps the first legacy project group assignment", () => {
  expect(readLegacyProjectGroups()).toBeNull();
  localStorage.setItem(
    projectGroupsKey,
    JSON.stringify([
      {
        id: "first",
        name: " First ",
        projectIds: ["p1", "p1", "p2"],
        collapsed: true,
      },
      { id: "second", name: "Second", projectIds: ["p2", "p3"] },
    ]),
  );

  expect(readLegacyProjectGroups()).toEqual([
    {
      id: "first",
      name: "First",
      projectIds: ["p1", "p2"],
      groupProjectId: null,
      collapsed: true,
    },
    {
      id: "second",
      name: "Second",
      projectIds: ["p3"],
      groupProjectId: null,
      collapsed: false,
    },
  ]);
});

it("reads service views as closed unless open, dropping invalid service IDs", () => {
  localStorage.setItem(
    serviceViewsKey,
    JSON.stringify({
      first: { open: true, serviceId: "bad\n" },
      second: { open: "yes", serviceId: "service" },
      legacy: { surface: "services", serviceId: "service" },
      invalid: ["service"],
    }),
  );

  expect(readServiceViews()).toEqual({
    first: { open: true },
    second: { open: false, serviceId: "service" },
    legacy: { open: false, serviceId: "service" },
  });
});

it("limits terminal titles to 1024 entries and 512 characters", () => {
  const titles = Object.fromEntries([
    ["maximum", "x".repeat(512)],
    ["too-long", "x".repeat(513)],
    ...Array.from({ length: 1024 }, (_, index) => [
      `session-${index}`,
      "title",
    ]),
  ]);
  localStorage.setItem(terminalTitlesKey, JSON.stringify(titles));

  const stored = readTerminalTitles();
  expect(Object.keys(stored)).toHaveLength(1024);
  expect(stored.maximum).toHaveLength(512);
  expect(stored["too-long"]).toBeUndefined();
  expect(stored["session-1022"]).toBe("title");
  expect(stored["session-1023"]).toBeUndefined();
});
