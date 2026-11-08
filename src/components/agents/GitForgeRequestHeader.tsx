import { ArrowRight } from "lucide-react";
import type { ForgeRequestDetail } from "../../domain/forge";
import {
  ForgeReviewerIcon,
  ForgeStateIcon,
  requestStateKey,
} from "./GitForgeRequestRow";
import { useGitStrings } from "./gitStrings";

export function ForgeRequestHeader({ detail }: { detail: ForgeRequestDetail }) {
  const s = useGitStrings();
  return (
    <header className="git-forge-detail-header">
      <h3>
        {detail.title}{" "}
        <span className="git-forge-number">#{detail.number}</span>
      </h3>
      <div className="git-forge-meta">
        <span className="git-forge-state" data-state={requestStateKey(detail)}>
          <ForgeStateIcon request={detail} />
          {detail.draft && detail.state === "open"
            ? s.forgeDraft
            : s.forgeStates[detail.state]}
        </span>
        <strong>{detail.author}</strong>
        <span className="git-forge-branches">
          <code title={detail.sourceBranch}>{detail.sourceBranch}</code>
          <ArrowRight size={12} aria-hidden="true" />
          <code title={detail.targetBranch}>{detail.targetBranch}</code>
        </span>
      </div>
      {detail.reviewers.length || detail.labels.length ? (
        <dl className="git-forge-facts">
          {detail.reviewers.length ? (
            <div>
              <dt>{s.forgeReviewers}</dt>
              <dd>
                {detail.reviewers.map((reviewer) => (
                  <span
                    className="git-forge-chip"
                    key={reviewer.name}
                    title={s.forgeReviewerStates[reviewer.state]}
                  >
                    <ForgeReviewerIcon state={reviewer.state} />
                    {reviewer.name}
                    <span className="git-forge-sr">
                      {` (${s.forgeReviewerStates[reviewer.state]})`}
                    </span>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
          {detail.labels.length ? (
            <div>
              <dt>{s.forgeLabels}</dt>
              <dd>
                {detail.labels.map((label) => (
                  <span className="git-forge-chip" key={label.name}>
                    {label.color ? (
                      <span
                        className="git-forge-label-swatch"
                        style={{ background: label.color }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {label.name}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </header>
  );
}
