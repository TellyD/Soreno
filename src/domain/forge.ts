import type { GitFile } from "./projectGit";

export type ForgeKind = "github" | "gitlab";
export type ForgeMergeMethod = "merge" | "squash" | "rebase";
export type ForgeFilter = "open" | "mine" | "review" | "closed";
export type ForgeState = "open" | "closed" | "merged";
export type ForgeChecks = "success" | "failure" | "pending" | null;
export type ForgeReview =
  "approved" | "changesRequested" | "reviewRequired" | null;
export type ForgeMergeBlocker =
  | "draft"
  | "conflicts"
  | "checks"
  | "approvals"
  | "behind"
  | "unknown"
  | "blocked";

export type ForgeRemote = {
  kind: ForgeKind;
  host: string;
  path: string;
  remote: string;
  webUrl: string;
};

export type ForgeRequestSummary = {
  number: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  crossRepository: boolean;
  draft: boolean;
  state: ForgeState;
  checks: ForgeChecks;
  review: ForgeReview;
  conflicts: boolean;
  createdAt: string;
  url: string;
};

export type ForgeReviewer = {
  name: string;
  state: "requested" | "approved" | "changesRequested" | "commented";
};
export type ForgeLabel = { name: string; color: string | null };
export type ForgeCheck = {
  name: string;
  status: "success" | "failure" | "pending" | "skipped" | "neutral";
  url: string | null;
};
export type ForgeCommit = {
  oid: string;
  title: string;
  author: string;
  date: string;
};

export type ForgeRequestDetail = ForgeRequestSummary & {
  body: string;
  headOid: string;
  baseOid: string;
  reviewers: ForgeReviewer[];
  labels: ForgeLabel[];
  checkRuns: ForgeCheck[];
  commits: ForgeCommit[];
  mergeBlockers: ForgeMergeBlocker[];
  mergeMethods: ForgeMergeMethod[];
  deleteSourceBranch: boolean;
  changedFiles: number;
  /** `<host>/<path>` of the remote it was read from, sent back by its mutations. */
  repository: string;
};

export type ForgeChanges = { base: string; head: string; files: GitFile[] };
export type ForgeCheckout = { name: string; remote: boolean; oid: string };
export type ForgeUpdateAction = "close" | "reopen" | "ready";

/** Failures shown in place of the list: nothing useful can be listed until they are fixed. */
export const forgeStateErrors = [
  "noRemote",
  "unrecognizedRemote",
  "unsupportedForge",
  "cliMissing",
  "unauthenticated",
  "forbidden",
  "network",
  "rateLimited",
] as const;
export type ForgeStateError = (typeof forgeStateErrors)[number];

export function forgeErrorCode(reason: unknown): string | null {
  return reason &&
    typeof reason === "object" &&
    "code" in reason &&
    typeof reason.code === "string"
    ? reason.code
    : null;
}

export function forgeStateError(reason: unknown): ForgeStateError | null {
  const code = forgeErrorCode(reason);
  return forgeStateErrors.find((item) => item === code) ?? null;
}

/** The request of the checked-out branch comes first; a fork's branch only shares its name. */
export function currentBranchRequestFirst<T extends ForgeRequestSummary>(
  requests: readonly T[],
  branch: string | null,
): { requests: T[]; current: number | null } {
  const index = branch
    ? requests.findIndex(
        (request) =>
          request.sourceBranch === branch && !request.crossRepository,
      )
    : -1;
  if (index < 0) return { requests: [...requests], current: null };
  const current = requests[index];
  return {
    requests: [current, ...requests.filter((_, item) => item !== index)],
    current: current.number,
  };
}

export type ForgeListedRequest = ForgeRequestSummary & { projectId: string };

/** Requests of several projects, newest first; one listed by two projects sharing a remote keeps the first. */
export function mergeForgeRequests(
  lists: readonly {
    projectId: string;
    requests: readonly ForgeRequestSummary[];
  }[],
): ForgeListedRequest[] {
  const seen = new Set<string>();
  return lists
    .flatMap(({ projectId, requests }) =>
      requests.flatMap((request) => {
        if (seen.has(request.url)) return [];
        seen.add(request.url);
        return [{ ...request, projectId }];
      }),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function forgeLoginSession(kind: ForgeKind) {
  return kind === "github"
    ? {
        executable: "gh",
        args: ["auth", "login", "--hostname", "github.com"],
      }
    : {
        executable: "glab",
        args: ["auth", "login", "--hostname", "gitlab.com"],
      };
}
