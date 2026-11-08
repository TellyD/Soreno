import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  UserCheck,
  UserX,
} from "lucide-react";
import type { ForgeRequestSummary, ForgeReviewer } from "../../domain/forge";
import { useGitStrings } from "./gitStrings";

export function ForgeStatusIcon({
  status,
}: {
  status: "success" | "failure" | "pending" | "skipped" | "neutral";
}) {
  const Icon =
    status === "success"
      ? CircleCheck
      : status === "failure"
        ? CircleX
        : CircleDot;
  return (
    <Icon
      size={13}
      className="git-forge-status"
      data-status={status}
      aria-hidden="true"
    />
  );
}

export function ForgeRequestRow({
  request,
  current,
  selected,
  date,
  onSelect,
}: {
  request: ForgeRequestSummary;
  current: boolean;
  selected: boolean;
  date: string;
  onSelect: () => void;
}) {
  const s = useGitStrings();
  const signals = [
    request.draft ? s.forgeDraft : null,
    current ? s.forgeCurrentBranch : null,
    request.checks ? s.forgeChecks[request.checks] : null,
    request.review ? s.forgeReview[request.review] : null,
    request.conflicts ? s.forgeConflicts : null,
  ].filter(Boolean);
  const description = [
    `${request.title} #${request.number}`,
    `${request.author} · ${request.sourceBranch} → ${request.targetBranch}`,
    ...signals,
    date,
  ].join("\n");
  return (
    <button
      type="button"
      className={["git-forge-row", selected ? "is-selected" : ""].join(" ")}
      title={description}
      aria-label={description}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <ForgeStateIcon request={request} />
      <strong className="git-forge-row-title">{request.title}</strong>
      <time dateTime={request.createdAt}>{date}</time>
      <span className="git-forge-row-meta">
        {current ? (
          <span className="git-history-reference" data-kind="head">
            {s.forgeCurrentBranch}
          </span>
        ) : null}
        <span>#{request.number}</span>
        <span>{request.author}</span>
        <span className="git-forge-row-branch">
          {request.sourceBranch} → {request.targetBranch}
        </span>
      </span>
      <span className="git-forge-row-signals">
        {request.conflicts ? (
          <AlertTriangle
            size={13}
            className="git-forge-status"
            data-status="failure"
            aria-hidden="true"
          />
        ) : null}
        {request.review === "approved" ? (
          <UserCheck
            size={13}
            className="git-forge-status"
            data-status="success"
            aria-hidden="true"
          />
        ) : request.review === "changesRequested" ? (
          <UserX
            size={13}
            className="git-forge-status"
            data-status="failure"
            aria-hidden="true"
          />
        ) : null}
        {request.checks ? <ForgeStatusIcon status={request.checks} /> : null}
      </span>
    </button>
  );
}

export function requestStateKey(request: ForgeRequestSummary) {
  return request.state === "open" && request.draft ? "draft" : request.state;
}

export function ForgeStateIcon({ request }: { request: ForgeRequestSummary }) {
  const state = requestStateKey(request);
  const Icon =
    state === "draft"
      ? GitPullRequestDraft
      : state === "merged"
        ? GitMerge
        : state === "closed"
          ? GitPullRequestClosed
          : GitPullRequest;
  return (
    <Icon
      size={14}
      className="git-forge-state-icon"
      data-state={state}
      aria-hidden="true"
    />
  );
}

export function ForgeReviewerIcon({
  state,
}: {
  state: ForgeReviewer["state"];
}) {
  const Icon =
    state === "approved"
      ? UserCheck
      : state === "changesRequested"
        ? UserX
        : state === "commented"
          ? MessageSquare
          : Clock;
  return (
    <Icon
      size={12}
      className="git-forge-status"
      data-status={
        state === "approved"
          ? "success"
          : state === "changesRequested"
            ? "failure"
            : "pending"
      }
      aria-hidden="true"
    />
  );
}
