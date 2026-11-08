import { CameraOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import type { MobileStrings } from "./mobileStrings";
import { pairingFromUrl, type PairingCode } from "./pairing";
import { CameraError, startScanner, type CameraFailure } from "./qrScanner";

type ScanNotice = "hint" | "foreign" | CameraFailure;

/** Reads a pairing QR code with the camera: what an app on the iOS home screen needs, since it does not share Safari's keys. */
export function ScanView({
  strings,
  onCode,
  onClose,
}: {
  strings: MobileStrings;
  onCode: (code: PairingCode) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [notice, setNotice] = useState<ScanNotice>("hint");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stop: (() => void) | null = null;
    let done = false;
    const abort = new AbortController();
    startScanner(
      video.current!,
      (text) => {
        if (done) return;
        const code = pairingFromUrl(text, window.location.origin);
        if (!code) {
          setNotice("foreign");
          return;
        }
        done = true;
        onCodeRef.current(code);
      },
      abort.signal,
    ).then(
      (stopScanner) => {
        if (done) stopScanner?.();
        else stop = stopScanner;
      },
      (error: unknown) => {
        if (!done)
          setNotice(error instanceof CameraError ? error.kind : "unavailable");
      },
    );
    return () => {
      done = true;
      abort.abort();
      stop?.();
    };
  }, []);

  const failed = notice === "denied" || notice === "unavailable";
  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-header-title">
          <h1 className="mobile-app-title">{strings.scanQr}</h1>
        </div>
        <IconButton
          aria-label={strings.cancel}
          title={strings.cancel}
          onClick={onClose}
        >
          <X />
        </IconButton>
      </header>
      <main className="mobile-content mobile-scan">
        {failed ? (
          <EmptyState
            fill
            icon={<CameraOff />}
            description={
              notice === "denied"
                ? strings.cameraDenied
                : strings.cameraUnavailable
            }
          />
        ) : (
          <>
            <video
              ref={video}
              className="mobile-scan-video"
              muted
              playsInline
            />
            <p className="mobile-scan-notice" role="status">
              {notice === "foreign" ? strings.scanForeign : strings.scanHint}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
