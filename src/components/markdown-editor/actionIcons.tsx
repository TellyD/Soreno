import {
  Bold,
  CheckCheck,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  Strikethrough,
  Table,
  type LucideIcon,
} from "lucide-react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { EditorAction } from "./commands";

export const actionIcons = [
  ["bold", Bold],
  ["italic", Italic],
  ["strike", Strikethrough],
  ["code", Code],
  ["link", Link],
  ["paragraph", Pilcrow],
  ["heading1", Heading1],
  ["heading2", Heading2],
  ["heading3", Heading3],
  ["heading4", Heading4],
  ["heading5", Heading5],
  ["heading6", Heading6],
  ["bullet", List],
  ["numbered", ListOrdered],
  ["task", ListTodo],
  ["quote", Quote],
  ["codeBlock", CodeXml],
  ["rule", Minus],
  ["table", Table],
  ["image", ImagePlus],
  ["indent", IndentIncrease],
  ["outdent", IndentDecrease],
  ["toggleTask", CheckCheck],
] as const satisfies ReadonlyArray<
  readonly [EditorAction | "image", LucideIcon]
>;

export type IconAction = (typeof actionIcons)[number][0];

export const actionIcon = (action: IconAction): LucideIcon =>
  actionIcons.find(([id]) => id === action)![1];

const renderedIcons = new Map<IconAction, Node>();

// CodeMirror builds completion options as plain DOM: render each icon once, then clone it.
export function actionIconElement(action: IconAction): Node | null {
  let icon = renderedIcons.get(action);
  if (!icon) {
    const Icon = actionIcon(action);
    const host = document.createElement("span");
    const root = createRoot(host);
    flushSync(() => root.render(<Icon aria-hidden="true" />));
    icon = host.firstChild?.cloneNode(true);
    root.unmount();
    // flushSync cannot commit inside a React lifecycle; the next render retries.
    if (!icon) return null;
    renderedIcons.set(action, icon);
  }
  return icon.cloneNode(true);
}
