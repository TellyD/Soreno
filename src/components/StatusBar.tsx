import { Clock3, Moon, Sun } from "lucide-react";
import type { Ref } from "react";
import { version } from "../../package.json";
import type { Vault } from "../domain/vaults";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { AppUpdateStatus } from "./AppUpdateStatus";
import { ReleaseNotes } from "./ReleaseNotes";
import { IconButton } from "./ui/IconButton";
import { SubscriptionUsage } from "./SubscriptionUsage";
import { VaultPicker } from "./VaultPicker";
import "./StatusBar.css";

type StatusBarProps = {
  activeVault: Vault | null;
  cancelPreparedClose: () => void;
  connectionStatusRef?: Ref<HTMLDivElement>;
  isChangingVault: boolean;
  onCreateVault: (name: string) => Promise<void>;
  onDeleteVault: (id: string) => Promise<void>;
  onRenameVault: (id: string, name: string) => Promise<void>;
  onSelectVault: (id: string) => Promise<void>;
  prepareToClose: () => Promise<boolean>;
  saveStateText: string;
  showNotesInfo: boolean;
  vaults: Vault[];
};

export function StatusBar({
  activeVault,
  cancelPreparedClose,
  connectionStatusRef,
  isChangingVault,
  onCreateVault,
  onDeleteVault,
  onRenameVault,
  onSelectVault,
  prepareToClose,
  saveStateText,
  showNotesInfo,
  vaults,
}: StatusBarProps) {
  const { t } = useI18n();
  const { setThemePreference, theme } = useTheme();
  const nextThemePreference = theme === "dark" ? "light" : "dark";
  const themeToggleLabel =
    theme === "dark" ? t("status.themeLight") : t("status.themeDark");
  const ThemeToggleIcon = theme === "dark" ? Sun : Moon;

  return (
    <footer className="status-bar" aria-label={t("status.barAria")}>
      {showNotesInfo ? (
        <VaultPicker
          activeVault={activeVault}
          isChangingVault={isChangingVault}
          onCreateVault={onCreateVault}
          onDeleteVault={onDeleteVault}
          onRenameVault={onRenameVault}
          onSelectVault={onSelectVault}
          vaults={vaults}
        />
      ) : null}
      {showNotesInfo ? (
        <span>
          <Clock3 size={13} /> {saveStateText || t("status.ready")}
        </span>
      ) : null}
      <SubscriptionUsage />
      <AppUpdateStatus
        cancelPreparedClose={cancelPreparedClose}
        prepareToClose={prepareToClose}
      />
      <span className="status-spacer" />
      <div className="status-connection" ref={connectionStatusRef} />
      <ReleaseNotes version={version} />
      <IconButton
        aria-label={themeToggleLabel}
        aria-pressed={theme === "dark"}
        size="small"
        title={themeToggleLabel}
        onClick={() => void setThemePreference(nextThemePreference)}
      >
        <ThemeToggleIcon />
      </IconButton>
    </footer>
  );
}
