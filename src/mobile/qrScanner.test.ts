// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startScanner } from "./qrScanner";

function fakeStream() {
  const track = { stop: vi.fn() };
  return {
    track,
    stream: { getTracks: () => [track] } as never as MediaStream,
  };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the preview of a remounted scanner when the first one starts late", async () => {
  const cameras: ((stream: MediaStream) => void)[] = [];
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => cameras.push(resolve)),
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as never,
  );
  const video = document.createElement("video");
  video.play = () => Promise.resolve();

  const first = new AbortController();
  const firstStart = startScanner(video, () => undefined, first.signal);
  first.abort();
  const second = new AbortController();
  const secondStart = startScanner(video, () => undefined, second.signal);

  const late = fakeStream();
  const current = fakeStream();
  cameras[1](current.stream);
  const stopSecond = await secondStart;
  expect(video.srcObject).toBe(current.stream);

  cameras[0](late.stream);
  expect(await firstStart).toBeNull();
  expect(late.track.stop).toHaveBeenCalled();
  expect(video.srcObject).toBe(current.stream);
  expect(current.track.stop).not.toHaveBeenCalled();

  stopSecond?.();
  expect(video.srcObject).toBeNull();
});

it("releases the camera as soon as the start is cancelled during play, without touching a remounted preview", async () => {
  const late = fakeStream();
  const current = fakeStream();
  const streams = [late.stream, current.stream];
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => Promise.resolve(streams.shift()) },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as never,
  );
  const video = document.createElement("video");
  const plays: (() => void)[] = [];
  video.play = () => new Promise<void>((resolve) => plays.push(resolve));

  const first = new AbortController();
  const firstStart = startScanner(video, () => undefined, first.signal);
  await vi.waitFor(() => expect(plays).toHaveLength(1));
  first.abort();
  expect(late.track.stop).toHaveBeenCalled();
  expect(video.srcObject).toBeNull();
  const secondStart = startScanner(
    video,
    () => undefined,
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(plays).toHaveLength(2));
  plays[1]();
  const stopSecond = await secondStart;
  plays[0]();
  expect(await firstStart).toBeNull();
  expect(late.track.stop).toHaveBeenCalled();
  expect(video.srcObject).toBe(current.stream);
  stopSecond?.();
});
