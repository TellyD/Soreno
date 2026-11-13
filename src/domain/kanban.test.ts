import { describe, expect, it } from "vitest";
import {
  allKanbanProjectsFilter,
  applyIssueUpdate,
  defaultCreateSource,
  droppedIssueStateId,
  filterIssuesByProject,
  filterIssuesBySource,
  groupIssuesByState,
  kanbanColumn,
  kanbanIssueInput,
  kanbanIssueProjects,
  kanbanPriorityName,
  noKanbanProjectFilter,
  replacedKanbanImages,
  transferDescription,
  transferLabelIds,
  visibleStates,
  type KanbanIssue,
  type KanbanIssueFields,
  type KanbanWorkflowState,
} from "./kanban";

function state(id: string, type: string): KanbanWorkflowState {
  return { id, name: id, type, color: "#888888", position: 0 };
}

function issue(id: string, stateId: string, updatedAt: string): KanbanIssue {
  return {
    source: "local",
    id,
    identifier: id.toUpperCase(),
    title: id,
    priority: 0,
    stateId,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt,
    project: null,
    labels: [],
    pullRequests: [],
  };
}

const states = [
  state("backlog", "backlog"),
  state("todo", "unstarted"),
  state("doing", "started"),
  state("done", "completed"),
  state("canceled", "canceled"),
  state("duplicate", "canceled"),
];

describe("visibleStates", () => {
  it("shows unstarted and started states on the active tab", () => {
    expect(visibleStates(states, "active").map(({ id }) => id)).toEqual([
      "todo",
      "doing",
    ]);
  });

  it("shows only backlog states on the backlog tab", () => {
    expect(visibleStates(states, "backlog").map(({ id }) => id)).toEqual([
      "backlog",
    ]);
  });

  it("keeps every state in the given order on the all tab", () => {
    const reordered = [states[4], states[0], states[2]];
    expect(visibleStates(reordered, "all")).toEqual(reordered);
  });
});

describe("groupIssuesByState", () => {
  it("creates a group per state, including empty ones", () => {
    const groups = groupIssuesByState([], states);

    expect([...groups.keys()]).toEqual(states.map(({ id }) => id));
    expect(groups.get("done")).toEqual([]);
  });

  it("ignores issues whose state is not on the board", () => {
    const groups = groupIssuesByState(
      [
        issue("a", "todo", "2026-08-02T10:00:00.000Z"),
        issue("ghost", "archived", "2026-08-02T10:00:00.000Z"),
      ],
      states,
    );

    expect([...groups.values()].flat().map(({ id }) => id)).toEqual(["a"]);
    expect(groups.has("archived")).toBe(false);
  });

  it("sorts every column by most recently updated", () => {
    const groups = groupIssuesByState(
      [
        issue("done-old", "done", "2026-08-02T10:00:00.000Z"),
        issue("done-new", "done", "2026-08-08T10:00:00.000Z"),
        issue("dup-old", "duplicate", "2026-08-01T10:00:00.000Z"),
        issue("dup-new", "duplicate", "2026-08-03T10:00:00.000Z"),
        issue("todo-old", "todo", "2026-08-01T10:00:00.000Z"),
        issue("todo-new", "todo", "2026-08-09T10:00:00.000Z"),
      ],
      states,
    );

    expect(groups.get("done")?.map(({ id }) => id)).toEqual([
      "done-new",
      "done-old",
    ]);
    expect(groups.get("duplicate")?.map(({ id }) => id)).toEqual([
      "dup-new",
      "dup-old",
    ]);
    expect(groups.get("todo")?.map(({ id }) => id)).toEqual([
      "todo-new",
      "todo-old",
    ]);
  });

  const sortable = [
    { ...issue("a", "todo", "2026-08-02T10:00:00.000Z"), priority: 2 },
    { ...issue("b", "todo", "2026-08-09T10:00:00.000Z"), priority: 0 },
    { ...issue("c", "todo", "2026-08-01T10:00:00.000Z"), priority: 1 },
    { ...issue("d", "todo", "2026-08-05T10:00:00.000Z"), priority: 2 },
  ].map((sorted, index) => ({
    ...sorted,
    createdAt: [
      "2026-07-05T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
      "2026-07-03T10:00:00.000Z",
      "2026-07-02T10:00:00.000Z",
    ][index],
  }));

  it.each([
    ["updated", false, ["b", "d", "a", "c"]],
    ["updated", true, ["c", "a", "d", "b"]],
    ["created", false, ["a", "c", "d", "b"]],
    ["created", true, ["b", "d", "c", "a"]],
    ["priority", false, ["c", "d", "a", "b"]],
    ["priority", true, ["a", "d", "c", "b"]],
  ] as const)(
    "sorts by %s (ascending: %s), issues without priority last",
    (field, ascending, expected) => {
      const groups = groupIssuesByState(sortable, states, [], {
        field,
        ascending,
      });

      expect(groups.get("todo")?.map(({ id }) => id)).toEqual(expected);
    },
  );
});

describe("Linear issues on the local columns", () => {
  const local = [
    { ...state("l-backlog", "backlog"), name: "Backlog" },
    { ...state("l-todo", "unstarted"), name: "Todo" },
    { ...state("l-progress", "started"), name: "In Progress" },
    { ...state("l-review", "started"), name: "In Review" },
    { ...state("l-done", "completed"), name: "Done" },
    { ...state("l-canceled", "canceled"), name: "Canceled" },
  ];
  const linearState = (
    id: string,
    type: string,
    name: string,
    position: number,
  ): KanbanWorkflowState => ({ id, name, type, color: "#888888", position });
  const linear = [
    linearState("triage", "triage", "Triage", 0),
    linearState("doing-late", "started", "Doing", 3),
    linearState("doing", "started", "In progress", 1),
    linearState("revue", "started", "En revue", 2),
    linearState("shipped", "completed", "Shipped", 4),
    linearState("odd", "mystery", "Odd", 5),
  ];
  const linearIssue = (id: string, stateId: string): KanbanIssue => ({
    ...issue(id, stateId, "2026-08-01T10:00:00.000Z"),
    source: "linear",
  });

  it.each([
    ["backlog", "Backlog", "backlog"],
    ["triage", "Triage", "todo"],
    ["unstarted", "Todo", "todo"],
    ["started", "In Review", "inReview"],
    ["started", "En REVUE", "inReview"],
    ["started", "Doing", "inProgress"],
    ["completed", "Done", "done"],
    ["canceled", "Duplicate", "canceled"],
    ["mystery", "Odd", "todo"],
  ])("puts a %s state named %s in the %s column", (type, name, column) => {
    expect(kanbanColumn({ type, name })).toBe(column);
  });

  it("groups Linear issues under the local column of their state", () => {
    const groups = groupIssuesByState(
      [
        linearIssue("a", "revue"),
        linearIssue("b", "odd"),
        linearIssue("c", "doing-late"),
        linearIssue("ghost", "unknown"),
        issue("local", "l-done", "2026-08-01T10:00:00.000Z"),
      ],
      local,
      linear,
    );

    expect(
      Object.fromEntries(
        [...groups].map(([id, issues]) => [id, issues.map(({ id }) => id)]),
      ),
    ).toEqual({
      "l-backlog": [],
      "l-todo": ["b"],
      "l-progress": ["c"],
      "l-review": ["a"],
      "l-done": ["local"],
      "l-canceled": [],
    });
  });

  it.each([
    ["the first Linear state by position", "l-progress", "doing"],
    ["nothing when no Linear state fits", "l-canceled", null],
    ["nothing when the card stays in its column", "l-review", null],
  ])("sends %s for a dropped Linear card", (_, target, expected) => {
    expect(
      droppedIssueStateId(linearIssue("a", "revue"), target, local, linear),
    ).toBe(expected);
  });

  it("sends the target column for a dropped local card", () => {
    const card = issue("a", "l-todo", "2026-08-01T10:00:00.000Z");
    expect(droppedIssueStateId(card, "l-done", local, linear)).toBe("l-done");
    expect(droppedIssueStateId(card, "l-todo", local, linear)).toBeNull();
  });

  it("keeps issues of the selected source", () => {
    const issues = [linearIssue("a", "doing"), issue("b", "l-todo", "")];
    const ids = (filter: "all" | "local" | "linear") =>
      filterIssuesBySource(issues, filter).map(({ id }) => id);
    expect([ids("all"), ids("local"), ids("linear")]).toEqual([
      ["a", "b"],
      ["b"],
      ["a"],
    ]);
  });

  it.each([
    ["local", "linear", true, "local"],
    ["linear", null, true, "linear"],
    ["linear", null, false, "local"],
    ["all", "linear", true, "linear"],
    ["all", null, true, "local"],
    ["all", "linear", false, "local"],
  ] as const)(
    "creates in %s view, remembered %s, Linear available %s, in %s",
    (filter, remembered, available, expected) => {
      expect(defaultCreateSource(filter, remembered, available)).toBe(expected);
    },
  );
});

describe("kanbanPriorityName", () => {
  it("maps priority numbers and falls back to none", () => {
    expect([0, 1, 2, 3, 4, 7].map(kanbanPriorityName)).toEqual([
      "none",
      "urgent",
      "high",
      "medium",
      "low",
      "none",
    ]);
  });
});

describe("applyIssueUpdate", () => {
  const board = {
    source: "local" as const,
    team: { id: "t1", key: "SOR", name: "Soreno" },
    states: [state("todo", "unstarted"), state("done", "completed")],
    labels: [],
    issues: [
      issue("a", "todo", "2026-08-01T10:00:00.000Z"),
      issue("b", "todo", "2026-08-02T10:00:00.000Z"),
    ],
  };

  it("updates only the changed issue and regroups it under its new state", () => {
    const next = applyIssueUpdate(board, {
      id: "a",
      title: "Renamed",
      stateId: "done",
      priority: 2,
      project: null,
      labels: [{ id: "l1", name: "Bug", color: "#ff0000" }],
      updatedAt: "2026-09-27T10:00:00.000Z",
    });

    const groups = groupIssuesByState(next.issues, next.states);
    expect(groups.get("todo")?.map(({ id }) => id)).toEqual(["b"]);
    expect(groups.get("done")?.[0]).toMatchObject({
      id: "a",
      title: "Renamed",
      priority: 2,
      labels: [{ id: "l1" }],
      updatedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(next.issues[1]).toBe(board.issues[1]);
    expect(board.issues[0]).toMatchObject({ stateId: "todo", priority: 0 });
  });
});

describe("kanbanIssueInput", () => {
  const bug = { id: "l-bug", name: "Bug", color: "#ff0000" };
  const ui = { id: "l-ui", name: "UI", color: "#00ff00" };
  const docs = { id: "l-docs", name: "Docs", color: "#0000ff" };
  const confirmed: KanbanIssueFields = {
    title: "Issue",
    stateId: "todo",
    priority: 1,
    project: { id: "p1", name: "Alpha" },
    labels: [bug, ui],
    assignee: { id: "u-ada", name: "Ada" },
  };

  it("clears the project and the assignee with null", () => {
    expect(
      kanbanIssueInput({ project: null, assignee: null }, confirmed),
    ).toEqual({ projectId: null, assigneeId: null });
  });

  it("omits fields equal to the confirmed ones", () => {
    expect(
      kanbanIssueInput(
        {
          title: "Renamed",
          stateId: "todo",
          priority: 1,
          project: { id: "p2", name: "Beta" },
          labels: [ui, bug],
        },
        confirmed,
      ),
    ).toEqual({ title: "Renamed", projectId: "p2" });
  });

  it("sends label additions and removals as an id diff", () => {
    expect(kanbanIssueInput({ labels: [ui, docs] }, confirmed)).toEqual({
      addedLabelIds: ["l-docs"],
      removedLabelIds: ["l-bug"],
    });
    expect(kanbanIssueInput({ labels: [ui] }, confirmed)).toEqual({
      removedLabelIds: ["l-bug"],
    });
  });

  it("returns an empty input when nothing differs", () => {
    expect(kanbanIssueInput({}, confirmed)).toEqual({});
    expect(kanbanIssueInput(confirmed, confirmed)).toEqual({});
  });
});

describe("project filter", () => {
  const alpha = { id: "p-alpha", name: "alpha" };
  const beta = { id: "p-beta", name: "Beta" };
  const issues = [
    { ...issue("a", "todo", "2026-08-01T10:00:00.000Z"), project: beta },
    issue("b", "todo", "2026-08-01T10:00:00.000Z"),
    { ...issue("c", "todo", "2026-08-01T10:00:00.000Z"), project: alpha },
    { ...issue("d", "done", "2026-08-01T10:00:00.000Z"), project: beta },
  ];
  const ids = (filtered: readonly KanbanIssue[]) =>
    filtered.map(({ id }) => id);

  it("lists each project once sorted by name ignoring case", () => {
    expect(kanbanIssueProjects(issues, new Map())).toEqual({
      hasIssueWithoutProject: true,
      projects: [alpha, beta],
    });
    expect(
      kanbanIssueProjects(
        issues.filter(({ project }) => project),
        new Map(),
      ).hasIssueWithoutProject,
    ).toBe(false);
  });

  it("lists a renamed project under its current name", () => {
    const renamed = { id: alpha.id, name: "Zeta" };
    expect(
      kanbanIssueProjects(issues, new Map([[alpha.id, renamed]])).projects,
    ).toEqual([beta, renamed]);
  });

  it("keeps every issue, one project's issues or issues without project", () => {
    expect(ids(filterIssuesByProject(issues, allKanbanProjectsFilter))).toEqual(
      ["a", "b", "c", "d"],
    );
    expect(ids(filterIssuesByProject(issues, beta.id))).toEqual(["a", "d"]);
    expect(ids(filterIssuesByProject(issues, noKanbanProjectFilter))).toEqual([
      "b",
    ]);
    expect(filterIssuesByProject(issues, "p-missing")).toEqual([]);
  });
});

describe("transfer to Linear", () => {
  const label = (id: string, name: string) => ({ id, name, color: "#888" });

  it.each([
    ["case-insensitive matches", [label("l1", "bug")], ["L-bug"]],
    ["nothing for unmatched labels", [label("l2", "Docs")], []],
    [
      "each Linear label once",
      [label("l1", "Bug"), label("l3", "BUG")],
      ["L-bug"],
    ],
  ])("keeps %s", (_, local, expected) => {
    const linear = [label("L-bug", "Bug"), label("L-ui", "UI")];
    expect(transferLabelIds(local, linear)).toEqual(expected);
  });

  it("leaves the description unchanged without comments", () => {
    expect(transferDescription("Body", [], "Comments", String)).toBe("Body");
    expect(transferDescription(null, [], "Comments", String)).toBe("");
  });

  it("appends comments oldest first after a separator", () => {
    const comments = [
      { id: "c2", body: "Second", createdAt: "2026-08-02T10:00:00.000Z" },
      { id: "c1", body: "First", createdAt: "2026-08-01T10:00:00.000Z" },
    ];
    expect(
      transferDescription("Body", comments, "Comments", (value) =>
        value.slice(0, 10),
      ),
    ).toBe(
      "Body\n\n---\n\nComments\n\n**2026-08-01**\n\nFirst\n\n**2026-08-02**\n\nSecond",
    );
  });
});

describe("replacedKanbanImages", () => {
  const local = (id: string) =>
    `asset://localhost/%2Fdata%2Fkanban-images%2F${id.repeat(32)}.png`;
  const upload = (id: string) => `https://uploads.linear.app/team/${id}/shot`;

  it("pairs each new Linear upload with the local image it replaced, in order", () => {
    const previous = `![a](${local("a")}) ![old](${upload("o")})\n![b](<${local("b")}>) ![a](${local("a")})`;
    const next = `![a](${upload("x")}) ![old](${upload("o")})\n![b](${upload("y")}) ![a](${upload("x")})`;
    expect(replacedKanbanImages(previous, next)).toEqual([
      [upload("x"), local("a")],
      [upload("y"), local("b")],
    ]);
  });

  it("pairs nothing when the uploads do not match the removed local images", () => {
    expect(
      replacedKanbanImages(
        `![a](${local("a")})`,
        `![a](${upload("x")}) ![b](${upload("y")})`,
      ),
    ).toBeNull();
  });
});
