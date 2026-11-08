import { describe, expect, it } from "vitest";
import { currentBranchRequestFirst, type ForgeRequestSummary } from "./forge";

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
