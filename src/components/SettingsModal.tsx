import {
  ALargeSmall,
  Bell,
  Bot,
  Check,
  Files,
  FolderOpen,
  FileText,
  KeyRound,
  Keyboard,
  Languages,
  Palette,
  Scaling,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import {
  languagePreferences,
  useI18n,
  type LanguagePreference,
  type TranslationKey,
} from "../i18n";
import {
  terminalThemePreferences,
  themePreferences,
  type TerminalThemePreference,
  type ThemePreference,
} from "../domain/theme";
import { useAppSettings, type AppSettingsPatch } from "../settings";
import { agentGridLogPath } from "../data/agentSessionsApi";
import { writeClipboardText } from "../data/clipboard";
import { openLogDirectory } from "../data/diagnosticsApi";
import {
  agentTextSizeOptions,
  noteLockMinutesOptions,
  resetWindowSizes,
  type AgentTextSize,
  type NoteLockMinutes,
} from "../data/settingsApi";
import type { NoteEncryption } from "../hooks/useNoteEncryption";
import { dismissNotification, notifyError } from "../notifications";
import { Button } from "./ui/Button";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { CodexSettingsSection } from "./CodexSettingsSection";
import { ShortcutsSettingsSection } from "./ShortcutsSettingsSection";
import { ConfirmationDialog } from "./ui/ConfirmationDialog";
import { DialogOverlay, DialogSurface } from "./ui/Dialog";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl, SegmentedControlItem } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { NotePassphraseDialog } from "./NotePassphraseDialog";
import "./SettingsModal.css";
import { useDismissibleLayer } from "./ui/useDismissibleLayer";

type SettingsModalProps = {
  noteEncryption?: Pick<
    NoteEncryption,
    "changePassphrase" | "keyStatus" | "resetPassphrase" | "resolveKeyStatus"
  >;
  onClose: () => void;
  onResetLayout: () => void;
};

const languagePreferenceLabels: Record<LanguagePreference, TranslationKey> = {
  en: "language.en",
  fr: "language.fr",
  system: "language.system",
};

const themePreferenceLabels: Record<ThemePreference, TranslationKey> = {
  dark: "theme.dark",
  light: "theme.light",
  system: "theme.system",
};

const terminalThemePreferenceLabels: Record<
  TerminalThemePreference,
  TranslationKey
> = {
  app: "theme.app",
  dark: "theme.dark",
  light: "theme.light",
};

type SettingsSection = "general" | "notes" | "agents" | "codex" | "shortcuts";

const settingsNavItems: {
  id: SettingsSection;
  labelKey: TranslationKey;
  Icon: typeof SlidersHorizontal;
}[] = [
  { id: "general", labelKey: "settings.nav.general", Icon: SlidersHorizontal },
  { id: "agents", labelKey: "settings.nav.agents", Icon: Bot },
  { id: "codex", labelKey: "settings.nav.codex", Icon: Sparkles },
  { id: "notes", labelKey: "settings.nav.notes", Icon: FileText },
  { id: "shortcuts", labelKey: "settings.nav.shortcuts", Icon: Keyboard },
];

const settingsUpdateNotificationKey = "settings-update";
const windowSizesNotificationKey = "settings-window-sizes";
const terminalLogNotificationKey = "settings-terminal-log";
const logDirectoryNotificationKey = "settings-log-directory";

export function SettingsModal({
  noteEncryption,
  onClose,
  onResetLayout,
}: SettingsModalProps) {
  const { t } = useI18n();
  const { settings, updateSettings } = useAppSettings();
  const {
    agentNotificationsEnabled,
    languagePreference,
    materialFileIconsEnabled,
    terminalLogEnabled,
    terminalThemePreference,
    themePreference,
  } = settings;
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("general");
  const [resetStatus, setResetStatus] = useState<
    "idle" | "pending" | "success"
  >("idle");
  const [logPathCopied, setLogPathCopied] = useState(false);
  const [pendingUpdateCount, setPendingUpdateCount] = useState(0);
  const modalRef = useDismissibleLayer<HTMLElement>(true, onClose);
  const [isChangingPassphrase, setIsChangingPassphrase] = useState(false);
  const [passphraseChanged, setPassphraseChanged] = useState(false);
  const [passphraseReset, setPassphraseReset] = useState<
    "idle" | "confirming" | "pending" | "success"
  >("idle");
  const hasPassphrase =
    noteEncryption?.keyStatus === "locked" ||
    noteEncryption?.keyStatus === "unlocked";

  useEffect(() => {
    void noteEncryption?.resolveKeyStatus().catch(() => undefined);
  }, []);

  async function applyPatch(patch: AppSettingsPatch) {
    setPendingUpdateCount((count) => count + 1);
    try {
      return await updateSettings(patch);
    } catch (error) {
      notifyError(t("settings.updateError"), {
        key: settingsUpdateNotificationKey,
      });
      throw error;
    } finally {
      setPendingUpdateCount((count) => Math.max(0, count - 1));
    }
  }

  async function handleResetSizes() {
    setResetStatus("pending");
    try {
      await resetWindowSizes();
      onResetLayout();
      dismissNotification(windowSizesNotificationKey);
      setResetStatus("success");
    } catch {
      setResetStatus("idle");
      notifyError(t("settings.windowSizes.error"), {
        key: windowSizesNotificationKey,
        action: {
          label: t("settings.windowSizes.retry"),
          onAction: () => void handleResetSizes(),
        },
      });
    }
  }

  async function handleCopyLogPath() {
    setLogPathCopied(false);
    try {
      await writeClipboardText(await agentGridLogPath());
      dismissNotification(terminalLogNotificationKey);
      setLogPathCopied(true);
    } catch {
      notifyError(t("settings.terminalLog.error"), {
        key: terminalLogNotificationKey,
      });
    }
  }

  async function handleOpenLogDirectory() {
    try {
      await openLogDirectory();
      dismissNotification(logDirectoryNotificationKey);
    } catch {
      notifyError(t("logs.openError"), { key: logDirectoryNotificationKey });
    }
  }

  async function handleResetPassphrase() {
    if (!noteEncryption) return;
    setPassphraseReset("pending");
    try {
      await noteEncryption.resetPassphrase();
      setPassphraseReset("success");
    } catch {
      setPassphraseReset("idle");
      notifyError(t("settings.passphrase.resetError"));
    }
  }

  function handleSettingsPatch(patch: AppSettingsPatch) {
    void applyPatch(patch).catch(() => undefined);
  }

  return (
    <DialogOverlay className="settings-overlay">
      <DialogSurface
        aria-labelledby="settings-modal-title"
        className="settings-modal"
        ref={modalRef}
      >
        <header className="settings-modal-header">
          <h2 id="settings-modal-title">{t("settings.title")}</h2>
          <IconButton
            aria-label={t("settings.close")}
            autoFocus
            onClick={onClose}
          >
            <X />
          </IconButton>
        </header>
        <div className="settings-modal-content">
          <aside className="settings-sidebar" aria-label={t("settings.title")}>
            {settingsNavItems.map(({ id, labelKey, Icon }) => {
              const isActive = id === activeSection;

              return (
                <button
                  type="button"
                  className={isActive ? "selected" : undefined}
                  key={id}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setActiveSection(id)}
                >
                  <Icon size={16} />
                  <span>{t(labelKey)}</span>
                </button>
              );
            })}
          </aside>

          <div className="settings-modal-body">
            <section className="settings-panel">
              {activeSection === "general" ? (
                <>
                  <div className="settings-panel-header">
                    <h3>{t("settings.general.title")}</h3>
                    <p>{t("settings.general.description")}</p>
                  </div>
                  <SettingsGroup
                    title={t("settings.general.theme")}
                    tone="warning"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={Palette} />
                      <div>
                        <h5>{t("settings.appearance.theme.title")}</h5>
                        <p>{t("settings.appearance.theme.description")}</p>
                      </div>
                      <SegmentedControl
                        aria-label={t("settings.appearance.theme.title")}
                      >
                        {themePreferences.map((preference) => (
                          <SegmentedControlItem
                            key={preference}
                            selected={preference === themePreference}
                            onClick={() =>
                              handleSettingsPatch({
                                themePreference: preference,
                              })
                            }
                          >
                            {t(themePreferenceLabels[preference])}
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>
                    </div>
                    <div className="settings-section">
                      <SettingsIcon icon={SquareTerminal} />
                      <div>
                        <h5>{t("settings.appearance.terminalTheme.title")}</h5>
                        <p>
                          {t("settings.appearance.terminalTheme.description")}
                        </p>
                      </div>
                      <SegmentedControl
                        aria-label={t(
                          "settings.appearance.terminalTheme.title",
                        )}
                      >
                        {terminalThemePreferences.map((preference) => (
                          <SegmentedControlItem
                            key={preference}
                            selected={preference === terminalThemePreference}
                            onClick={() =>
                              handleSettingsPatch({
                                terminalThemePreference: preference,
                              })
                            }
                          >
                            {t(terminalThemePreferenceLabels[preference])}
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>
                    </div>
                    <div className="settings-section">
                      <SettingsIcon icon={ALargeSmall} />
                      <div>
                        <h5>{t("settings.appearance.agentTextSize.title")}</h5>
                        <p>
                          {t("settings.appearance.agentTextSize.description")}
                        </p>
                      </div>
                      <Select
                        aria-label={t(
                          "settings.appearance.agentTextSize.title",
                        )}
                        popupClassName="settings-select-popup"
                        value={String(settings.agentTextSize)}
                        options={agentTextSizeOptions.map((size) => ({
                          value: String(size),
                          label: t("design.canvas.zoomLevel", {
                            percent: size,
                          }),
                        }))}
                        onValueChange={(value) =>
                          handleSettingsPatch({
                            agentTextSize: Number(value) as AgentTextSize,
                          })
                        }
                      />
                    </div>
                  </SettingsGroup>
                  <SettingsGroup
                    title={t("settings.general.interface")}
                    tone="primary"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={Languages} />
                      <div>
                        <h5>{t("settings.language.title")}</h5>
                        <p>{t("settings.language.description")}</p>
                      </div>
                      <SegmentedControl
                        aria-label={t("settings.language.title")}
                      >
                        {languagePreferences.map((preference) => (
                          <SegmentedControlItem
                            key={preference}
                            selected={preference === languagePreference}
                            onClick={() =>
                              handleSettingsPatch({
                                languagePreference: preference,
                              })
                            }
                          >
                            {t(languagePreferenceLabels[preference])}
                          </SegmentedControlItem>
                        ))}
                      </SegmentedControl>
                    </div>
                    <div className="settings-section">
                      <SettingsIcon icon={Files} />
                      <div>
                        <h5>{t("settings.fileIcons.title")}</h5>
                        <p>{t("settings.fileIcons.description")}</p>
                      </div>
                      <Switch
                        aria-label={t("settings.fileIcons.title")}
                        checked={materialFileIconsEnabled}
                        onCheckedChange={(enabled) =>
                          handleSettingsPatch({
                            materialFileIconsEnabled: enabled,
                          })
                        }
                      />
                    </div>
                  </SettingsGroup>
                  <SettingsGroup
                    title={t("settings.general.notifications")}
                    tone="warning"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={Bell} />
                      <div>
                        <h5>{t("settings.notifications.enabled.title")}</h5>
                        <p>{t("settings.notifications.enabled.description")}</p>
                      </div>
                      <Switch
                        aria-label={t("settings.notifications.enabled.title")}
                        checked={agentNotificationsEnabled}
                        onCheckedChange={(enabled) =>
                          handleSettingsPatch({
                            agentNotificationsEnabled: enabled,
                          })
                        }
                      />
                    </div>
                  </SettingsGroup>
                  <SettingsGroup
                    title={t("settings.general.terminal")}
                    tone="success"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={ScrollText} />
                      <div>
                        <h5>{t("settings.terminalLog.title")}</h5>
                        <p>{t("settings.terminalLog.description")}</p>
                        {terminalLogEnabled ? (
                          <Button
                            className="settings-section-action"
                            size="small"
                            onClick={() => void handleCopyLogPath()}
                          >
                            {t("settings.terminalLog.copyPath")}
                          </Button>
                        ) : null}
                        {logPathCopied ? (
                          <p role="status">
                            {t("settings.terminalLog.copied")}
                          </p>
                        ) : null}
                      </div>
                      <Switch
                        aria-label={t("settings.terminalLog.title")}
                        checked={terminalLogEnabled}
                        onCheckedChange={(enabled) => {
                          setLogPathCopied(false);
                          handleSettingsPatch({ terminalLogEnabled: enabled });
                        }}
                      />
                    </div>
                  </SettingsGroup>
                  <SettingsGroup
                    title={t("settings.general.diagnostics")}
                    tone="danger"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={FolderOpen} />
                      <div>
                        <h5>{t("settings.logs.title")}</h5>
                        <p>{t("settings.logs.description")}</p>
                      </div>
                      <Button onClick={() => void handleOpenLogDirectory()}>
                        {t("logs.open")}
                      </Button>
                    </div>
                    <div className="settings-section">
                      <SettingsIcon icon={Scaling} />
                      <div>
                        <h5>{t("settings.windowSizes.title")}</h5>
                        <p>{t("settings.windowSizes.description")}</p>
                        {resetStatus === "success" ? (
                          <p role="status">
                            {t("settings.windowSizes.success")}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        disabled={resetStatus === "pending"}
                        aria-busy={resetStatus === "pending"}
                        onClick={() => void handleResetSizes()}
                      >
                        {t(
                          resetStatus === "pending"
                            ? "settings.windowSizes.pending"
                            : "settings.windowSizes.reset",
                        )}
                      </Button>
                    </div>
                  </SettingsGroup>
                </>
              ) : null}
              {activeSection === "notes" ? (
                <>
                  <div className="settings-panel-header">
                    <h3>{t("settings.notes.title")}</h3>
                    <p>{t("settings.notes.description")}</p>
                  </div>
                  <SettingsGroup
                    title={t("settings.notes.encryption")}
                    tone="primary"
                  >
                    <div className="settings-section">
                      <SettingsIcon icon={Timer} />
                      <div>
                        <h5>{t("settings.noteLock.title")}</h5>
                        <p>{t("settings.noteLock.description")}</p>
                      </div>
                      <Select
                        aria-label={t("settings.noteLock.title")}
                        popupClassName="settings-select-popup"
                        value={String(settings.noteLockMinutes)}
                        options={noteLockMinutesOptions.map((minutes) => ({
                          value: String(minutes),
                          label: t("settings.noteLock.minutes", {
                            count: minutes,
                          }),
                        }))}
                        onValueChange={(value) =>
                          handleSettingsPatch({
                            noteLockMinutes: Number(value) as NoteLockMinutes,
                          })
                        }
                      />
                    </div>
                    {noteEncryption ? (
                      <div className="settings-section">
                        <SettingsIcon icon={KeyRound} />
                        <div>
                          <h5>{t("settings.passphrase.title")}</h5>
                          <p>
                            {t(
                              hasPassphrase
                                ? "settings.passphrase.description"
                                : "settings.passphrase.none",
                            )}
                          </p>
                          <div className="settings-section-action settings-section-actions">
                            <Button
                              disabled={!hasPassphrase}
                              size="small"
                              onClick={() => {
                                setPassphraseChanged(false);
                                setPassphraseReset("idle");
                                setIsChangingPassphrase(true);
                              }}
                            >
                              {t("settings.passphrase.change")}
                            </Button>
                            {hasPassphrase ? (
                              <Button
                                size="small"
                                onClick={() => {
                                  setPassphraseChanged(false);
                                  setPassphraseReset("confirming");
                                }}
                              >
                                {t("settings.passphrase.reset")}
                              </Button>
                            ) : null}
                          </div>
                          {passphraseChanged ||
                          passphraseReset === "success" ? (
                            <p role="status">
                              {t(
                                passphraseChanged
                                  ? "settings.passphrase.changed"
                                  : "settings.passphrase.resetDone",
                              )}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </SettingsGroup>
                </>
              ) : null}
              {activeSection === "agents" ? (
                <AgentSettingsSection
                  hiddenAgentPresets={settings.hiddenAgentPresets}
                  agentPresetArgs={settings.agentPresetArgs}
                  hiddenChatCommands={settings.hiddenChatCommands}
                  onUpdateSettings={handleSettingsPatch}
                />
              ) : null}
              {activeSection === "shortcuts" ? (
                <ShortcutsSettingsSection />
              ) : null}
              {activeSection === "codex" ? (
                <CodexSettingsSection
                  settings={settings}
                  onUpdateSettings={applyPatch}
                />
              ) : null}
            </section>
          </div>
        </div>
        <footer className="settings-modal-footer">
          <span className="settings-autosave" role="status" aria-live="polite">
            <Check size={13} />
            {pendingUpdateCount > 0
              ? t("settings.saving")
              : t("settings.autosaved")}
          </span>
          <Button variant="primary" onClick={onClose}>
            {t("settings.done")}
          </Button>
        </footer>
      </DialogSurface>
      {/* Outside the settings surface, whose Tab trap would steal focus from it. */}
      {isChangingPassphrase && noteEncryption ? (
        <NotePassphraseDialog
          mode="change"
          onCancel={() => setIsChangingPassphrase(false)}
          onSubmit={async (passphrase, currentPassphrase) => {
            await noteEncryption.changePassphrase(
              currentPassphrase,
              passphrase,
            );
            setIsChangingPassphrase(false);
            setPassphraseChanged(true);
          }}
        />
      ) : null}
      {(passphraseReset === "confirming" || passphraseReset === "pending") &&
      noteEncryption ? (
        <ConfirmationDialog
          cancelDisabled={passphraseReset === "pending"}
          cancelLabel={t("notes.passphrase.cancel")}
          closeLabel={t("confirmationDialog.close")}
          confirmDisabled={passphraseReset === "pending"}
          confirmLabel={t("settings.passphrase.resetDialog.confirm")}
          confirmPending={passphraseReset === "pending"}
          description={t("settings.passphrase.resetDialog.description")}
          onCancel={() => setPassphraseReset("idle")}
          onConfirm={() => void handleResetPassphrase()}
          title={t("settings.passphrase.resetDialog.title")}
        />
      ) : null}
    </DialogOverlay>
  );
}

function SettingsGroup({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "primary" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const titleId = useId();

  return (
    <section
      className={`settings-group tone-${tone}`}
      aria-labelledby={titleId}
    >
      <h4 id={titleId}>{title}</h4>
      {children}
    </section>
  );
}

function SettingsIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="settings-section-icon" aria-hidden="true">
      <Icon size={16} />
    </span>
  );
}
