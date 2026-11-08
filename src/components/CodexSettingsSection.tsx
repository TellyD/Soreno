import {
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  Cpu,
  Download,
  GitCommitHorizontal,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  checkCodexUpdate,
  getCodexStatus,
  listCodexModels,
  updateCodexCli,
  type CodexModel,
  type CodexStatus,
  type CodexUpdateStatus,
} from "../data/codexApi";
import type { AppSettings } from "../data/settingsApi";
import {
  commitMessageStyles,
  type CommitMessageStyle,
} from "../domain/codexOptions";
import { useI18n, type I18nContextValue, type TranslationKey } from "../i18n";
import { formatCodexError } from "../i18n/codexErrors";
import {
  dismissNotification,
  notifyError,
  useNotification,
} from "../notifications";
import { Button } from "./ui/Button";
import { SegmentedControl, SegmentedControlItem } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import "./CodexSettingsSection.css";

type CodexSettingsSectionProps = {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
};

type CodexInstallation = "unknown" | "available" | "missing";

const codexStatusNotificationKey = "codex-status";

// Examples stay in English: they illustrate the shape, not the generated language.
const commitStyles: Record<
  CommitMessageStyle,
  {
    label: TranslationKey;
    description: TranslationKey;
    subject: string;
    body?: string;
  }
> = {
  imperative: {
    label: "settings.codex.git.style.imperative",
    description: "settings.codex.git.style.imperativeHint",
    subject: "Add commit style setting",
  },
  conventional: {
    label: "settings.codex.git.style.conventional",
    description: "settings.codex.git.style.conventionalHint",
    subject: "feat(settings): add commit style setting",
  },
  detailed: {
    label: "settings.codex.git.style.detailed",
    description: "settings.codex.git.style.detailedHint",
    subject: "Add commit style setting",
    body: "Let users choose the default message format. Project conventions in AGENTS.md still take precedence.",
  },
};

export function CodexSettingsSection({
  settings,
  onUpdateSettings,
}: CodexSettingsSectionProps) {
  const { t } = useI18n();
  const { codexGitCommitStyle, codexGitFastMode, codexGitModel } = settings;
  const commitStyle = commitStyles[codexGitCommitStyle];
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const installation: CodexInstallation = !codexStatus
    ? "unknown"
    : codexStatus.installed
      ? "available"
      : "missing";
  const codexVersion = codexStatus?.version ?? null;
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const installationLabelId = useId();
  const fastModeLabelId = useId();
  const commitStyleLabelId = useId();
  const [isTestingCodex, setIsTestingCodex] = useState(true);
  const [codexUpdate, setCodexUpdate] = useState<
    | CodexUpdateStatus
    | { status: "checking" }
    | { status: "unavailable"; error: unknown }
  >({ status: "checking" });
  const [isUpdatingCodex, setIsUpdatingCodex] = useState(false);
  const [codexUpdateSuccess, setCodexUpdateSuccess] = useState(false);
  const statusLabel = codexStatusLabel(installation, codexVersion, t);
  const showsUpdateCheckResult =
    installation === "available" && !isTestingCodex && !isUpdatingCodex;

  useNotification(
    showsUpdateCheckResult && codexUpdate.status === "unavailable"
      ? {
          key: "codex-update-check",
          message: formatCodexError(
            codexUpdate.error,
            t,
            "settings.codex.updateCheckError",
          ),
        }
      : showsUpdateCheckResult && codexUpdate.status === "unsupported"
        ? {
            key: "codex-update-check",
            message: t("settings.codex.updateUnsupported"),
            tone: "warning",
          }
        : null,
  );

  const gitModelIds = codexModels.map(({ id }) => id);
  if (codexGitModel && !gitModelIds.includes(codexGitModel)) {
    gitModelIds.unshift(codexGitModel);
  }
  const gitModelOptions = [
    {
      value: "",
      label: t("settings.codex.git.defaultModel", {
        model: codexModels[0]?.id ?? "Codex",
      }),
    },
    ...gitModelIds.map((id) => ({ value: id, label: id })),
  ];

  useEffect(() => {
    let isCurrent = true;

    void listCodexModels()
      .then((models) => {
        if (isCurrent) {
          setCodexModels(models);
        }
      })
      .catch(() => undefined);
    void refreshCodexStatus(() => isCurrent);

    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (isTestingCodex || isUpdatingCodex || installation !== "available") {
      return;
    }

    let isCurrent = true;
    setCodexUpdate({ status: "checking" });
    void checkCodexUpdate()
      .then((status) => {
        if (isCurrent) setCodexUpdate(status);
      })
      .catch((error: unknown) => {
        if (isCurrent) setCodexUpdate({ status: "unavailable", error });
      });
    return () => {
      isCurrent = false;
    };
  }, [installation, codexVersion, isTestingCodex, isUpdatingCodex]);

  async function refreshCodexStatus(isCurrent: () => boolean) {
    try {
      setIsTestingCodex(true);
      setCodexUpdateSuccess(false);
      const status = await getCodexStatus();

      if (!isCurrent()) {
        return;
      }

      dismissNotification(codexStatusNotificationKey);
      setCodexStatus(status);
    } catch {
      if (isCurrent()) {
        notifyError(t("settings.codex.testError"), {
          key: codexStatusNotificationKey,
        });
      }
    } finally {
      if (isCurrent()) {
        setIsTestingCodex(false);
      }
    }
  }

  async function handleUpdateCodex() {
    if (isTestingCodex || isUpdatingCodex || codexUpdate.status !== "available")
      return;

    setIsUpdatingCodex(true);
    setCodexUpdateSuccess(false);
    try {
      setCodexStatus(await updateCodexCli());
      setCodexUpdateSuccess(true);
      // Model discovery is optional; it must not turn a successful update into an error.
      void listCodexModels()
        .then(setCodexModels)
        .catch(() => undefined);
    } catch (error) {
      notifyError(formatCodexError(error, t, "settings.codex.updateError"));
    } finally {
      setIsUpdatingCodex(false);
    }
  }

  return (
    <>
      <div className="settings-panel-header">
        <h3>{t("settings.codex.title")}</h3>
        <p>{t("settings.codex.subtitle")}</p>
      </div>

      <div className="codex-settings-card">
        <div className="codex-settings-card-head">
          <div className="codex-settings-card-title">
            <strong>{t("settings.codex.status.title")}</strong>
            <span>{t("settings.codex.status.subtitle")}</span>
          </div>
        </div>
        <div className="codex-settings-card-body">
          <div className="codex-settings-field">
            <span
              className="codex-settings-field-label"
              id={installationLabelId}
            >
              {t("settings.codex.installation")}
            </span>
            <div className="codex-settings-field-row">
              <span
                className={`codex-settings-status ${installation}`}
                aria-labelledby={installationLabelId}
                aria-live="polite"
              >
                {codexStatusIcon(installation)}
                <span>
                  {isTestingCodex
                    ? t("settings.codex.status.checking")
                    : statusLabel}
                </span>
              </span>
              {installation === "available" && !isTestingCodex ? (
                isUpdatingCodex || codexUpdate.status === "available" ? (
                  <Button
                    disabled={isUpdatingCodex}
                    aria-busy={isUpdatingCodex}
                    onClick={() => void handleUpdateCodex()}
                    size="small"
                    startIcon={<Download />}
                  >
                    {isUpdatingCodex
                      ? t("settings.codex.updating")
                      : t("settings.codex.update", {
                          version:
                            codexUpdate.status === "available"
                              ? (codexUpdate.latestVersion ?? "")
                              : "",
                        })}
                  </Button>
                ) : codexUpdate.status === "upToDate" ||
                  codexUpdate.status === "checking" ? (
                  <span className="settings-inline-hint" role="status">
                    {t(
                      codexUpdate.status === "upToDate"
                        ? "settings.codex.upToDate"
                        : "settings.codex.checkingUpdate",
                    )}
                  </span>
                ) : null
              ) : null}
            </div>
            {codexUpdateSuccess ? (
              <p className="settings-inline-hint" role="status">
                {t("settings.codex.updateSuccess")}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="codex-settings-card">
        <div className="codex-settings-card-head">
          <div className="codex-settings-card-title">
            <strong>{t("settings.codex.git.title")}</strong>
            <span>{t("settings.codex.git.subtitle")}</span>
          </div>
        </div>
        <div className="codex-settings-card-body">
          <div className="codex-settings-field">
            <span
              className="codex-settings-field-label"
              id={commitStyleLabelId}
            >
              {t("settings.codex.git.style")}
            </span>
            <SegmentedControl aria-labelledby={commitStyleLabelId}>
              {commitMessageStyles.map((style) => (
                <SegmentedControlItem
                  key={style}
                  selected={style === codexGitCommitStyle}
                  onClick={() =>
                    void onUpdateSettings({
                      codexGitCommitStyle: style,
                    }).catch(() => undefined)
                  }
                >
                  {t(commitStyles[style].label)}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <p className="settings-inline-hint">{t(commitStyle.description)}</p>
            <div className="codex-settings-commit-preview">
              <GitCommitHorizontal size={14} aria-hidden />
              <div>
                <strong>{commitStyle.subject}</strong>
                {commitStyle.body ? <p>{commitStyle.body}</p> : null}
              </div>
            </div>
            <p className="settings-inline-hint">
              {t("settings.codex.git.style.projectHint")}
            </p>
          </div>
          <div className="codex-settings-config-grid">
            <div className="codex-settings-field">
              <label htmlFor="codex-git-model-select">
                {t("settings.codex.modelTitle")}
              </label>
              <Select
                id="codex-git-model-select"
                size="small"
                startIcon={<Cpu />}
                value={codexGitModel ?? ""}
                onValueChange={(value) =>
                  void onUpdateSettings({
                    codexGitModel: value || null,
                  }).catch(() => undefined)
                }
                options={gitModelOptions}
              />
            </div>
            <div className="codex-settings-field">
              <span className="codex-settings-field-label" id={fastModeLabelId}>
                {t("settings.codex.git.fastMode")}
              </span>
              <div className="codex-settings-field-row">
                <Switch
                  aria-labelledby={fastModeLabelId}
                  checked={codexGitFastMode}
                  onCheckedChange={(enabled) =>
                    void onUpdateSettings({
                      codexGitFastMode: enabled,
                    }).catch(() => undefined)
                  }
                />
                <span className="settings-inline-hint">
                  {t("settings.codex.git.fastModeHint")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function codexStatusIcon(installation: CodexInstallation) {
  if (installation === "available") {
    return <CheckCircle2 size={16} />;
  }

  if (installation === "missing") {
    return <CircleAlert size={16} />;
  }

  return <CircleHelp size={16} />;
}

function codexStatusLabel(
  installation: CodexInstallation,
  version: string | null,
  t: I18nContextValue["t"],
) {
  if (installation === "available") {
    return version
      ? t("settings.codex.status.availableWithVersion", {
          version: version.replace(/^codex-cli\s+/, ""),
        })
      : t("settings.codex.status.available");
  }

  if (installation === "missing") {
    return t("settings.codex.status.missing");
  }

  return t("settings.codex.status.unknown");
}
