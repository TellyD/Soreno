import { Sparkle } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { listSkills } from "../../data/skillsApi";
import {
  agentConversationCommandAt,
  insertAgentConversationCommand,
  type AgentConversationCommandToken,
} from "../../domain/agentConversationCommands";
import { automationSkillToken } from "../../domain/automations";
import { isImeComposing, listNavigation } from "../../domain/keyboard";
import { filterSkills, type InstalledSkill } from "../../domain/skills";
import { useI18n } from "../../i18n";
import { MenuItem, MenuSurface } from "../ui/Menu";

const SKILL_RESULTS = 50;

type AutomationPromptFieldProps = {
  value: string;
  onChange: (value: string) => void;
  executable: string;
  /** Lists its skills and its server's; null while the project is not connected. */
  projectId: string | null;
  labelId: string;
  hintId: string;
};

/** The prompt, where `/` completes the project's and server's skills in the agent's syntax. */
export function AutomationPromptField({
  value,
  onChange,
  executable,
  projectId,
  labelId,
  hintId,
}: AutomationPromptFieldProps) {
  const { t } = useI18n();
  const listId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [token, setToken] = useState<AgentConversationCommandToken | null>(
    null,
  );
  const [skills, setSkills] = useState<{
    projectId: string;
    skills: InstalledSkill[];
  } | null>(null);
  const [index, setIndex] = useState(0);
  const wanted = token !== null && projectId !== null;
  const loaded = skills?.projectId === projectId ? skills.skills : null;

  // shortcut: a failed read is kept as an empty list until the panel remounts; retry failures on the
  // next `/` if servers often drop while composing.
  // Read on the first `/`, not on opening the panel: listing skills runs commands on the server.
  useEffect(() => {
    if (!wanted || loaded) return;
    let current = true;
    const target = projectId;
    void Promise.allSettled([
      listSkills({ scope: "project", projectId: target }),
      listSkills({ scope: "global", projectId: target }),
    ]).then((results) => {
      if (!current) return;
      const byName = new Map<string, InstalledSkill>();
      for (const result of results)
        if (result.status === "fulfilled")
          for (const skill of result.value.skills)
            if (!byName.has(skill.name)) byName.set(skill.name, skill);
      setSkills({
        projectId: target,
        skills: [...byName.values()].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      });
    });
    return () => {
      current = false;
    };
  }, [wanted, loaded, projectId]);

  // shortcut: keyed on `value`, so choosing the skill already written leaves the caret mid-name; run
  // after every render, as the conversation composer does, if users re-pick written skills.
  useEffect(() => {
    if (pendingCaret.current === null || !textarea.current) return;
    textarea.current.setSelectionRange(
      pendingCaret.current,
      pendingCaret.current,
    );
    pendingCaret.current = null;
  }, [value]);

  useEffect(() => {
    document
      .getElementById(`${listId}-${index}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [listId, index]);

  // shortcut: lists every skill of the project and server, including those the chosen agent does not read; filter by each CLI's skill folders if users pick unreadable ones.
  const matches =
    token && loaded
      ? filterSkills(loaded, token.query).slice(0, SKILL_RESULTS)
      : [];

  function track(element: HTMLTextAreaElement) {
    const caret = element.selectionStart;
    setToken(
      caret === element.selectionEnd
        ? agentConversationCommandAt(element.value, caret)
        : null,
    );
    setIndex(0);
  }

  function choose(skill: InstalledSkill) {
    if (!token) return;
    const { prefix, name } = automationSkillToken(executable, skill.name);
    const next = insertAgentConversationCommand(value, token, name, prefix);
    pendingCaret.current = next.caret;
    setToken(null);
    onChange(next.text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeComposing(event.nativeEvent) || matches.length === 0) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setToken(null);
      return;
    }
    const move = listNavigation(event.key, matches.length);
    if (move && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setIndex(move);
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      choose(matches[index] ?? matches[0]);
    }
  }

  return (
    <div className="automations-prompt-field">
      <textarea
        ref={textarea}
        className="automations-prompt"
        value={value}
        maxLength={16 * 1024}
        placeholder={t("automations.field.promptPlaceholder")}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-expanded={matches.length > 0}
        aria-activedescendant={
          matches.length > 0 ? `${listId}-${index}` : undefined
        }
        onChange={(event) => {
          onChange(event.target.value);
          track(event.target);
        }}
        onSelect={(event) => track(event.currentTarget)}
        onKeyDown={onKeyDown}
        onBlur={() => setToken(null)}
      />
      {matches.length > 0 ? (
        <MenuSurface
          id={listId}
          role="listbox"
          aria-label={t("automations.skills")}
          className="automations-skills"
        >
          {matches.map((skill, position) => (
            <MenuItem
              key={skill.name}
              id={`${listId}-${position}`}
              role="option"
              aria-selected={position === index}
              selected={position === index}
              tabIndex={-1}
              leading={<Sparkle />}
              title={skill.description ?? skill.name}
              // Keeps the focus, and so the caret, in the prompt.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setIndex(position)}
              onClick={() => choose(skill)}
            >
              {skill.name}
              {skill.description ? (
                <span className="automations-skill-detail">
                  {skill.description}
                </span>
              ) : null}
            </MenuItem>
          ))}
        </MenuSurface>
      ) : null}
    </div>
  );
}
