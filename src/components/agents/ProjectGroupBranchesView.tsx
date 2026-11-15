import {
  ChevronRight,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/projectGitApi";
import {
  gitReadKeys,
  gitReadScope,
  readMutableGit,
  type GitReadCache,
} from "../../data/gitReadCache";
import type { AgentProject } from "../../domain/agentSessions";
import {
  groupGitBranches,
  type GitBranch as GitBranchValue,
  type GitGroupBranch,
  type GitMutationResult,
} from "../../domain/projectGit";
import { useNotification } from "../../notifications";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { useGitStrings } from "./gitStrings";
import "./GitArchiveViews.css";

export type GroupBranchRef = {
  projectId: string;
  name: string;
  remote: boolean;
  version: string;
};
type SwitchRequest = {
  name: string;
  refs: GroupBranchRef[];
  missing: string[];
};

export function ProjectGroupBranchesView({
  active,
  members,
  versions,
  readCache,
  busy,
  blocked,
  onMutate,
}: {
  active: boolean;
  /** Connected members whose repository is ready. */
  members: AgentProject[];
  versions: Record<string, string>;
  readCache: GitReadCache;
  busy: boolean;
  blocked: (projectId: string) => boolean;
  onMutate: (
    operation: "branch" | "switch",
    refs: GroupBranchRef[],
  ) => Promise<PromiseSettledResult<GitMutationResult>[] | null>;
}) {
  const s = useGitStrings();
  const membersKey = JSON.stringify(
    members.map((member) => [member.id, gitReadScope(member)]),
  );
  const versionKey = JSON.stringify(
    members.map((member) => versions[member.id]),
  );
  const membersRef = useRef(members);
  membersRef.current = members;
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  // Repository version each member's branches were last requested at.
  const requested = useRef<Record<string, string | undefined>>({});
  const generation = useRef(0);
  const [branches, setBranches] = useState<Record<string, GitBranchValue[]>>(
    {},
  );
  const [readAt, setReadAt] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<SwitchRequest | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [createRequest, setCreateRequest] = useState<{
    name: string;
    selected: ReadonlySet<string>;
  } | null>(null);

  const refresh = useCallback(
    async (force = false) => {
      if (!active) return;
      const request = ++generation.current;
      const targets = membersRef.current;
      const current = versionsRef.current;
      setLoading(true);
      setReadFailed(false);
      const results = await Promise.allSettled(
        targets.map((member) => {
          // A version change usually moves refs: only then skip the short read cache.
          const stale = requested.current[member.id] !== current[member.id];
          requested.current[member.id] = current[member.id];
          return readMutableGit(
            readCache,
            gitReadScope(member),
            gitReadKeys.branches,
            () => api.readGitBranches(member.id),
            force || stale,
          );
        }),
      );
      if (request !== generation.current) return;
      const fulfilled = results.flatMap(
        (result, index): [string, GitBranchValue[]][] =>
          result.status === "fulfilled"
            ? [[targets[index].id, result.value]]
            : [],
      );
      setBranches(Object.fromEntries(fulfilled));
      setReadAt(Object.fromEntries(fulfilled.map(([id]) => [id, current[id]])));
      setReadFailed(results.some((result) => result.status === "rejected"));
      setLoading(false);
    },
    [active, membersKey, readCache],
  );
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh, versionKey]);
  useEffect(() => {
    if (!active && !busy) {
      setPending(null);
      setCreateRequest(null);
    }
  }, [active, busy]);

  const names = new Map(members.map((member) => [member.id, member.name]));
  const loaded = members.filter((member) => branches[member.id]);
  const rows = groupGitBranches(
    loaded.map((member) => ({
      projectId: member.id,
      branches: branches[member.id],
    })),
  );
  // Branches of a single repository stay folded under it: switching them is not a group action.
  const shared = rows.filter((row) => Object.keys(row.refs).length > 1);
  const own = loaded.flatMap((member) => {
    const memberRows = rows.filter(
      (row) => Object.keys(row.refs).length === 1 && row.refs[member.id],
    );
    return memberRows.length ? [{ member, rows: memberRows }] : [];
  });
  const createName = createRequest?.name ?? name.trim();
  const createRow = rows.find((row) => row.name === createName);
  const createOptions = loaded.map((member) => {
    const ref = createRow?.refs[member.id];
    const from = branches[member.id].find((branch) => branch.current)?.name;
    return {
      member,
      exists: ref?.remote === false,
      // A remote-only branch is checked out as its tracking branch, not recreated from HEAD.
      ref: {
        projectId: member.id,
        name: ref?.name ?? createName,
        remote: !!ref?.remote,
        version: versions[member.id],
      },
      note:
        ref?.remote === false
          ? s.groupBranchExists
          : ref
            ? `${s.remoteSource}: ${ref.name}`
            : from
              ? s.groupCreateFrom(from)
              : undefined,
    };
  });
  const creatable = createOptions.filter(
    (option) => !option.exists && !blocked(option.member.id),
  );
  const createRefs = creatable
    .filter((option) => createRequest?.selected.has(option.member.id))
    .map((option) => option.ref);
  // Notes come from `branches`: never confirm a version they were not read at.
  const createStale =
    loading || createRefs.some((ref) => readAt[ref.projectId] !== ref.version);
  const pendingChanged =
    !!pending &&
    pending.refs.some((ref) => versions[ref.projectId] !== ref.version);

  async function confirmCreate() {
    if (!createRequest || busy || createStale || createRefs.length === 0)
      return;
    const refs = createRefs;
    setCreateRequest(null);
    setCreating(true);
    try {
      const results = await onMutate("branch", refs);
      if (results?.every((result) => result.status === "fulfilled"))
        setName("");
    } finally {
      setCreating(false);
    }
    void refresh();
  }

  async function confirmSwitch() {
    const request = pending;
    if (
      !request ||
      pendingChanged ||
      busy ||
      request.refs.some((ref) => blocked(ref.projectId))
    )
      return;
    setPending(null);
    await onMutate("switch", request.refs);
    void refresh();
  }

  function branchRow(row: GitGroupBranch, shared: boolean) {
    const present = loaded.filter((member) => row.refs[member.id]);
    const current = present.filter((member) => row.refs[member.id].current);
    const refs = present.flatMap((member) =>
      row.refs[member.id].current
        ? []
        : [
            {
              projectId: member.id,
              name: row.refs[member.id].name,
              remote: row.refs[member.id].remote,
              version: versions[member.id],
            },
          ],
    );
    const rowBlocked = refs.some((ref) => blocked(ref.projectId));
    // shortcut: a member shown current from a branch list older than its version is skipped, not waited for; check every present member if mixed switches show up.
    const rowStale = refs.some((ref) => readAt[ref.projectId] !== ref.version);
    const others = refs.map((ref) => names.get(ref.projectId)).join(", ");
    return (
      <li className="git-branch-row" key={row.name}>
        <button
          type="button"
          className={`git-branch-main${refs.length === 0 ? " is-current" : ""}`}
          disabled={refs.length === 0 || busy || rowBlocked || rowStale}
          aria-current={refs.length === 0 ? "true" : undefined}
          aria-label={`${s.switchBranch} · ${row.name}`}
          title={
            refs.length === 0
              ? s.currentBranch
              : rowBlocked
                ? s.actionUnavailable
                : undefined
          }
          onClick={() =>
            setPending({
              name: row.name,
              refs,
              missing: shared
                ? loaded
                    .filter((member) => !row.refs[member.id])
                    .map((member) => member.name)
                : [],
            })
          }
        >
          <span className="git-branch-icon">
            <GitBranch size={14} aria-hidden="true" />
          </span>
          <span className="git-branch-copy">
            <strong>{row.name}</strong>
            {shared ? (
              <small>
                {current.length
                  ? s.groupBranchCurrentIn(
                      current.map((member) => member.name).join(", "),
                      others,
                    )
                  : others}
              </small>
            ) : null}
          </span>
          {!shared && current.length ? (
            <span className="git-branch-status">{s.currentBranch}</span>
          ) : null}
        </button>
      </li>
    );
  }

  useNotification(
    active && readFailed
      ? {
          key: `group-git-branches:${membersKey}`,
          message: s.branchesReadError,
          action: { label: s.retry, onAction: () => void refresh(true) },
        }
      : null,
  );
  useNotification(
    active && pendingChanged
      ? {
          key: "group-git:repository-changed",
          message: s.repositoryChanged,
          tone: "warning",
        }
      : null,
  );

  return (
    <div className="git-branches-view">
      <div className="git-view-toolbar">
        <strong>{s.branches}</strong>
        <IconButton
          size="small"
          aria-label={s.refreshBranches}
          title={s.refreshBranches}
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          <RefreshCw className={loading ? "app-loading-spinner" : undefined} />
        </IconButton>
      </div>
      <form
        className="git-branch-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !createName || creatable.length === 0) return;
          setCreateRequest({
            name: createName,
            selected: new Set(creatable.map((option) => option.member.id)),
          });
        }}
      >
        <div className="git-branch-create-controls">
          <Input
            aria-label={s.newBranch}
            value={name}
            placeholder={s.branchPlaceholder}
            disabled={busy}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            aria-busy={creating || undefined}
            type="submit"
            variant="primary"
            disabled={busy || !createName || creatable.length === 0}
            startIcon={
              creating ? (
                <LoaderCircle className="app-loading-spinner" />
              ) : undefined
            }
          >
            {s.createBranch}
          </Button>
        </div>
      </form>
      {loading && loaded.length === 0 ? (
        <LoadingState className="git-panel-centered-status">
          {s.branchesLoading}
        </LoadingState>
      ) : (
        <div className="git-branch-groups">
          <section className="git-branch-section git-worktree-section">
            <header className="git-branch-section-heading">
              <span className="git-branch-section-title">
                <GitBranch size={13} aria-hidden="true" />
                <h3>{s.groupSharedBranches}</h3>
              </span>
              <span className="git-branch-count">{shared.length}</span>
            </header>
            {shared.length ? (
              <ul>{shared.map((row) => branchRow(row, true))}</ul>
            ) : (
              <EmptyState
                className="git-branch-empty"
                description={s.noBranches}
                size="compact"
              />
            )}
          </section>
          {own.length ? (
            <div className="git-branch-columns">
              <header className="git-branch-family-heading">
                <span className="git-branch-section-title">
                  <FolderGit2 size={13} aria-hidden="true" />
                  <strong>{s.groupBranchesByRepository}</strong>
                </span>
              </header>
              {own.map(({ member, rows: memberRows }) => {
                const open = expanded.has(member.id);
                return (
                  <section
                    className="git-branch-section git-branch-subsection"
                    key={member.id}
                  >
                    <header className="git-branch-section-heading">
                      <h3>
                        <button
                          className="git-change-group-toggle"
                          type="button"
                          aria-expanded={open}
                          onClick={() =>
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (!next.delete(member.id)) next.add(member.id);
                              return next;
                            })
                          }
                        >
                          <ChevronRight size={12} aria-hidden="true" />
                          <span>{member.name}</span>
                        </button>
                      </h3>
                      <span className="git-branch-count">
                        {memberRows.length}
                      </span>
                    </header>
                    {open ? (
                      <ul>{memberRows.map((row) => branchRow(row, false))}</ul>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
      {pending && active
        ? createPortal(
            <ConfirmationDialog
              title={s.switchTitle}
              confirmVariant="primary"
              description={
                <span className="git-commit-confirmation">
                  <span>{s.switchDescription}</span>
                  <span>
                    <strong>{s.destination}:</strong> {pending.name}
                  </span>
                  <span>
                    <strong>{s.groupSwitchRepositories}:</strong>{" "}
                    {pending.refs
                      .map((ref) => names.get(ref.projectId))
                      .join(", ")}
                  </span>
                  {pending.missing.length ? (
                    <span>
                      <strong>{s.groupSwitchMissing}:</strong>{" "}
                      {pending.missing.join(", ")}
                    </span>
                  ) : null}
                </span>
              }
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.switchBranch}
              cancelDisabled={busy}
              confirmDisabled={busy || pendingChanged}
              onCancel={() => {
                if (!busy) setPending(null);
              }}
              onConfirm={() => void confirmSwitch()}
            />,
            document.body,
          )
        : null}
      {createRequest && active
        ? createPortal(
            <ConfirmationDialog
              title={s.createBranch}
              confirmVariant="primary"
              description={
                <span className="git-commit-confirmation">
                  <span>{s.groupCreateDescription}</span>
                  <span>
                    <strong>{s.newBranch}:</strong> {createRequest.name}
                  </span>
                </span>
              }
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.groupCreateAndSwitch}
              cancelDisabled={busy}
              confirmDisabled={busy || createStale || createRefs.length === 0}
              onCancel={() => {
                if (!busy) setCreateRequest(null);
              }}
              onConfirm={() => void confirmCreate()}
            >
              {createOptions.map(({ member, exists, note }) => {
                const disabled = exists || busy || blocked(member.id);
                return (
                  <div key={member.id}>
                    <label
                      className="confirmation-dialog-option"
                      title={
                        !exists && blocked(member.id)
                          ? s.actionUnavailable
                          : undefined
                      }
                    >
                      <Checkbox
                        checked={
                          !disabled && createRequest.selected.has(member.id)
                        }
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setCreateRequest((current) => {
                            if (!current) return current;
                            const selected = new Set(current.selected);
                            if (checked) selected.add(member.id);
                            else selected.delete(member.id);
                            return { ...current, selected };
                          })
                        }
                      />
                      {member.name}
                      {note ? <small>{note}</small> : null}
                    </label>
                  </div>
                );
              })}
            </ConfirmationDialog>,
            document.body,
          )
        : null}
    </div>
  );
}
