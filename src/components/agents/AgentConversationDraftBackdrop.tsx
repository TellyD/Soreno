import { ImageIcon } from "lucide-react";
import { useLayoutEffect, type RefObject } from "react";
import { AGENT_CONVERSATION_IMAGE_MARKERS } from "../../domain/agentConversationAttachments";

/** A textarea cannot style its text: image markers get chips drawn beneath its transparent copy. */
export function AgentConversationDraftBackdrop({
  draft,
  ref,
}: {
  draft: string;
  ref: RefObject<HTMLDivElement | null>;
}) {
  // A marker holds a space, so it may wrap: its chip would then sit over one fragment only.
  useLayoutEffect(() => {
    const backdrop = ref.current;
    if (!backdrop) return;
    const markSplitChips = () =>
      backdrop
        .querySelectorAll(".agent-conversation-draft-chip")
        .forEach((chip) =>
          chip.classList.toggle("is-split", chip.getClientRects().length > 1),
        );
    markSplitChips();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(markSplitChips);
    observer.observe(backdrop);
    return () => observer.disconnect();
  }, [draft, ref]);

  const parts = draft.split(AGENT_CONVERSATION_IMAGE_MARKERS);
  if (parts.length < 2) return null;
  return (
    <div
      ref={ref}
      className="agent-conversation-draft-backdrop"
      aria-hidden="true"
    >
      {parts.map((part, index) =>
        index % 2 ? (
          <span key={index} className="agent-conversation-draft-chip">
            {part}
            <span>
              <ImageIcon size={12} />
              <span>{part.slice(1, -1)}</span>
            </span>
          </span>
        ) : (
          part
        ),
      )}
      {/* Keeps a trailing empty line, so both scroll as far. */}
      {"\u200b"}
    </div>
  );
}
