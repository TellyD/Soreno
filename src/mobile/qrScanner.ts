export type CameraFailure = "denied" | "unavailable";

export class CameraError extends Error {
  constructor(readonly kind: CameraFailure) {
    super(kind);
  }
}

const SCAN_INTERVAL_MS = 200;

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CameraError("unavailable");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (error) {
    const denied =
      error instanceof DOMException &&
      (error.name === "NotAllowedError" || error.name === "SecurityError");
    throw new CameraError(denied ? "denied" : "unavailable");
  }
}

/** Shows the back camera in `video` and reads QR codes until stopped; returns the stop, or `null` when `signal` aborted the start. */
export async function startScanner(
  video: HTMLVideoElement,
  onText: (text: string) => void,
  signal: AbortSignal,
) {
  const stream = await openCamera();
  let stopped = false;
  let timer = 0;
  const stop = () => {
    stopped = true;
    signal.removeEventListener("abort", stop);
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    // A newer scanner may already show its own stream in the same element.
    if (video.srcObject === stream) video.srcObject = null;
  };
  if (signal.aborted) {
    stop();
    return null;
  }
  // Closing the view while `play()` or the decoder is pending must release the camera at once.
  signal.addEventListener("abort", stop, { once: true });
  try {
    // Loaded on demand: the decoder is the heaviest part of the page and most visits never scan.
    const [{ default: jsQR }] = await Promise.all([
      import("jsqr"),
      (async () => {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await video.play();
      })(),
    ]);
    if (stopped) return null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new CameraError("unavailable");
    const scan = () => {
      if (stopped) return;
      if (video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: "dontInvert",
        });
        if (code?.data) onText(code.data);
      }
      timer = window.setTimeout(scan, SCAN_INTERVAL_MS);
    };
    scan();
  } catch (error) {
    const cancelled = stopped;
    stop();
    if (cancelled) return null;
    throw error instanceof CameraError ? error : new CameraError("unavailable");
  }
  return stop;
}
