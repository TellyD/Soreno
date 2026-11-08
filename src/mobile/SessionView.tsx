import {
  ChevronLeft,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  SendHorizontal,
  Server,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/Button";
import "@/components/ui/Input.css";
import { ConversationView } from "./ConversationView";
import { HeaderMenu } from "./HeaderMenu";
import { ComposerImageError, composerImage } from "./composerImage";
import { conversationMessage } from "./conversation";
import type { ConnectionStatus } from "./conversationConnection";
import type { RemoteSession, SessionTarget } from "./mobileApi";
import { loadToolsHidden, saveToolsHidden } from "./mobileStorage";
import { sessionSubtitle, sessionTitle } from "./mobileSessions";
import type { MobileStrings } from "./mobileStrings";
import { unreadKey } from "./sessionUnread";
import { useConversation } from "./useConversation";

type SessionViewProps = {
  target: SessionTarget;
  session: RemoteSession | null;
  /** Tells which session has a conversation on screen, from its first `reset` until the view closes. */
  onShown: (id: string, shown: boolean) => void;
  strings: MobileStrings;
};

function statusMessage(status: ConnectionStatus, strings: MobileStrings) {
  switch (status) {
    case "connecting":
      return strings.connecting;
    case "reconnecting":
      return strings.reconnecting;
    case "ended":
      return strings.ended;
    case "gone":
      return strings.gone;
    case "unpaired":
      return strings.unpaired;
    case "open":
      return null;
  }
}

function imageErrorMessage(error: unknown, strings: MobileStrings) {
  if (!(error instanceof ComposerImageError)) return strings.imageFailed;
  return error.reason === "tooLarge"
    ? strings.imageTooLarge
    : strings.imageUnsupported;
}

/** The path where the agent reads the image, as its own word in the message. */
function withImagePath(message: string, path: string) {
  const separator = message === "" || /\s$/.test(message) ? "" : " ";
  return `${message}${separator}${path} `;
}

export function SessionView({
  target,
  session,
  onShown,
  strings,
}: SessionViewProps) {
  const [message, setMessage] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [toolsHidden, setToolsHidden] = useState(loadToolsHidden);
  const conversation = useConversation(target);
  const status = conversation.status;
  const reset = conversation.conversation;
  // Nothing may be typed until this connection's `reset` tells whether an agent reads it.
  const open = status === "open" && conversation.synced;
  const notice = statusMessage(status, strings);
  const connecting = status === "connecting" || status === "reconnecting";
  // Before anything is shown the wait sits in the middle; afterwards a banner keeps the messages visible.
  const firstLoad = reset === null && (connecting || status === "open");
  const loading = status === "open" ? strings.loadingConversation : notice;
  const title = sessionTitle(session ?? { key: target.key, label: null });
  // Typing blind into a shell, an unknown program or a conversation no longer shown is too risky from a phone.
  const blind =
    reset !== null && (reset.provider === null || reset.deleted === true);
  const imagesAccepted = reset?.images === true;
  const shown = reset !== null;
  const id = unreadKey(target.server.server, target.key);

  useEffect(() => {
    if (!shown) return;
    onShown(id, true);
    return () => onShown(id, false);
  }, [shown, id, onShown]);

  // Grows with the text; the stylesheet caps it at four lines.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [message]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message || !open || attaching) return;
    if (conversation.input(conversationMessage(message, reset?.rpc === true))) {
      setMessage("");
      setImageError(null);
    }
  };

  const attach = async (files: File[]) => {
    if (files.length === 0) return;
    setAttaching(true);
    setImageError(null);
    try {
      for (const file of files) {
        const image = await composerImage(file);
        const path = await conversation.sendImage(image.mimeType, image.data);
        setMessage((current) => withImagePath(current, path));
      }
    } catch (error) {
      setImageError(imageErrorMessage(error, strings));
    } finally {
      setAttaching(false);
    }
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0 || !imagesAccepted || !open || attaching) return;
    event.preventDefault();
    void attach(files);
  };

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <a className="mobile-header-back" href="#/">
          <span className="mobile-header-back-icon" aria-hidden="true">
            <ChevronLeft size={20} />
          </span>
          <span className="mobile-visually-hidden">{strings.back}</span>
          <span className="mobile-header-title">
            <h1>{title}</h1>
            <span className="mobile-header-subtitle">
              <span className="mobile-header-host">
                <Server size={12} aria-hidden="true" />
                {target.host}
              </span>
              {session && sessionSubtitle(session) ? (
                <span className="mobile-header-name">
                  {sessionSubtitle(session)}
                </span>
              ) : null}
            </span>
          </span>
        </a>
        <HeaderMenu
          label={strings.moreActions}
          actions={[
            {
              id: "tools",
              label: toolsHidden ? strings.showTools : strings.hideTools,
              icon: toolsHidden ? <Eye /> : <EyeOff />,
              onSelect: () => {
                saveToolsHidden(!toolsHidden);
                setToolsHidden(!toolsHidden);
              },
            },
            {
              id: "reload",
              label: strings.reload,
              icon: <RefreshCw />,
              onSelect: () => window.location.reload(),
            },
          ]}
        />
      </header>
      {notice && !firstLoad ? (
        <p className="mobile-banner" role="status">
          {connecting ? (
            <LoaderCircle
              size={14}
              className="app-loading-spinner"
              aria-hidden="true"
            />
          ) : null}
          {notice}
        </p>
      ) : null}
      <ConversationView
        conversation={conversation.conversation}
        working={conversation.working}
        loading={firstLoad ? loading : null}
        toolsHidden={toolsHidden}
        strings={strings}
      />
      {blind ? null : (
        <div className="mobile-controls">
          {imageError ? (
            <p className="mobile-composer-error" role="alert">
              {imageError}
            </p>
          ) : null}
          <form className="mobile-composer" onSubmit={submit}>
            {imagesAccepted ? (
              <>
                <input
                  ref={picker}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    // Picking the same screenshot again must fire `change` again.
                    event.target.value = "";
                    void attach(files);
                  }}
                />
                <Button
                  size="large"
                  className="mobile-composer-image"
                  disabled={!open || attaching}
                  startIcon={
                    attaching ? (
                      <LoaderCircle className="app-loading-spinner" />
                    ) : (
                      <ImagePlus />
                    )
                  }
                  aria-label={
                    attaching ? strings.attachingImage : strings.attachImage
                  }
                  title={
                    attaching ? strings.attachingImage : strings.attachImage
                  }
                  onClick={() => picker.current?.click()}
                >
                  {null}
                </Button>
              </>
            ) : null}
            <span className="app-input app-input-large mobile-composer-input">
              <textarea
                ref={field}
                rows={1}
                className="app-input-element mobile-composer-field"
                value={message}
                placeholder={strings.messagePlaceholder}
                aria-label={strings.messageLabel}
                autoComplete="off"
                onChange={(event) => setMessage(event.target.value)}
                onPaste={paste}
              />
            </span>
            <Button
              type="submit"
              size="large"
              variant="primary"
              className="mobile-composer-send"
              disabled={!open || !message || attaching}
              startIcon={<SendHorizontal />}
              aria-label={strings.send}
              title={strings.send}
              onPointerDown={(event) => event.preventDefault()}
            >
              {null}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
