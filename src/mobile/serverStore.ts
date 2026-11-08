import { generateStaticKey } from "./noise";
import { decodeKey } from "./protocol";

/** A server this phone is paired with; `keyPair` is its own X25519 key for it, private half not extractable once stored. */
export type PairedServer = {
  server: string;
  host: string;
  keyPair: CryptoKeyPair;
  /** The phone's public key, base64url. */
  publicKey: string;
  pairedAt: number;
};

export type ServerStore = {
  list(): Promise<PairedServer[]>;
  save(server: PairedServer): Promise<void>;
  forget(server: string): Promise<void>;
};

const DATABASE = "soreno-mobile";
const SERVERS = "servers";
const X25519 = { name: "X25519" } as const;
const IV_LENGTH = 12;

/** The private key in PKCS#8, encrypted by a non-extractable AES-GCM key kept beside it. */
type SealedKey = {
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
};

type StoredServer = Omit<PairedServer, "keyPair"> &
  ({ keyPair: CryptoKeyPair } | { sealedKey: SealedKey });

let clonesKeys: Promise<boolean> | null = null;

// A key read back is not extractable, so it keeps the seal it came from.
const sealed = new WeakMap<CryptoKey, SealedKey>();

/** WebKit cannot clone X25519 keys, so IndexedDB refuses them: https://bugs.webkit.org/show_bug.cgi?id=312279 */
export function clonesX25519Keys() {
  clonesKeys ??= generateStaticKey().then(
    ({ keyPair }) => {
      try {
        structuredClone(keyPair.privateKey);
        return true;
      } catch {
        return false;
      }
    },
    () => false,
  );
  return clonesKeys;
}

async function stored(
  server: PairedServer,
  clones: boolean,
): Promise<StoredServer> {
  if (clones) return server;
  const { keyPair, ...rest } = server;
  const sealedKey =
    sealed.get(keyPair.privateKey) ?? (await seal(keyPair.privateKey));
  return { ...rest, sealedKey };
}

async function seal(privateKey: CryptoKey): Promise<SealedKey> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = await crypto.subtle.wrapKey("pkcs8", privateKey, key, {
    name: "AES-GCM",
    iv,
  });
  return { key, iv, data };
}

async function paired(entry: StoredServer): Promise<PairedServer> {
  if ("keyPair" in entry) return entry;
  const { sealedKey, ...rest } = entry;
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.unwrapKey(
      "pkcs8",
      sealedKey.data,
      sealedKey.key,
      { name: "AES-GCM", iv: sealedKey.iv },
      X25519,
      false,
      ["deriveBits"],
    ),
    crypto.subtle.importKey(
      "raw",
      new Uint8Array(decodeKey(rest.publicKey) ?? []),
      X25519,
      true,
      [],
    ),
  ]);
  sealed.set(privateKey, sealedKey);
  return { ...rest, keyPair: { privateKey, publicKey } };
}

function request<T>(pending: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });
}

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** CryptoKeys survive in IndexedDB only: localStorage holds strings. Opened at first use. */
export function indexedDbServerStore(
  factory?: IDBFactory,
  clones: () => Promise<boolean> = clonesX25519Keys,
): ServerStore {
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise((resolve, reject) => {
      const opening = (factory ?? indexedDB).open(DATABASE, 1);
      opening.onupgradeneeded = () =>
        opening.result.createObjectStore(SERVERS, { keyPath: "server" });
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => {
        database = null;
        reject(opening.error);
      };
    });
    return database;
  };
  const write = async (change: (store: IDBObjectStore) => void) => {
    const transaction = (await open()).transaction(SERVERS, "readwrite");
    change(transaction.objectStore(SERVERS));
    await done(transaction);
  };
  return {
    list: async () => {
      const servers = (await open())
        .transaction(SERVERS, "readonly")
        .objectStore(SERVERS)
        .getAll();
      return Promise.all(
        ((await request(servers)) as StoredServer[]).map(paired),
      );
    },
    save: async (server) => {
      // Sealed first: a transaction ends at the first wait outside IndexedDB.
      const entry = await stored(server, await clones());
      await write((store) => store.put(entry));
    },
    forget: (server) => write((store) => store.delete(server)),
  };
}
