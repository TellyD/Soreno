import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/agentSessionsApi";
import type { SshPortForward } from "../../domain/agentSessions";
import {
  dismissNotification,
  notifyError,
  notifyWarning,
} from "../../notifications";
import { Button } from "../ui/Button";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useAgentStrings } from "./agentStrings";

type SshPortForwardControlProps = {
  address: string;
  disabled: boolean;
  disconnected: boolean;
  onBusyChange: (busy: boolean) => void;
  projectId: string;
};

export function SshPortForwardControl({
  address,
  disabled,
  disconnected,
  onBusyChange,
  projectId,
}: SshPortForwardControlProps) {
  const s = useAgentStrings();
  const titleId = useId();
  const hintId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [ports, setPorts] = useState("");
  const [forwards, setForwards] = useState<SshPortForward[]>([]);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const dismiss = () => {
    if (!pending) setOpen(false);
  };
  const surfaceRef = useDismissibleLayer<HTMLElement>(open, dismiss);
  const noticeKey = `ssh-forward:${projectId}`;
  const fail = (message: string) => notifyError(message, { key: noticeKey });

  useEffect(() => {
    let current = true;
    setForwards([]);
    dismissNotification(noticeKey);
    if (disconnected) return () => void (current = false);
    setLoading(true);
    void api
      .listAgentSshPortForwards(projectId)
      .then((value) => {
        if (current) setForwards(value);
      })
      .catch(() => {
        if (current) fail(s.sshForwardLoadError);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => void (current = false);
  }, [disconnected, noticeKey, projectId, s.sshForwardLoadError]);

  async function start() {
    if (!ports.trim() || pending) return;
    setPending(true);
    onBusyChange(true);
    dismissNotification(noticeKey);
    try {
      const result = await api.startAgentSshPortForward(projectId, ports);
      setForwards(result.forwards);
      if (result.ignoredPorts.length > 0)
        notifyWarning(s.sshForwardIgnored(result.ignoredPorts), {
          key: `${noticeKey}:ignored`,
        });
    } catch {
      fail(s.sshForwardStartError);
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }

  async function stop() {
    if (pending) return;
    setPending(true);
    onBusyChange(true);
    dismissNotification(noticeKey);
    try {
      await api.stopAgentSshPortForward(projectId);
      setForwards([]);
    } catch {
      fail(s.sshForwardStopError);
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }

  async function openLocalUrl(url: string) {
    try {
      await openUrl(url);
    } catch {
      fail(s.sshForwardOpenError);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="agent-ssh-toggle"
        disabled={disabled || disconnected}
        title={s.sshForwardTitle}
        onClick={() => setOpen(true)}
      >
        {forwards.length > 0
          ? s.sshForwardCount(forwards.length)
          : s.sshForwardPorts}
      </button>
      {open
        ? createPortal(
            <DialogOverlay>
              <DialogSurface
                ref={surfaceRef}
                className="agent-form-dialog ssh-forward-dialog"
                returnFocusRef={triggerRef}
                aria-labelledby={titleId}
              >
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void start();
                  }}
                >
                  <h2 id={titleId}>{s.sshForwardTitle}</h2>
                  <p className="ssh-forward-description">
                    {s.sshForwardDescription(address)}
                  </p>
                  {forwards.length === 0 ? (
                    <fieldset disabled={pending || loading}>
                      <label htmlFor={`${titleId}-ports`}>
                        {s.sshForwardInput}
                      </label>
                      <Input
                        id={`${titleId}-ports`}
                        value={ports}
                        placeholder={s.sshForwardPlaceholder}
                        aria-describedby={hintId}
                        onChange={(event) => setPorts(event.target.value)}
                      />
                      <p id={hintId} className="agent-form-hint">
                        {s.sshForwardHint}
                      </p>
                    </fieldset>
                  ) : (
                    <ul className="ssh-forward-list">
                      {forwards.map(({ remotePort, localPort }) => {
                        const url = `http://localhost:${localPort}`;
                        return (
                          <li key={remotePort}>
                            <span>
                              <strong>{remotePort}</strong>
                              <span aria-hidden="true">→</span>
                              <code
                                className={
                                  remotePort !== localPort
                                    ? "ssh-forward-port-changed"
                                    : undefined
                                }
                                title={
                                  remotePort !== localPort
                                    ? s.sshForwardLocalChanged
                                    : undefined
                                }
                              >
                                {url}
                              </code>
                            </span>
                            <IconButton
                              size="small"
                              aria-label={s.sshForwardOpen(url)}
                              title={s.sshForwardOpen(url)}
                              onClick={() => void openLocalUrl(url)}
                            >
                              <ExternalLink />
                            </IconButton>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {loading ? (
                    <p className="ssh-forward-loading" role="status">
                      <LoaderCircle
                        size={14}
                        className="app-loading-spinner"
                        aria-hidden="true"
                      />
                      <span className="sr-only">{s.sshForwardLoading}</span>
                    </p>
                  ) : forwards.length === 0 ? (
                    <p className="ssh-forward-empty">{s.sshForwardEmpty}</p>
                  ) : null}
                  <footer>
                    <Button disabled={pending} onClick={dismiss}>
                      {s.cancel}
                    </Button>
                    {forwards.length > 0 ? (
                      <Button
                        disabled={pending}
                        startIcon={
                          pending ? (
                            <LoaderCircle className="app-loading-spinner" />
                          ) : undefined
                        }
                        onClick={() => void stop()}
                      >
                        {s.sshForwardStop}
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={pending || loading || !ports.trim()}
                        startIcon={
                          pending ? (
                            <LoaderCircle className="app-loading-spinner" />
                          ) : undefined
                        }
                      >
                        {s.sshForwardStart}
                      </Button>
                    )}
                  </footer>
                </form>
              </DialogSurface>
            </DialogOverlay>,
            document.body,
          )
        : null}
    </>
  );
}
