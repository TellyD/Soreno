import { vi } from "vitest";
import type { GitRepository } from "../../domain/projectGit";
import type { useProjectGit } from "../../hooks/useProjectGit";

type ProjectGitState = ReturnType<typeof useProjectGit>;

export function projectGitTestState(
  repo: GitRepository,
  overrides: Partial<ProjectGitState> = {},
): ProjectGitState {
  return {
    desktop: true,
    draft: { view: "changes", message: "", selection: null },
    updateDraft: vi.fn(),
    clearCommittedMessage: vi.fn(),
    repo,
    hasFreshStatus: true,
    branchRead: null,
    diff: null,
    stale: false,
    error: null,
    dismissError: vi.fn(),
    loading: false,
    revalidating: false,
    diffLoading: false,
    busy: false,
    isBusy: vi.fn(() => false),
    hasPendingMutation: vi.fn(() => false),
    autoRefreshPaused: false,
    prepareClose: vi.fn(() => true),
    cancelClose: vi.fn(),
    revision: 0,
    refresh: vi.fn(async () => {}),
    loadComparison: vi.fn(async () => {}),
    mutate: vi.fn(async (work: () => Promise<unknown>) =>
      work(),
    ) as ProjectGitState["mutate"],
    ...overrides,
  };
}
