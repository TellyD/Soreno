import {
  CircleCheck,
  Clock,
  CloudOff,
  QrCode,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import type { MobileStrings } from "./mobileStrings";
import type { PairingPhase } from "./usePairing";

type Failure = Extract<PairingPhase, { kind: "failed" }>["end"];

function failureText(end: Failure, strings: MobileStrings) {
  switch (end) {
    case "pairing":
      return {
        icon: <Clock />,
        title: strings.pairingExpiredTitle,
        body: strings.pairingExpiredBody,
      };
    case "throttled":
      return {
        icon: <Clock />,
        title: strings.pairingThrottledTitle,
        body: strings.pairingThrottledBody,
      };
    case "offline":
      return {
        icon: <CloudOff />,
        title: strings.pairingOfflineTitle,
        body: strings.pairingOfflineBody,
      };
    case "invalid":
      return {
        icon: <QrCode />,
        title: strings.pairingInvalidTitle,
        body: strings.pairingInvalidBody,
      };
    default:
      return {
        icon: <TriangleAlert />,
        title: strings.pairingFailedTitle,
        body: strings.pairingFailedBody,
      };
  }
}

/** A screen of the app shell without session content: pairing, unsupported browser. */
export function MessageScreen({
  strings,
  children,
}: {
  strings: MobileStrings;
  children: ReactNode;
}) {
  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-header-title">
          <h1 className="mobile-app-title">{strings.appName}</h1>
        </div>
      </header>
      <main className="mobile-content">{children}</main>
    </div>
  );
}

export function PairingView({
  phase,
  canRetry,
  strings,
  onRetry,
  onScan,
  onClose,
}: {
  phase: PairingPhase;
  canRetry: boolean;
  strings: MobileStrings;
  onRetry: () => void;
  onScan: () => void;
  onClose: () => void;
}) {
  if (phase.kind === "pairing")
    return (
      <MessageScreen strings={strings}>
        <LoadingState className="mobile-loading">
          {strings.pairingProgress}
        </LoadingState>
      </MessageScreen>
    );
  if (phase.kind === "paired")
    return (
      <MessageScreen strings={strings}>
        <EmptyState
          fill
          icon={<CircleCheck />}
          title={strings.pairedTitle(phase.host)}
          description={strings.pairedIosInstall}
          actions={
            <Button size="large" variant="primary" onClick={onClose}>
              {strings.showSessions}
            </Button>
          }
        />
      </MessageScreen>
    );
  const text = failureText(phase.end, strings);
  // A used or expired secret never works again: only a new QR code helps.
  const retry = canRetry && phase.end !== "pairing";
  return (
    <MessageScreen strings={strings}>
      <EmptyState
        fill
        icon={text.icon}
        title={text.title}
        description={text.body}
        actions={
          <>
            {retry ? (
              <Button
                size="large"
                variant="primary"
                startIcon={<RefreshCw />}
                onClick={onRetry}
              >
                {strings.retry}
              </Button>
            ) : (
              <Button
                size="large"
                variant="primary"
                startIcon={<QrCode />}
                onClick={onScan}
              >
                {strings.scanQr}
              </Button>
            )}
            <Button size="large" onClick={onClose}>
              {strings.backToServers}
            </Button>
          </>
        }
      />
    </MessageScreen>
  );
}
