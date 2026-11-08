import {
  ArrowDownToLine,
  Bot,
  ChevronRight,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Image,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareOff,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { IconButton } from "@/components/ui/IconButton";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  awaitingReply,
  toolLabel,
  type Conversation,
  type ConversationEntry,
  type ToolAction,
  type ToolEntry,
} from "./conversation";
import type { MobileStrings } from "./mobileStrings";

type ConversationViewProps = {
  conversation: Conversation | null;
  working: boolean | null;
  /** Shown alone, centered, until the first `reset`. */
  loading?: string | null;
  /** Leaves out tool calls: only the messages remain. */
  toolsHidden?: boolean;
  strings: MobileStrings;
};

const TOOL_ICONS: Record<ToolAction, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  run: SquareTerminal,
  search: Search,
  web: Globe,
  agent: Bot,
  ask: MessageCircleQuestion,
  other: Wrench,
};
// Within this distance of the end, new messages keep the view at the bottom.
const STICK_PX = 24;

function ToolLine({
  tool,
  strings,
}: {
  tool: ToolEntry;
  strings: MobileStrings;
}) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.action] ?? Wrench;
  const result = tool.result;
  return (
    <div className={`mobile-tool${result?.error ? " is-error" : ""}`}>
      <button
        type="button"
        className="mobile-tool-line"
        aria-expanded={result ? open : undefined}
        disabled={!result}
        onClick={() => setOpen(!open)}
      >
        <Icon size={14} className="mobile-tool-icon" aria-hidden="true" />
        <span className="mobile-tool-text">
          {toolLabel(tool, strings)}
          {tool.subject ? (
            <>
              {" "}
              <code>{tool.subject}</code>
            </>
          ) : null}
          {result?.error ? (
            <span className="mobile-visually-hidden">
              {" "}
              ({strings.toolFailed})
            </span>
          ) : null}
        </span>
        {result ? (
          <ChevronRight
            size={14}
            className="mobile-tool-chevron"
            aria-hidden="true"
          />
        ) : null}
      </button>
      {open && result ? (
        <pre className="mobile-tool-output">
          {result.text || strings.noOutput}
        </pre>
      ) : null}
    </div>
  );
}

function Entry({
  entry,
  strings,
}: {
  entry: ConversationEntry;
  strings: MobileStrings;
}) {
  if (entry.kind === "tool") return <ToolLine tool={entry} strings={strings} />;
  const truncated = entry.truncated ? (
    <span className="mobile-message-note">{strings.textTruncated}</span>
  ) : null;
  if (entry.kind === "assistant")
    return (
      <div className="mobile-message is-assistant">
        <MarkdownContent
          className="mobile-markdown"
          content={entry.text}
          scrollableTables={false}
        />
        {truncated}
      </div>
    );
  return (
    <div className="mobile-message is-user">
      {entry.text ? <p className="mobile-message-text">{entry.text}</p> : null}
      {entry.images ? (
        <span className="mobile-message-note">
          <Image size={13} aria-hidden="true" />
          {strings.images(entry.images)}
        </span>
      ) : null}
      {truncated}
    </div>
  );
}

export function ConversationView({
  conversation,
  working,
  loading,
  toolsHidden = false,
  strings,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const entries = conversation?.entries;
  // OMP writes a Chat's history with its first message: until then the Chat is empty, not unreadable.
  const available =
    conversation?.available === true ||
    (conversation?.rpc === true &&
      conversation.provider !== null &&
      conversation.deleted !== true);
  // The reply check still sees every call: a hidden question must not hide the banner.
  const awaiting = available && awaitingReply(entries ?? [], working);
  const shown = toolsHidden
    ? entries?.filter((entry) => entry.kind !== "tool")
    : entries;

  const toBottom = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  useLayoutEffect(() => {
    if (stickRef.current) toBottom();
  }, [shown, working, awaiting]);

  // A shrinking view (keyboard, composer) or a growing log (late diagram) must keep the end in sight.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) toBottom();
    });
    observer.observe(element);
    if (log.current) observer.observe(log.current);
    return () => observer.disconnect();
  }, [available]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atBottom =
      element.scrollTop + element.clientHeight >=
      element.scrollHeight - STICK_PX;
    stickRef.current = atBottom;
    setStuck(atBottom);
  };

  return (
    <div className="mobile-conversation">
      <div className="mobile-conversation-body">
        {/* Focusable so the keyboard can scroll the conversation. */}
        <div
          className="mobile-conversation-scroller"
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label={strings.conversationScroller}
          onScroll={onScroll}
        >
          {!conversation && loading ? (
            <LoadingState className="mobile-conversation-loading">
              {loading}
            </LoadingState>
          ) : null}
          {conversation && !available ? (
            <div className="mobile-conversation-unavailable">
              <MessageSquareOff
                size={22}
                className="mobile-conversation-unavailable-icon"
                aria-hidden="true"
              />
              <strong>
                {conversation.deleted
                  ? strings.deletedConversationTitle
                  : strings.noConversationTitle}
              </strong>
              <p>
                {conversation.deleted
                  ? strings.deletedConversationBody
                  : strings.noConversationBody}
              </p>
            </div>
          ) : null}
          {available ? (
            <div
              ref={log}
              className="mobile-conversation-log"
              role="log"
              aria-label={strings.conversationLabel}
            >
              {conversation.truncated ? (
                <p className="mobile-conversation-note">
                  {strings.conversationTruncated}
                </p>
              ) : null}
              {shown?.length ? null : (
                <p className="mobile-conversation-note">
                  {strings.conversationEmpty}
                </p>
              )}
              {shown?.map((entry) => (
                <Entry
                  key={`${entry.kind}:${entry.id}`}
                  entry={entry}
                  strings={strings}
                />
              ))}
              {working ? (
                <p className="mobile-conversation-working" role="status">
                  <LoaderCircle
                    size={14}
                    className="app-loading-spinner"
                    aria-hidden="true"
                  />
                  {strings.agentWorking}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {stuck ? null : (
          <IconButton
            size="large"
            className="mobile-scroll-bottom"
            aria-label={strings.scrollBottom}
            title={strings.scrollBottom}
            onClick={() => {
              stickRef.current = true;
              setStuck(true);
              toBottom();
            }}
          >
            <ArrowDownToLine />
          </IconButton>
        )}
      </div>
      {awaiting ? (
        <div className="mobile-awaiting" role="status">
          <MessageCircleQuestion size={16} aria-hidden="true" />
          <span>{strings.awaitingReply}</span>
        </div>
      ) : null}
    </div>
  );
}
