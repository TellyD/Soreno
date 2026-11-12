import {
  Palette,
  PanelLeft,
  PenLine,
  Search,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import "./ShortcutsSettingsSection.css";

const isMacOS = import.meta.env.TAURI_ENV_PLATFORM === "darwin";

// "mod" is Cmd on macOS and Ctrl elsewhere; the last key is a physical key (KeyboardEvent.code).
type Shortcut = {
  label: TranslationKey;
  chords: string[];
  macChords?: string[];
};

const shortcutGroups: {
  title: TranslationKey;
  icon: LucideIcon;
  tone: "primary" | "success" | "warning" | "danger";
  shortcuts: Shortcut[];
}[] = [
  {
    title: "settings.shortcuts.group.navigation",
    icon: PanelLeft,
    tone: "primary",
    shortcuts: [
      { label: "settings.shortcuts.toggleSidebar", chords: ["mod+B"] },
      { label: "settings.shortcuts.toggleGitPanel", chords: ["mod+alt+B"] },
      {
        label: "settings.shortcuts.expandGitPanel",
        chords: ["mod+shift+M"],
      },
      { label: "settings.shortcuts.toggleIssuePanel", chords: ["mod+alt+K"] },
      { label: "settings.shortcuts.toggleServices", chords: ["mod+alt+J"] },
      { label: "settings.shortcuts.nextSession", chords: ["ctrl+Tab"] },
      {
        label: "settings.shortcuts.previousSession",
        chords: ["ctrl+shift+Tab"],
      },
      {
        label: "settings.shortcuts.attentionSession",
        chords: ["mod+shift+U"],
      },
      {
        label: "settings.shortcuts.closeTab",
        chords: ["ctrl+shift+W"],
        macChords: ["mod+W"],
      },
      { label: "settings.shortcuts.agentTextLarger", chords: ["mod+="] },
      { label: "settings.shortcuts.agentTextSmaller", chords: ["mod+-"] },
      { label: "settings.shortcuts.agentTextReset", chords: ["mod+0"] },
      { label: "settings.shortcuts.openSettings", chords: ["mod+,"] },
    ],
  },
  {
    title: "settings.shortcuts.group.search",
    icon: Search,
    tone: "warning",
    shortcuts: [
      { label: "settings.shortcuts.openFile", chords: ["mod+P"] },
      { label: "settings.shortcuts.searchProject", chords: ["mod+shift+F"] },
      { label: "settings.shortcuts.searchFile", chords: ["mod+F"] },
      { label: "settings.shortcuts.nextMatch", chords: ["F3", "mod+G"] },
      {
        label: "settings.shortcuts.previousMatch",
        chords: ["shift+F3", "mod+shift+G"],
      },
      { label: "settings.shortcuts.caseSensitive", chords: ["alt+C"] },
      { label: "settings.shortcuts.wholeWord", chords: ["alt+W"] },
      { label: "settings.shortcuts.regex", chords: ["alt+R"] },
    ],
  },
  {
    title: "settings.shortcuts.group.editing",
    icon: PenLine,
    tone: "danger",
    shortcuts: [
      { label: "settings.shortcuts.save", chords: ["mod+S"] },
      { label: "settings.shortcuts.bold", chords: ["mod+B"] },
      { label: "settings.shortcuts.italic", chords: ["mod+I"] },
      { label: "settings.shortcuts.link", chords: ["mod+K"] },
      { label: "settings.shortcuts.task", chords: ["mod+shift+X"] },
      { label: "settings.shortcuts.indent", chords: ["mod+]"] },
      { label: "settings.shortcuts.outdent", chords: ["mod+["] },
      { label: "settings.shortcuts.submit", chords: ["mod+Enter"] },
    ],
  },
  {
    title: "settings.shortcuts.group.terminal",
    icon: SquareTerminal,
    tone: "success",
    shortcuts: [
      { label: "settings.shortcuts.copy", chords: ["mod+C"] },
      { label: "settings.shortcuts.paste", chords: ["mod+V"] },
      {
        label: "settings.shortcuts.selectAll",
        chords: ["ctrl+shift+A"],
        macChords: ["mod+A"],
      },
      { label: "settings.shortcuts.scrollUp", chords: ["shift+PageUp"] },
      { label: "settings.shortcuts.scrollDown", chords: ["shift+PageDown"] },
    ],
  },
  {
    title: "settings.shortcuts.group.design",
    icon: Palette,
    tone: "primary",
    shortcuts: [
      { label: "settings.shortcuts.design.undo", chords: ["mod+Z"] },
      {
        label: "settings.shortcuts.design.redo",
        chords: ["mod+shift+Z", "ctrl+Y"],
        macChords: ["mod+shift+Z"],
      },
      { label: "settings.shortcuts.design.duplicate", chords: ["mod+D"] },
      {
        label: "settings.shortcuts.design.delete",
        chords: ["Delete"],
        macChords: ["Backspace"],
      },
      // shortcut: Ctrl++ and the numpad +/− also zoom on the board but don't light these rows (chords split on "+"); list them if users look for them here.
      { label: "settings.shortcuts.design.zoomIn", chords: ["mod+="] },
      { label: "settings.shortcuts.design.zoomOut", chords: ["mod+-"] },
      { label: "settings.shortcuts.design.fit", chords: ["shift+1"] },
      { label: "settings.shortcuts.design.zoomReset", chords: ["shift+0"] },
      { label: "settings.shortcuts.design.zoomSelection", chords: ["shift+2"] },
      { label: "settings.shortcuts.design.target", chords: ["T"] },
      { label: "settings.shortcuts.design.prompt", chords: ["/"] },
    ],
  },
];

const macSymbols: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  Enter: "↩",
  Backspace: "⌫",
};

const keyNames: Record<string, string> = {
  mod: isMacOS ? "Cmd" : "Ctrl",
  ctrl: "Ctrl",
  alt: isMacOS ? "Option" : "Alt",
};

const translatedKeys: Record<string, TranslationKey> = {
  shift: "settings.shortcuts.key.shift",
  Enter: "settings.shortcuts.key.enter",
  PageUp: "settings.shortcuts.key.pageUp",
  PageDown: "settings.shortcuts.key.pageDown",
  Delete: "settings.shortcuts.key.delete",
};

const keyCodes: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
  "/": "Slash",
};

function matchesChord(chord: string, event: KeyboardEvent) {
  const keys = chord.split("+");
  const key = keys[keys.length - 1];
  const mod = keys.includes("mod");
  return (
    event.ctrlKey === (keys.includes("ctrl") || (mod && !isMacOS)) &&
    event.metaKey === (mod && isMacOS) &&
    event.altKey === keys.includes("alt") &&
    event.shiftKey === keys.includes("shift") &&
    // shortcut: physical keys, so AZERTY letters A/Q, Z/W and M light up their QWERTY slot.
    event.code ===
      (/^[A-Z]$/.test(key)
        ? `Key${key}`
        : /^[0-9]$/.test(key)
          ? `Digit${key}`
          : (keyCodes[key] ?? key))
  );
}

export function ShortcutsSettingsSection() {
  const { t } = useI18n();
  const [pressed, setPressed] = useState<KeyboardEvent | null>(null);

  useEffect(() => {
    const release = () => setPressed(null);
    document.addEventListener("keydown", setPressed);
    document.addEventListener("keyup", release);
    window.addEventListener("blur", release);
    return () => {
      document.removeEventListener("keydown", setPressed);
      document.removeEventListener("keyup", release);
      window.removeEventListener("blur", release);
    };
  }, []);

  const keyName = (key: string) =>
    keyNames[key] ?? (translatedKeys[key] ? t(translatedKeys[key]) : key);

  return (
    <>
      <div className="settings-panel-header">
        <h3>{t("settings.shortcuts.title")}</h3>
        <p>{t("settings.shortcuts.description")}</p>
      </div>
      {shortcutGroups.map(({ title, icon: Icon, tone, shortcuts }) => (
        <section
          className={`settings-group tone-${tone}`}
          aria-labelledby={title}
          key={title}
        >
          <h4 id={title}>{t(title)}</h4>
          <div className="settings-section shortcut-section">
            <span className="settings-section-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <ul className="shortcut-list" aria-labelledby={title}>
              {shortcuts.map(({ label, chords, macChords }) => (
                <li className="shortcut-row" key={label}>
                  <span>{t(label)}</span>
                  <span className="shortcut-chords">
                    {((isMacOS && macChords) || chords).map((chord, index) => (
                      <span className="shortcut-chord-option" key={chord}>
                        {index > 0 ? (
                          <span className="shortcut-or">
                            {t("settings.shortcuts.or")}
                          </span>
                        ) : null}
                        <kbd
                          className="shortcut-chord"
                          aria-label={chord.split("+").map(keyName).join("+")}
                          data-active={
                            (pressed && matchesChord(chord, pressed)) ||
                            undefined
                          }
                        >
                          {chord.split("+").map((key) => (
                            <kbd key={key}>
                              {(isMacOS && macSymbols[key]) || keyName(key)}
                            </kbd>
                          ))}
                        </kbd>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ))}
    </>
  );
}
