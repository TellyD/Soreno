import { describe, expect, it } from "vitest";
import {
  currentBranchRequestFirst,
  mergeForgeRequests,
  type ForgeRequestSummary,
} from "./forge";

function request(
  number: number,
  sourceBranch: string,
  crossRepository = false,
): ForgeRequestSummary {
  return {
    number,
    title: `Request ${number}`,
    author: "ada",
    sourceBranch,
    targetBranch: "main",
    crossRepository,
    draft: false,
    state: "open",
    checks: null,
    review: null,
    conflicts: false,
    createdAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/o/r/pull/${number}`,
  };
}

describe("currentBranchRequestFirst", () => {
  it("moves the current branch request first, ignoring a fork with the same branch name", () => {
    const result = currentBranchRequestFirst(
      [request(3, "feature", true), request(2, "other"), request(1, "feature")],
      "feature",
    );
    expect(result.current).toBe(1);
    expect(result.requests.map((item) => item.number)).toEqual([1, 3, 2]);
  });

  it("keeps the order without a matching branch or on a detached HEAD", () => {
    const requests = [request(2, "a"), request(1, "b")];
    expect(currentBranchRequestFirst(requests, "c").current).toBeNull();
    expect(
      currentBranchRequestFirst(requests, null).requests.map(
        (item) => item.number,
      ),
    ).toEqual([2, 1]);
  });
});

describe("mergeForgeRequests", () => {
  it("lists every project's requests newest first, once per URL", () => {
    const at = (item: ForgeRequestSummary, createdAt: string) => ({
      ...item,
      createdAt,
    });
    const merged = mergeForgeRequests([
      {
        projectId: "api",
        requests: [
          at(request(9, "a"), "2026-03-01T00:00:00Z"),
          at(request(4, "b"), "2026-01-01T00:00:00Z"),
        ],
      },
      {
        projectId: "worktree",
        requests: [at(request(9, "a"), "2026-03-01T00:00:00Z")],
      },
      {
        projectId: "web",
        requests: [
          {
            ...request(9, "c"),
            url: "https://gitlab.com/o/web/-/merge_requests/9",
            createdAt: "2026-02-01T00:00:00Z",
          },
        ],
      },
    ]);
    expect(merged.map((item) => [item.projectId, item.number])).toEqual([
      ["api", 9],
      ["web", 9],
      ["api", 4],
    ]);
  });
});
