import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as api from "../../data/agentSessionsApi";
import {
  MOBILE_ACCESS_PAUSED,
  type SshMobilePairing,
  type SshMobileStatus,
} from "../../domain/agentSessions";
import { errorMessage } from "../../domain/errors";
import { Button } from "../ui/Button";
import { ConfirmationDialog } from "../ui/ConfirmationDialog";
import { DialogOverlay, DialogSurface } from "../ui/Dialog";
import { useDismissibleLayer } from "../ui/useDismissibleLayer";
import { useAgentStrings, type AgentStrings } from "./agentStrings";
import { formatOperationError } from "./operationError";

type SshMobileAccessControlProps = {
  address: string;
  disabled: boolean;
  disconnected: boolean;
  onBusyChange: (busy: boolean) => void;
  projectId: string;
};

type MobileView = "unsupported" | "off" | "legacy" | "outdated" | "active";

type MobileAction =
  | { kind: "enable" | "disable" | "pair" }
  | { kind: "revoke"; deviceId: string };

const STATUS_REFRESH_MS = 5000;

function mobileView(status: SshMobileStatus): MobileView {
  if (!status.supported) return "unsupported";
  if (!status.installed) return "off";
  if (status.legacy) return "legacy";
  if (!status.upToDate || !status.active) return "outdated";
  return "active";
}

// An unreadable authorization list keeps the last one known instead of reading as empty.
function withKnownAccess(
  previous: SshMobileStatus | null,
  next: SshMobileStatus,
): SshMobileStatus {
  return {
    ...next,
    devices: next.devices ?? previous?.devices ?? null,
    pairings: next.pairings ?? previous?.pairings ?? null,
    pairingsUsed: next.pairingsUsed ?? previous?.pairingsUsed ?? null,
  };
}

function mobileErrorCode(reason: unknown) {
  return /\[Mobile\/(\w+)\]/.exec(errorMessage(reason))?.[1] ?? null;
}

function mobileErrorMessage(s: AgentStrings, reason: unknown) {
  const code = mobileErrorCode(reason);
  if (!code || !Object.prototype.hasOwnProperty.call(s.sshMobileErrors, code))
    return formatOperationError(s, {
      message: errorMessage(reason),
      context: s.sshMobileFailed,
    });
  return s.sshMobileErrors[code as keyof AgentStrings["sshMobileErrors"]];
}

export function SshMobileAccessControl({
  address,
  disabled,
  disconnected,
  onBusyChange,
  projectId,
}: SshMobileAccessControlProps) {
  const s = useAgentStrings();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SshMobileStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest status read failure, cleared by the next successful read.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<MobileAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pairing, setPairing] = useState<SshMobilePairing | null>(null);
  const [pairingExpired, setPairingExpired] = useState(false);
  const pending = pendingAction !== null;
  const [loading, setLoading] = useState(false);
  const dismiss = () => {
    if (pending || confirming) return;
    setOpen(false);
    setPairing(null);
  };
  const surfaceRef = useDismissibleLayer<HTMLElement>(open, dismiss);
  // Bumped by every mutation so an older status read cannot overwrite its result.
  const statusVersion = useRef(0);

  const view = status ? mobileView(status) : null;
  const pairingUsed =
    pairing !== null && (status?.pairingsUsed?.includes(pairing.id) ?? false);
  // Gone without a phone: evicted by newer codes, as dead as an expired one.
  const pairingGone =
    pairing !== null &&
    status?.pairings != null &&
    !status.pairings.includes(pairing.id);
  const pairingInvalid = pairingExpired || (pairingGone && !pairingUsed);
  const pairingLive = pairing !== null && !pairingInvalid && !pairingUsed;

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    setStatusError(null);
    setLoading(true);
    void api
      .loadAgentSshMobileStatus(projectId)
      .then((value) => {
        if (current) setStatus((previous) => withKnownAccess(previous, value));
      })
      .catch((reason: unknown) => {
        if (current) setStatusError(mobileErrorMessage(s, reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => void (current = false);
  }, [open, projectId, s]);

  // Paused: whether the button shows at all depends on the server, so read it before any click.
  useEffect(() => {
    if (!MOBILE_ACCESS_PAUSED || disconnected) return;
    let current = true;
    void api.loadAgentSshMobileStatus(projectId).then(
      (value) => {
        if (current) setStatus((previous) => withKnownAccess(previous, value));
      },
      // shortcut: a failed read keeps the button hidden until the project is reselected; retry if users report it.
      () => undefined,
    );
    return () => void (current = false);
  }, [disconnected, projectId]);

  useEffect(() => {
    if (!open || pending || loading || disconnected) return;
    let active = true;
    let timer = 0;
    const version = statusVersion.current;
    const refresh = () => {
      void api
        .loadAgentSshMobileStatus(projectId)
        .then(
          (value) => {
            if (!active || version !== statusVersion.current) return;
            setStatus((previous) => withKnownAccess(previous, value));
            setStatusError(null);
          },
          (reason: unknown) => {
            if (active && version === statusVersion.current)
              setStatusError(mobileErrorMessage(s, reason));
          },
        )
        .finally(() => {
          if (active) timer = window.setTimeout(refresh, STATUS_REFRESH_MS);
        });
    };
    timer = window.setTimeout(refresh, STATUS_REFRESH_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, pending, loading, disconnected, projectId, s]);

  useEffect(() => {
    if (!pairing || !pairingLive) return;
    const timer = window.setTimeout(
      () => setPairingExpired(true),
      Math.max(0, pairing.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pairing, pairingLive]);

  const hidden = MOBILE_ACCESS_PAUSED && !status?.installed;
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  async function requestPairing() {
    const next = await api.pairAgentSshMobile(projectId);
    setPairing(next);
    setPairingExpired(false);
    // The pending secret is known before the next status read lists it.
    setStatus((current) =>
      current?.pairings && !current.pairings.includes(next.id)
        ? { ...current, pairings: [...current.pairings, next.id] }
        : current,
    );
  }

  async function enable() {
    const pairAfter = view === "off" || view === "legacy";
    let next: SshMobileStatus;
    try {
      next = await api.enableAgentSshMobile(projectId);
    } catch (reason) {
      if (mobileErrorCode(reason) !== "relay") throw reason;
      // Installed and running: the service keeps reaching for the relay on its own.
      setError(mobileErrorMessage(s, reason));
      next = await api.loadAgentSshMobileStatus(projectId);
    }
    setStatus((previous) => withKnownAccess(previous, next));
    setStatusError(null);
    if (pairAfter && mobileView(next) === "active") {
      setPendingAction({ kind: "pair" });
      await requestPairing();
    }
  }

  async function run(action: MobileAction) {
    if (pending) return;
    setConfirming(false);
    statusVersion.current += 1;
    setPendingAction(action);
    onBusyChange(true);
    setError(null);
    try {
      if (action.kind === "enable") await enable();
      else if (action.kind === "pair") await requestPairing();
      else {
        const next = await (action.kind === "revoke"
          ? api.revokeAgentSshMobile(projectId, action.deviceId)
          : api.disableAgentSshMobile(projectId));
        setStatus((previous) => withKnownAccess(previous, next));
        setStatusError(null);
        if (action.kind === "disable") setPairing(null);
      }
    } catch (reason) {
      setError(mobileErrorMessage(s, reason));
      // A failed step can leave the service half installed: show what is really there.
      try {
        const next = await api.loadAgentSshMobileStatus(projectId);
        setStatus((previous) => withKnownAccess(previous, next));
        setStatusError(null);
      } catch {
        // The first error stays the one to explain.
      }
    } finally {
      setPendingAction(null);
      onBusyChange(false);
    }
  }

  const pendingKey =
    pendingAction?.kind === "revoke"
      ? `revoke:${pendingAction.deviceId}`
      : pendingAction?.kind;
  const spinner = (key: string) =>
    pendingKey === key ? (
      <LoaderCircle className="app-loading-spinner" />
    ) : undefined;
  const connected = Boolean(status?.installed && status.connected);

  function qrPanel() {
    if (!pairing || !pairingLive) return null;
    return (
      <div className="ssh-mobile-phone">
        <img
          className="ssh-mobile-qr"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`}
          alt={s.sshMobileQrAlt}
          width={152}
          height={152}
        />
        <div>
          <ol className="ssh-mobile-steps">
            {s.sshMobilePhoneSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="ssh-mobile-validity">
            {s.sshMobilePairingValidity(pairing.expiresAt)}
          </p>
          <Button
            size="small"
            disabled={pending}
            startIcon={spinner("pair")}
            onClick={() => void run({ kind: "pair" })}
          >
            {s.sshMobileNewQr}
          </Button>
        </div>
      </div>
    );
  }

  function pairingNote() {
    if (pairingUsed)
      return (
        <p className="ssh-mobile-pair-note is-paired" role="status">
          <CircleCheck size={14} aria-hidden="true" />
          {s.sshMobilePaired}
        </p>
      );
    if (pairing && pairingInvalid)
      return (
        <p className="ssh-mobile-pair-note" role="status">
          {s.sshMobilePairingExpired}
        </p>
      );
    return null;
  }

  function activeAccess(status: SshMobileStatus) {
    return (
      <>
        {status.stateFresh && !status.connected ? (
          <p className="ssh-mobile-warning" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{s.sshMobileRelayUnreachable}</span>
          </p>
        ) : null}
        {qrPanel()}
        <div className="ssh-mobile-section-head">
          <h3 className="ssh-mobile-heading">{s.sshMobileDevices}</h3>
          {pairing && pairingLive ? null : (
            <div className="ssh-mobile-section-actions">
              {pairingNote()}
              <Button
                variant="primary"
                size="small"
                disabled={pending || loading}
                startIcon={spinner("pair")}
                onClick={() => void run({ kind: "pair" })}
              >
                {s.sshMobilePair}
              </Button>
            </div>
          )}
        </div>
        {status.devices === null ? (
          <p className="ssh-forward-description">{s.sshMobileDevicesUnknown}</p>
        ) : status.devices.length === 0 ? (
          <p className="ssh-forward-description">{s.sshMobileNoDevices}</p>
        ) : (
          <ul className="ssh-mobile-devices">
            {status.devices.map((device) => (
              <li key={device.id}>
                <div className="ssh-mobile-device">
                  <strong>{device.label}</strong>
                  <span>
                    {s.sshMobileDeviceDates(device.pairedAt, device.lastSeenAt)}
                  </span>
                </div>
                <Button
                  size="small"
                  disabled={pending || loading}
                  startIcon={spinner(`revoke:${device.id}`)}
                  onClick={() =>
                    void run({ kind: "revoke", deviceId: device.id })
                  }
                >
                  {s.sshMobileRevoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  if (hidden) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="agent-ssh-toggle"
        disabled={disabled || disconnected}
        title={
          connected
            ? `${s.sshMobileTitle} · ${s.sshMobileConnected}`
            : s.sshMobileTitle
        }
        onClick={() => setOpen(true)}
      >
        {status?.installed && status.supported ? (
          <span
            className={`ssh-mobile-dot${connected ? " ssh-mobile-dot-connected" : ""}`}
            aria-hidden="true"
          />
        ) : null}
        {s.sshMobile}
      </button>
      {open
        ? createPortal(
            <DialogOverlay>
              <DialogSurface
                ref={surfaceRef}
                className="agent-form-dialog ssh-forward-dialog ssh-mobile-dialog"
                returnFocusRef={triggerRef}
                aria-labelledby={titleId}
              >
                <header className="ssh-mobile-header">
                  <div className="ssh-mobile-title">
                    <h2 id={titleId}>{s.sshMobileTitle}</h2>
                    <p className="ssh-mobile-server" title={address}>
                      {address}
                    </p>
                  </div>
                  {status &&
                  view === "active" &&
                  !(status.stateFresh && !status.connected) ? (
                    <span className="ssh-mobile-connection" role="status">
                      <span
                        className={`ssh-mobile-dot${status.connected ? " ssh-mobile-dot-connected" : ""}`}
                        aria-hidden="true"
                      />
                      {status.connected
                        ? s.sshMobileConnected
                        : s.sshMobileConnecting}
                    </span>
                  ) : null}
                </header>
                {loading && !status ? (
                  <p className="ssh-mobile-loading" role="status">
                    <span className="ssh-mobile-spinner" aria-hidden="true">
                      <LoaderCircle size={14} className="app-loading-spinner" />
                    </span>
                    {s.sshMobileLoading}
                  </p>
                ) : status && MOBILE_ACCESS_PAUSED ? (
                  <p className="ssh-mobile-state">{s.sshMobilePaused}</p>
                ) : status && view === "active" ? (
                  activeAccess(status)
                ) : status && view ? (
                  <p
                    className={
                      view === "off"
                        ? "ssh-forward-description"
                        : "ssh-mobile-state"
                    }
                  >
                    {view === "unsupported"
                      ? s.sshMobileUnsupported(status.platform)
                      : view === "off"
                        ? s.sshMobileIntro
                        : view === "legacy"
                          ? s.sshMobileLegacy
                          : s.sshMobileOutdated}
                  </p>
                ) : null}
                {statusError ? (
                  <p className="ssh-mobile-error" role="alert">
                    {statusError}
                  </p>
                ) : null}
                {error ? (
                  <p className="ssh-mobile-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <footer>
                  <Button disabled={pending} onClick={dismiss}>
                    {s.dismiss}
                  </Button>
                  {view === "legacy" ||
                  view === "outdated" ||
                  view === "active" ? (
                    <Button
                      disabled={pending || loading}
                      startIcon={spinner("disable")}
                      onClick={() => setConfirming(true)}
                    >
                      {s.sshMobileDisable}
                    </Button>
                  ) : null}
                  {!MOBILE_ACCESS_PAUSED &&
                  (view === "off" ||
                    view === "legacy" ||
                    view === "outdated") ? (
                    <Button
                      variant="primary"
                      disabled={pending || loading}
                      startIcon={spinner("enable")}
                      onClick={() => void run({ kind: "enable" })}
                    >
                      {view === "off" ? s.sshMobileEnable : s.sshMobileUpdate}
                    </Button>
                  ) : null}
                </footer>
              </DialogSurface>
            </DialogOverlay>,
            document.body,
          )
        : null}
      {open && confirming
        ? createPortal(
            <ConfirmationDialog
              title={s.sshMobileDisableTitle}
              description={s.sshMobileDisableDescription}
              cancelLabel={s.cancel}
              closeLabel={s.cancel}
              confirmLabel={s.sshMobileDisable}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void run({ kind: "disable" })}
            />,
            document.body,
          )
        : null}
    </>
  );
}
