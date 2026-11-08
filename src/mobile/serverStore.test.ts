import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { dh, generateStaticKey } from "./noise";
import { encodeKey } from "./protocol";
import { indexedDbServerStore, type PairedServer } from "./serverStore";

async function paired(
  server: string,
  host: string,
  extractable = false,
): Promise<PairedServer> {
  const { keyPair, publicKey } = await generateStaticKey(extractable);
  return {
    server,
    host,
    keyPair,
    publicKey: encodeKey(publicKey),
    pairedAt: 1_700_000_000_000,
  };
}

/** WebKit's structured clone, which IndexedDB uses: X25519 keys cannot go through. */
function refuseX25519Keys(value: unknown) {
  if (typeof value !== "object" || value === null) return;
  if ("algorithm" in value && "type" in value) {
    if ((value as CryptoKey).algorithm.name === "X25519")
      throw new DOMException("X25519 key", "DataCloneError");
    return;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
  Object.values(value).forEach(refuseX25519Keys);
}

it("keeps paired servers with their non-extractable keys across openings", async () => {
  const factory = new IDBFactory();
  const vps = await paired("A".repeat(43), "vps");
  const lab = await paired("B".repeat(43), "lab");
  const store = indexedDbServerStore(factory);
  await store.save(vps);
  await store.save(lab);
  await store.save({ ...vps, host: "vps-2" });

  const reopened = await indexedDbServerStore(factory).list();
  expect(reopened.map((entry) => [entry.server, entry.host])).toEqual([
    [vps.server, "vps-2"],
    [lab.server, "lab"],
  ]);
  expect(reopened[0].keyPair.privateKey.extractable).toBe(false);
  expect(reopened[0].publicKey).toBe(vps.publicKey);

  await store.forget(vps.server);
  expect(
    (await indexedDbServerStore(factory).list()).map((entry) => entry.server),
  ).toEqual([lab.server]);
});

it("seals the keys of a browser that cannot clone X25519 keys", async () => {
  const clone = structuredClone;
  vi.stubGlobal("structuredClone", (value: unknown) => {
    refuseX25519Keys(value);
    return clone(value);
  });
  try {
    const factory = new IDBFactory();
    const vps = await paired("A".repeat(43), "vps", true);
    await indexedDbServerStore(factory, async () => false).save(vps);

    const [reopened] = await indexedDbServerStore(
      factory,
      async () => false,
    ).list();
    expect(reopened.keyPair.privateKey.extractable).toBe(false);
    expect(reopened.publicKey).toBe(vps.publicKey);
    const peer = await generateStaticKey();
    expect(await dh(reopened.keyPair.privateKey, peer.publicKey)).toEqual(
      await dh(vps.keyPair.privateKey, peer.publicKey),
    );

    const store = indexedDbServerStore(factory, async () => false);
    await store.save({ ...reopened, host: "vps-2" });
    const [repaired] = await store.list();
    expect(repaired.host).toBe("vps-2");
    expect(repaired.keyPair.privateKey.extractable).toBe(false);
    expect(await dh(repaired.keyPair.privateKey, peer.publicKey)).toEqual(
      await dh(vps.keyPair.privateKey, peer.publicKey),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
