// The server's side of Noise IK, for tests only: the page never answers a handshake.
import {
  dh,
  SymmetricState,
  Transport,
  generateStaticKey,
  type StaticKey,
} from "./noise";
import { KEY_LENGTH, TAG_LENGTH, decodeKey, type Bytes } from "./protocol";

const PKCS8_X25519 = "302e020100300506032b656e04220420";

export function hex(text: string): Bytes {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

export function toHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A fixed key, imported as JWK with its private half not extractable, like the page's own. */
export async function importStaticKey(privateHex: string): Promise<StaticKey> {
  const extractable = await crypto.subtle.importKey(
    "pkcs8",
    hex(PKCS8_X25519 + privateHex),
    { name: "X25519" },
    true,
    ["deriveBits"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", d: jwk.d, x: jwk.x },
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  return { privateKey, publicKey: decodeKey(jwk.x!)! };
}

export async function randomStaticKey(): Promise<StaticKey> {
  const { keyPair, publicKey } = await generateStaticKey();
  return { privateKey: keyPair.privateKey, publicKey };
}

export class Responder {
  private constructor(
    private readonly state: SymmetricState,
    private readonly remoteEphemeral: Bytes,
    readonly remoteStatic: Bytes,
  ) {}

  /** Message 1: `-> e, es, s, ss`. */
  static async read(options: {
    local: StaticKey;
    prologue: Uint8Array;
    message: Uint8Array;
  }) {
    const { local, message } = options;
    const state = await SymmetricState.initialize(options.prologue);
    await state.mixHash(local.publicKey);
    const remoteEphemeral = message.slice(0, KEY_LENGTH);
    await state.mixHash(remoteEphemeral);
    await state.mixKey(await dh(local.privateKey, remoteEphemeral));
    const remoteStatic = await state.decryptAndHash(
      message.subarray(KEY_LENGTH, 2 * KEY_LENGTH + TAG_LENGTH),
    );
    await state.mixKey(await dh(local.privateKey, remoteStatic));
    const payload = await state.decryptAndHash(
      message.subarray(2 * KEY_LENGTH + TAG_LENGTH),
    );
    return {
      responder: new Responder(state, remoteEphemeral, remoteStatic),
      payload,
    };
  }

  /** Message 2: `<- e, ee, se`. */
  async write(payload: Uint8Array, ephemeral?: StaticKey) {
    const state = this.state;
    const local = ephemeral ?? (await randomStaticKey());
    await state.mixHash(local.publicKey);
    await state.mixKey(await dh(local.privateKey, this.remoteEphemeral));
    await state.mixKey(await dh(local.privateKey, this.remoteStatic));
    const encrypted = await state.encryptAndHash(payload);
    const [initiatorSending, responderSending] = await state.split();
    const message = new Uint8Array(KEY_LENGTH + encrypted.length);
    message.set(local.publicKey);
    message.set(encrypted, KEY_LENGTH);
    return {
      message,
      transport: new Transport(responderSending, initiatorSending, state.hash),
    };
  }
}
