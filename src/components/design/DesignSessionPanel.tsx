import {
  Palette,
  PencilRuler,
  Search,
  Send,
  SquarePen,
  Unlink,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as designApi from "../../data/designApi";
import type {
  AgentProject,
  AgentSessionMessage,
} from "../../domain/agentSessions";
import type { DesignBoard } from "../../domain/design";
import { errorMessage } from "../../domain/errors";
import { useAgentSessionMessage } from "../../hooks/useAgentSessionMessage";
import { useDesignFrames } from "../../hooks/useDesignFrames";
import { useI18n } from "../../i18n";
import { notifyError } from "../../notifications";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/LoadingState";
import { EmptyState } from "../ui/EmptyState";
import { kanbanProjectOption } from "../kanban/KanbanIssueFieldControls";
import { DesignCanvas } from "./DesignCanvas";
import { DesignBoardForm, type DesignBoardFormValues } from "./DesignBoardForm";
import "../kanban/KanbanIssueView.css";
import "./DesignSessionPanel.css";

type DesignSessionPanelProps = {
  sessionId: string;
  /** The session's project, whose boards are listed first. */
  projectId: string;
  boardId: string | null;
  running: boolean;
  projects: readonly AgentProject[];
  /** The session's project when it can host a new board; undefined when missing or disconnected. */
  hostProject: AgentProject | undefined;
  /** The link changed: the workspace reloads its links. */
  onLinkChange: () => void;
  onOpenBoard: (board: DesignBoard) => void;
  onClose: () => void;
};

// Last loaded list: reopening the panel shows it at once while a fresh one loads.
let lastBoards: DesignBoard[] | null = null;

/** A coding agent's Design board beside its terminal, built like the issue panel. */
export function DesignSessionPanel({
  sessionId,
  projectId,
  boardId,
  running,
  projects,
  hostProject,
  onLinkChange,
  onOpenBoard,
  onClose,
}: DesignSessionPanelProps) {
  const { t } = useI18n();
  const [boards, setBoards] = useState<DesignBoard[] | null>(lastBoards);
  const [creating, setCreating] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  // The board just created and linked here: its view takes the focus from the create button it replaces.
  const focusEditFor = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<AgentSessionMessage | null>(null);
  const delivery = useAgentSessionMessage(sent);
  const board = boards?.find((item) => item.id === boardId);
  const projectName = (id: string | null) =>
    id === null
      ? t("design.noProject")
      : (projects.find((project) => project.id === id)?.name ?? id);
  // Same-named projects on other machines: the environment tells them apart, as in the Kanban.
  const projectWithEnvironment = (id: string | null) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return projectName(id);
    const { hint } = kanbanProjectOption(
      project,
      project,
      t("kanban.project.local"),
    );
    return `${project.name} · ${hint}`;
  };

  useEffect(() => {
    if (!board || focusEditFor.current !== board.id) return;
    focusEditFor.current = null;
    editRef.current?.focus();
  }, [board]);

  useEffect(() => {
    let current = true;
    void designApi.loadDesignBoards().then(
      (list) => {
        lastBoards = list;
        if (current) setBoards(list);
      },
      (reason) => notifyError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [boardId]);

  const frames = useDesignFrames(boardId);

  useEffect(() => {
    if (delivery?.status !== "failed") return;
    notifyError(
      delivery.error
        ? t("design.panel.sendFailedReason", { reason: delivery.error })
        : t("design.panel.sendFailed"),
    );
  }, [delivery?.id, delivery?.status]);

  const candidates = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const found = (boards ?? []).filter(
      (item) => !needle || item.name.toLocaleLowerCase().includes(needle),
    );
    return [
      ...found.filter((item) => item.projectId === projectId),
      ...found.filter((item) => item.projectId !== projectId),
    ];
  }, [boards, projectId, query]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (reason) {
      notifyError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const send = (id: string) =>
    run(async () => {
      setSent(await designApi.sendDesignToSession(sessionId, id, null, true));
    });
  const link = (id: string) =>
    run(async () => {
      await designApi.linkDesignSession(sessionId, id);
      onLinkChange();
      if (running)
        setSent(await designApi.sendDesignToSession(sessionId, id, null, false));
    });
  const unlink = () =>
    run(async () => {
      await designApi.unlinkDesignSession(sessionId);
      setSent(null);
      onLinkChange();
    });
  // An empty board: nothing to send yet, the link alone is enough.
  const create = (values: DesignBoardFormValues) =>
    run(async () => {
      const created = await designApi.createDesignBoard(
        values.name,
        values.projectId,
        values.executable,
      );
      // The board exists: a failed link is reported, the board stays listed to link again.
      setBoards((list) => [created, ...(list ?? [])]);
      // shortcut: the dialog returns focus while the create button is still disabled by `busy`, so a failed link leaves focus nowhere; refocus it once `busy` clears if keyboard users hit it.
      setCreating(false);
      try {
        await designApi.linkDesignSession(sessionId, created.id);
        focusEditFor.current = created.id;
      } finally {
        // Also brings the board's hidden designer session into the workspace.
        onLinkChange();
      }
    });

  // The side panel host is a grid: the issue panel's wrapper sizes the absolutely placed section.
  const header = (title: string) => (
    <header className="agent-git-panel-header">
      <div className="git-panel-heading">
        <h2>{title}</h2>
      </div>
      <div className="git-panel-header-actions">
        <IconButton
          aria-label={t("design.panel.close")}
          onClick={onClose}
          size="small"
          title={t("design.panel.close")}
        >
          <X />
        </IconButton>
      </div>
    </header>
  );

  if (!boards)
    return (
      <div className="kanban-issue-panel">
        <section
          aria-label={t(boardId ? "design.panel.title" : "design.panel.link")}
          className="kanban-issue-attach design-session-panel"
        >
          {header(t(boardId ? "design.panel.title" : "design.panel.link"))}
          <LoadingState className="kanban-board-status">
            {t("design.panel.loading")}
          </LoadingState>
        </section>
      </div>
    );

  if (boardId) {
    const status = !delivery
      ? null
      : delivery.status === "queued"
        ? delivery.error
          ? t("design.queuedReason", { reason: delivery.error })
          : t("design.queued")
        : delivery.status === "delivered"
          ? t("design.panel.delivered")
          : t("design.panel.sendFailed");
    return (
      <div className="kanban-issue-panel">
        <section
          aria-label={t("design.panel.title")}
          className="kanban-issue-attach design-session-panel"
        >
          {header(t("design.panel.title"))}
          {board ? (
            <>
              <div className="kanban-issue-attach-body design-session-panel-summary">
                <div className="design-session-panel-title">
                  <h3 className="design-session-panel-name">
                    <Palette size={14} aria-hidden="true" />
                    <span>{board.name}</span>
                  </h3>
                  <p className="kanban-issue-muted">
                    {projectName(board.projectId)}
                    {frames
                      ? ` · ${t("design.panel.frames", { count: frames.length })}`
                      : null}
                  </p>
                </div>
                <div className="design-session-panel-actions">
                  <Button
                    ref={editRef}
                    size="small"
                    startIcon={<PencilRuler />}
                    onClick={() => onOpenBoard(board)}
                  >
                    {t("design.panel.edit")}
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    startIcon={<Send />}
                    disabled={busy || !running}
                    title={running ? undefined : t("design.panel.notRunning")}
                    onClick={() => void send(board.id)}
                  >
                    {t("design.panel.send")}
                  </Button>
                  <Button
                    size="small"
                    startIcon={<Unlink />}
                    disabled={busy}
                    onClick={() => void unlink()}
                  >
                    {t("design.panel.unlink")}
                  </Button>
                </div>
                {running ? null : (
                  <p className="kanban-issue-muted">
                    {t("design.panel.notRunning")}
                  </p>
                )}
                {status ? (
                  <p className="kanban-issue-muted" role="status">
                    {status}
                  </p>
                ) : null}
              </div>
              <div className="design-session-panel-preview">
                {frames ? (
                  <DesignCanvas
                    readOnly
                    viewKey={`preview:${board.id}`}
                    frames={frames}
                    empty={
                      <EmptyState
                        size="compact"
                        icon={<Palette />}
                        title={t("design.framesEmptyTitle")}
                      />
                    }
                  />
                ) : (
                  <LoadingState className="kanban-board-status">
                    {t("design.panel.loading")}
                  </LoadingState>
                )}
              </div>
            </>
          ) : (
            <div className="kanban-issue-attach-body">
              <p className="kanban-issue-muted">{t("design.panel.missing")}</p>
            </div>
          )}
        </section>
      </div>
    );
  }

  const createButton = (
    <Button
      ref={createRef}
      disabled={busy || !hostProject}
      title={hostProject ? undefined : t("design.panel.createUnavailable")}
      onClick={() => setCreating(true)}
      size="small"
      startIcon={<SquarePen />}
    >
      {t("design.panel.create")}
    </Button>
  );

  return (
    <div className="kanban-issue-panel">
      <section
        aria-label={t("design.panel.link")}
        className="kanban-issue-attach design-session-panel"
      >
        {header(t("design.panel.link"))}
        <div className="kanban-issue-attach-body">
          {boards.length === 0 ? (
            <EmptyState
              fill
              size="compact"
              icon={<Palette />}
              title={t("design.emptyTitle")}
              description={t("design.emptyBody")}
              actions={createButton}
            />
          ) : (
            <>
              {createButton}
              <Input
                aria-label={t("design.panel.search")}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("design.panel.search")}
                size="small"
                startIcon={<Search />}
                type="search"
                value={query}
              />
              {candidates.length > 0 ? (
                <ul className="kanban-issue-children">
                  {candidates.map((item) => (
                    <li key={item.id}>
                      <button
                        className="kanban-issue-child"
                        disabled={busy}
                        onClick={() => void link(item.id)}
                        type="button"
                      >
                        <Palette size={14} aria-hidden="true" />
                        <span className="kanban-issue-child-title">
                          {item.name}
                        </span>
                        <span className="kanban-issue-muted">
                          {projectWithEnvironment(item.projectId)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="kanban-issue-muted">
                  {t("design.panel.noMatch")}
                </p>
              )}
            </>
          )}
        </div>
      </section>
      {creating && hostProject ? (
        <DesignBoardForm
          projects={[]}
          fixedProject={hostProject}
          pending={busy}
          returnFocusRef={createRef}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => void create(values)}
        />
      ) : null}
    </div>
  );
}
