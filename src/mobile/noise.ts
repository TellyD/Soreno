import { KEY_LENGTH, NOISE, TAG_LENGTH, type Bytes } from "./protocol";

/** `publicKey` is raw: what Noise sends and the server identifies. */
export type StaticKey = { privateKey: CryptoKey; publicKey: Bytes };

const X25519 = { name: "X25519" } as const;
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const HASH_LENGTH = 32;
const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Bytes {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** A private key that never leaves the browser, unless `extractable` to be stored wrapped, and its raw public key. */
export async function generateStaticKey(extractable = false): Promise<{
  keyPair: CryptoKeyPair;
  publicKey: Bytes;
}> {
  const keyPair = (await crypto.subtle.generateKey(X25519, extractable, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return { keyPair, publicKey: await rawPublicKey(keyPair.publicKey) };
}

async function rawPublicKey(publicKey: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

/** Safari before 17 and older Chromium have no X25519 in WebCrypto. */
export async function x25519Supported() {
  try {
    await generateStaticKey();
    return true;
  } catch {
    return false;
  }
}

export async function dh(privateKey: CryptoKey, publicKey: Uint8Array) {
  if (publicKey.length !== KEY_LENGTH) throw new Error("Invalid key");
  const remote = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(publicKey),
    X25519,
    true,
    [],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: remote },
      privateKey,
      KEY_LENGTH * 8,
    ),
  );
}

async function hash(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  );
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    HMAC,
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new Uint8Array(data)),
  );
}

async function hkdf(chainingKey: Uint8Array, input: Uint8Array) {
  const temporary = await hmac(chainingKey, input);
  const first = await hmac(temporary, Uint8Array.of(1));
  const second = await hmac(temporary, concat(first, Uint8Array.of(2)));
  return [first, second] as const;
}

/** AES-GCM with the Noise nonce: 4 zero bytes, then a 64-bit big-endian counter. */
class CipherState {
  private key: CryptoKey | null = null;
  private nonce = 0;

  static async withKey(key: Uint8Array) {
    const state = new CipherState();
    state.key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(key.subarray(0, 32)),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return state;
  }

  // The counter moves at call time: calls answer in the order they were made.
  private next() {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(4, Math.floor(this.nonce / 2 ** 32));
    view.setUint32(8, this.nonce >>> 0);
    this.nonce++;
    return iv;
  }

  async encrypt(ad: Uint8Array, plaintext: Uint8Array): Promise<Bytes> {
    if (!this.key) return new Uint8Array(plaintext);
    const iv = this.next();
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new Uint8Array(ad),
          tagLength: TAG_LENGTH * 8,
        },
        this.key,
        new Uint8Array(plaintext),
      ),
    );
  }

  async decrypt(ad: Uint8Array, ciphertext: Uint8Array): Promise<Bytes> {
    if (!this.key) return new Uint8Array(ciphertext);
    const iv = this.next();
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: new Uint8Array(ad),
          tagLength: TAG_LENGTH * 8,
        },
        this.key,
        new Uint8Array(ciphertext),
      ),
    );
  }
}

/** The SymmetricState of the Noise specification, revision 34. */
export class SymmetricState {
  cipher = new CipherState();

  private constructor(
    private chainingKey: Bytes,
    public hash: Bytes,
  ) {}

  static async initialize(prologue: Uint8Array) {
    const name = encoder.encode(NOISE);
    const initial =
      name.length <= HASH_LENGTH
        ? concat(name, new Uint8Array(HASH_LENGTH - name.length))
        : await hash(name);
    const state = new SymmetricState(initial, initial);
    await state.mixHash(prologue);
    return state;
  }

  async mixHash(data: Uint8Array) {
    this.hash = await hash(concat(this.hash, data));
  }

  async mixKey(input: Uint8Array) {
    const [chainingKey, key] = await hkdf(this.chainingKey, input);
    this.chainingKey = chainingKey;
    this.cipher = await CipherState.withKey(key);
  }

  async encryptAndHash(plaintext: Uint8Array) {
    const ciphertext = await this.cipher.encrypt(this.hash, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array) {
    const plaintext = await this.cipher.decrypt(this.hash, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  async split() {
    const [first, second] = await hkdf(this.chainingKey, new Uint8Array());
    return [
      await CipherState.withKey(first),
      await CipherState.withKey(second),
    ] as const;
  }
}

/** Transport messages once the handshake is done; call `open` in arrival order. */
export class Transport {
  constructor(
    private readonly sending: CipherState,
    private readonly receiving: CipherState,
    readonly handshakeHash: Bytes,
  ) {}

  seal(plaintext: Uint8Array) {
    return this.sending.encrypt(new Uint8Array(), plaintext);
  }

  open(message: Uint8Array) {
    return this.receiving.decrypt(new Uint8Array(), message);
  }
}

/** The phone's side of Noise IK: it knows the server's static key from the QR code. */
export class Initiator {
  private constructor(
    private readonly state: SymmetricState,
    private readonly local: StaticKey,
    private readonly ephemeral: StaticKey,
  ) {}

  /** Message 1: `-> e, es, s, ss` and the payload. `ephemeral` is fixed only by test vectors. */
  static async start(options: {
    local: StaticKey;
    remote: Uint8Array;
    prologue: Uint8Array;
    payload: Uint8Array;
    ephemeral?: StaticKey;
  }) {
    const state = await SymmetricState.initialize(options.prologue);
    const remote = new Uint8Array(options.remote);
    await state.mixHash(remote);
    let ephemeral = options.ephemeral;
    if (!ephemeral) {
      const { keyPair, publicKey } = await generateStaticKey();
      ephemeral = { privateKey: keyPair.privateKey, publicKey };
    }
    const handshake = new Initiator(state, options.local, ephemeral);
    await state.mixHash(ephemeral.publicKey);
    await state.mixKey(await dh(ephemeral.privateKey, remote));
    const encryptedStatic = await state.encryptAndHash(options.local.publicKey);
    await state.mixKey(await dh(options.local.privateKey, remote));
    const payload = await state.encryptAndHash(options.payload);
    return {
      handshake,
      message: concat(ephemeral.publicKey, encryptedStatic, payload),
    };
  }

  /** Message 2: `<- e, ee, se`; throws when it does not decrypt. */
  async finish(message: Uint8Array) {
    if (message.length < KEY_LENGTH + TAG_LENGTH)
      throw new Error("Short handshake message");
    const state = this.state;
    const remoteEphemeral = message.subarray(0, KEY_LENGTH);
    await state.mixHash(remoteEphemeral);
    await state.mixKey(await dh(this.ephemeral.privateKey, remoteEphemeral));
    await state.mixKey(await dh(this.local.privateKey, remoteEphemeral));
    const payload = await state.decryptAndHash(message.subarray(KEY_LENGTH));
    const [sending, receiving] = await state.split();
    return {
      payload,
      transport: new Transport(sending, receiving, state.hash),
    };
  }
}
