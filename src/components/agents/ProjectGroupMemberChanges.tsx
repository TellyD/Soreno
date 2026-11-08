import { ChevronRight, GitBranch, SquareArrowOutUpRight } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type { AgentProject } from "../../domain/agentSessions";
import { buildGitFileTree } from "../../domain/gitFileTree";
import type {
  GitChange,
  GitChangeOrder,
  GitGroup,
  GitRepository,
  GitSide,
} from "../../domain/projectGit";
import { IconButton } from "../ui/IconButton";
import {
  GitBulkChangeActions,
  GitChangeRow,
  GitFileTree,
} from "./GitChangeList";
import { useAgentStrings } from "./agentStrings";
import { useGitStrings } from "./gitStrings";

type MemberSelection = { projectId: string; path: string; side: GitSide };

type ProjectGroupMemberChangesProps = {
  member: AgentProject;
  read: { repo?: GitRepository; error?: string } | undefined;
  memberChanges: GitChange[];
  groups: GitGroup[];
  agents: number;
  tree: boolean;
  order: GitChangeOrder;
  selection: MemberSelection | null;
  isCollapsed: boolean;
  actionBlocked: boolean;
  restoreBlocked: boolean;
  setSelection: (selection: MemberSelection) => void;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  requestAction: (
    member: AgentProject,
    paths: string[],
    side: GitSide,
    version: string,
  ) => void;
  requestRestore: (
    member: AgentProject,
    paths: string[],
    version: string,
  ) => void;
  requestResolve: (
    member: AgentProject,
    paths: string[],
    version: string,
  ) => void;
  onSelectProject: (projectId: string) => void;
};

export function ProjectGroupMemberChanges({
  member,
  read,
  memberChanges,
  groups,
  agents,
  tree,
  order,
  selection,
  isCollapsed,
  actionBlocked,
  restoreBlocked,
  setSelection,
  setCollapsed,
  requestAction,
  requestRestore,
  requestResolve,
  onSelectProject,
}: ProjectGroupMemberChangesProps) {
  const s = useAgentStrings();
  const g = useGitStrings();
  const repo = read?.repo;
  const changes = read?.error ? [] : memberChanges;
  const [conflictChanges, unstagedChanges, stagedChanges] = (
    ["conflicts", "unstaged", "staged"] as const
  ).map((key) => groups.find((group) => group.key === key)?.changes ?? []);
  const untracked = unstagedChanges.filter(
    ({ file }) => file.worktreeStatus === "?",
  ).length;
  const status =
    read?.error ||
    s.groupChangeCounts({
      conflicts: conflictChanges.length,
      staged: stagedChanges.length,
      unstaged: unstagedChanges.length - untracked,
      untracked,
    });
  const listId = `project-group-files-${member.id}`;
  const version = repo?.availability === "ready" ? repo.version : "";
  const renderChange = (change: GitChange) => (
    <GitChangeRow
      key={`${change.file.path}:${change.side}`}
      change={change}
      tree={tree}
      selected={
        selection?.projectId === member.id &&
        selection.path === change.file.path &&
        selection.side === change.side
      }
      blocked={actionBlocked}
      restoreBlocked={restoreBlocked}
      snapshotVersion={version}
      ariaPrefix={member.name}
      showStatus={change.side === "staged"}
      onSelect={({ file, side }) =>
        setSelection({
          projectId: member.id,
          path: file.path,
          side,
        })
      }
      onAction={(paths, side, snapshotVersion) =>
        requestAction(member, paths, side, snapshotVersion)
      }
      onRestore={(paths, snapshotVersion) =>
        requestRestore(member, paths, snapshotVersion)
      }
      onResolve={(paths, snapshotVersion) =>
        requestResolve(member, paths, snapshotVersion)
      }
    />
  );
  return (
    <section
      className={`git-change-group project-group-member${tree ? " is-tree" : ""}`}
    >
      <header>
        <h3>
          <button
            className="git-change-group-toggle"
            type="button"
            aria-expanded={!isCollapsed && changes.length > 0}
            aria-controls={listId}
            disabled={!changes.length}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (!next.delete(member.id)) next.add(member.id);
                return next;
              })
            }
          >
            <ChevronRight size={12} aria-hidden="true" />
            <span>{member.name}</span>
            {changes.length ? <small>{changes.length}</small> : null}
          </button>
        </h3>
        <span className="git-change-group-actions is-visible">
          <GitBulkChangeActions
            changes={unstagedChanges}
            side="unstaged"
            snapshotVersion={version}
            blocked={actionBlocked}
            restoreBlocked={restoreBlocked}
            ariaPrefix={member.name}
            onAction={(paths, side, snapshotVersion) =>
              requestAction(member, paths, side, snapshotVersion)
            }
            onRestore={(paths, snapshotVersion) =>
              requestRestore(member, paths, snapshotVersion)
            }
          />
          <GitBulkChangeActions
            changes={stagedChanges}
            side="staged"
            snapshotVersion={version}
            blocked={actionBlocked}
            restoreBlocked={restoreBlocked}
            ariaPrefix={member.name}
            onAction={(paths, side, snapshotVersion) =>
              requestAction(member, paths, side, snapshotVersion)
            }
            onRestore={(paths, snapshotVersion) =>
              requestRestore(member, paths, snapshotVersion)
            }
          />
          <IconButton
            size="small"
            aria-label={s.openGroupMember(member.name)}
            title={s.openGroupMember(member.name)}
            onClick={() => onSelectProject(member.id)}
          >
            <SquareArrowOutUpRight />
          </IconButton>
        </span>
      </header>
      <p className="project-group-member-status">
        {repo?.availability === "ready" && !read?.error ? (
          <span className="project-group-member-ref">
            <span className="project-group-member-branch">
              <GitBranch size={12} aria-hidden="true" />
              <span>{repo.branch ?? repo.head?.slice(0, 8) ?? "—"}</span>
            </span>
            {repo.ahead || repo.behind ? (
              <span
                className="git-tracking-status"
                title={g.trackingStatus(repo.ahead, repo.behind)}
              >
                {[
                  repo.ahead ? `↑${repo.ahead}` : "",
                  repo.behind ? `↓${repo.behind}` : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </span>
            ) : null}
          </span>
        ) : null}
        {status ? <span>{status}</span> : null}
        {agents > 0 ? (
          <span className="project-group-member-agents">
            {s.groupActiveAgents(agents)}
          </span>
        ) : null}
      </p>
      <div
        id={listId}
        className="project-group-member-files"
        hidden={isCollapsed || !changes.length}
      >
        {tree ? (
          groups.map((group) => (
            <GitFileTree
              key={group.key}
              nodes={buildGitFileTree(
                group.changes.map(({ file }) => file.path),
                order,
              )}
              rows={
                new Map(
                  group.changes.map((change) => [
                    change.file.path,
                    renderChange(change),
                  ]),
                )
              }
            />
          ))
        ) : (
          <ul>{changes.map(renderChange)}</ul>
        )}
      </div>
    </section>
  );
}
