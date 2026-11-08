// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importAgentProjectIcon } from "./agentProjectIcon";

const png = "data:image/png;base64,aWNvbg==";
const drawImage = vi.fn();
let decodeFails: boolean;
let dimensions: { width: number; height: number };

beforeEach(() => {
  decodeFails = false;
  dimensions = { width: 200, height: 100 };
  drawImage.mockClear();
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:icon"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = dimensions.width;
      naturalHeight = dimensions.height;
      onload = () => {};
      onerror = () => {};
      set src(_value: string) {
        queueMicrotask(() => (decodeFails ? this.onerror() : this.onload()));
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (this: HTMLCanvasElement, type) {
      expect([this.width, this.height, type]).toEqual([64, 64, "image/png"]);
      return png;
    },
  );
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["image/png", "image/jpeg", "image/webp", "image/gif"])(
  "converts %s to a contained, centered PNG and releases the source URL",
  async (type) => {
    await expect(
      importAgentProjectIcon(new File(["image"], "logo", { type })),
    ).resolves.toBe(png);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 16, 64, 32);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon");
  },
);

it("fills the icon slot even for a small source icon", async () => {
  dimensions = { width: 16, height: 16 };
  await importAgentProjectIcon(
    new File(["icon"], "small.png", { type: "image/png" }),
  );
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 64, 64);
});

it("rejects unsupported, empty and oversized files before decoding", async () => {
  for (const file of [
    new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
    new File([], "empty.png", { type: "image/png" }),
    new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    }),
  ])
    await expect(importAgentProjectIcon(file)).rejects.toThrow();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("releases the source URL on decoding or encoding failure", async () => {
  const file = new File(["image"], "logo.png", { type: "image/png" });
  decodeFails = true;
  await expect(importAgentProjectIcon(file)).rejects.toThrow("decode");
  decodeFails = false;
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue("data:,");
  await expect(importAgentProjectIcon(file)).rejects.toThrow("encode");
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue(
    `data:image/png;base64,${"A".repeat(32 * 1024)}`,
  );
  await expect(importAgentProjectIcon(file)).rejects.toThrow("encode");
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
});
