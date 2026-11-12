import { ChevronRight, Info, Sparkle, SquareSlash } from "lucide-react";
import { useId, useState } from "react";
import type { AppSettings } from "../data/settingsApi";
import type { AppSettingsPatch } from "../settings";
import { readChatCommandCatalog } from "../domain/agentConversationCommands";
import {
  agentLaunchPresets,
  ompConversationExecutable,
} from "../domain/agentSessions";
import { useI18n } from "../i18n";
import { AgentProviderIcon } from "./agents/AgentProviderIcon";
import { Switch } from "./ui/Switch";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import "./AgentSettingsSection.css";

export function AgentSettingsSection({
  hiddenAgentPresets,
  agentPresetArgs,
  hiddenChatCommands,
  onUpdateSettings,
}: {
  hiddenAgentPresets: AppSettings["hiddenAgentPresets"];
  agentPresetArgs: AppSettings["agentPresetArgs"];
  hiddenChatCommands: AppSettings["hiddenChatCommands"];
  onUpdateSettings: (patch: AppSettingsPatch) => void;
}) {
  const { t } = useI18n();
  const [catalog] = useState(readChatCommandCatalog);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const commandsId = useId();
  // Hidden commands stay listed when the last chat lacked them, so they can be shown again.
  // shortcut: a removed Soreno command (e.g. a hidden `mockup`) keeps a dead toggle here, and the stored catalog lists it until a chat refreshes it; prune removed names from settings if users notice.
  const chatCommands = [
    ...catalog,
    ...hiddenChatCommands
      .filter((name) => !catalog.some((command) => command.name === name))
      .map((name) => ({ name, description: "" })),
  ];

  return (
    <>
      <div className="settings-panel-header">
        <h3>{t("settings.agents.title")}</h3>
        <p>{t("settings.agents.subtitle")}</p>
      </div>

      <ul className="settings-agent-list">
        {agentLaunchPresets.map(({ executable, name }) => (
          <li key={executable}>
            <label className="settings-agent-row">
              <span className="settings-agent-badge">
                <AgentProviderIcon executable={executable} size={16} />
              </span>
              <span className="settings-agent-title">
                <strong>{name}</strong>
                <span>
                  {executable === ompConversationExecutable ? (
                    t("settings.agents.ompConversation")
                  ) : (
                    <>
                      {t("settings.agents.command")} <code>{executable}</code>
                    </>
                  )}
                </span>
              </span>
              <Switch
                aria-label={t("settings.agents.toggle", { agent: name })}
                checked={!hiddenAgentPresets.includes(executable)}
                onCheckedChange={(visible) =>
                  onUpdateSettings((current) => ({
                    hiddenAgentPresets: visible
                      ? current.hiddenAgentPresets.filter(
                          (hidden) => hidden !== executable,
                        )
                      : current.hiddenAgentPresets.includes(executable)
                        ? current.hiddenAgentPresets
                        : [...current.hiddenAgentPresets, executable],
                  }))
                }
              />
            </label>
            {executable !== ompConversationExecutable && (
              <div className="settings-agent-args">
                <Input
                  size="small"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={t("settings.agents.args", { agent: name })}
                  placeholder={t("settings.agents.argsPlaceholder")}
                  defaultValue={agentPresetArgs[executable]?.join(" ")}
                  // onChange, not onBlur: Escape closes the modal without a blur event.
                  onChange={(event) => {
                    // shortcut: split on whitespace, so one argument cannot contain a space; add quoting if users need it.
                    const args = event.currentTarget.value
                      .split(/\s+/)
                      .filter(Boolean);
                    onUpdateSettings((current) => ({
                      agentPresetArgs: {
                        ...current.agentPresetArgs,
                        [executable]: args,
                      },
                    }));
                  }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="settings-agent-note">
        <Info size={14} aria-hidden="true" />
        <span>{t("settings.agents.installNote")}</span>
      </p>

      <section
        className="settings-agent-commands"
        aria-label={t("settings.agents.chatCommands.title")}
      >
        <div className="settings-panel-header">
          <h3>{t("settings.agents.chatCommands.title")}</h3>
          <p>
            {t(
              catalog.length
                ? "settings.agents.chatCommands.subtitle"
                : "settings.agents.chatCommands.empty",
            )}
          </p>
        </div>
        {chatCommands.length ? (
          <Button
            className="settings-agent-commands-toggle"
            size="small"
            aria-expanded={commandsOpen}
            aria-controls={commandsOpen ? commandsId : undefined}
            startIcon={<ChevronRight aria-hidden="true" />}
            onClick={() => setCommandsOpen(!commandsOpen)}
          >
            {t(
              commandsOpen
                ? "settings.agents.chatCommands.hide"
                : "settings.agents.chatCommands.show",
              { count: chatCommands.length },
            )}
          </Button>
        ) : null}
        {commandsOpen && chatCommands.length ? (
          <ul id={commandsId} className="settings-agent-list">
            {chatCommands.map(({ name, description }) => (
              <li key={name}>
                <label className="settings-agent-row">
                  <span className="settings-agent-badge">
                    {name.startsWith("skill:") ? (
                      <Sparkle size={16} aria-hidden="true" />
                    ) : (
                      <SquareSlash size={16} aria-hidden="true" />
                    )}
                  </span>
                  <span className="settings-agent-title">
                    <strong>/{name}</strong>
                    {description ? <span>{description}</span> : null}
                  </span>
                  <Switch
                    aria-label={t("settings.agents.chatCommands.toggle", {
                      command: name,
                    })}
                    checked={!hiddenChatCommands.includes(name)}
                    onCheckedChange={(visible) =>
                      onUpdateSettings((current) => ({
                        hiddenChatCommands: visible
                          ? current.hiddenChatCommands.filter(
                              (hidden) => hidden !== name,
                            )
                          : current.hiddenChatCommands.includes(name)
                            ? current.hiddenChatCommands
                            : [...current.hiddenChatCommands, name],
                      }))
                    }
                  />
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
