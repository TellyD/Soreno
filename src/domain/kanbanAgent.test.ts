import { describe, expect, it } from "vitest";
import type {
  AgentSession,
  AgentSessionKanbanIssue,
  AgentSessionStatus,
} from "./agentSessions";
import {
  kanbanAgentComment,
  kanbanCommentRequest,
  kanbanCommentTargets,
  kanbanIssueAgents,
  kanbanIssueLaunch,
  signAgentSummary,
  withoutIssueSummaryTags,
} from "./kanbanAgent";

const kanbanIssuePrompt = (issue: Parameters<typeof kanbanIssueLaunch>[0]) =>
  kanbanIssueLaunch(issue).prompt;

const issue = {
  identifier: "TEL-1",
  title: "  Fix login  ",
  description: "\n\n- step one\n- step two\n\n",
};
const head = "Issue TEL-1: Fix login";
const tail = kanbanIssuePrompt({ ...issue, description: null }).slice(
  head.length,
);
const SUMMARY = tail.slice(2);

it("names the issue, gives the trimmed description, then asks for a summary", () => {
  expect(kanbanIssuePrompt(issue)).toBe(
    ["Issue TEL-1: Fix login", "", "- step one\n- step two", "", SUMMARY].join(
      "\n",
    ),
  );
});

it("omits a missing or blank description", () => {
  expect(tail).toMatch(/^\n\n.*<soreno-summary>/);
  expect(kanbanIssuePrompt({ ...issue, description: " \n\t" })).toBe(
    `${head}${tail}`,
  );
});

it("never starts with an option or file-reference character", () => {
  for (const title of ["-rf /", "@file"])
    expect(kanbanIssuePrompt({ ...issue, identifier: "-X", title })).toMatch(
      /^Issue /,
    );
});

const LIMIT = 1000;
// Truncation attaches issue.md, so the backend appends an attachment note.
const TRUNCATED_LIMIT = LIMIT - 450 - 16;
// Derived from a truncated prompt so the wording stays free to change.
const MARKER = kanbanIssuePrompt({
  ...issue,
  description: "T".repeat(LIMIT),
}).slice(`${head}\n\n`.length, -tail.length);
const cost = (text: string) =>
  [...text].reduce((total, char) => {
    if (char === '"' || char === "\\") return total + 3;
    if ("\n\r\t".includes(char)) return total + 2;
    if (char < " ") return total + 6;
    return total + new TextEncoder().encode(char).length;
  }, 0);

it("keeps a whole prompt at exactly the launch budget intact", () => {
  const room = LIMIT - cost(`${head}\n\n${tail}`);
  const description = "a".repeat(room % 2) + "é".repeat(Math.floor(room / 2));
  const prompt = kanbanIssuePrompt({ ...issue, description });
  expect(prompt).toBe(`${head}\n\n${description}${tail}`);
  expect(cost(prompt)).toBe(LIMIT);
  expect(
    kanbanIssuePrompt({ ...issue, description: `${description}a` }),
  ).toContain(MARKER);
});

it("leaves an oversized description out of the prompt and attaches the whole issue", () => {
  for (const description of ["T".repeat(LIMIT), '"'.repeat(LIMIT)]) {
    const launch = kanbanIssueLaunch({ ...issue, description });
    expect(MARKER).toContain("issue.md");
    expect(launch.prompt).not.toContain(description.slice(0, 20));
    expect(launch).toEqual({
      prompt: `${head}\n\n${MARKER}${tail}`,
      imageNames: [],
      imageUrls: [],
      imageTargets: [],
      issueFile: `${head}\n\n${description}\n`,
    });
    expect(cost(launch.prompt)).toBeLessThanOrEqual(TRUNCATED_LIMIT);
  }
});

it("shortens a title too long for the budget, keeping the identifier", () => {
  const room = TRUNCATED_LIMIT - cost(`Issue TEL-1: …\n\n${MARKER}${tail}`);
  for (const description of [null, " "])
    expect(
      kanbanIssuePrompt({ ...issue, title: "T".repeat(3000), description }),
    ).toBe(`Issue TEL-1: ${"T".repeat(room)}…\n\n${MARKER}${tail}`);

  const prompt = kanbanIssuePrompt({
    ...issue,
    title: "😀".repeat(1500),
    description: "Steps to reproduce",
  });
  expect(prompt.startsWith("Issue TEL-1: 😀")).toBe(true);
  expect(prompt.endsWith(`😀…\n\n${MARKER}${tail}`)).toBe(true);
  expect(cost(prompt)).toBeLessThanOrEqual(TRUNCATED_LIMIT);
  expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

const imageName = (id: string) => `${id.repeat(32)}.png`;
// `convertFileSrc` URLs: `asset://localhost/…` on Linux and macOS, `http://asset.localhost/…` on Windows.
const upload = (id: string) =>
  `asset://localhost/${encodeURIComponent(`/home/me/.local/share/soreno/kanban-images/${imageName(id)}`)}`;
const windowsUpload = (id: string) =>
  `http://asset.localhost/${encodeURIComponent(`C:\\Users\\me\\AppData\\Soreno\\kanban-images\\${imageName(id)}`)}`;

it("replaces Kanban image links with numbered placeholders and returns their names in order", () => {
  const note = `asset://localhost/${encodeURIComponent(`/home/me/notes/${imageName("c")}`)}`;
  const description = [
    `Before ![shot \\[1\\].png](<${upload("a")}>)`,
    `![b](${windowsUpload("b")} "title") and again ![a](${upload("a")})`,
    `![note](${note}) ![ext](https://example.com/x.png)`,
  ].join("\n");

  expect(kanbanIssueLaunch({ ...issue, description })).toEqual({
    prompt: [
      head,
      "",
      "Before ![shot \\[1\\].png](image-1)",
      '![b](image-2 "title") and again ![a](image-1)',
      `![note](${note}) ![ext](https://example.com/x.png)`,
      "",
      SUMMARY,
    ].join("\n"),
    imageNames: [imageName("a"), imageName("b")],
    imageUrls: [],
    imageTargets: [upload("a"), windowsUpload("b")],
    issueFile: null,
  });
});

it("numbers Linear upload images after the Kanban ones and returns their URLs", () => {
  const linear = (id: string) => `https://uploads.linear.app/team/${id}/shot`;
  const description = [
    `![l](<${linear("x")}>) ![a](${upload("a")})`,
    `![again](${linear("x")}) ![y](${linear("y")} "title")`,
  ].join("\n");

  expect(kanbanIssueLaunch({ ...issue, description })).toEqual({
    prompt: [
      head,
      "",
      "![l](image-2) ![a](image-1)",
      '![again](image-2) ![y](image-3 "title")',
      "",
      SUMMARY,
    ].join("\n"),
    imageNames: [imageName("a")],
    imageUrls: [linear("x"), linear("y")],
    imageTargets: [upload("a"), linear("x"), linear("y")],
    issueFile: null,
  });
});

it("keeps image links beyond the image limit as they are", () => {
  const ids = ["1", "2", "3", "4", "5"];
  const linear = "https://uploads.linear.app/team/z/shot";
  const description = [
    ...ids.map((id) => `![${id}](${upload(id)})`),
    `![6](${linear})`,
    `![7](${upload("7")})`,
    `![8](${linear}2)`,
  ].join("\n");
  const launch = kanbanIssueLaunch({
    ...issue,
    identifier: "TEAM-1234",
    description,
  });

  expect(launch.imageNames).toEqual([...ids, "7"].map(imageName));
  expect(launch.imageUrls).toEqual([]);
  expect(launch.imageTargets).toEqual([...ids, "7"].map(upload));
  // Six images leave too little room, so the description lands whole in issue.md.
  expect(launch.prompt).toMatch(/^Issue TEAM-1234: Fix login\n\n/);
  expect(cost(launch.prompt)).toBeLessThanOrEqual(LIMIT - 450 - 7 * 16);
  expect(launch.issueFile).toContain("![7](image-6)");
  expect(launch.issueFile).toContain(`![6](${linear})`);
  expect(launch.issueFile).toContain(`![8](${linear}2)`);
});

it("attaches every image along with the whole issue when the description is cut", () => {
  const rest = `${"z".repeat(LIMIT)}![y](image-2)`;
  const launch = kanbanIssueLaunch({
    ...issue,
    description: `![x](${upload("a")})${"z".repeat(LIMIT)}![y](${upload("b")})`,
  });

  expect(launch).toEqual({
    prompt: `${head}\n\n${MARKER}${tail}`,
    imageNames: [imageName("a"), imageName("b")],
    imageUrls: [],
    imageTargets: [upload("a"), upload("b")],
    issueFile: `${head}\n\n![x](image-1)${rest}\n`,
  });
});

it("shortens the title to keep the truncation marker and attaches it whole", () => {
  const title = "界".repeat(255);
  const launch = kanbanIssueLaunch({
    ...issue,
    title,
    description: "é".repeat(LIMIT),
  });
  expect(launch.prompt).toMatch(/^Issue TEL-1: 界+…\n/);
  expect(launch.prompt.endsWith(`\n\n${MARKER}${tail}`)).toBe(true);
  expect(cost(launch.prompt)).toBeLessThanOrEqual(TRUNCATED_LIMIT);
  expect(launch.issueFile).toBe(
    `Issue TEL-1: ${title}\n\n${"é".repeat(LIMIT)}\n`,
  );
});

it("attaches a title cut without a description", () => {
  const title = "😀".repeat(255);
  for (const description of [null, " \n\t"]) {
    const launch = kanbanIssueLaunch({ ...issue, title, description });
    expect(launch.prompt).toMatch(/^Issue TEL-1: 😀+…\n\n/u);
    expect(launch.prompt.endsWith(`\n\n${MARKER}${tail}`)).toBe(true);
    expect(cost(launch.prompt)).toBeLessThanOrEqual(TRUNCATED_LIMIT);
    expect(launch.issueFile).toBe(`Issue TEL-1: ${title}\n`);
  }
});

describe("kanbanCommentRequest", () => {
  const issue = { identifier: "ACM-1", title: "Fix vault lock" };

  it("leads with the issue, then quotes the whole comment", () => {
    const text = kanbanCommentRequest(
      issue,
      { body: " Peux-tu couvrir WSL ?\nEt ajouter un test. " },
      true,
    );
    expect(text.split("\n")[0]).toBe(
      "Soreno: comment on ACM-1: Peux-tu couvrir WSL ?",
    );
    expect(text).toContain(
      "Issue ACM-1: Fix vault lock\n\nComment:\nPeux-tu couvrir WSL ?\nEt ajouter un test.\n",
    );
    expect(text.endsWith(`\n${SUMMARY}`)).toBe(true);
  });

  it("asks for a summary only from the issue's own session", () => {
    const text = kanbanCommentRequest(issue, { body: "Merci" }, false);
    expect(text).not.toContain("<soreno-summary>");
  });
});

describe("kanbanCommentTargets", () => {
  const session = (
    id: string,
    patch: Partial<AgentSession> = {},
  ): AgentSession => ({
    id,
    projectId: "web",
    name: id,
    executable: "claude",
    args: [],
    createdAt: "2026-09-27T10:00:00.000Z",
    ...patch,
  });
  const running = (sessionId: string): AgentSessionStatus => ({
    sessionId,
    state: "running",
    exitCode: null,
  });
  const linkedAgent = (
    linked: AgentSession,
    statuses: AgentSessionStatus[],
    terminalTitles: Record<string, string> = {},
  ) => {
    const link: AgentSessionKanbanIssue = {
      source: "local",
      issueId: "issue",
      issueIdentifier: "ACM-1",
      sessionId: linked.id,
      sessionName: linked.name,
      executable: linked.executable,
      projectName: "Web",
      startedAt: "2026-09-27T10:00:00.000Z",
      endedAt: null,
      endReason: null,
      mergedInto: null,
    };
    return kanbanIssueAgents(
      [link],
      [linked],
      statuses,
      new Set(),
      terminalTitles,
    ).live.get("issue");
  };

  it("names the linked agent as its tab: custom name, then conversation name, then terminal title", () => {
    const linked = session("linked");
    const titles = { linked: "Fix login" };
    const status = {
      ...running("linked"),
      conversation: {
        provider: "omp" as const,
        sessionId: "c1",
        sessionFile: null,
        name: "Finish the steps",
      },
    };
    expect(linkedAgent(linked, [running("linked")], titles)?.name).toBe(
      "Fix login",
    );
    expect(linkedAgent(linked, [status], titles)?.name).toBe(
      "Finish the steps",
    );
    expect(
      linkedAgent({ ...linked, customName: "Renamed" }, [status], titles)?.name,
    ).toBe("Renamed");
  });

  it("sends only to the issue's running session, else to its project's running agents", () => {
    const linked = session("linked", {
      projectId: "other",
      customName: "Renamed",
    });
    const targets = kanbanCommentTargets(
      linkedAgent(linked, [running("linked")]),
      "web",
      [
        session("pi", { executable: "pi" }),
        session("shell", { executable: "" }),
        session("stopped"),
        session("service", { kind: "service" }),
        session("elsewhere", { projectId: "api" }),
        linked,
      ],
      ["linked", "pi", "shell", "service", "elsewhere"].map(running),
      {},
    );
    expect(targets).toEqual([
      {
        sessionId: "linked",
        name: "Renamed",
        executable: "claude",
        linkedToIssue: true,
      },
    ]);
    expect(
      kanbanCommentTargets(
        linkedAgent(linked, []),
        "web",
        [
          session("pi", { executable: "pi" }),
          session("shell", { executable: "" }),
          session("stopped"),
          session("service", { kind: "service" }),
          session("elsewhere", { projectId: "api" }),
          linked,
        ],
        ["pi", "shell", "service", "elsewhere"].map(running),
        { pi: "Fix login" },
      ),
    ).toEqual([
      {
        sessionId: "pi",
        name: "Fix login",
        executable: "pi",
        linkedToIssue: false,
      },
    ]);
  });

  it("offers no stopped linked session and nothing without a project", () => {
    expect(
      kanbanCommentTargets(
        linkedAgent(session("linked"), []),
        undefined,
        [session("pi")],
        [running("pi")],
        {},
      ),
    ).toEqual([]);
  });
});

describe("agent summary signature", () => {
  it("names the agent from its launcher and strips the signature back", () => {
    const signed = signAgentSummary("Fixed it.\n\n", "C:\\bin\\omp.ps1");
    expect(signed).toBe("Fixed it.\n\n— OMP via Soreno");
    expect(kanbanAgentComment(signed)).toEqual({
      name: "OMP",
      executable: "omp",
      body: "Fixed it.",
    });
  });

  it("labels comments the backend signs with an executable name", () => {
    expect(kanbanAgentComment("Rewrote it.\n\n— claude via Soreno")).toEqual({
      name: "Claude Code",
      executable: "claude",
      body: "Rewrote it.",
    });
    expect(
      kanbanAgentComment("Rewrote it.\n\n— omp-conversation via Soreno")?.name,
    ).toBe("Chat (OMP)");
  });

  it("survives whitespace normalization but ignores a mid-body mention", () => {
    expect(kanbanAgentComment("Done.\n— Pi via Soreno\n")?.name).toBe("Pi");
    expect(kanbanAgentComment("See\n— Pi via Soreno\nfor details")).toBeNull();
    expect(kanbanAgentComment("Posted — Pi via Soreno")).toBeNull();
  });
});

it("unwraps only the summary block that ends the agent's message", () => {
  expect(
    withoutIssueSummaryTags(
      "Done.<soreno-summary>draft</soreno-summary> Then:\n<soreno-summary>\n  Fixed it.\n</soreno-summary>\n",
    ),
  ).toBe("Done.<soreno-summary>draft</soreno-summary> Then:\n\n\nFixed it.");
  for (const kept of [
    "I will end with `<soreno-summary>…</soreno-summary>` once done.",
    "<soreno-summary> </soreno-summary>",
    "Done.</soreno-summary>",
  ]) {
    expect(withoutIssueSummaryTags(kept)).toBe(kept);
  }
});
