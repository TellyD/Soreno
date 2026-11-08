import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "mjs", "cjs"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript(),
  }),
  LanguageDescription.of({
    name: "JSX",
    alias: ["jsx"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "mts", "cts"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
      }),
  }),
  LanguageDescription.of({
    name: "TSX",
    alias: ["tsx"],
    load: async () =>
      (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      }),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    load: async () => (await import("@codemirror/lang-python")).python(),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs"],
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json"],
    load: async () => (await import("@codemirror/lang-json")).json(),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "htm"],
    load: async () => (await import("@codemirror/lang-html")).html(),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    load: async () => (await import("@codemirror/lang-css")).css(),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql"],
    load: async () => (await import("@codemirror/lang-sql")).sql(),
  }),
  LanguageDescription.of({
    name: "Bash",
    alias: ["bash", "sh", "shell"],
    load: async () =>
      new LanguageSupport(
        StreamLanguage.define(
          (await import("@codemirror/legacy-modes/mode/shell")).shell,
        ),
      ),
  }),
];

export const codeLanguageOptions: { value: string; label: string }[] =
  codeLanguages.map((language) => ({
    value: language.alias[0],
    label: language.name,
  }));

export function codeLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s+/u)[0].toLowerCase();
  return (
    codeLanguages.find((language) => language.alias.includes(name)) ?? null
  );
}

/** Raw text stays in place when the lazy language chunk cannot load. */
export function appendLoadedLanguage(
  language: LanguageDescription,
  views: EditorView[],
  disposed: () => boolean,
) {
  void language
    .load()
    .then((support) => {
      if (disposed()) return;
      for (const view of views)
        view.dispatch({ effects: StateEffect.appendConfig.of(support) });
    })
    .catch(() => {});
}
