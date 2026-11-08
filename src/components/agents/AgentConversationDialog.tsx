import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  AgentConversationAskQuestion,
  AgentConversationDialog as Dialog,
  AgentConversationDialogAnswer,
} from "../../domain/agentConversation";
import { isImeComposing } from "../../domain/keyboard";
import { MarkdownInline } from "../MarkdownContent";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import type { AgentStrings } from "./agentStrings";
import "./AgentConversationDialog.css";

/** A new request takes the focus only from nowhere or from its own conversation, unless the user is typing there. */
function focusUnlessTyping(target: HTMLElement | null) {
  const active = document.activeElement;
  if (
    active !== document.body &&
    !target?.closest(".agent-conversation")?.contains(active)
  )
    return;
  const typing =
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement &&
      ["text", "search", "url", "email", "tel", "password", "number"].includes(
        active.type,
      ));
  if (typing && active.value.trim()) return;
  // The radio already shows the selection; the ring returns on keyboard navigation.
  target?.focus({ preventScroll: true, focusVisible: false });
}

type Strings = AgentStrings["conversation"];

/**
 * The oldest request OMP waits on, docked above the composer: one decision at a time.
 * Enter takes the first choice and Escape the refusal while focus is inside it.
 */
export function AgentConversationDialog({
  dialog,
  waiting,
  onAnswer,
  s,
}: {
  dialog: Dialog;
  /** Further requests queued behind this one. */
  waiting: number;
  onAnswer: (answer: AgentConversationDialogAnswer) => void;
  s: Strings;
}) {
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => focusUnlessTyping(primary.current), [dialog.id]);

  const cancel = () => onAnswer({ cancelled: true });

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (isImeComposing(event.nativeEvent) || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (dialog.kind === "approval") {
        const refusal = dialog.options.find((option) => option === "Deny");
        onAnswer(refusal ? { value: refusal } : { cancelled: true });
      } else cancel();
    }
  }

  let title: string;
  let body: ReactNode;
  let actions: ReactNode;
  switch (dialog.kind) {
    case "approval": {
      title = s.approvalTitle(dialog.tool);
      body = dialog.detail ? (
        <pre className="agent-conversation-dialog-detail">
          {dialog.detail.replace(/^Command:\s*/, "")}
        </pre>
      ) : null;
      actions = dialog.options.map((option, index) => (
        <Button
          key={option}
          ref={index === 0 ? primary : undefined}
          size="small"
          variant={index === 0 ? "primary" : "secondary"}
          onClick={() => onAnswer({ value: option })}
          endIcon={
            index === 0 ? (
              <kbd>{s.enterKey}</kbd>
            ) : option === "Deny" ? (
              <kbd>{s.escapeKey}</kbd>
            ) : undefined
          }
        >
          {s.approvalChoice(option)}
        </Button>
      ));
      break;
    }
    case "select":
      title = dialog.title;
      body = (
        <div className="agent-conversation-dialog-options">
          {dialog.options.map((option, index) => (
            <button
              key={option.label}
              ref={index === 0 ? primary : undefined}
              type="button"
              className="agent-conversation-dialog-option"
              onClick={() => onAnswer({ value: option.label })}
            >
              <span>{option.label}</span>
              {option.description ? (
                <small>
                  <MarkdownInline content={option.description} />
                </small>
              ) : null}
            </button>
          ))}
        </div>
      );
      actions = (
        <Button size="small" onClick={cancel}>
          {s.dialogCancel}
        </Button>
      );
      break;
    case "confirm":
      title = dialog.title;
      body = dialog.message ? (
        <p className="agent-conversation-dialog-message">{dialog.message}</p>
      ) : null;
      actions = (
        <>
          <Button
            ref={primary}
            size="small"
            variant="primary"
            onClick={() => onAnswer({ confirmed: true })}
          >
            {s.dialogConfirm}
          </Button>
          <Button size="small" onClick={() => onAnswer({ confirmed: false })}>
            {s.dialogDecline}
          </Button>
        </>
      );
      break;
    case "input":
    case "editor":
      return (
        <TextDialog
          dialog={dialog}
          titleId={titleId}
          waiting={waiting}
          onAnswer={onAnswer}
          onKeyDown={onKeyDown}
          s={s}
        />
      );
    case "ask":
      return (
        <AskDialog
          dialog={dialog}
          titleId={titleId}
          waiting={waiting}
          onAnswer={onAnswer}
          onKeyDown={onKeyDown}
          s={s}
        />
      );
  }
  return (
    <DialogFrame
      kind={dialog.kind}
      title={title}
      titleId={titleId}
      waiting={waiting}
      onKeyDown={onKeyDown}
      s={s}
      actions={actions}
    >
      {body}
    </DialogFrame>
  );
}

function DialogFrame({
  kind,
  title,
  titleId,
  waiting,
  onKeyDown,
  actions,
  children,
  s,
}: {
  kind: Dialog["kind"];
  title: string;
  titleId: string;
  waiting: number;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  actions: ReactNode;
  children?: ReactNode;
  s: Strings;
}) {
  return (
    <section
      className={`agent-conversation-dialog is-${kind}`}
      role="group"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <header>
        <h3 id={titleId}>{title}</h3>
        {waiting > 0 ? (
          <span className="agent-conversation-dialog-waiting">
            {s.dialogsWaiting(waiting)}
          </span>
        ) : null}
      </header>
      {children ? (
        <div className="agent-conversation-dialog-body">{children}</div>
      ) : null}
      <div className="agent-conversation-dialog-actions">{actions}</div>
    </section>
  );
}

function TextDialog({
  dialog,
  titleId,
  waiting,
  onAnswer,
  onKeyDown,
  s,
}: {
  dialog: Extract<Dialog, { kind: "input" | "editor" }>;
  titleId: string;
  waiting: number;
  onAnswer: (answer: AgentConversationDialogAnswer) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  s: Strings;
}) {
  const [value, setValue] = useState(
    dialog.kind === "editor" ? dialog.prefill : "",
  );
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => focusUnlessTyping(field.current), [dialog.id]);
  return (
    <DialogFrame
      kind={dialog.kind}
      title={dialog.title}
      titleId={titleId}
      waiting={waiting}
      onKeyDown={onKeyDown}
      s={s}
      actions={
        <>
          <Button
            size="small"
            variant="primary"
            onClick={() => onAnswer({ value })}
          >
            {s.dialogSubmit}
          </Button>
          <Button size="small" onClick={() => onAnswer({ cancelled: true })}>
            {s.dialogCancel}
          </Button>
        </>
      }
    >
      {dialog.kind === "editor" ? (
        <textarea
          ref={field}
          className="agent-conversation-dialog-editor"
          aria-labelledby={titleId}
          value={value}
          rows={6}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      ) : (
        <Input
          ref={field}
          aria-labelledby={titleId}
          placeholder={dialog.placeholder}
          type={dialog.secret ? "password" : undefined}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || isImeComposing(event.nativeEvent))
              return;
            event.preventDefault();
            onAnswer({ value });
          }}
        />
      )}
    </DialogFrame>
  );
}

type AskAnswer = { selected: string[]; custom: string };

function initialAnswer(question: AgentConversationAskQuestion): AskAnswer {
  const recommended =
    question.recommended !== null
      ? question.options[question.recommended]?.label
      : undefined;
  return { selected: recommended ? [recommended] : [], custom: "" };
}

function AskDialog({
  dialog,
  titleId,
  waiting,
  onAnswer,
  onKeyDown,
  s,
}: {
  dialog: Extract<Dialog, { kind: "ask" }>;
  titleId: string;
  waiting: number;
  onAnswer: (answer: AgentConversationDialogAnswer) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  s: Strings;
}) {
  const [answers, setAnswers] = useState(() =>
    dialog.questions.map(initialAnswer),
  );
  const submit = useRef<HTMLButtonElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  useEffect(
    () => focusUnlessTyping(firstOption.current ?? submit.current),
    [dialog.id],
  );

  function update(index: number, next: Partial<AskAnswer>) {
    setAnswers((current) =>
      current.map((answer, position) =>
        position === index ? { ...answer, ...next } : answer,
      ),
    );
  }

  const single = dialog.questions.length === 1 ? dialog.questions[0] : null;
  // OMP reads a blank answer to a lone question as a cancel; in a round it leaves only that question unanswered.
  const complete =
    !single ||
    single.multi ||
    answers[0].selected.length > 0 ||
    answers[0].custom.trim();
  return (
    <DialogFrame
      kind="ask"
      title={single?.question ?? s.askTitle}
      titleId={titleId}
      waiting={waiting}
      onKeyDown={onKeyDown}
      s={s}
      actions={
        <>
          <Button
            ref={submit}
            size="small"
            variant="primary"
            disabled={!complete}
            onClick={() =>
              onAnswer({
                answers: dialog.questions.map((question, index) => {
                  const { selected, custom } = answers[index];
                  const text = custom.trim();
                  return !question.multi && text
                    ? {
                        id: question.id,
                        selectedOptions: [],
                        customInput: text,
                      }
                    : {
                        id: question.id,
                        selectedOptions: selected,
                        ...(text ? { customInput: text } : {}),
                      };
                }),
              })
            }
          >
            {s.askSubmit}
          </Button>
          <Button size="small" onClick={() => onAnswer({ cancelled: true })}>
            {s.dialogCancel}
          </Button>
        </>
      }
    >
      {dialog.questions.map((question, index) => (
        <fieldset key={question.id} className="agent-conversation-ask">
          {single ? null : <legend>{question.question}</legend>}
          <div className="agent-conversation-dialog-options">
            {question.options.map((option, optionIndex) => {
              const selected = answers[index].selected.includes(option.label);
              const label = (
                <span>
                  {option.label}
                  {optionIndex === question.recommended ? (
                    <span className="agent-conversation-dialog-recommended">
                      {s.askRecommended}
                    </span>
                  ) : null}
                </span>
              );
              return question.multi ? (
                <label
                  key={option.label}
                  className="agent-conversation-dialog-option is-check"
                >
                  <Checkbox
                    checked={selected}
                    onCheckedChange={(checked) =>
                      update(index, {
                        selected: checked
                          ? [...answers[index].selected, option.label]
                          : answers[index].selected.filter(
                              (label) => label !== option.label,
                            ),
                      })
                    }
                  />
                  {label}
                  {option.description ? (
                    <small>
                      <MarkdownInline content={option.description} />
                    </small>
                  ) : null}
                </label>
              ) : (
                <button
                  key={option.label}
                  ref={single && optionIndex === 0 ? firstOption : undefined}
                  type="button"
                  className="agent-conversation-dialog-option is-check"
                  aria-pressed={selected}
                  onClick={() =>
                    update(index, {
                      selected: selected && !single ? [] : [option.label],
                      custom: "",
                    })
                  }
                >
                  <span
                    className="agent-conversation-dialog-radio"
                    aria-hidden="true"
                  />
                  {label}
                  {option.description ? (
                    <small>
                      <MarkdownInline content={option.description} />
                    </small>
                  ) : null}
                </button>
              );
            })}
          </div>
          <Input
            aria-label={s.askCustom(question.question)}
            placeholder={s.askCustomPlaceholder}
            value={answers[index].custom}
            onChange={(event) =>
              update(index, {
                custom: event.currentTarget.value,
                ...(question.multi ? {} : { selected: [] }),
              })
            }
          />
        </fieldset>
      ))}
    </DialogFrame>
  );
}
