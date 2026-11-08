// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import {
  runtime,
  container,
  gitPanelContainer,
  root,
  data,
  project,
  worktreeCacheKey,
  cacheWorktrees,
  session,
  render,
  requestKanban,
  button,
  click,
  dialog,
  field,
  input,
  action,
  addProject,
  projectNames,
  requestDesign,
  setStatus,
  tabNames,
  setGitPanelContainer,
  enableProjectServices,
  servicesToggle,
  toggleServices,
  type AgentProjectWorktreeGroup,
  type WorkspaceData,
} from "./AgentWorkspaceTestHarness";
import * as api from "../../data/agentSessionsApi";
import * as designApi from "../../data/designApi";
import { designProjectId } from "../../domain/agentSessions";
import { setInputValue } from "../ui/testInput";
import * as gitApi from "../../data/projectGitApi";
import { getNotifications } from "../../notifications";
import { deferred } from "../../testing/deferred";

vi.mock("../kanban/KanbanBoard", () => ({
  KanbanBoard: () => <div data-testid="kanban-board" />,
}));
vi.mock("../design/DesignCanvas", () => ({
  DesignCanvas: ({
    frames,
    busyFrameIds,
    onTargetChange,
  }: {
    frames: readonly { id: string; title: string }[];
    busyFrameIds?: ReadonlySet<string>;
    onTargetChange?: (target: { kind: "frame"; frameId: string }) => void;
  }) => (
    <div
      data-testid="design-canvas"
      data-busy={[...(busyFrameIds ?? [])].join(",")}
    >
      {frames.map((frame) => frame.title).join(", ")}
      {frames.map((frame) => (
        <button
          key={frame.id}
          type="button"
          aria-label={`select ${frame.id}`}
          onClick={() => onTargetChange?.({ kind: "frame", frameId: frame.id })}
        />
      ))}
    </div>
  ),
}));
vi.mock("../../hooks/useKanbanController", () => ({
  KanbanControllerProvider: ({ children }: { children: ReactNode }) => children,
  useKanbanControllerContext: () => null,
  useLastAgentPreset: () => [null, () => {}],
}));

it("shows projects while initial worktree grouping finishes", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await render();
  expect(projectNames()).toEqual(["Soreno", "Test workspace"]);
  expect(container.querySelector(".agent-project-list.is-loading")).toBeNull();
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () =>
    finish({ groups, complete: true, missingProjectIds: [] }),
  );
  await vi.waitFor(() => expect(projectNames()).toEqual(["Soreno"]));
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2);
  expect(
    container.querySelector(".agent-project-list")?.hasAttribute("aria-busy"),
  ).toBe(false);
});

it("selects an existing remote project instead of saving a duplicate", async () => {
  data.projects[0] = {
    ...project,
    environment: { kind: "wsl", distribution: "Ubuntu" },
  };
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: `${project.path}/`,
    suggestedName: project.name,
    environment: { kind: "wsl", distribution: "ubuntu" },
  });

  await render();
  await addProject("Ajouter un projet");
  await click("Choisir un dossier…", dialog());
  await click("Enregistrer", dialog());

  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(api.saveAgentProject).not.toHaveBeenCalled();
  expect(projectNames()).toEqual(["Soreno"]);
});

it("saves a distinct WSL project whose path ends with a backslash", async () => {
  data.projects[0] = {
    ...project,
    environment: { kind: "wsl", distribution: "Ubuntu" },
  };
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: `${project.path}\\`,
    suggestedName: project.name,
    environment: { kind: "wsl", distribution: "ubuntu" },
  });

  await render();
  await addProject("Ajouter un projet");
  await click("Choisir un dossier…", dialog());
  await click("Enregistrer", dialog());

  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(api.saveAgentProject).toHaveBeenCalledWith(
    expect.objectContaining({ path: `${project.path}\\` }),
  );
});

it("uses the live project branch for an expanded worktree row", async () => {
  vi.mocked(api.listAgentBranches).mockResolvedValue([
    { projectId: "p1", branch: "feature" },
  ]);
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });

  await render();

  await vi.waitFor(() =>
    expect(container.querySelector(".agent-worktree-name")?.textContent).toBe(
      "feature",
    ),
  );
});

it("keeps existing worktrees visible while refreshing after adding a project", async () => {
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
      ],
    },
  ];
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({ groups, complete: true, missingProjectIds: [] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  vi.mocked(api.pickAgentProjectDirectory).mockResolvedValue({
    path: "/projects/second",
    suggestedName: "second",
    environment: project.environment,
  });

  await render();
  await vi.waitFor(() => expect(button("main")).not.toBeNull());
  await addProject("Ajouter un projet");
  await input("Nom affiché", "Second project");
  await click("Choisir un dossier…", dialog());
  await click("Enregistrer", dialog());
  await vi.waitFor(() => expect(dialog()).toBeNull());

  expect(button("main")).not.toBeNull();
  expect(projectNames()).toEqual(["Soreno", "Second project"]);
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2);

  await act(async () =>
    finish({ groups, complete: true, missingProjectIds: [] }),
  );
});

it("creates a worktree directly from the project row", async () => {
  await render();

  await click("Créer un worktree · Soreno");
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(gitApi.readGitRepository).toHaveBeenCalledWith("p1");
  expect(field("Dossier parent").value).toBe("/projects");
  expect(field("Dossier du worktree").value).toBe("soreno-worktree");

  await input("Branche", "feature/sidebar");
  expect(field("Dossier du worktree").value).toBe("soreno-feature-sidebar");
  await click("Créer un worktree", dialog());

  expect(gitApi.createGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({
      name: "Soreno · feature/sidebar",
      parentPath: "/projects",
      folderName: "soreno-feature-sidebar",
      branch: "feature/sidebar",
      remote: false,
      createBranch: true,
      version: "v1",
    }),
  );
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(projectNames()).toContain("Soreno · feature/sidebar");
});

it("notifies structured Git errors in the quick worktree flow without raw details", async () => {
  vi.mocked(gitApi.readGitRepository).mockRejectedValueOnce({
    code: "readFailed",
    message: "Lecture Git impossible.",
  });

  await render();
  await click("Créer un worktree · Soreno");
  await vi.waitFor(() =>
    expect(getNotifications()).toContainEqual(
      expect.objectContaining({
        message: "L’opération a échoué. Réessayez.",
        tone: "error",
      }),
    ),
  );
  expect(container.textContent).not.toContain("Lecture Git impossible.");
  expect(container.textContent).not.toContain("[Git/readFailed]");

  await click("Créer un worktree · Soreno");
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  expect(getNotifications()).toEqual([]);
  await input("Branche", "feature/error");
  vi.mocked(gitApi.createGitWorktree).mockRejectedValueOnce({
    code: "createFailed",
    message: "Création Git impossible.",
  });
  await click("Créer un worktree", dialog());

  await vi.waitFor(() =>
    expect(getNotifications()).toContainEqual(
      expect.objectContaining({
        message: "L’opération a échoué. Réessayez.",
        tone: "error",
      }),
    ),
  );
  expect(dialog()).not.toBeNull();
  expect(dialog().textContent).not.toContain("Création Git impossible.");
  expect(getNotifications().some((item) => item.message.includes("Git/"))).toBe(
    false,
  );
});

it("does not open a delayed quick-worktree dialog after being hidden", async () => {
  const repository = await gitApi.readGitRepository("p1");
  vi.mocked(gitApi.readGitRepository).mockClear();
  let finish!: (value: typeof repository) => void;
  vi.mocked(gitApi.readGitRepository).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await render();
  await click("Créer un worktree · Soreno");
  await render(true);
  await act(async () => finish(repository));

  expect(dialog()).toBeNull();
  await render(false);
  expect(dialog()).toBeNull();
});

it("closes a created quick worktree after its mutation reload fails", async () => {
  await render();
  await click("Créer un worktree · Soreno");
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  await input("Branche", "feature/reload-failure");
  vi.mocked(api.loadAgentWorkspace).mockRejectedValueOnce(
    new Error("Reload failed"),
  );

  await click("Créer un worktree", dialog());

  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(gitApi.createGitWorktree).toHaveBeenCalledTimes(1);
  expect(projectNames()).toContain("Soreno · feature/reload-failure");
});

it("keeps a newly created worktree out of the project root while regrouping", async () => {
  const created = {
    ...project,
    id: "created-worktree",
    name: "Created worktree",
    path: "/worktrees/created",
  };
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
      ],
    },
  ];
  let finish!: (
    snapshot: Awaited<ReturnType<typeof api.listAgentWorktrees>>,
  ) => void;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({ groups, complete: true, missingProjectIds: [] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);

  await render(false, null, gitPanelContainer);
  await vi.waitFor(() => expect(button("main")).not.toBeNull());
  data.projects.push(created);
  await click("Signaler le worktree créé", gitPanelContainer);
  await vi.waitFor(() =>
    expect(api.listAgentWorktrees).toHaveBeenCalledTimes(2),
  );

  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2);
  expect(container.textContent).toContain("created");

  await act(async () =>
    finish({
      groups: [
        {
          ...groups[0],
          projectIds: ["p1", created.id],
          worktrees: [
            ...groups[0].worktrees,
            {
              path: created.path,
              head: "b".repeat(40),
              branch: "created",
              projectIds: [created.id],
            },
          ],
        },
      ],
      complete: true,
      missingProjectIds: [],
    }),
  );
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
});

it("does not erase a worktree cache before the initial workspace load completes", async () => {
  const cached = JSON.stringify({ scope: "cached", groups: [] });
  localStorage.setItem(worktreeCacheKey, cached);
  vi.mocked(api.loadAgentWorkspace).mockImplementationOnce(
    () => new Promise(() => {}),
  );

  await render();

  expect(localStorage.getItem(worktreeCacheKey)).toBe(cached);
});

it("shows a matching cached grouping while refreshing topology", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
  await act(async () => root.render(null));

  vi.mocked(api.listAgentWorktrees).mockImplementationOnce(
    () => new Promise(() => {}),
  );
  await render();
  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2);
  expect(container.querySelector(".agent-project-list.is-loading")).toBeNull();
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");
});

it("keeps cached groups when only the SSH connection state changed", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  cacheWorktrees({ ...data, disconnectedProjectIds: [] }, groups);
  data.disconnectedProjectIds = ["p2"];
  let fail!: (error: Error) => void;
  vi.mocked(api.listAgentWorktrees).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );

  await render();
  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.querySelector(".agent-project-list.is-loading")).toBeNull();
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2);
  expect(
    container.querySelector(".agent-project-list")?.getAttribute("aria-busy"),
  ).toBe("true");

  await act(async () => fail(new Error("offline")));
  await vi.waitFor(() => expect(projectNames()).toEqual(["Soreno"]));
  expect(
    container.querySelector(".agent-project-list")?.hasAttribute("aria-busy"),
  ).toBe(false);
});

it("reveals a cold incomplete grouping instead of spinning forever", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValueOnce({
    groups,
    complete: false,
    missingProjectIds: [],
  });

  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
  expect(projectNames()).toEqual(["Soreno"]);
  expect(
    container.querySelector('.agent-project-list [role="status"]'),
  ).toBeNull();
  expect(localStorage.getItem(worktreeCacheKey)).toBeNull();
});

it("retains matching cached groups after an incomplete refresh", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  cacheWorktrees(data, groups);
  vi.mocked(api.listAgentWorktrees).mockResolvedValueOnce({
    groups: [],
    complete: false,
    missingProjectIds: [],
  });

  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
  expect(projectNames()).toEqual(["Soreno"]);
  expect(
    container.querySelector('.agent-project-list [role="status"]'),
  ).toBeNull();
  expect(JSON.parse(localStorage.getItem(worktreeCacheKey)!).groups).toEqual(
    groups,
  );
});

it("replaces matching cached groups with a complete empty refresh", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const groups = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  cacheWorktrees(data, groups);
  vi.mocked(api.listAgentWorktrees).mockResolvedValueOnce({
    groups: [],
    complete: true,
    missingProjectIds: [],
  });

  await render();
  await vi.waitFor(() =>
    expect(projectNames()).toEqual(["Soreno", "Test workspace"]),
  );
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem(worktreeCacheKey)!).groups).toEqual(
    [],
  );
});

it("keeps a repository collapsed when a former child project was collapsed", async () => {
  const wslProject = {
    ...project,
    environment: { kind: "wsl" as const, distribution: "Ubuntu" },
  };
  const linked = {
    ...wslProject,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects = [wslProject, linked];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          {
            path: linked.path,
            head: "b".repeat(40),
            branch: "Test",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  localStorage.setItem(
    "soreno.agents.collapsed-projects.v1",
    JSON.stringify(["p2"]),
  );

  await render();
  await vi.waitFor(() =>
    expect(
      button("Déplier le projet · Soreno").getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  expect(container.querySelector(".agent-worktree-list")).toBeNull();
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("WSL");
  expect(
    button("Soreno").querySelector(".agent-project-details")?.textContent,
  ).toContain("main");
  await vi.waitFor(() =>
    expect(
      new Set(
        JSON.parse(
          localStorage.getItem("soreno.agents.collapsed-projects.v1")!,
        ),
      ),
    ).toEqual(new Set(["p1", "p2"])),
  );

  await click("Déplier le projet · Soreno");
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2);
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.collapsed-projects.v1")!),
  ).toEqual([]);
});

it("opens an external worktree once while backend group data stays stale", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Test agent",
  });
  data.statuses.push({ sessionId: "s3", state: "idle", exitCode: null });
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: "/projects/soreno",
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          {
            path: "/worktrees/test",
            head: "b".repeat(40),
            branch: "Test",
            projectIds: ["p2"],
          },
          {
            path: "/worktrees/review",
            head: "c".repeat(40),
            branch: "Review",
            projectIds: [],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });

  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(3),
  );
  expect(projectNames()).toEqual(["Soreno"]);
  expect(button("Test").closest(".agent-worktree")?.textContent).toContain(
    "Test agent",
  );

  await click("Review");
  await vi.waitFor(() => expect(api.saveAgentProject).toHaveBeenCalledTimes(1));
  expect(api.saveAgentProject).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Review",
      path: "/worktrees/review",
      environment: project.environment,
    }),
  );
  await vi.waitFor(() =>
    expect(
      container.querySelector(
        '.agent-project-select[aria-current="page"] .agent-project-name',
      )?.textContent,
    ).toBe("Review"),
  );

  await click("Review");
  expect(api.saveAgentProject).toHaveBeenCalledTimes(1);
});

it("keeps an opened external worktree under its repository before the next topology read", async () => {
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: [
        {
          repositoryProjectId: "p1",
          projectIds: ["p1"],
          worktrees: [
            {
              path: project.path,
              head: "a".repeat(40),
              branch: "main",
              projectIds: ["p1"],
            },
            {
              path: "/worktrees/nightly",
              head: "b".repeat(40),
              branch: "nuit/2026-09-28",
              projectIds: [],
            },
          ],
        },
      ],
      complete: true,
      missingProjectIds: [],
    })
    .mockImplementation(() => new Promise(() => {}));
  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Worktree externe · Ouvrir"),
  );

  await click("nuit/2026-09-28");
  await vi.waitFor(() =>
    expect(
      container.querySelector('.agent-worktree-select[aria-current="page"]')
        ?.textContent,
    ).toBe("nuit/2026-09-28"),
  );

  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.textContent).not.toContain("Worktree externe · Ouvrir");
});

it("removes a worktree immediately without reloading the rail during navigation", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Test workspace",
    path: "/worktrees/test",
  };
  data.projects.push(linked);
  const oldGroups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "Test",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  cacheWorktrees(data, oldGroups);
  type WorktreeSnapshot = Awaited<ReturnType<typeof api.listAgentWorktrees>>;
  const finishNew = deferred<WorktreeSnapshot>();
  let finishReload!: (workspace: WorkspaceData) => void;
  vi.mocked(api.listAgentWorktrees)
    .mockResolvedValueOnce({
      groups: oldGroups,
      complete: true,
      missingProjectIds: [],
    })
    .mockImplementationOnce(() => finishNew.promise);
  vi.mocked(api.loadAgentWorkspace)
    .mockResolvedValueOnce(structuredClone(data))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = resolve;
        }),
    );

  await render();
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
  let showedLoading = false;
  const observer = new MutationObserver(() => {
    if (container.textContent?.includes("Chargement des projets…"))
      showedLoading = true;
  });
  observer.observe(container, { childList: true, subtree: true });

  await action("Test", "Supprimer le worktree");
  expect(dialog().textContent).toContain(
    "les commits non fusionnés seront supprimés",
  );
  await click("Supprimer le worktree", dialog());
  await vi.waitFor(() =>
    expect(api.loadAgentWorkspace).toHaveBeenCalledTimes(2),
  );
  await act(async () => finishReload(structuredClone(data)));
  await vi.waitFor(() =>
    expect(api.listAgentWorktrees).toHaveBeenCalledTimes(3),
  );
  await act(async () =>
    finishNew.resolve({ groups: [], complete: false, missingProjectIds: [] }),
  );
  observer.disconnect();

  expect(showedLoading).toBe(false);
  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.textContent).not.toContain("Test workspace");
  expect(gitApi.removeGitWorktree).toHaveBeenCalledWith(
    "p1",
    oldGroups[0].worktrees[1],
  );
  const reads = vi.mocked(api.listAgentWorktrees).mock.calls.length;
  await click("Soreno");
  expect(api.listAgentWorktrees).toHaveBeenCalledTimes(reads);
});

it("deletes an external worktree without registering it first", async () => {
  let groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: "/worktrees/review",
          head: "b".repeat(40),
          branch: "review",
          projectIds: [],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => ({
    groups: structuredClone(groups),
    complete: true,
    missingProjectIds: [],
  }));
  vi.mocked(gitApi.removeGitWorktree).mockImplementationOnce(async () => {
    groups = [{ ...groups[0], worktrees: groups[0].worktrees.slice(0, 1) }];
    return { oid: null, message: "Worktree supprimé.", warning: null };
  });

  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("review"));
  await action("review", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(container.textContent).not.toContain("Worktree externe · Ouvrir"),
  );
  expect(gitApi.removeGitWorktree).toHaveBeenCalledWith(
    "p1",
    expect.objectContaining({
      path: "/worktrees/review",
      head: "b".repeat(40),
      branch: "review",
    }),
  );
  expect(api.saveAgentProject).not.toHaveBeenCalled();
});

it("notifies a dirty-worktree GitError in the active locale and keeps the confirmation open", async () => {
  const groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: "/worktrees/dirty",
          head: "b".repeat(40),
          branch: "dirty",
          projectIds: [],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups,
    complete: true,
    missingProjectIds: [],
  });
  vi.mocked(gitApi.removeGitWorktree).mockRejectedValueOnce({
    code: "dirty",
    message:
      "Git refuse de supprimer ce worktree car il contient des changements locaux.",
  });

  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("dirty"));
  await action("dirty", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(getNotifications()).toContainEqual(
      expect.objectContaining({
        message:
          "La copie de travail doit être propre avant cette opération Git.",
        tone: "error",
      }),
    ),
  );
  expect(dialog()).not.toBeNull();
  expect(dialog().textContent).not.toContain("changements locaux");
  expect(container.textContent).toContain("dirty");
});

it("closes and forgets a removed worktree while surfacing a branch warning", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Warning",
    path: "/worktrees/warning",
  };
  data.projects.push(linked);
  let groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: linked.path,
          head: "b".repeat(40),
          branch: "warning",
          projectIds: ["p2"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => ({
    groups: structuredClone(groups),
    complete: true,
    missingProjectIds: [],
  }));
  vi.mocked(gitApi.removeGitWorktree).mockImplementationOnce(async () => {
    data.projects = data.projects.filter((item) => item.id !== "p2");
    groups = [
      {
        ...groups[0],
        projectIds: ["p1"],
        worktrees: groups[0].worktrees.slice(0, 1),
      },
    ];
    return {
      oid: null,
      message: "Worktree supprimé.",
      warning: "La branche warning subsiste.",
    };
  });

  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("warning"));
  await action("warning", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(
      document.querySelector('[role="dialog"], [role="alertdialog"]'),
    ).toBeNull(),
  );
  expect(projectNames()).toEqual(["Soreno"]);
  expect(container.querySelectorAll(".agent-worktree")).toHaveLength(1);
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      message: "La branche warning subsiste.",
      tone: "warning",
    }),
  ]);
});

it("stops the worktree sessions, then merges its current commit from the project menu", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects.push(linked);
  data.sessions.push({ ...session, id: "s3", projectId: "p2", name: "Agent" });
  data.statuses.push({ sessionId: "s3", state: "running", exitCode: null });
  const worktree = {
    path: linked.path,
    head: "b".repeat(40),
    branch: "feature",
    projectIds: ["p2"],
  };
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          worktree,
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  // A commit made after the rail's last topology poll, e.g. a resolved conflict.
  const committed = {
    path: linked.path,
    head: "c".repeat(40),
    branch: "feature",
  };
  vi.mocked(gitApi.readGitWorktrees).mockResolvedValue([
    { path: project.path, head: "a".repeat(40), branch: "main" },
    committed,
  ]);
  vi.mocked(gitApi.mergeGitWorktree).mockResolvedValueOnce({
    oid: null,
    message: "Worktree fusionné et supprimé.",
    warning: null,
  });

  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));
  await action("feature", "Fusionner dans main et supprimer");
  expect(dialog().textContent).toContain(
    "La session active de ce worktree sera d’abord arrêtée.",
  );
  await click("Arrêter les sessions et fusionner", dialog());

  await vi.waitFor(() => expect(gitApi.mergeGitWorktree).toHaveBeenCalled());
  expect(api.stopAgentSession).toHaveBeenCalledExactlyOnceWith("s3");
  expect(
    vi.mocked(api.stopAgentSession).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(gitApi.readGitWorktrees).mock.invocationCallOrder[0],
  );
  expect(gitApi.mergeGitWorktree).toHaveBeenCalledWith("p1", committed, "main");
});

it("hands a worktree merge conflict to the worktree's agent from the error notification", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects.push(linked);
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Agent",
    executable: "codex",
  });
  data.statuses.push({ sessionId: "s3", state: "exited", exitCode: 0 });
  const worktree = {
    path: linked.path,
    head: "b".repeat(40),
    branch: "feature",
    projectIds: ["p2"],
  };
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          worktree,
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  vi.mocked(gitApi.mergeGitWorktree).mockRejectedValueOnce({
    code: "mergeConflict",
    message: "conflits",
  });
  vi.mocked(api.startAgentSession).mockRejectedValueOnce(
    new Error("préparation SSH impossible"),
  );
  const resolveAction = () =>
    vi.waitFor(() => {
      const notification = getNotifications().find(
        ({ action }) => action?.label === "Résoudre avec un agent",
      );
      expect(notification).toBeDefined();
      return notification!;
    });

  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("feature"));
  await action("feature", "Fusionner dans main et supprimer");
  await click("Fusionner dans main et supprimer", dialog());
  const conflict = await resolveAction();
  expect(container.textContent).toContain("feature");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();

  await act(async () => conflict.action!.onAction());

  const failed = await resolveAction();
  const [failedId] = vi.mocked(api.startAgentSession).mock.calls[0];
  expect(api.deleteAgentSession).toHaveBeenCalledWith(failedId);
  expect(data.sessions.some(({ id }) => id === failedId)).toBe(false);

  await act(async () => failed.action!.onAction());

  await vi.waitFor(() =>
    expect(api.startAgentSession).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
      undefined,
      expect.stringMatching(/feature[\s\S]*main/),
      [],
      null,
      [],
      [],
    ),
  );
  const [sessionId] = vi.mocked(api.startAgentSession).mock.calls[1];
  expect(sessionId).not.toBe(failedId);
  expect(api.saveAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      id: sessionId,
      projectId: "p2",
      executable: "codex",
      name: "Conflits · Codex",
    }),
  );
  expect(
    getNotifications().some(
      ({ action }) => action?.label === "Résoudre avec un agent",
    ),
  ).toBe(false);
});

it("forgets a worktree only in its repository group", async () => {
  const first = {
    ...project,
    id: "p2",
    name: "First target",
    path: "/shared/path",
  };
  const secondRepository = {
    ...project,
    id: "p3",
    name: "Other repository",
    path: "/projects/other",
  };
  const second = {
    ...project,
    id: "p4",
    name: "Second target",
    path: "/shared/path",
  };
  data.projects.push(first, secondRepository, second);
  let groups: AgentProjectWorktreeGroup[] = [
    {
      repositoryProjectId: "p1",
      projectIds: ["p1", "p2"],
      worktrees: [
        {
          path: project.path,
          head: "a".repeat(40),
          branch: "main",
          projectIds: ["p1"],
        },
        {
          path: "/shared/path",
          head: "b".repeat(40),
          branch: "first-target",
          projectIds: ["p2"],
        },
      ],
    },
    {
      repositoryProjectId: "p3",
      projectIds: ["p3", "p4"],
      worktrees: [
        {
          path: secondRepository.path,
          head: "c".repeat(40),
          branch: "main",
          projectIds: ["p3"],
        },
        {
          path: "/shared/path",
          head: "d".repeat(40),
          branch: "second-target",
          projectIds: ["p4"],
        },
      ],
    },
  ];
  vi.mocked(api.listAgentWorktrees).mockImplementation(async () => ({
    groups: structuredClone(groups),
    complete: true,
    missingProjectIds: [],
  }));
  vi.mocked(gitApi.removeGitWorktree).mockImplementationOnce(async () => {
    data.projects = data.projects.filter((item) => item.id !== "p2");
    groups = [
      {
        ...groups[0],
        projectIds: ["p1"],
        worktrees: groups[0].worktrees.slice(0, 1),
      },
      groups[1],
    ];
    return { oid: null, message: "Worktree supprimé.", warning: null };
  });

  await render();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("second-target"),
  );
  await action("first-target", "Supprimer le worktree");
  await click("Supprimer le worktree", dialog());

  await vi.waitFor(() =>
    expect(container.textContent).not.toContain("first-target"),
  );
  expect(container.textContent).toContain("second-target");
});

it("uses the backend worktree association across WSL distribution casing for a Git-panel external callback", async () => {
  const repository = {
    ...project,
    environment: { kind: "wsl" as const, distribution: "Ubuntu-24.04" },
  };
  const linked = {
    ...repository,
    id: "p2",
    name: "Feature",
    path: "/symlink/feature",
    environment: { kind: "wsl" as const, distribution: "ubuntu-24.04" },
  };
  data.projects = [repository, linked];
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: "/projects/soreno",
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          {
            path: "/actual/feature",
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);

  await render(false, null, gitPanelContainer);
  await vi.waitFor(() =>
    expect(container.querySelectorAll(".agent-worktree")).toHaveLength(2),
  );
  await click("Ouvrir le worktree Git", gitPanelContainer);

  expect(api.saveAgentProject).not.toHaveBeenCalled();
  expect(gitPanelContainer.textContent).toContain("Feature");
  expect(button("feature").getAttribute("aria-current")).toBe("page");
});

it("expands the repository parent when selecting a child worktree session", async () => {
  const linked = {
    ...project,
    id: "p2",
    name: "Feature",
    path: "/worktrees/feature",
  };
  data.projects.push(linked);
  data.sessions.push({
    ...session,
    id: "s3",
    projectId: "p2",
    name: "Feature agent",
  });
  data.statuses.push({ sessionId: "s3", state: "running", exitCode: null });
  vi.mocked(api.listAgentWorktrees).mockResolvedValue({
    groups: [
      {
        repositoryProjectId: "p1",
        projectIds: ["p1", "p2"],
        worktrees: [
          {
            path: project.path,
            head: "a".repeat(40),
            branch: "main",
            projectIds: ["p1"],
          },
          {
            path: linked.path,
            head: "b".repeat(40),
            branch: "feature",
            projectIds: ["p2"],
          },
        ],
      },
    ],
    complete: true,
    missingProjectIds: [],
  });
  localStorage.setItem(
    "soreno.agents.selection.v1",
    JSON.stringify({ projectId: "p2", sessionId: "s3" }),
  );
  localStorage.setItem(
    "soreno.agents.collapsed-projects.v1",
    JSON.stringify(["p1"]),
  );

  await render();
  await vi.waitFor(() =>
    expect(
      button("Déplier le projet · Soreno").getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  await click("Feature agent");

  expect(
    button("Replier le projet · Soreno").getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    JSON.parse(localStorage.getItem("soreno.agents.collapsed-projects.v1")!),
  ).toEqual([]);
});

it("shows the Kanban board on request while keeping terminals mounted", async () => {
  setGitPanelContainer(document.createElement("div"));
  document.body.append(gitPanelContainer);
  await render(false, null, gitPanelContainer);
  const terminal = container.querySelector<HTMLElement>(
    '[data-terminal="s1"]',
  )!;
  const gitPanel =
    gitPanelContainer.querySelector<HTMLElement>(".agent-git-panel")!;
  expect(gitPanel.hidden).toBe(false);
  const board = () =>
    container.querySelector<HTMLElement>('[data-testid="kanban-board"]');
  const boardPane = () => board()!.closest<HTMLElement>(".agent-kanban")!;
  runtime.projectNavigationPrepare.mockResolvedValueOnce(false);

  await requestKanban(true);
  expect(board()).toBeNull();
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");

  await requestKanban(true);
  const openedBoard = board();
  expect(openedBoard).not.toBeNull();
  expect(boardPane().hidden).toBe(false);
  expect(
    container.querySelector('.agent-rail [aria-current="page"]'),
  ).toBeNull();
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(terminal.closest<HTMLElement>(".agent-terminal-stack")!.hidden).toBe(
    true,
  );
  expect(gitPanelContainer.querySelector(".agent-git-panel")).toBe(gitPanel);
  expect(gitPanel.hidden).toBe(true);
  expect(localStorage.getItem("soreno.agents.kanban.v1")).toBe("true");

  await click("Soreno");
  expect(board()).toBe(openedBoard);
  expect(boardPane().hidden).toBe(true);
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(container.querySelector('[data-terminal="s1"]')).toBe(terminal);
  expect(terminal.hidden).toBe(false);
  expect(gitPanelContainer.querySelector(".agent-git-panel")).toBe(gitPanel);
  expect(gitPanel.hidden).toBe(false);
  expect(localStorage.getItem("soreno.agents.kanban.v1")).toBe("false");
  expect(runtime.unmounts).not.toHaveBeenCalled();

  await requestKanban(true);
  expect(board()).toBe(openedBoard);
  expect(boardPane().hidden).toBe(false);

  await requestKanban(false);
  expect(boardPane().hidden).toBe(true);
  expect(button("Soreno").getAttribute("aria-current")).toBe("page");
  expect(terminal.hidden).toBe(false);
  expect(localStorage.getItem("soreno.agents.kanban.v1")).toBe("false");
});

it("mounts the Kanban board at startup only when Kanban was left open", async () => {
  localStorage.setItem("soreno.agents.kanban.v1", "true");
  await render();
  const board = container.querySelector<HTMLElement>(
    '[data-testid="kanban-board"]',
  );
  expect(board).not.toBeNull();
  expect(board!.closest<HTMLElement>(".agent-kanban")!.hidden).toBe(false);
});

it("keeps the service terminal mounted while the Kanban board is open", async () => {
  enableProjectServices();
  await render();
  await toggleServices();
  const serviceTerminal = container.querySelector<HTMLElement>(
    '[data-terminal="service-api"]',
  )!;
  const surface = serviceTerminal.closest<HTMLElement>(".agent-services-dock")!;
  expect(serviceTerminal.hidden).toBe(false);

  await requestKanban(true);
  expect(
    container.querySelector('[data-testid="kanban-board"]'),
  ).not.toBeNull();
  expect(container.querySelector('[data-terminal="service-api"]')).toBe(
    serviceTerminal,
  );
  expect(serviceTerminal.hidden).toBe(true);
  expect(surface.hidden).toBe(true);
  expect(servicesToggle).toThrow();

  await click("Soreno");
  const board = container.querySelector<HTMLElement>(
    '[data-testid="kanban-board"]',
  )!;
  expect(board.closest<HTMLElement>(".agent-kanban")!.hidden).toBe(true);
  expect(servicesToggle().getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[data-terminal="service-api"]')).toBe(
    serviceTerminal,
  );
  expect(serviceTerminal.hidden).toBe(false);
  expect(surface.hidden).toBe(false);
  expect(runtime.unmounts).not.toHaveBeenCalledWith("service-api");
});

it("opens a Design board whose hidden session stays out of the agents space and receives the prompt", async () => {
  data.projects.push({
    id: designProjectId,
    name: "Design",
    path: "/home/me/.soreno/design",
    environment: { kind: "local", distribution: null },
  });
  data.sessions.push({
    ...session,
    id: "design-1",
    name: "Accueil",
    executable: "claude",
    design: true,
  });
  data.statuses.push({
    sessionId: "design-1",
    state: "running",
    exitCode: null,
  });
  vi.mocked(designApi.loadDesignBoards).mockResolvedValue([
    {
      id: "board-1",
      name: "Accueil",
      projectId: project.id,
      sessionId: "design-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    id: "m1",
    sessionId: "design-1",
    body: "",
    status: "queued",
    error: null,
    createdAt: "",
    deliveredAt: null,
  });
  await render();

  expect(projectNames()).not.toContain("Design");
  expect(tabNames()).not.toContain("Accueil");

  await requestDesign();
  const prompt = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="design.placeholder"]',
  )!;
  await act(async () => setInputValue(prompt, "Un écran de connexion"));
  await act(async () => {
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });

  expect(api.sendAgentSessionMessage).toHaveBeenCalledExactlyOnceWith(
    "design-1",
    expect.any(String),
    expect.stringContaining("Un écran de connexion"),
  );
  expect(api.startAgentSession).not.toHaveBeenCalled();
  expect(tabNames()).not.toContain("Accueil");
});

function designBoardSetup() {
  data.sessions.push({
    ...session,
    id: "design-1",
    name: "Accueil",
    executable: "claude",
    design: true,
  });
  data.statuses.push({
    sessionId: "design-1",
    state: "running",
    exitCode: null,
  });
  vi.mocked(designApi.loadDesignBoards).mockResolvedValue([
    {
      id: "board-1",
      name: "Accueil",
      projectId: project.id,
      sessionId: "design-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  vi.mocked(designApi.loadDesignFrames).mockResolvedValue([
    {
      boardId: "board-1",
      id: "home",
      title: "Home",
      html: "<html></html>",
      x: 0,
      y: 0,
      width: 1440,
      height: 900,
      z: 1,
      updatedAt: "",
    },
  ]);
}

it("marks a frame busy after a prompt targets it, with the agent's work in the prompt bar, until the frame is rewritten or the agent stops", async () => {
  vi.useFakeTimers();
  designBoardSetup();
  data.statuses = data.statuses.map((item) =>
    item.sessionId === "design-1" ? { ...item, working: true } : item,
  );
  let framesChanged: (boardId: string) => void = () => {};
  vi.mocked(designApi.listenDesignFramesChanged).mockImplementation(
    async (onChange) => {
      framesChanged = onChange;
      return () => {};
    },
  );
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    id: "m1",
    sessionId: "design-1",
    body: "",
    status: "delivered",
    error: null,
    createdAt: "",
    deliveredAt: "",
  });
  await render();
  await requestDesign();
  await click("select home");
  const prompt = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="design.placeholder"]',
  )!;
  const send = async (text: string) => {
    await act(async () => setInputValue(prompt, text));
    await act(async () => {
      prompt.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  };
  const rewrite = async (updatedAt: string) => {
    const [home] = await vi.mocked(designApi.loadDesignFrames)("board-1");
    vi.mocked(designApi.loadDesignFrames).mockResolvedValue([
      { ...home, updatedAt },
    ]);
    await act(async () => framesChanged("board-1"));
  };
  await send("Plus sombre");
  const canvas = () =>
    container.querySelector<HTMLElement>('[data-testid="design-canvas"]')!;

  expect(canvas().dataset.busy).toBe("home");
  expect(container.querySelector(".design-prompt-status")?.textContent).toBe(
    "design.drawing",
  );

  await rewrite("2026-01-02T00:00:00Z");

  expect(canvas().dataset.busy).toBe("");

  // A prompt still queued keeps its mark through a rewrite by the earlier turn.
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    id: "m2",
    sessionId: "design-1",
    body: "",
    status: "queued",
    error: null,
    createdAt: "",
    deliveredAt: null,
  });
  await send("Plus clair");
  expect(canvas().dataset.busy).toBe("home");
  await rewrite("2026-01-03T00:00:00Z");
  expect(canvas().dataset.busy).toBe("home");

  // A read prompt clears when the agent stops, even if no poll saw it work.
  data.statuses = data.statuses.map((item) =>
    item.sessionId === "design-1" ? { ...item, working: false } : item,
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    id: "m3",
    sessionId: "design-1",
    body: "",
    status: "delivered",
    error: null,
    createdAt: "",
    deliveredAt: "",
  });
  await send("Bordure");
  expect(canvas().dataset.busy).toBe("home");
  setStatus("design-1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(canvas().dataset.busy).toBe("");
});

it("keeps a frame marked through the earlier turn's end, until the agent works on the prompt and stops", async () => {
  vi.useFakeTimers();
  designBoardSetup();
  const working = async (value: boolean, awaiting = false) => {
    data.statuses = data.statuses.map((item) =>
      item.sessionId === "design-1"
        ? { ...item, working: value, awaiting }
        : item,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  };
  data.statuses = data.statuses.map((item) =>
    item.sessionId === "design-1" ? { ...item, working: true } : item,
  );
  let messagesChanged: (sessionId: string) => void = () => {};
  vi.mocked(api.listenAgentSessionMessages).mockImplementation(
    async (onChange) => {
      messagesChanged = onChange;
      return () => {};
    },
  );
  const message = {
    id: "m1",
    sessionId: "design-1",
    body: "",
    status: "queued" as const,
    error: null,
    createdAt: "",
    deliveredAt: null,
  };
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue(message);
  await render();
  await requestDesign();
  await click("select home");
  const prompt = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="design.placeholder"]',
  )!;
  await act(async () => setInputValue(prompt, "Plus sombre"));
  await act(async () => {
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  const busy = () =>
    container.querySelector<HTMLElement>('[data-testid="design-canvas"]')!
      .dataset.busy;

  // Read while the status still shows the earlier turn at work.
  vi.mocked(api.listAgentSessionMessages).mockResolvedValue([
    { ...message, status: "delivered", deliveredAt: "" },
  ]);
  await act(async () => messagesChanged("design-1"));
  await working(false);
  expect(busy()).toBe("home");

  await working(true);
  expect(busy()).toBe("home");
  await working(false);
  expect(busy()).toBe("");

  // A turn blocked on a question, then interrupted without a rewrite, clears it too.
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    ...message,
    id: "m-await",
    status: "delivered",
    deliveredAt: "",
  });
  await act(async () => setInputValue(prompt, "Bordure"));
  await act(async () => {
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await working(true, true);
  expect(busy()).toBe("home");
  await working(false);
  expect(busy()).toBe("");

  // An exit polled while the prompt was queued clears it once read.
  vi.mocked(api.sendAgentSessionMessage).mockResolvedValue({
    ...message,
    id: "m2",
  });
  await act(async () => setInputValue(prompt, "Plus clair"));
  await act(async () => {
    prompt.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(busy()).toBe("home");
  setStatus("design-1", "exited");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(busy()).toBe("home");
  vi.mocked(api.listAgentSessionMessages).mockResolvedValue([
    { ...message, id: "m2", status: "delivered", deliveredAt: "" },
  ]);
  await act(async () => messagesChanged("design-1"));
  expect(busy()).toBe("");
});

it("hands a Design board to a coding agent: saved, linked, started with the frames attached", async () => {
  designBoardSetup();
  vi.mocked(api.saveAgentSession).mockImplementation(async (saved) => {
    data.sessions.push(saved);
  });
  vi.mocked(designApi.linkDesignSession).mockResolvedValue();
  await render();
  await requestDesign();

  await click("design.implement.button");
  const [worktree] =
    dialog().querySelectorAll<HTMLElement>('[role="checkbox"]');
  await act(async () => worktree.click());
  await act(async () =>
    setInputValue(
      dialog().querySelector("textarea")!,
      "  Seulement l'écran Notes, garder le thème.  ",
    ),
  );
  await click("design.implement.start");

  const saved = vi.mocked(api.saveAgentSession).mock.calls[0][0];
  expect(saved.projectId).toBe(project.id);
  expect(saved.design).toBeFalsy();
  expect(designApi.linkDesignSession).toHaveBeenCalledExactlyOnceWith(
    saved.id,
    "board-1",
  );
  const start = vi
    .mocked(api.startAgentSession)
    .mock.calls.find(([id]) => id === saved.id)!;
  expect(start[3]).toContain("Design board “Accueil”");
  expect(start[3]).toContain("instructions.md");
  expect(start[8]).toEqual({
    boardId: "board-1",
    frameIds: ["home"],
    instructions: "Seulement l'écran Notes, garder le thème.",
  });
});

it("links a session to a Design board from its side panel, sends it the board and previews it", async () => {
  designBoardSetup();
  vi.mocked(designApi.linkDesignSession).mockImplementation(async () => {
    data.designBoardSessions = [
      { boardId: "board-1", sessionId: "s1", linkedAt: "" },
    ];
  });
  vi.mocked(designApi.sendDesignToSession).mockResolvedValue({
    id: "m1",
    sessionId: "s1",
    body: "",
    status: "queued",
    error: null,
    createdAt: "",
    deliveredAt: null,
  });
  const gitPanel = document.createElement("div");
  setGitPanelContainer(gitPanel);
  document.body.append(gitPanel);
  await render(false, null, gitPanel);
  await click("Pi notes");

  await click("Lier un design");
  const choice = [
    ...gitPanel.querySelectorAll<HTMLButtonElement>(
      ".design-session-panel button",
    ),
  ].find((item) => item.textContent?.startsWith("Accueil"))!;
  await act(async () => choice.click());

  expect(designApi.linkDesignSession).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "board-1",
  );
  expect(designApi.sendDesignToSession).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "board-1",
    null,
    false,
  );
  await vi.waitFor(() =>
    expect(
      gitPanel.querySelector('[data-testid="design-canvas"]')?.textContent,
    ).toBe("Home"),
  );
});

it("creates a Design board in the session's project from its side panel and links the session", async () => {
  designBoardSetup();
  vi.mocked(designApi.createDesignBoard).mockResolvedValue({
    id: "board-2",
    name: "Tableau de bord",
    projectId: project.id,
    sessionId: "design-2",
    createdAt: "",
    updatedAt: "",
  });
  vi.mocked(designApi.linkDesignSession).mockResolvedValue();
  const gitPanel = document.createElement("div");
  setGitPanelContainer(gitPanel);
  document.body.append(gitPanel);
  await render(false, null, gitPanel);
  await click("Pi notes");
  await click("Lier un design");

  await click("design.panel.create");
  const name = dialog().querySelector<HTMLInputElement>("input")!;
  await act(async () => setInputValue(name, "Tableau de bord"));
  await click("design.create");

  expect(designApi.createDesignBoard).toHaveBeenCalledExactlyOnceWith(
    "Tableau de bord",
    project.id,
    expect.any(String),
  );
  expect(designApi.linkDesignSession).toHaveBeenCalledExactlyOnceWith(
    "s1",
    "board-2",
  );
  expect(designApi.sendDesignToSession).not.toHaveBeenCalled();
});
