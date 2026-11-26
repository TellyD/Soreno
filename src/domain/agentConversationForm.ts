// OMP 19.1.0 sends the `ask` tool's HTML form whole (`form` request). This follows `pi-tui/html-form` (MIT)
// for fields, values and checks; OMP 19.1 rejects an answer failing them, 19.2.0 only flags it.

export type AgentConversationFormChoice = {
  kind: "choice";
  name: string;
  /** What the field asks, for its accessible name. */
  question: string;
  /** Checkbox group or `<select multiple>`. */
  multi: boolean;
  select: boolean;
  /** A `<select>`'s own label; radio and checkbox groups ask through the text around them. */
  label: string;
  /** Radio and checkbox groups of two or more options without their own "Other" take a free-text answer. */
  other: boolean;
  options: {
    value: string;
    label: string;
    checked: boolean;
    disabled: boolean;
  }[];
  required: boolean;
};

type AgentConversationFormText = {
  kind: "text";
  name: string;
  question: string;
  /** The `<input type>`, or `textarea`. */
  type: string;
  label: string;
  value: string;
  placeholder: string;
  required: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  rows: number;
};

export type AgentConversationFormField =
  AgentConversationFormChoice | AgentConversationFormText;

export type AgentConversationFormBlock =
  | { kind: "text"; text: string; heading: boolean }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: string[][]; headerRows: number }
  | { kind: "image"; src: string; alt: string }
  | { kind: "field"; field: AgentConversationFormField };

export type AgentConversationForm = {
  blocks: AgentConversationFormBlock[];
  fields: AgentConversationFormField[];
};

/** A choice field's checked option indices and "Other" text, or a text field's text. */
export type AgentConversationFormInput =
  { checked: number[]; other: string } | string;

export type AgentConversationFormValue = string | number | string[];

export type AgentConversationFormError =
  | { kind: "required" | "selectOne" | "number" | "email" | "url" | "pattern" }
  | { kind: "min" | "max" | "minLength" | "maxLength"; limit: number };

const SKIPPED = new Set([
  "button",
  "head",
  "iframe",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figure",
  "figcaption",
  "footer",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "section",
]);
const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "summary"]);
const IGNORED_INPUTS = new Set(["button", "file", "image", "reset", "submit"]);
const CONTROLS = "input, select, textarea";

/** Runs of whitespace become one space, spaces next to a `<br>` vanish. */
function normalize(text: string) {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

function numberAttr(element: Element, name: string) {
  const raw = element.getAttribute(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Text of `element` without its controls: a picture reads as its alt text. */
function textOf(element: Element) {
  let text = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node as Text).data.replace(/\s+/g, " ");
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName;
    if (SKIPPED.has(tag) || tag === "svg" || node.matches(CONTROLS)) return;
    if (tag === "br") text += "\n";
    else if (tag === "img") text += node.getAttribute("alt") ?? "";
    else {
      const block = BLOCK.has(tag) || HEADING.has(tag);
      if (block) text += " ";
      node.childNodes.forEach(visit);
      if (block) text += " ";
    }
  };
  element.childNodes.forEach(visit);
  return normalize(text);
}

/** Parses agent-written form HTML; content outside the first `<form>` is ignored when one exists. */
export function parseAgentConversationForm(
  html: string,
): AgentConversationForm {
  const document = new DOMParser().parseFromString(html, "text/html");
  const root = document.querySelector("form") ?? document.body;
  const blocks: AgentConversationFormBlock[] = [];
  const fields: AgentConversationFormField[] = [];
  const groups = new Map<string, AgentConversationFormChoice>();
  const labelFor = new Map<string, Element>();
  // The question of a group without its own label: the text right before it, else the fieldset legend.
  const captions = new Map<AgentConversationFormField, string>();
  let legend = "";
  let fieldsetDepth = 0;
  let inline = "";

  const ids = new Set(
    [...root.querySelectorAll(CONTROLS)].map(({ id }) => id).filter(Boolean),
  );
  for (const label of root.querySelectorAll("label")) {
    const target = label.getAttribute("for");
    if (target && ids.has(target) && !labelFor.has(target))
      labelFor.set(target, label);
  }

  const flush = (heading = false) => {
    const text = normalize(inline);
    inline = "";
    if (text) blocks.push({ kind: "text", text, heading });
  };

  const addField = (field: AgentConversationFormField) => {
    const previous = blocks[blocks.length - 1];
    captions.set(field, previous?.kind === "text" ? previous.text : legend);
    fields.push(field);
    blocks.push({ kind: "field", field });
  };

  const control = (element: Element, wrapping?: string) => {
    flush();
    const detached = element.id ? labelFor.get(element.id) : undefined;
    const label =
      wrapping ||
      (detached
        ? textOf(detached)
        : normalize(
            element.getAttribute("aria-label") ??
              element.getAttribute("title") ??
              "",
          ));
    const name = element.getAttribute("name") ?? "";
    const nameLabel = name.replace(/[_-]+/g, " ");
    const required = element.hasAttribute("required");
    const tag = element.localName;
    if (tag === "select") {
      const multi = element.hasAttribute("multiple");
      const options = [...element.querySelectorAll("option")].map((option) => {
        const text = normalize(option.textContent ?? "");
        return {
          value: option.getAttribute("value") ?? text,
          label: text,
          checked: option.hasAttribute("selected"),
          disabled: option.hasAttribute("disabled"),
        };
      });
      // A single select always has a selection: the first enabled option unless one is marked.
      if (!multi && !options.some(({ checked }) => checked)) {
        const first = options.find(({ disabled }) => !disabled);
        if (first) first.checked = true;
      }
      addField({
        kind: "choice",
        name,
        question: label,
        label,
        multi,
        select: true,
        other: false,
        options,
        required,
      });
      return;
    }
    if (tag === "textarea") {
      addField({
        kind: "text",
        name,
        question: label || nameLabel,
        type: "textarea",
        label: label || nameLabel,
        value: (element.textContent ?? "").replace(/^\r?\n/, ""),
        placeholder: element.getAttribute("placeholder") ?? "",
        required,
        minLength: numberAttr(element, "minlength"),
        maxLength: numberAttr(element, "maxlength"),
        rows: numberAttr(element, "rows") ?? 4,
      });
      return;
    }
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    // OMP keeps hidden inputs' own values: the answer leaves them out.
    if (IGNORED_INPUTS.has(type) || type === "hidden") return;
    const value = element.getAttribute("value");
    if (type === "radio" || type === "checkbox") {
      const option = {
        value: value ?? "on",
        label: label || value || name,
        checked: element.hasAttribute("checked"),
        disabled: element.hasAttribute("disabled"),
      };
      const key = `${type}\0${name}`;
      const group = groups.get(key);
      if (group) {
        group.options.push(option);
        group.required ||= required;
        return;
      }
      const field: AgentConversationFormChoice = {
        kind: "choice",
        name,
        question: "",
        label: "",
        multi: type === "checkbox",
        select: false,
        other: false,
        options: [option],
        required,
      };
      groups.set(key, field);
      addField(field);
      return;
    }
    addField({
      kind: "text",
      name,
      question: label || nameLabel,
      type,
      label: label || nameLabel,
      value: value ?? "",
      placeholder: element.getAttribute("placeholder") ?? "",
      required,
      min: numberAttr(element, "min"),
      max: numberAttr(element, "max"),
      pattern: element.getAttribute("pattern") ?? undefined,
      minLength: numberAttr(element, "minlength"),
      maxLength: numberAttr(element, "maxlength"),
      rows: 1,
    });
  };

  const table = (element: Element) => {
    flush();
    const rows = [...element.querySelectorAll("tr")].filter(
      (row) => row.closest("table") === element,
    );
    const cellsOf = (row: Element) =>
      [...row.children].filter(
        (cell) => cell.localName === "td" || cell.localName === "th",
      );
    if (!element.querySelector(CONTROLS)) {
      let headerRows = 0;
      while (
        headerRows < rows.length &&
        (rows[headerRows].closest("thead") !== null ||
          cellsOf(rows[headerRows]).every((cell) => cell.localName === "th"))
      )
        headerRows += 1;
      const cells = rows.map((row) => cellsOf(row).map(textOf));
      if (cells.some((row) => row.length > 0))
        blocks.push({ kind: "table", rows: cells, headerRows });
      return;
    }
    // A table of controls: each row's text becomes a line, an unlabelled control takes its column header.
    let header: string[] = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (
        cells.every((cell) => cell.localName === "th") &&
        !row.querySelector(CONTROLS)
      ) {
        header = cells.map(textOf);
        continue;
      }
      const text = cells
        .filter((cell) => !cell.querySelector(CONTROLS))
        .map(textOf)
        .filter(Boolean)
        .join(" · ");
      if (text) blocks.push({ kind: "text", text, heading: false });
      cells.forEach((cell, column) => {
        for (const element of cell.querySelectorAll(CONTROLS)) {
          const own = element.closest("label");
          const text = textOf(own && cell.contains(own) ? own : cell);
          control(element, text || header[column]);
        }
      });
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      inline += (node as Text).data.replace(/\s+/g, " ");
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName;
    if (SKIPPED.has(tag)) return;
    switch (tag) {
      case "br":
        inline += "\n";
        return;
      case "hr":
        flush();
        return;
      case "input":
      case "select":
      case "textarea":
        control(node);
        return;
      case "label": {
        const target = node.getAttribute("for");
        const controls = node.querySelectorAll(CONTROLS);
        if (target && labelFor.get(target) === node) return;
        if (controls.length === 0) {
          node.childNodes.forEach(walk);
          return;
        }
        flush();
        const text = textOf(node);
        controls.forEach((element) => control(element, text));
        return;
      }
      case "fieldset": {
        flush();
        const own = [...node.children].find(
          (child) => child.localName === "legend",
        );
        const outer = legend;
        if (own) {
          const text = textOf(own);
          if (text) blocks.push({ kind: "text", text, heading: true });
          if (fieldsetDepth === 0) legend = text;
        }
        fieldsetDepth += 1;
        node.childNodes.forEach((child) => {
          if (child !== own) walk(child);
        });
        flush();
        fieldsetDepth -= 1;
        legend = outer;
        return;
      }
      case "ul":
      case "ol": {
        flush();
        if (node.querySelector(CONTROLS)) {
          // A list of controls is layout, not content.
          node.childNodes.forEach(walk);
          flush();
          return;
        }
        const items = [...node.children]
          .filter((child) => child.localName === "li")
          .map(textOf)
          .filter(Boolean);
        if (items.length)
          blocks.push({ kind: "list", items, ordered: tag === "ol" });
        return;
      }
      case "pre":
        flush();
        blocks.push({
          kind: "pre",
          text: (node.textContent ?? "").replace(/^\n/, "").trimEnd(),
        });
        return;
      case "table":
        table(node);
        return;
      case "img": {
        const src = node.getAttribute("src")?.trim();
        if (!src) return;
        flush();
        blocks.push({
          kind: "image",
          src,
          alt: (node.getAttribute("alt") ?? "").trim(),
        });
        return;
      }
      case "svg":
        flush();
        blocks.push({
          kind: "image",
          // An image never runs the scripts or handlers an inline svg could carry; XML keeps its namespace.
          src: `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(node))}`,
          alt: normalize(
            node.getAttribute("aria-label") ??
              [...node.children].find((child) => child.localName === "title")
                ?.textContent ??
              "",
          ),
        });
        return;
    }
    const heading = HEADING.has(tag);
    if (heading || BLOCK.has(tag)) {
      flush();
      node.childNodes.forEach(walk);
      flush(heading);
      return;
    }
    node.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  flush();
  for (const field of fields) {
    if (field.kind !== "choice") continue;
    if (!field.select && field.options.length > 1)
      field.other = !field.options.some(({ label }) =>
        /^\s*other\b/i.test(label),
      );
    const lone = field.options.length === 1 ? field.options[0].label : "";
    field.question ||= captions.get(field) || lone || field.name;
  }
  return { blocks, fields };
}

/** Whether a choice answers with an array rather than one value. */
function agentConversationFormArray(field: AgentConversationFormChoice) {
  return field.multi && field.options.length > 1;
}

/** What each field starts with: preselected options and prefilled text. */
export function agentConversationFormInputs(
  form: AgentConversationForm,
): AgentConversationFormInput[] {
  return form.fields.map((field) =>
    field.kind === "text"
      ? field.value
      : {
          checked: field.options.flatMap(({ checked }, index) =>
            checked ? [index] : [],
          ),
          other: "",
        },
  );
}

/** What a field submits: a radio's "Other" text stands in for its option, a checkbox group's joins its values. */
export function agentConversationFormValue(
  field: AgentConversationFormField,
  input: AgentConversationFormInput,
): AgentConversationFormValue | undefined {
  if (field.kind === "text") {
    const text = typeof input === "string" ? input : "";
    if ((field.type === "number" || field.type === "range") && text.trim()) {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
    return text;
  }
  if (typeof input === "string") return undefined;
  const typed = field.other ? input.other.trim() : "";
  const values = field.options.flatMap((option, index) =>
    input.checked.includes(index) && !option.disabled ? [option.value] : [],
  );
  if (agentConversationFormArray(field))
    return [...new Set(typed ? [...values, typed] : values)];
  return typed || values[0];
}

/** `^(?:pattern)$` as HTML matches `pattern`; an invalid pattern checks nothing. */
function compilePattern(pattern: string) {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
}

/** Why `value` breaks `field`'s rules, or undefined when it keeps them. */
export function agentConversationFormError(
  field: AgentConversationFormField,
  value: AgentConversationFormValue | undefined,
): AgentConversationFormError | undefined {
  if (field.kind === "choice") {
    const empty =
      value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return {
      kind: agentConversationFormArray(field) ? "selectOne" : "required",
    };
  }
  const text = value === undefined ? "" : String(value);
  if (!text.trim()) return field.required ? { kind: "required" } : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return { kind: "number" };
    if (field.min !== undefined && number < field.min)
      return { kind: "min", limit: field.min };
    if (field.max !== undefined && number > field.max)
      return { kind: "max", limit: field.max };
  }
  if (field.minLength !== undefined && text.length < field.minLength)
    return { kind: "minLength", limit: field.minLength };
  if (field.maxLength !== undefined && text.length > field.maxLength)
    return { kind: "maxLength", limit: field.maxLength };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text))
    return { kind: "email" };
  if (field.type === "url" && !URL.canParse(text)) return { kind: "url" };
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false)
    return { kind: "pattern" };
  return undefined;
}

/** The `data` answering the form, by control name as a browser submits it. */
export function agentConversationFormData(
  form: AgentConversationForm,
  inputs: AgentConversationFormInput[],
) {
  // A null prototype keeps a control named `__proto__` an ordinary key.
  const data: Record<string, AgentConversationFormValue> = Object.create(null);
  form.fields.forEach((field, index) => {
    const value = agentConversationFormValue(field, inputs[index]);
    // shortcut: fields sharing a name keep the first answer, as OMP lets one entry answer them all; split it if agents mix shapes under one name.
    if (field.name && value !== undefined && !(field.name in data))
      data[field.name] = value;
  });
  return data;
}
