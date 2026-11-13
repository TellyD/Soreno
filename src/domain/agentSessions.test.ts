import { expect, it } from "vitest";
import {
  agentEnvironmentKey,
  agentEnvironmentLabel,
  agentImagePasteSequence,
  agentProjectNameFromPath,
  agentProjectTargetKey,
  agentProviderLabel,
  agentSessionActivity,
  agentSessionDisplayName,
  agentSessionTitle,
  moveAgentItem,
  pinnedAgentItemsFirst,
  orderAgentItems,
  projectSectionIds,
  reconcileProjectSectionOrder,
  sameAgentMachine,
  sorenoNotices,
  type AgentEnvironment,
  visibleAgentPresets,
  type AgentSession,
} from "./agentSessions";
import { isNoteCollectionView, normalizeLibraryView } from "./library";

const sessions: AgentSession[] = ["a", "b", "c"].map((id) => ({
  id,
  projectId: "p",
  name: id,
  executable: "pi",
  args: [],
  createdAt: "",
}));
const projects = ["one", "two", "three"].map((id) => ({ id, name: id }));
it("derives project names from POSIX and Windows folders", () => {
  expect(agentProjectNameFromPath("/home/user/project/")).toBe("project");
  expect(agentProjectNameFromPath("C:\\Projects\\Soreno\\")).toBe("Soreno");
  expect(agentProjectNameFromPath("/")).toBe("");
});

it("reconciles saved order without duplicates, stale IDs or mutations", () => {
  const ordered = orderAgentItems(sessions, ["c", "missing", "c", "a"]);
  expect(ordered.map((session) => session.id)).toEqual(["c", "a", "b"]);
  expect(ordered[0]).toBe(sessions[2]);
  expect(sessions.map((session) => session.id)).toEqual(["a", "b", "c"]);
  expect(orderAgentItems(sessions)).toEqual(sessions);
  expect(orderAgentItems(projects, ["two", "gone"])).toEqual([
    projects[1],
    projects[0],
    projects[2],
  ]);
});
it("lists each group section once, at its first member, then empty groups", () => {
  const sectionProjects = ["a", "b", "c"].map((id) => ({
    id,
    name: id,
    path: `/${id}`,
    environment: { kind: "local" as const, distribution: null },
  }));
  const groups = [
    { id: "g", name: "G", projectIds: ["b", "c"], groupProjectId: null },
    { id: "h", name: "H", projectIds: [], groupProjectId: null },
  ];

  expect(projectSectionIds(sectionProjects, groups)).toEqual([
    "project:a",
    "group:g",
    "group:h",
  ]);
});

it("keeps the saved section order and inserts new sections beside their neighbours", () => {
  const current = ["group:g", "stale", "project:a", "group:g"];

  expect(
    reconcileProjectSectionOrder(current, [
      "project:a",
      "project:new",
      "group:g",
      "group:h",
    ]),
  ).toEqual(["group:g", "group:h", "project:a", "project:new"]);
  expect(
    reconcileProjectSectionOrder(["project:a"], ["project:first", "project:a"]),
  ).toEqual(["project:first", "project:a"]);
  expect(current).toEqual(["group:g", "stale", "project:a", "group:g"]);
});

it("moves sessions in either direction and bounds insertion indexes", () => {
  expect(moveAgentItem(sessions, "a", 1).map((s) => s.id)).toEqual([
    "b",
    "a",
    "c",
  ]);
  expect(moveAgentItem(sessions, "c", -10).map((s) => s.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
  expect(moveAgentItem(sessions, "a", 10).map((s) => s.id)).toEqual([
    "b",
    "c",
    "a",
  ]);
  expect(moveAgentItem(sessions, "b", 1)).toBe(sessions);
  expect(moveAgentItem(sessions, "missing", 1)).toBe(sessions);
  expect(moveAgentItem([], "a", 1)).toEqual([]);
  expect(moveAgentItem(projects, "three", 0)).toEqual([
    projects[2],
    projects[0],
    projects[1],
  ]);
  expect(sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);
});

it("moves pinned items first while keeping each group in its current order", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));
  expect(
    pinnedAgentItemsFirst(items, new Set(["d", "b", "gone"])).map(
      ({ id }) => id,
    ),
  ).toEqual(["b", "d", "a", "c"]);
});

it("identifies the provider independently of the session name or executable path", () => {
  expect(agentProviderLabel("/home/user/bin/pi")).toBe("Pi");
  expect(agentProviderLabel("C:\\Tools\\omp.ps1")).toBe("OMP");
  expect(agentProviderLabel("CLAUDE.EXE")).toBe("Claude Code");
  expect(agentProviderLabel("/opt/custom-agent")).toBe("custom-agent");
  expect(agentProviderLabel("")).toBe("Terminal");
});

it("selects Pi's platform image shortcut without changing other providers", () => {
  const local = { kind: "local" as const, distribution: null };
  const wsl = { kind: "wsl" as const, distribution: "Ubuntu" };
  const ssh = {
    kind: "ssh" as const,
    distribution: null,
    ssh: {
      host: "server",
      user: null,
      port: null,
      identityFile: null,
      hostKey: null,
    },
  };
  expect(agentImagePasteSequence("pi", local, "Win32")).toBe("\x1bv");
  expect(agentImagePasteSequence("C:\\Tools\\pi.cmd", local, "Windows")).toBe(
    "\x1bv",
  );
  expect(agentImagePasteSequence("pi", wsl, "Linux x86_64")).toBe("\x1bv");
  expect(agentImagePasteSequence("pi", ssh, "MacIntel")).toBe("\x16");
  expect(agentImagePasteSequence("pi", ssh, "Win32")).toBe("\x16");
  expect(agentImagePasteSequence("pi", local, "MacIntel")).toBe("\x16");
  expect(agentImagePasteSequence("pi", local, "Linux x86_64")).toBe("\x16");
  expect(agentImagePasteSequence("omp", local, "Win32")).toBe("\x16");
});

it("prefers the manual name, then the linked issue over Claude and Codex titles, then the launcher name", () => {
  const issue = { issueIdentifier: "TEL-1", issueTitle: "Fix login" };
  const name = (
    executable: string,
    automatic?: string,
    linked?: typeof issue,
    customName?: string,
  ) =>
    agentSessionDisplayName(
      { name: "Agent", customName, executable },
      automatic,
      linked,
    );
  expect(name("claude", "Auto", issue, "Manuel")).toBe("Manuel");
  expect(name("claude", "Auto")).toBe("Auto");
  expect(name("claude", "", undefined, "")).toBe("Agent");
  for (const executable of ["claude", "C:\\bin\\codex.cmd", "/bin/sh"])
    expect(name(executable, "Soreno file", issue)).toBe("TEL-1 · Fix login");
  // OMP retitles itself and a Pi name is chosen: the issue only replaces the launcher name.
  for (const executable of ["omp", "omp-conversation", "pi"]) {
    expect(name(executable, "Auto", issue)).toBe("Auto");
    expect(name(executable, "", issue)).toBe("TEL-1 · Fix login");
  }
  // A Linear link made before titles were kept.
  expect(name("codex", "Auto", { ...issue, issueTitle: "" })).toBe("TEL-1");
});

it("extracts changing Pi names without the title prefix, spinner or project folder", () => {
  expect(agentSessionTitle("π - soreno", "pi", "/projects/soreno")).toBe("");
  expect(
    agentSessionTitle("π - First - soreno", "pi", "/projects/soreno"),
  ).toBe("First");
  expect(
    agentSessionTitle("⠋ π - Fix - tests - soreno", "pi", "/projects/soreno"),
  ).toBe("Fix - tests");
  expect(
    agentSessionTitle(
      "π - Nouveau - soreno",
      "pi.exe",
      "C:\\Projects\\soreno\\",
    ),
  ).toBe("Nouveau");
  expect(agentSessionTitle(" New title\n", "custom", "/project")).toBe(
    "New title",
  );
  expect(
    agentSessionTitle("x".repeat(1000), "custom", "/project"),
  ).toHaveLength(512);
});

it("removes OMP activity markers without altering the session name", () => {
  for (const title of [
    "π > Fix notes",
    "π ⠋ Fix notes",
    "π ⠙ Fix notes",
    "π ! Fix notes",
    "π : Fix notes",
    "π: Fix notes",
  ]) {
    expect(agentSessionTitle(title, "omp", "/project")).toBe("Fix notes");
  }
  expect(agentSessionTitle("π >", "omp", "/project")).toBe("");
  expect(agentSessionTitle("π", "omp", "/project")).toBe("");
  expect(agentSessionTitle("π > New name", "omp", "/project")).toBe("New name");
  expect(agentSessionTitle("Extension title", "omp", "/project")).toBeNull();
});

it("removes Claude activity markers only from the title prefix", () => {
  for (const marker of ["✳", "◐", "◑"]) {
    expect(
      agentSessionTitle(
        `${marker} Stockage des sessions`,
        "claude",
        "/project",
      ),
    ).toBe("Stockage des sessions");
  }
  expect(agentSessionTitle("✳", "claude", "/project")).toBe("");
  expect(agentSessionTitle("Stockage ✳ sessions", "claude", "/project")).toBe(
    "Stockage ✳ sessions",
  );
  expect(agentSessionTitle("✳ Stockage", "custom", "/project")).toBe(
    "✳ Stockage",
  );
});

it("removes only Codex's automatic project suffix", () => {
  expect(
    agentSessionTitle("Envoyer | Soreno", "codex", "/projects/Soreno"),
  ).toBe("Envoyer");
  expect(
    agentSessionTitle("Envoyer | Soreno | Soreno", "codex", "/projects/Soreno"),
  ).toBe("Envoyer | Soreno");
  expect(
    agentSessionTitle("Envoyer | Other", "codex", "/projects/Soreno"),
  ).toBe("Envoyer | Other");
  expect(
    agentSessionTitle("Envoyer | Soreno", "custom", "/projects/Soreno"),
  ).toBe("Envoyer | Soreno");
});

it("removes Codex's project suffix when Codex truncates a long folder name", () => {
  const group = "/home/u/.soreno/groups/dbfde0c6-ba1f-4ab8-89ab-0123456789ab";
  expect(
    agentSessionTitle(
      "Répondre au salut | dbfde0c6-ba1f-4ab8-89...",
      "codex",
      group,
    ),
  ).toBe("Répondre au salut");
  expect(
    agentSessionTitle(
      "Répondre au salut | dbfde0c6-ffff-4ab8-89...",
      "codex",
      group,
    ),
  ).toBe("Répondre au salut | dbfde0c6-ffff-4ab8-89...");
  expect(
    agentSessionTitle("Envoyer | Sor...", "codex", "/projects/Soreno"),
  ).toBe("Envoyer | Sor...");
  expect(agentSessionTitle("Envoyer | d...", "codex", group)).toBe(
    "Envoyer | d...",
  );
  expect(
    agentSessionTitle(
      "Fix | Client | Projet très ...",
      "codex",
      "/projects/Client | Projet très long numero 42",
    ),
  ).toBe("Fix");
  expect(
    agentSessionTitle(
      "Envoyer | Documentation frontend | Documentation fronten...",
      "codex",
      "/projects/Documentation frontend | Documentation frontend serveur",
    ),
  ).toBe("Envoyer | Documentation frontend");
  const a = "👩‍💻".repeat(9);
  expect(
    agentSessionTitle(
      `Envoyer | Correctif | ${a} | ${a}...`,
      "codex",
      `/projects/${a} | ${a}abcdef`,
    ),
  ).toBe("Envoyer | Correctif");
});

it("ignores launcher titles instead of replacing a session name during startup", () => {
  for (const executable of ["pi", "omp", "codex", "claude"]) {
    expect(
      agentSessionTitle(
        "C:\\Windows\\system32\\wsl.exe",
        executable,
        "/project",
      ),
    ).toBeNull();
    expect(
      agentSessionTitle("wsl.exe -d Ubuntu", executable, "/project"),
    ).toBeNull();
    expect(agentSessionTitle("/bin/zsh", executable, "/project")).toBeNull();
    expect(agentSessionTitle("", executable, "/project")).toBe("");
  }
  expect(
    agentSessionTitle("user@host: ~/project", "omp", "/project"),
  ).toBeNull();
  expect(agentSessionTitle("π > C:\\docs", "omp", "/project")).toBe("C:\\docs");
});

it("reports agent activity only for running sessions, unknown when unreported", () => {
  const status = (
    state: "idle" | "running" | "exited",
    working?: boolean | null,
    awaiting?: boolean,
  ) =>
    agentSessionActivity({
      sessionId: "s",
      state,
      exitCode: null,
      working,
      awaiting,
    });
  expect(status("running", true)).toBe("working");
  expect(status("running", false)).toBe("waiting");
  expect(status("running", null)).toBe("running");
  expect(status("running")).toBe("running");
  expect(status("running", true, true)).toBe("awaiting");
  expect(status("exited", true, true)).toBe("stopped");
  expect(status("exited", true)).toBe("stopped");
  expect(status("idle")).toBe("stopped");
  expect(agentSessionActivity(undefined)).toBe("stopped");
});

it("keeps agent navigation independent of note types and vault contents", () => {
  expect(isNoteCollectionView("agents")).toBe(false);
  expect(normalizeLibraryView("agents", [])).toBe("agents");
});

it("distinguishes local, WSL and SSH execution environments", () => {
  expect(
    agentEnvironmentLabel(
      { kind: "wsl", distribution: "Ubuntu-24.04" },
      "Windows",
    ),
  ).toBe("WSL");
  expect(
    agentEnvironmentLabel({
      kind: "ssh",
      distribution: null,
      ssh: {
        host: "2001:db8::1",
        user: "dev",
        port: 2222,
        identityFile: null,
        hostKey: null,
      },
    }),
  ).toBe("SSH · dev@[2001:db8::1]:2222");
  expect(
    agentEnvironmentLabel({ kind: "local", distribution: null }, "macOS"),
  ).toBe("macOS");
});

it("hides chosen presets but never Terminal", () => {
  expect(
    visibleAgentPresets([
      "pi",
      "omp",
      "omp-conversation",
      "codex",
      "claude",
    ]).map(({ name }) => name),
  ).toEqual(["Terminal"]);
});

const sshEnvironment: AgentEnvironment = {
  kind: "ssh",
  distribution: null,
  ssh: {
    host: "server",
    user: "dev",
    port: 22,
    identityFile: "~/.ssh/id_ed25519",
    hostKey: "ssh-ed25519 AAAA",
  },
};

it.each<[string, AgentEnvironment, AgentEnvironment, boolean]>([
  [
    "local",
    { kind: "local", distribution: null },
    { kind: "local", distribution: null },
    true,
  ],
  [
    "WSL ASCII casing",
    { kind: "wsl", distribution: "Ubuntu" },
    { kind: "wsl", distribution: "uBUNTU" },
    true,
  ],
  [
    "SSH host",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, host: "other" } },
    false,
  ],
  [
    "SSH user",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, user: "ops" } },
    false,
  ],
  [
    "SSH port",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, port: 2222 } },
    false,
  ],
  [
    "SSH identity file",
    sshEnvironment,
    {
      ...sshEnvironment,
      ssh: { ...sshEnvironment.ssh!, identityFile: "~/.ssh/other" },
    },
    false,
  ],
  [
    "SSH host key",
    sshEnvironment,
    {
      ...sshEnvironment,
      ssh: { ...sshEnvironment.ssh!, hostKey: "ssh-ed25519 BBBB" },
    },
    false,
  ],
])("keys compare as expected for %s", (_name, left, right, equal) => {
  expect(agentEnvironmentKey(left) === agentEnvironmentKey(right)).toBe(equal);
});

it("identifies a project target by environment and path without trailing slashes", () => {
  expect(agentProjectTargetKey(sshEnvironment, "/srv/app//")).toBe(
    agentProjectTargetKey(sshEnvironment, "/srv/app"),
  );
  expect(agentProjectTargetKey(sshEnvironment, "/srv/app")).not.toBe(
    agentProjectTargetKey(sshEnvironment, "/srv/App"),
  );
  expect(agentProjectTargetKey(sshEnvironment, "/srv/app")).not.toBe(
    agentProjectTargetKey({ kind: "local", distribution: null }, "/srv/app"),
  );
});

it.each<[string, AgentEnvironment, AgentEnvironment, boolean]>([
  [
    "same SSH target with other key and host key",
    sshEnvironment,
    {
      ...sshEnvironment,
      ssh: {
        ...sshEnvironment.ssh!,
        identityFile: "~/.ssh/other",
        hostKey: "ssh-ed25519 BBBB",
      },
    },
    true,
  ],
  [
    "SSH host",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, host: "other" } },
    false,
  ],
  [
    "SSH user",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, user: "ops" } },
    false,
  ],
  [
    "SSH port",
    sshEnvironment,
    { ...sshEnvironment, ssh: { ...sshEnvironment.ssh!, port: 2222 } },
    false,
  ],
  [
    "SSH missing connection",
    { ...sshEnvironment, ssh: null },
    { ...sshEnvironment, ssh: null },
    false,
  ],
  [
    "WSL ASCII casing",
    { kind: "wsl", distribution: "Ubuntu" },
    { kind: "wsl", distribution: "uBUNTU" },
    true,
  ],
  [
    "WSL distribution",
    { kind: "wsl", distribution: "Ubuntu" },
    { kind: "wsl", distribution: "Debian" },
    false,
  ],
  [
    "kind",
    { kind: "local", distribution: null },
    { kind: "wsl", distribution: "Ubuntu" },
    false,
  ],
])(
  "machines compare as the backend does for %s",
  (_name, left, right, same) => {
    expect(sameAgentMachine(left, right)).toBe(same);
  },
);

it("splits a delivered batch into Soreno notices, keeping a description's own rules", () => {
  const linked =
    "Soreno: this session is now linked to issue SOR-1: Ship\n\nPart one\n\n---\n\nPart two";
  expect(
    sorenoNotices(`${linked}\n\n---\n\nSoreno: Kanban issue SOR-1 updated.`),
  ).toEqual([
    {
      summary: "Soreno: this session is now linked to issue SOR-1: Ship",
      details: "Part one\n\n---\n\nPart two",
    },
    { summary: "Soreno: Kanban issue SOR-1 updated.", details: "" },
  ]);
  expect(sorenoNotices("Soreno design request:\nA login screen")).toBeNull();
  expect(sorenoNotices("Fix Soreno: the build")).toBeNull();
});
