// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionView } from "./SessionView";
import type { ConversationItem, ConversationReset } from "./conversation";
import { mobileStrings } from "./mobileStrings";
import type { Channel, OpenRequest } from "./relayChannel";
import type { PairedServer } from "./serverStore";

class FakeChannel implements Channel {
  open = false;
  onopen: Channel["onopen"] = null;
  onmessage: Channel["onmessage"] = null;
  onclose: Channel["onclose"] = null;
  sent: unknown[] = [];
  constructor(
    readonly server: string,
    readonly request: OpenRequest,
  ) {}
  send(message: unknown) {
    this.sent.push(message);
  }
  close() {
    this.open = false;
  }
}

const channels = vi.hoisted(() => [] as FakeChannel[]);
vi.mock("./relayChannel", () => ({
  serverChannel: (server: PairedServer, request: OpenRequest) => {
    const channel = new FakeChannel(server.server, request);
    channels.push(channel);
    return channel;
  },
}));

const SERVER: PairedServer = {
  server: `${"V".repeat(42)}Q`,
  host: "vps",
  keyPair: {} as CryptoKeyPair,
  publicKey: "",
  pairedAt: 0,
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  channels.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function current() {
  return channels[channels.length - 1];
}

async function open() {
  await act(async () => {
    const channel = current();
    channel.open = true;
    channel.onopen?.({ host: "vps", version: "1" });
  });
}

async function reset(
  message: ConversationReset & { items?: ConversationItem[] },
) {
  await act(async () => current().onmessage?.({ type: "reset", ...message }));
}

/** The composer: hidden, or whether a typed message can be sent. */
async function composer() {
  const field = container.querySelector("textarea");
  if (!field) return "hidden";
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, "Oui");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = container.querySelector<HTMLButtonElement>(
    ".mobile-composer-send",
  )!;
  return send.disabled ? "disabled" : "enabled";
}

function render() {
  return act(async () =>
    root.render(
      <SessionView
        target={{
          server: SERVER,
          host: "vps",
          key: "0123456789abcdef0123456789abcdef",
        }}
        session={null}
        onShown={() => undefined}
        strings={mobileStrings.fr}
      />,
    ),
  );
}

function loading() {
  return (
    container.querySelector(".mobile-conversation-loading")?.textContent ?? null
  );
}

it("keeps the wait in the middle until the first conversation arrives with its messages", async () => {
  await render();
  expect([current().server, current().request]).toEqual([
    SERVER.server,
    { kind: "conversation", key: "0123456789abcdef0123456789abcdef" },
  ]);
  expect(loading()).toBe("Connexion…");
  await open();
  expect(loading()).toBe("Chargement de la conversation…");
  await reset({
    provider: "omp",
    available: true,
    truncated: false,
    items: [{ kind: "assistant", id: "a", text: "Tests verts." }],
  });
  expect(loading()).toBeNull();
  expect(container.textContent).toContain("Tests verts.");
  expect(container.textContent).not.toContain(
    mobileStrings.fr.conversationEmpty,
  );
});

it("says when this phone is no longer allowed on the server", async () => {
  await render();
  await act(async () => current().onclose?.("unpaired"));
  expect(container.querySelector(".mobile-banner")?.textContent).toBe(
    mobileStrings.fr.unpaired,
  );
});

it("lets the phone type only once this connection names a recognized agent", async () => {
  await render();
  await open();
  expect(await composer()).toBe("disabled");
  await reset({ provider: "omp", available: false, truncated: false });
  expect(await composer()).toBe("enabled");

  // The session may have been relaunched without an agent while the link was down.
  await act(async () => {
    current().open = false;
    current().onclose?.("closed");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  await open();
  expect(await composer()).toBe("disabled");
  await reset({ provider: null, available: false, truncated: false });
  expect(await composer()).toBe("hidden");
});

it("says the history was deleted and stops typing into a conversation no longer shown", async () => {
  await render();
  await open();
  await reset({ provider: "omp", available: true, truncated: false });
  expect(await composer()).toBe("enabled");
  await reset({
    provider: "omp",
    available: false,
    truncated: false,
    deleted: true,
  });
  expect(await composer()).toBe("hidden");
  expect(container.textContent).toContain(
    mobileStrings.fr.deletedConversationTitle,
  );
  expect(container.textContent).not.toContain(
    mobileStrings.fr.noConversationTitle,
  );
});

function field() {
  return container.querySelector("textarea")!;
}

function imageButton() {
  return container.querySelector<HTMLButtonElement>(".mobile-composer-image");
}

async function typeMessage(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field(), text);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pick(file: File) {
  const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(current().sent).toHaveLength(1));
  });
  return current().sent[0] as { id: number; mimeType: string; data: string };
}

const capture = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "capture.png", {
    type: "image/png",
  });

it("offers images only to a server that saves them", async () => {
  await render();
  await open();
  await reset({ provider: "omp", available: true, truncated: false });
  expect(imageButton()).toBeNull();
  await reset({
    provider: "omp",
    available: true,
    truncated: false,
    images: true,
  });
  expect(imageButton()?.disabled).toBe(false);
});

it("adds the saved path of a picked screenshot to the message", async () => {
  await render();
  await open();
  await reset({
    provider: "claude",
    available: true,
    truncated: false,
    images: true,
  });
  await typeMessage("Regarde");
  const sent = await pick(capture());
  expect(sent).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(atob(sent.data)).toBe("\x89PNG");
  expect(imageButton()?.disabled).toBe(true);
  await act(async () =>
    current().onmessage?.({
      type: "imageSaved",
      id: sent.id,
      path: "/h/clipboard/i.png",
    }),
  );
  expect(field().value).toBe("Regarde /h/clipboard/i.png ");
  expect(imageButton()?.disabled).toBe(false);
});

it("holds the message until the picked screenshot is saved", async () => {
  await render();
  await open();
  await reset({
    provider: "claude",
    available: true,
    truncated: false,
    images: true,
  });
  await typeMessage("Regarde");
  const sent = await pick(capture());
  const send = container.querySelector<HTMLButtonElement>(
    ".mobile-composer-send",
  )!;
  expect(send.disabled).toBe(true);
  await act(async () => {
    send.click();
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(current().sent).toEqual([sent]);
  await act(async () =>
    current().onmessage?.({
      type: "imageSaved",
      id: sent.id,
      path: "/h/clipboard/i.png",
    }),
  );
  expect(send.disabled).toBe(false);
  expect(field().value).toBe("Regarde /h/clipboard/i.png ");
});

it("explains a refused image and keeps the message", async () => {
  await render();
  await open();
  await reset({
    provider: "claude",
    available: true,
    truncated: false,
    images: true,
  });
  await typeMessage("Regarde");
  const sent = await pick(capture());
  await act(async () =>
    current().onmessage?.({ type: "imageFailed", id: sent.id }),
  );
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "L’image n’a pas pu être envoyée au serveur.",
  );
  expect(field().value).toBe("Regarde");
});
