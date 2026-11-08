import { useCallback, useEffect, useRef, useState } from "react";
import {
  createKanbanComment,
  deleteKanbanComment,
  loadKanbanIssue,
  updateKanbanIssueDescription,
} from "../data/kanbanApi";
import type {
  KanbanComment,
  KanbanIssueDetail,
  KanbanSource,
} from "../domain/kanban";

type IssueLoad = {
  issueId: string;
  detail: KanbanIssueDetail | null;
  error: unknown;
  loading: boolean;
};

export function useKanbanIssue(
  selection: { id: string; source: KanbanSource } | null,
) {
  const issueId = selection?.id ?? null;
  const source = selection?.source ?? "local";
  const [issueLoad, setIssueLoad] = useState<IssueLoad | null>(null);
  // Bumped on every request and id change so late responses are dropped.
  const requestRef = useRef(0);
  // A save resolving after another issue was opened must not load its own issue over it.
  const shownRef = useRef({ issueId, source });
  // Agent summaries are replayed from a cache that still holds the deleted ones.
  const deletedIdsRef = useRef(new Set<string>());

  const load = useCallback(async (id: string, source: KanbanSource) => {
    const request = ++requestRef.current;
    setIssueLoad((current) => ({
      issueId: id,
      detail: current?.issueId === id ? current.detail : null,
      error: null,
      loading: true,
    }));
    try {
      const detail = await loadKanbanIssue(source, id);
      if (request !== requestRef.current) return;
      setIssueLoad({ issueId: id, detail, error: null, loading: false });
    } catch (error) {
      if (request !== requestRef.current) return;
      setIssueLoad((current) => ({
        issueId: id,
        detail: current?.issueId === id ? current.detail : null,
        error,
        loading: false,
      }));
    }
  }, []);

  useEffect(() => {
    shownRef.current = { issueId, source };
    if (issueId === null) return;
    void load(issueId, source);
    return () => {
      requestRef.current += 1;
    };
  }, [issueId, load, source]);

  const reload = useCallback(() => {
    if (issueId !== null) void load(issueId, source);
  }, [issueId, load, source]);

  // Pull requests are derived from the description and comments: a saved change refreshes them,
  // and the new load supersedes any pending one whose snapshot predates the change.
  const refresh = useCallback(
    (id: string) => {
      const shown = shownRef.current;
      if (id === shown.issueId) void load(id, shown.source);
    },
    [load],
  );

  // Lists a comment posted elsewhere, e.g. an agent's summary, if it targets the shown issue; a known id is an edit.
  const receiveComment = useCallback(
    (id: string, comment: KanbanComment) => {
      if (id !== issueId || deletedIdsRef.current.has(comment.id)) return;
      setIssueLoad((current) => {
        const detail = current?.issueId === id ? current.detail : null;
        if (!current || !detail) return current;
        const known = detail.comments.find(({ id }) => id === comment.id);
        if (known?.body === comment.body) return current;
        return {
          ...current,
          detail: {
            ...detail,
            comments: known
              ? detail.comments.map((shown) =>
                  shown.id === comment.id ? comment : shown,
                )
              : [...detail.comments, comment],
          },
        };
      });
      refresh(id);
    },
    [issueId, refresh],
  );

  const addComment = useCallback(
    async (body: string) => {
      if (issueId === null) throw new Error("No Kanban issue is selected.");
      receiveComment(issueId, await createKanbanComment(source, issueId, body));
    },
    [issueId, receiveComment, source],
  );

  const deleteComment = useCallback(
    async (commentId: string) => {
      if (issueId === null) throw new Error("No Kanban issue is selected.");
      await deleteKanbanComment(source, issueId, commentId);
      deletedIdsRef.current.add(commentId);
      setIssueLoad((current) => {
        const detail = current?.issueId === issueId ? current.detail : null;
        if (!current || !detail) return current;
        return {
          ...current,
          detail: {
            ...detail,
            comments: detail.comments.filter(({ id }) => id !== commentId),
          },
        };
      });
      refresh(issueId);
    },
    [issueId, refresh, source],
  );

  const updateDescription = useCallback(
    async (description: string) => {
      if (issueId === null) throw new Error("No Kanban issue is selected.");
      const update = await updateKanbanIssueDescription(
        source,
        issueId,
        description,
      );
      setIssueLoad((current) => {
        const detail = current?.issueId === issueId ? current.detail : null;
        if (!current || !detail || detail.id !== update.id) return current;
        return {
          ...current,
          detail: {
            ...detail,
            description: update.description,
            updatedAt: update.updatedAt,
          },
        };
      });
      refresh(issueId);
      return update.description;
    },
    [issueId, refresh, source],
  );

  const current = issueLoad?.issueId === issueId ? issueLoad : null;
  return {
    addComment,
    deleteComment,
    detail: current?.detail ?? null,
    error: current?.error ?? null,
    loading: issueId !== null && (current?.loading ?? true),
    receiveComment,
    reload,
    updateDescription,
  };
}
