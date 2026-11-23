// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  agentConversationFormData,
  agentConversationFormError,
  agentConversationFormInputs,
  agentConversationFormValue,
  parseAgentConversationForm,
  type AgentConversationFormInput,
} from "./agentConversationForm";

// The `form` request OMP 19.1.0 sent for a short `ask` call.
const PROBE = `<form>
  <label><input type="checkbox" name="agree"> Agree</label>
  <fieldset>
    <legend>Color</legend>
    <label><input type="radio" name="color" value="red" checked> Red</label>
    <label><input type="radio" name="color" value="blue"> Blue</label>
  </fieldset>
  <label>Note <input type="text" name="note" required></label>
  <label>Count <input type="number" name="count" min="1" max="5"></label>
</form>`;

describe("agentConversationForm", () => {
  it("submits defaults, then the user's answers as OMP reads them", () => {
    const form = parseAgentConversationForm(PROBE);
    expect(
      form.fields.map(({ name, question, kind }) => ({ name, question, kind })),
    ).toEqual([
      { name: "agree", question: "Agree", kind: "choice" },
      { name: "color", question: "Color", kind: "choice" },
      { name: "note", question: "Note", kind: "text" },
      { name: "count", question: "Count", kind: "text" },
    ]);
    const defaults = agentConversationFormInputs(form);
    expect({ ...agentConversationFormData(form, defaults) }).toEqual({
      color: "red",
      note: "",
      count: "",
    });
    expect(
      form.fields.map((field, index) =>
        agentConversationFormError(
          field,
          agentConversationFormValue(field, defaults[index]),
        ),
      ),
    ).toEqual([undefined, undefined, { kind: "required" }, undefined]);

    const answered: AgentConversationFormInput[] = [
      { checked: [0], other: "" },
      // Typing an "Other" answer clears the radio.
      { checked: [], other: " pink " },
      "hello",
      "3",
    ];
    expect({ ...agentConversationFormData(form, answered) }).toEqual({
      agree: "on",
      color: "pink",
      note: "hello",
      count: 3,
    });
  });

  it("keeps choices to the values OMP accepts", () => {
    const form = parseAgentConversationForm(`<form>
      <p>Which fruits?</p>
      <label><input type="checkbox" name="fruit" value="apple" checked> Apple</label>
      <label><input type="checkbox" name="fruit" value="pear" disabled> Pear</label>
      <label><input type="checkbox" name="solo" value="yes"> Only one</label>
      <select name="size"><option disabled>XS</option><option value="m">M</option></select>
      <select name="tags" multiple><option>a</option><option>b</option></select>
      <label><input type="radio" name="pick" value="x"> X</label>
      <label><input type="radio" name="pick" value="o"> Other</label>
    </form>`);
    const [fruit, solo, size, tags, pick] = form.fields;
    expect(fruit).toMatchObject({ question: "Which fruits?", other: true });
    // No free-text answer for a lone checkbox, a select or a group with its own "Other".
    expect(
      [solo, size, pick].map((field) => field.kind === "choice" && field.other),
    ).toEqual([false, false, false]);
    const inputs = agentConversationFormInputs(form);
    inputs[0] = { checked: [0, 1], other: "apple" };
    inputs[3] = { checked: [1], other: "" };
    expect({ ...agentConversationFormData(form, inputs) }).toEqual({
      // A disabled option is never sent, nor a duplicate.
      fruit: ["apple"],
      // A single select starts on its first enabled option.
      size: "m",
      tags: ["b"],
    });
    expect(agentConversationFormError(tags, [])).toBeUndefined();
    expect(
      agentConversationFormError({ ...fruit, required: true }, []),
    ).toEqual({ kind: "selectOne" });
  });

  it.each([
    ['<input name="v" required>', "   ", { kind: "required" }],
    ['<input name="v">', "   ", undefined],
    ['<input name="v" type="number" min="1">', "0", { kind: "min", limit: 1 }],
    ['<input name="v" type="number" max="5">', "6", { kind: "max", limit: 5 }],
    ['<input name="v" type="number">', "1e999", { kind: "number" }],
    ['<input name="v" minlength="3">', "ab", { kind: "minLength", limit: 3 }],
    [
      '<textarea name="v" maxlength="2"></textarea>',
      "abc",
      { kind: "maxLength", limit: 2 },
    ],
    ['<input name="v" pattern="[a-z]+">', "abc1", { kind: "pattern" }],
    ['<input name="v" pattern="[a-z">', "anything", undefined],
    ['<input name="v" type="email">', "a@b", undefined],
    ['<input name="v" type="email">', "a b@c", { kind: "email" }],
    ['<input name="v" type="url">', "example.com", { kind: "url" }],
  ])("checks %s with %j", (html, text, error) => {
    const [field] = parseAgentConversationForm(`<form>${html}</form>`).fields;
    expect(
      agentConversationFormError(
        field,
        agentConversationFormValue(field, text),
      ),
    ).toEqual(error);
  });

  it("keeps context in order and pictures out of the page", () => {
    const form = parseAgentConversationForm(`<p>Pick <b>one</b>:</p>
      <ul><li>fast</li><li>safe</li></ul>
      <table><tr><th>A</th></tr><tr><td>1</td></tr></table>
      <svg onload="alert(1)"><title>Chart</title></svg>
      <script>alert(1)</script>`);
    expect(form.blocks).toMatchObject([
      { kind: "text", text: "Pick one:" },
      { kind: "list", items: ["fast", "safe"] },
      { kind: "table", rows: [["A"], ["1"]], headerRows: 1 },
      { kind: "image", alt: "Chart" },
    ]);
    expect(form.blocks).toHaveLength(4);
    const svg = form.blocks[3];
    expect(svg.kind === "image" && svg.src).toMatch(/^data:image\/svg\+xml,/);
  });
});
