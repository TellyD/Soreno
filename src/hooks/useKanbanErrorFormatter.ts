import { useCallback } from "react";
import { errorMessage } from "../domain/errors";
import { kanbanErrorCode } from "../domain/kanban";
import { useI18n, type TranslationKey } from "../i18n";

const errorKeys = {
  desktopOnly: "kanban.error.desktopOnly",
  emptyComment: "kanban.error.emptyComment",
  emptyUpdate: "kanban.error.emptyUpdate",
  imageNotFound: "kanban.error.imageNotFound",
  imageTooLarge: "kanban.error.imageTooLarge",
  imageType: "kanban.error.imageType",
  invalidImageName: "kanban.error.invalidImageName",
  invalidLabelName: "kanban.error.invalidLabelName",
  invalidPriority: "kanban.error.invalidPriority",
  invalidTitle: "kanban.error.invalidTitle",
  issueHasSession: "kanban.error.issueHasSession",
  issueNotFound: "kanban.error.issueNotFound",
  labelConflict: "kanban.error.labelConflict",
  labelNotFound: "kanban.error.labelNotFound",
  linearAuth: "kanban.error.linearAuth",
  linearForbidden: "kanban.error.linearForbidden",
  linearMissingKey: "kanban.error.linearMissingKey",
  linearNoTeam: "kanban.error.linearNoTeam",
  linearProjectNotLinked: "kanban.error.linearProjectNotLinked",
  linearRateLimit: "kanban.error.linearRateLimit",
  linearRequest: "kanban.error.linearRequest",
  linearUnavailable: "kanban.error.linearUnavailable",
  parentNotFound: "kanban.error.parentNotFound",
  projectNotFound: "kanban.error.projectNotFound",
  requestClaimFailed: "kanban.error.requestClaimFailed",
  requestImagePlaceholder: "kanban.error.requestImagePlaceholder",
  requestInvalidJson: "kanban.error.requestInvalidJson",
  requestNotRegular: "kanban.error.requestNotRegular",
  requestTooLarge: "kanban.error.requestTooLarge",
  sessionHasIssue: "kanban.error.sessionHasIssue",
  sessionNotLinked: "kanban.error.sessionNotLinked",
  stateNotFound: "kanban.error.stateNotFound",
  teamNotFound: "kanban.error.teamNotFound",
  transferIncomplete: "kanban.error.transferIncomplete",
  transferSubIssues: "kanban.error.transferSubIssues",
} as const satisfies Record<string, TranslationKey>;

/** Translates coded Kanban errors; any other error (already localized or technical) is shown as is. */
export function useKanbanErrorFormatter() {
  const { t } = useI18n();
  return useCallback(
    (error: unknown) => {
      const message = errorMessage(error);
      const code = kanbanErrorCode(message);
      // Only `linearRequest` and `transferIncomplete` show their detail: the text after the tag.
      return code && Object.prototype.hasOwnProperty.call(errorKeys, code)
        ? t(errorKeys[code as keyof typeof errorKeys], {
            detail: message.slice(message.indexOf("] ") + 2),
          })
        : message;
    },
    [t],
  );
}
