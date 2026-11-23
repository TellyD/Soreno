import { formatCompactDate } from "../../domain/dateTime";
import type { ForgeRequestDetail } from "../../domain/forge";
import { useI18n } from "../../i18n";
import { MarkdownContent } from "../MarkdownContent";
import { EmptyState } from "../ui/EmptyState";
import { ForgeStatusIcon } from "./GitForgeRequestRow";
import { useGitStrings } from "./gitStrings";

export function ForgeRequestOverview({
  detail,
  tab,
  onOpenUrl,
}: {
  detail: ForgeRequestDetail;
  tab: "description" | "checks" | "commits";
  onOpenUrl: (url: string) => void;
}) {
  const s = useGitStrings();
  const { locale } = useI18n();
  return tab === "description" ? (
    detail.body.trim() ? (
      <MarkdownContent
        className="project-file-markdown git-forge-body"
        content={detail.body}
      />
    ) : (
      <EmptyState size="compact" description={s.forgeNoDescription} />
    )
  ) : tab === "checks" ? (
    detail.checkRuns.length ? (
      <ul className="git-forge-items">
        {detail.checkRuns.map((check, index) => (
          <li key={`${index}:${check.name}`}>
            <ForgeStatusIcon status={check.status} />
            {check.url ? (
              <button
                type="button"
                className="git-forge-link"
                onClick={() => onOpenUrl(check.url!)}
              >
                {check.name}
              </button>
            ) : (
              <span>{check.name}</span>
            )}
            <small>{s.forgeCheckStatus[check.status]}</small>
          </li>
        ))}
      </ul>
    ) : (
      <EmptyState size="compact" description={s.forgeNoChecks} />
    )
  ) : detail.commits.length ? (
    <ul className="git-forge-items">
      {detail.commits.map((commit) => (
        <li key={commit.oid}>
          <code title={commit.oid}>{commit.oid.slice(0, 8)}</code>
          <span>{commit.title}</span>
          <small>{commit.author}</small>
          <time dateTime={commit.date}>
            {formatCompactDate(commit.date, locale)?.value}
          </time>
        </li>
      ))}
    </ul>
  ) : (
    <EmptyState size="compact" description={s.forgeNoCommits} />
  );
}
