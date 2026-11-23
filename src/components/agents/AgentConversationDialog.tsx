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
import {
  agentConversationFormData,
  agentConversationFormError,
  agentConversationFormInputs,
  agentConversationFormValue,
  type AgentConversationFormError,
  type AgentConversationFormField,
  type AgentConversationFormInput,
} from "../../domain/agentConversationForm";
import { isImeComposing } from "../../domain/keyboard";
import { MarkdownInline } from "../MarkdownContent";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
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
          {/* OMP 18.20.3 lists compound bash segments indented below a bare `Command:`. */}
          {dialog.detail.replace(/^Command:[^\S\n]*\n?/, "")}
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
      return (
        <SelectDialog
          dialog={dialog}
          titleId={titleId}
          waiting={waiting}
          onAnswer={onAnswer}
          onKeyDown={onKeyDown}
          s={s}
        />
      );
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
    case "form":
      return (
        <FormDialog
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
  context,
  titleId,
  waiting,
  onKeyDown,
  actions,
  children,
  s,
}: {
  kind: Dialog["kind"];
  title: string;
  context?: string;
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
      {context || children ? (
        <div className="agent-conversation-dialog-body">
          {context ? (
            <p className="agent-conversation-dialog-message">{context}</p>
          ) : null}
          {children}
        </div>
      ) : null}
      <div className="agent-conversation-dialog-actions">{actions}</div>
    </section>
  );
}

function SelectDialog({
  dialog,
  titleId,
  waiting,
  onAnswer,
  onKeyDown,
  s,
}: {
  dialog: Extract<Dialog, { kind: "select" }>;
  titleId: string;
  waiting: number;
  onAnswer: (answer: AgentConversationDialogAnswer) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  s: Strings;
}) {
  const initial = useRef<HTMLElement>(null);
  useEffect(() => {
    const row = initial.current?.closest<HTMLElement>(
      ".agent-conversation-dialog-option",
    );
    const body = row?.closest<HTMLElement>(".agent-conversation-dialog-body");
    // Not scrollIntoView: a re-send remounts at the top, and only the body may scroll.
    if (row && body) {
      const top =
        row.getBoundingClientRect().top - body.getBoundingClientRect().top;
      if (top < 0) body.scrollTop += top;
      else if (top + row.offsetHeight > body.clientHeight)
        body.scrollTop += top + row.offsetHeight - body.clientHeight;
    }
    focusUnlessTyping(initial.current);
  }, [dialog.id]);
  // A callback: the initial option is a button or a checkbox span.
  const setInitial = (element: HTMLElement | null) => {
    initial.current = element;
  };
  return (
    <DialogFrame
      kind="select"
      title={dialog.title}
      context={dialog.context}
      titleId={titleId}
      waiting={waiting}
      onKeyDown={onKeyDown}
      s={s}
      actions={
        <Button size="small" onClick={() => onAnswer({ cancelled: true })}>
          {s.dialogCancel}
        </Button>
      }
    >
      <div className="agent-conversation-dialog-options">
        {dialog.options.map((option, index) => {
          const ref = index === dialog.initial ? setInitial : undefined;
          const description = option.description ? (
            <small>
              <MarkdownInline content={option.description} />
            </small>
          ) : null;
          // OMP re-sends a checkbox list after each toggle, focused on the toggled option.
          return option.marked && dialog.marker === "checkbox" ? (
            <label
              key={option.label}
              className="agent-conversation-dialog-option is-check"
            >
              <Checkbox
                ref={ref}
                checked={option.checked}
                onCheckedChange={() => onAnswer({ value: option.label })}
                // Base UI ignores Enter on a checkbox; here it takes the option like a click.
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    isImeComposing(event.nativeEvent) ||
                    event.defaultPrevented
                  )
                    return;
                  event.preventDefault();
                  onAnswer({ value: option.label });
                }}
              />
              <span>{option.label}</span>
              {description}
            </label>
          ) : (
            <button
              key={option.label}
              ref={ref}
              type="button"
              className={`agent-conversation-dialog-option${option.marked ? " is-check" : ""}`}
              aria-pressed={option.marked ? option.checked : undefined}
              onClick={() => onAnswer({ value: option.label })}
            >
              {option.marked ? (
                <span
                  className="agent-conversation-dialog-radio"
                  aria-hidden="true"
                />
              ) : null}
              <span>{option.label}</span>
              {description}
            </button>
          );
        })}
      </div>
    </DialogFrame>
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
      context={dialog.context}
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

const FOCUSABLE =
  "input:not([tabindex='-1']), textarea, button, [role='checkbox']";

/** Input types drawn natively; the others take a text field (`range` a number one), as OMP checks them as text. */
const INPUT_TYPES = new Set([
  "text",
  "email",
  "url",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "tel",
  "search",
  "password",
]);

/** OMP 19.1.0: an `ask` HTML form answered whole; OMP fails the call on data it refuses, so errors block sending. */
function FormDialog({
  dialog,
  titleId,
  waiting,
  onAnswer,
  onKeyDown,
  s,
}: {
  dialog: Extract<Dialog, { kind: "form" }>;
  titleId: string;
  waiting: number;
  onAnswer: (answer: AgentConversationDialogAnswer) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  s: Strings;
}) {
  const { form } = dialog;
  const [inputs, setInputs] = useState(() => agentConversationFormInputs(form));
  // Errors show once the user tries to send, then follow each change.
  const [showErrors, setShowErrors] = useState(false);
  const fields = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(
    () =>
      focusUnlessTyping(
        fields.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null,
      ),
    [dialog.id],
  );
  const errors = form.fields.map((field, index) =>
    agentConversationFormError(
      field,
      agentConversationFormValue(field, inputs[index]),
    ),
  );

  function submit() {
    const invalid = errors.findIndex(Boolean);
    if (invalid < 0) {
      onAnswer({ data: agentConversationFormData(form, inputs) });
      return;
    }
    setShowErrors(true);
    fields.current
      ?.querySelector(`[data-field="${invalid}"]`)
      ?.querySelector<HTMLElement>(FOCUSABLE)
      ?.focus();
  }

  return (
    <DialogFrame
      kind="form"
      title={s.askTitle}
      titleId={titleId}
      waiting={waiting}
      onKeyDown={onKeyDown}
      s={s}
      actions={
        <>
          <Button size="small" variant="primary" onClick={submit}>
            {s.askSubmit}
          </Button>
          <Button size="small" onClick={() => onAnswer({ cancelled: true })}>
            {s.dialogCancel}
          </Button>
        </>
      }
    >
      <div ref={fields} className="agent-conversation-form">
        {form.blocks.map((block, key) => {
          switch (block.kind) {
            case "text":
              return block.heading ? (
                <h4 key={key}>{block.text}</h4>
              ) : (
                <p key={key} className="agent-conversation-dialog-message">
                  {block.text}
                </p>
              );
            case "list": {
              const List = block.ordered ? "ol" : "ul";
              return (
                <List key={key} className="agent-conversation-dialog-message">
                  {block.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </List>
              );
            }
            case "pre":
              return (
                <pre key={key} className="agent-conversation-dialog-detail">
                  {block.text}
                </pre>
              );
            case "table":
              return (
                <div key={key} className="markdown-table">
                  <table>
                    <tbody>
                      {block.rows.map((row, index) => (
                        <tr key={index}>
                          {row.map((cell, column) =>
                            index < block.headerRows ? (
                              <th key={column}>{cell}</th>
                            ) : (
                              <td key={column}>{cell}</td>
                            ),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            case "image":
              // shortcut: a local path shows its alt text only; resolve it against the run's directory, local or remote, if agents rely on it.
              return /^(https?:|data:image\/)/i.test(block.src) ? (
                <img key={key} src={block.src} alt={block.alt} />
              ) : block.alt ? (
                <p key={key} className="agent-conversation-dialog-message">
                  {block.alt}
                </p>
              ) : null;
            case "field": {
              const index = form.fields.indexOf(block.field);
              return (
                <FormField
                  key={key}
                  index={index}
                  id={`${id}-${index}`}
                  field={block.field}
                  input={inputs[index]}
                  error={showErrors ? errors[index] : undefined}
                  onChange={(input) =>
                    setInputs((current) =>
                      current.map((value, position) =>
                        position === index ? input : value,
                      ),
                    )
                  }
                  onSubmit={submit}
                  s={s}
                />
              );
            }
          }
        })}
      </div>
    </DialogFrame>
  );
}

function FormField({
  index,
  id,
  field,
  input,
  error,
  onChange,
  onSubmit,
  s,
}: {
  index: number;
  id: string;
  field: AgentConversationFormField;
  input: AgentConversationFormInput;
  error: AgentConversationFormError | undefined;
  onChange: (input: AgentConversationFormInput) => void;
  onSubmit: () => void;
  s: Strings;
}) {
  const errorId = `${id}-error`;
  const invalid = error
    ? { "aria-invalid": true, "aria-describedby": errorId }
    : {};
  const message = error ? (
    <small id={errorId} className="agent-conversation-form-error">
      {s.formError(error)}
    </small>
  ) : null;
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isImeComposing(event.nativeEvent)) return;
    event.preventDefault();
    onSubmit();
  };

  if (field.kind === "text") {
    const text = typeof input === "string" ? input : "";
    return (
      <label className="agent-conversation-form-field" data-field={index}>
        <span className="agent-conversation-form-label">{field.label}</span>
        {field.type === "textarea" ? (
          <textarea
            className="agent-conversation-dialog-editor"
            rows={field.rows}
            placeholder={field.placeholder}
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...invalid}
          />
        ) : (
          <Input
            type={
              INPUT_TYPES.has(field.type)
                ? field.type
                : field.type === "range"
                  ? "number"
                  : "text"
            }
            placeholder={field.placeholder}
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={submitOnEnter}
            {...invalid}
          />
        )}
        {message}
      </label>
    );
  }

  const choice = typeof input === "string" ? { checked: [], other: "" } : input;
  let control: ReactNode;
  if (field.select && !field.multi)
    control = (
      <Select
        aria-label={field.question}
        value={String(choice.checked[0] ?? "")}
        options={field.options.map((option, position) => ({
          value: String(position),
          label: option.label,
          disabled: option.disabled,
        }))}
        onValueChange={(value) =>
          onChange({ checked: [Number(value)], other: "" })
        }
        {...invalid}
      />
    );
  else
    control = (
      <div
        role="group"
        aria-label={field.question}
        className="agent-conversation-dialog-options"
        {...invalid}
      >
        {field.options.map((option, position) =>
          field.multi ? (
            <label
              key={position}
              className="agent-conversation-dialog-option is-check"
            >
              <Checkbox
                checked={choice.checked.includes(position)}
                disabled={option.disabled}
                onCheckedChange={(checked) =>
                  onChange({
                    ...choice,
                    checked: checked
                      ? [...choice.checked, position]
                      : choice.checked.filter((value) => value !== position),
                  })
                }
              />
              <span>{option.label}</span>
            </label>
          ) : (
            <button
              key={position}
              type="button"
              className="agent-conversation-dialog-option is-check"
              aria-pressed={choice.checked.includes(position)}
              disabled={option.disabled}
              onClick={() => onChange({ checked: [position], other: "" })}
            >
              <span
                className="agent-conversation-dialog-radio"
                aria-hidden="true"
              />
              <span>{option.label}</span>
            </button>
          ),
        )}
      </div>
    );
  return (
    <div className="agent-conversation-form-field" data-field={index}>
      {field.label ? (
        <span className="agent-conversation-form-label">{field.label}</span>
      ) : null}
      {control}
      {field.other ? (
        <Input
          aria-label={s.askCustom(field.question)}
          placeholder={s.askCustomPlaceholder}
          value={choice.other}
          onChange={(event) =>
            onChange({
              // A radio's "Other" answer replaces its option.
              checked: field.multi ? choice.checked : [],
              other: event.currentTarget.value,
            })
          }
          onKeyDown={submitOnEnter}
        />
      ) : null}
      {message}
    </div>
  );
}
