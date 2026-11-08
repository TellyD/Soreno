// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import {
  readImage,
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import {
  readClipboardText,
  readTerminalClipboard,
  writeClipboardText,
} from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("uses the native plugin in desktop, never the denied WebView API", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(readText).mockResolvedValue("native");
  vi.mocked(writeText).mockResolvedValue(undefined);
  const browserRead = vi.fn();
  const browserWrite = vi.fn();
  vi.stubGlobal("navigator", {
    clipboard: { readText: browserRead, writeText: browserWrite },
  });
  expect(await readClipboardText()).toBe("native");
  await writeClipboardText("copy");
  expect(writeText).toHaveBeenCalledExactlyOnceWith("copy");
  expect(browserRead).not.toHaveBeenCalled();
  expect(browserWrite).not.toHaveBeenCalled();
  vi.mocked(readText).mockRejectedValue(new Error("native denied"));
  vi.mocked(writeText).mockRejectedValue(new Error("native denied"));
  await expect(readClipboardText()).rejects.toThrow("native denied");
  await expect(writeClipboardText("copy")).rejects.toThrow("native denied");
  expect(browserRead).not.toHaveBeenCalled();
  expect(browserWrite).not.toHaveBeenCalled();
});

it("prioritizes a native image, closes its resource and does not read its pixels or text", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const image = { close: vi.fn().mockResolvedValue(undefined), rgba: vi.fn() };
  vi.mocked(readImage).mockResolvedValue(image as never);
  vi.mocked(readText).mockResolvedValue("also text");
  await expect(readTerminalClipboard()).resolves.toEqual({ type: "image" });
  expect(image.close).toHaveBeenCalledOnce();
  expect(image.rgba).not.toHaveBeenCalled();
  expect(readText).not.toHaveBeenCalled();
});

it("encodes native clipboard pixels when a remote image payload is requested", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const image = {
    close: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockResolvedValue({ width: 1, height: 1 }),
    rgba: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 255])),
  };
  vi.mocked(readImage).mockResolvedValue(image as never);
  const set = vi.fn();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({
      createImageData: () => ({ data: { set } }),
      putImageData: vi.fn(),
    } as never);
  const webp = new TextEncoder().encode("RIFFxxxxWEBP");
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) => {
      callback({
        type: "image/webp",
        size: webp.length,
        arrayBuffer: async () => webp.buffer,
      } as Blob);
    });
  await expect(readTerminalClipboard(true)).resolves.toEqual({
    type: "image",
    mimeType: "image/webp",
    dataBase64: "UklGRnh4eHhXRUJQ",
  });
  expect(set).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 255]));
  expect(image.close).toHaveBeenCalledOnce();
  getContext.mockRestore();
  toBlob.mockRestore();
});

it("falls back to native text when image reading fails and propagates the text error", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(readImage).mockRejectedValue(new Error("no image"));
  vi.mocked(readText)
    .mockResolvedValueOnce("native text")
    .mockRejectedValueOnce(new Error("text denied"));
  await expect(readTerminalClipboard()).resolves.toEqual({
    type: "text",
    text: "native text",
  });
  await expect(readTerminalClipboard()).rejects.toThrow("text denied");
});

it("does not treat a native image close failure as absence of an image", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const image = { close: vi.fn().mockRejectedValue(new Error("close failed")) };
  vi.mocked(readImage).mockResolvedValue(image as never);
  await expect(readTerminalClipboard()).rejects.toThrow("close failed");
  expect(readText).not.toHaveBeenCalled();
});

it("inspects browser clipboard types and prioritizes images before falling back to text", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const read = vi
    .fn()
    .mockResolvedValueOnce([{ types: ["text/plain", "image/png"] }])
    .mockResolvedValueOnce([{ types: ["text/plain"] }])
    .mockRejectedValueOnce(new Error("browser denied"));
  const readText = vi.fn().mockResolvedValue("browser text");
  vi.stubGlobal("navigator", { clipboard: { read, readText } });
  await expect(readTerminalClipboard()).resolves.toEqual({ type: "image" });
  await expect(readTerminalClipboard()).resolves.toEqual({
    type: "text",
    text: "browser text",
  });
  await expect(readTerminalClipboard()).rejects.toThrow("browser denied");
  expect(readText).toHaveBeenCalledOnce();
  expect(readImage).not.toHaveBeenCalled();
});

it("falls back to browser text APIs outside Tauri and propagates denial", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const read = vi.fn().mockResolvedValue("browser");
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    clipboard: { readText: read, writeText: write },
  });
  expect(await readClipboardText()).toBe("browser");
  expect(await readTerminalClipboard()).toEqual({
    type: "text",
    text: "browser",
  });
  await writeClipboardText("copy");
  expect(write).toHaveBeenCalledExactlyOnceWith("copy");
  read.mockRejectedValue(new Error("Read permission denied"));
  write.mockRejectedValue(new Error("Write permission denied"));
  await expect(readClipboardText()).rejects.toThrow("Read permission denied");
  await expect(writeClipboardText("copy")).rejects.toThrow(
    "Write permission denied",
  );
  expect(readText).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
});

it("reports an unavailable browser API", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.stubGlobal("navigator", {});
  await expect(readClipboardText()).rejects.toThrow(
    "Clipboard API unavailable",
  );
  await expect(writeClipboardText("copy")).rejects.toThrow(
    "Clipboard API unavailable",
  );
});
