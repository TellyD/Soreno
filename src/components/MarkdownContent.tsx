import { ensureSyntaxTree, type LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree } from "@lezer/highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  parseInlineMarkdown,
  parseMarkdownContent,
  type MarkdownContentBlock,
  type MarkdownContentInline,
} from "../domain/markdownContent";
import { codeLanguage } from "./markdown-editor/codeLanguages";
import { markdownHighlightStyle } from "./markdown-editor/highlighting";
import { MermaidDiagram } from "./MermaidDiagram";
import "./MarkdownContent.css";

/** Local link targets a consumer renders and opens itself, e.g. stored images. */
export type MarkdownLocalLinks = {
  accepts: (href: string) => boolean;
  open: (href: string) => void;
};

type MarkdownContentProps = {
  className: string;
  content: string;
  // Must keep its identity across renders, like any memoized prop.
  localLinks?: MarkdownLocalLinks;
  // False where the stylesheet fits tables to the width: nothing to scroll, so no Tab stop.
  scrollableTables?: boolean;
};

export const MarkdownContent = memo(function MarkdownContent({
  className,
  content,
  localLinks,
  scrollableTables = true,
}: MarkdownContentProps) {
  const blocks = parseMarkdownContent(content, localLinks?.accepts);

  if (blocks.length === 0) {
    return <div className={`markdown-content ${className}`} />;
  }

  return (
    <div className={`markdown-content ${className}`}>
      {blocks.map((block, index) =>
        renderBlock(block, index, scrollableTables, localLinks),
      )}
    </div>
  );
});

// Option descriptions sit inside buttons, where a link would be nested interactive content.
export function MarkdownInline({ content }: { content: string }) {
  return renderInlineTokens(
    withoutLinks(parseInlineMarkdown(content)),
    "inline",
    undefined,
  );
}

function withoutLinks(
  tokens: MarkdownContentInline[],
): MarkdownContentInline[] {
  return tokens.map((token) =>
    token.type === "link"
      ? { text: token.text, type: "text" }
      : "children" in token
        ? { ...token, children: withoutLinks(token.children) }
        : token,
  );
}

function renderBlock(
  block: MarkdownContentBlock,
  index: number,
  scrollableTables: boolean,
  localLinks: MarkdownLocalLinks | undefined,
) {
  if (block.type === "paragraph" || block.type === "blockquote") {
    const Container = block.type === "blockquote" ? "blockquote" : "p";

    return (
      <Container key={index}>
        {block.lines.map((line, lineIndex) => (
          <Fragment key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {renderInlineTokens(line, `${index}-${lineIndex}`, localLinks)}
          </Fragment>
        ))}
      </Container>
    );
  }

  if (block.type === "heading") {
    return (
      <h3 data-level={block.level} key={index}>
        {renderInlineTokens(block.content, `${index}`, localLinks)}
      </h3>
    );
  }

  if (block.type === "unorderedList") {
    return (
      <ul key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {renderInlineTokens(
              item.content,
              `${index}-${itemIndex}`,
              localLinks,
            )}
            {item.children?.map((child, childIndex) =>
              renderBlock(child, childIndex, scrollableTables, localLinks),
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (block.type === "orderedList") {
    return (
      <ol key={index} start={block.start === 1 ? undefined : block.start}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {renderInlineTokens(
              item.content,
              `${index}-${itemIndex}`,
              localLinks,
            )}
            {item.children?.map((child, childIndex) =>
              renderBlock(child, childIndex, scrollableTables, localLinks),
            )}
          </li>
        ))}
      </ol>
    );
  }

  if (block.type === "rule") {
    return <hr key={index} />;
  }

  if (block.type === "table") {
    const cellStyle = (column: number) =>
      block.align[column] ? { textAlign: block.align[column] } : undefined;
    return (
      // Wide tables scroll inside the message instead of widening it; focusable so the keyboard can scroll them.
      <div
        key={index}
        className="markdown-table"
        tabIndex={scrollableTables ? 0 : undefined}
      >
        <table>
          <thead>
            <tr>
              {block.header.map((cell, column) => (
                <th key={column} style={cellStyle(column)}>
                  {renderInlineTokens(cell, `${index}-h-${column}`, localLinks)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, column) => (
                  <td key={column} style={cellStyle(column)}>
                    {renderInlineTokens(
                      cell,
                      `${index}-${rowIndex}-${column}`,
                      localLinks,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.language === "mermaid")
    return <MermaidDiagram key={index} code={block.text} />;

  return <CodeBlock key={index} code={block.text} info={block.language} />;
}

function CodeBlock({ code, info }: { code: string; info: string | null }) {
  const language = info ? codeLanguage(info) : null;
  const [, setLoaded] = useState<LanguageSupport>();
  const support = language?.support;
  useEffect(() => {
    if (!language || support) return;
    let live = true;
    // Raw text stays in place when the lazy language chunk cannot load.
    language.load().then(
      (support) => {
        if (live) setLoaded(support);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [language, support]);
  const content = useMemo(
    () => (support ? highlightCode(code, support) : code),
    [code, support],
  );
  return (
    <pre>
      <code>{content}</code>
    </pre>
  );
}

let highlightRulesMounted = false;

// shortcut: each streamed delta reparses the whole block on the UI thread; bound by size if huge blocks stall chat.
function highlightCode(code: string, support: LanguageSupport): ReactNode {
  const state = EditorState.create({ doc: code, extensions: support });
  const tree = ensureSyntaxTree(state, code.length, 200);
  if (!tree) return code;
  // Editors mount these rules through their view; read-only Markdown has none.
  if (!highlightRulesMounted && markdownHighlightStyle.module) {
    const style = document.createElement("style");
    style.textContent = markdownHighlightStyle.module.getRules();
    document.head.append(style);
    highlightRulesMounted = true;
  }
  const parts: ReactNode[] = [];
  let position = 0;
  highlightTree(tree, markdownHighlightStyle, (from, to, classes) => {
    if (from > position) parts.push(code.slice(position, from));
    parts.push(
      <span key={from} className={classes}>
        {code.slice(from, to)}
      </span>,
    );
    position = to;
  });
  parts.push(code.slice(position));
  return parts;
}

function renderInlineTokens(
  tokens: MarkdownContentInline[],
  keyPrefix: string,
  localLinks: MarkdownLocalLinks | undefined,
): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;

    if ("children" in token) {
      const Tag = token.type === "strong" ? "strong" : "em";
      return (
        <Tag key={key}>
          {renderInlineTokens(token.children, key, localLinks)}
        </Tag>
      );
    }

    if (token.type === "code") {
      return <code key={key}>{token.text}</code>;
    }

    if (token.type === "link") {
      return (
        <a
          href={token.href}
          key={key}
          onClick={(event) => {
            event.preventDefault();
            if (localLinks?.accepts(token.href)) localLinks.open(token.href);
            else void openUrl(token.href);
          }}
        >
          {token.text}
        </a>
      );
    }

    return <Fragment key={key}>{token.text}</Fragment>;
  });
}
