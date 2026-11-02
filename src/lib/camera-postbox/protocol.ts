import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/*
 * The camera post box (#508 follow-up, decisions 1226-1233): what both ends
 * share. The post box is a small program on a rented online server with a
 * public address. Cameras upload to it by FTPS; Tohyee, at home, reaches
 * out to it over HTTPS every minute, takes the files and tells it to
 * delete them. Nothing at home is opened to the internet.
 *
 * This file has no Tohyee server imports: it's bundled into the post box
 * program too (scripts/build-postbox.mjs). Tested in
 * tests/unit/camera-postbox-protocol.test.ts.
 */

export const POSTBOX_SERVICE = "tohyee-camera-postbox";
export const PROTOCOL_VERSION = 1;

/** Limits both ends keep to. */
export const LIMITS = {
  /** Biggest JSON body the post box reads. */
  maxJsonBytes: 1024 * 1024,
  /** Most camera logins one post box holds. */
  maxLogins: 500,
  /** Most files one listing returns. */
  maxList: 200,
  /** Requests per minute from one address, after which it waits. */
  requestsPerMinute: 600,
  /** Wrong tokens or pairing secrets from one address in the window before it's refused for the window. */
  maxFailures: 10,
  failureWindowMs: 15 * 60_000,
  /** How long a pairing code works. */
  pairingSecretMs: 24 * 60 * 60_000,
} as const;

// Pairing code ----------------------------------------------------------------------------------

export type PairingCode = {
  /** The post box's public address (IPv4, or a name). */
  address: string;
  /** Its HTTPS port. */
  port: number;
  /** SHA-256 of its certificate, 64 lowercase hex characters. */
  fingerprint: string;
  /** The one-time pairing secret. */
  secret: string;
  /** A domain name with a proper certificate, when the post box has one: Tohyee then checks the certificate the normal way instead of pinning it. */
  name: string | null;
};

const CODE_PREFIX = "TPB1-";
const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

export function isHost(value: string): boolean {
  if (!HOST.test(value)) return false;
  if (/^\d+(\.\d+){3}$/.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  return true;
}

export function encodePairingCode(code: PairingCode): string {
  const body = { a: code.address, p: code.port, f: code.fingerprint, s: code.secret, ...(code.name ? { n: code.name } : {}) };
  return CODE_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** Reads a pairing code as pasted (spaces and line breaks from copying are ignored). Null when it isn't one. */
export function decodePairingCode(input: string): PairingCode | null {
  const text = input.replace(/\s+/g, "");
  if (!text.startsWith(CODE_PREFIX) || text.length > 2000) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { a, p, f, s, n } = body;
  if (typeof a !== "string" || !isHost(a)) return null;
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) return null;
  if (typeof f !== "string" || !/^[0-9a-f]{64}$/.test(f)) return null;
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(s)) return null;
  if (n !== undefined && (typeof n !== "string" || !isHost(n) || /^\d+(\.\d+){3}$/.test(n))) return null;
  return { address: a, port: p, fingerprint: f, secret: s, name: typeof n === "string" ? n.toLowerCase() : null };
}

/** "AB:CD:…" (as Node and OpenSSL print it) or raw DER as 64 lowercase hex characters. */
export function normaliseFingerprint(input: string | Buffer): string {
  if (Buffer.isBuffer(input)) return createHash("sha256").update(input).digest("hex");
  return input.replace(/:/g, "").toLowerCase();
}

/** "ab12…" as "AB:12:…", for people comparing by eye. */
export function displayFingerprint(fingerprint: string): string {
  return (fingerprint.toUpperCase().match(/.{2}/g) ?? []).join(":");
}

// Tokens and secrets ----------------------------------------------------------------------------

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** What the post box keeps of a token or pairing secret: its SHA-256. Both are long and random, so a plain hash is enough. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

// Camera logins ---------------------------------------------------------------------------------

/** A camera's upload login as Tohyee pushes it: the user name, the scrypt hash (never the password) and which camera. */
export type PushedLogin = { username: string; hash: string; cameraId: string };

const USERNAME = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9]{10}$/;
const SCRYPT_HASH = /^scrypt\$\d{1,8}\$\d{1,3}\$\d{1,3}\$[A-Za-z0-9+/=]{1,64}\$[A-Za-z0-9+/=]{1,200}$/;

/** Checks a pushed list. Throws with a plain message when it's wrong. */
export function parseLogins(input: unknown): PushedLogin[] {
  if (!Array.isArray(input)) throw new Error("logins must be a list");
  if (input.length > LIMITS.maxLogins) throw new Error(`at most ${LIMITS.maxLogins} logins`);
  const seen = new Set<string>();
  return input.map((entry) => {
    const { username, hash, cameraId } = (entry ?? {}) as Record<string, unknown>;
    if (typeof username !== "string" || !USERNAME.test(username)) throw new Error("a login's user name isn't one of Tohyee's");
    if (typeof hash !== "string" || !SCRYPT_HASH.test(hash)) throw new Error("a login's hash isn't a scrypt hash");
    if (typeof cameraId !== "string" || !/^[1-9]\d{0,17}$/.test(cameraId)) throw new Error("a login's camera isn't a camera number");
    if (seen.has(username)) throw new Error("a user name is there twice");
    seen.add(username);
    return { username, hash, cameraId };
  });
}

/** One value for a set of logins, whatever the order: both ends compare it to see if a push is needed. */
export function loginsVersion(logins: PushedLogin[]): string {
  const sorted = [...logins].sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)).map((login) => [login.username, login.hash, login.cameraId]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// Files in the queue ----------------------------------------------------------------------------

export type QueuedFile = {
  id: string;
  username: string;
  cameraId: string;
  fileName: string;
  /** When the post box got it, ISO 8601. */
  receivedAt: string;
  /** The photo or clip's own size and SHA-256 (before encryption). */
  sizeBytes: number;
  sha256: string;
  /** The size of the encrypted file the post box sends. */
  storedBytes: number;
};

export const FILE_ID = /^[0-9]{13}-[0-9a-f]{16}$/;

export function isQueuedFile(value: unknown): value is QueuedFile {
  const file = value as QueuedFile;
  return (
    !!file &&
    typeof file === "object" &&
    typeof file.id === "string" &&
    FILE_ID.test(file.id) &&
    typeof file.username === "string" &&
    typeof file.cameraId === "string" &&
    /^[1-9]\d{0,17}$/.test(file.cameraId) &&
    typeof file.fileName === "string" &&
    file.fileName.length <= 255 &&
    typeof file.receivedAt === "string" &&
    !Number.isNaN(Date.parse(file.receivedAt)) &&
    Number.isSafeInteger(file.sizeBytes) &&
    file.sizeBytes > 0 &&
    typeof file.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(file.sha256) &&
    Number.isSafeInteger(file.storedBytes) &&
    file.storedBytes === file.sizeBytes + SEALED_OVERHEAD
  );
}

// Encryption at rest ----------------------------------------------------------------------------
//
// Each file is sealed to Tohyee's public key as it arrives (X25519, HKDF-SHA256, AES-256-GCM),
// with a new key pair for every file. The post box keeps only the public key, so once a file
// is sealed, someone with the post box's disk can't open it. The format:
//
//   "TPB1" | the file's own X25519 public key (32 bytes) | IV (12 bytes) | ciphertext | GCM tag (16 bytes)

const MAGIC = Buffer.from("TPB1");
const HEADER_BYTES = MAGIC.length + 32 + 12;
const TAG_BYTES = 16;
export const SEALED_OVERHEAD = HEADER_BYTES + TAG_BYTES;
const INFO = Buffer.from("tohyee camera post box v1");

/** A new key pair for Tohyee. The public key goes to the post box; the private key stays in Tohyee, encrypted. Both as base64url raw keys. */
export function newKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: publicKey.export({ format: "jwk" }).x!, privateKey: privateKey.export({ format: "jwk" }).d! };
}

function publicKeyObject(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
}

function privateKeyObject(raw: string, publicRaw: string): KeyObject {
  return createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: publicRaw, d: raw }, format: "jwk" });
}

export function isPublicKey(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
  try {
    publicKeyObject(raw);
    return true;
  } catch {
    return false;
  }
}

function fileKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralPublic, recipientPublic]), INFO, 32));
}

/** Seals `source` into `target` for the holder of the private key. Streams, so big clips don't fill memory. */
export async function sealFile(source: string, target: string, recipientPublicKey: string): Promise<void> {
  const recipient = publicKeyObject(recipientPublicKey);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey(shared, ephemeralRaw, Buffer.from(recipientPublicKey, "base64url")), iv);
  await pipeline(
    createReadStream(source),
    cipher,
    async function* (encrypted: AsyncIterable<Buffer>) {
      yield Buffer.concat([MAGIC, ephemeralRaw, iv]);
      for await (const chunk of encrypted) yield chunk;
      // The cipher has finished once its output has all been read, so the tag is ready.
      yield cipher.getAuthTag();
    },
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
}

/**
 * Opens a sealed file into `target`. Throws if it isn't one, was sealed
 * for another key, or was changed (the GCM tag): `target` is then removed
 * by the caller. Nothing in `target` may be used until this resolves.
 */
export async function openSealedFile(source: string, target: string, keys: { publicKey: string; privateKey: string }): Promise<void> {
  const handle = await open(source, "r");
  let size: number;
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    size = (await handle.stat()).size;
    if (size < SEALED_OVERHEAD) throw new Error("The file from the post box is too short to be a sealed file.");
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("The file from the post box isn't a sealed file.");
  const ephemeralRaw = header.subarray(MAGIC.length, MAGIC.length + 32);
  const iv = header.subarray(MAGIC.length + 32);
  const ephemeral = publicKeyObject(ephemeralRaw.toString("base64url"));
  const shared = diffieHellman({ privateKey: privateKeyObject(keys.privateKey, keys.publicKey), publicKey: ephemeral });
  const decipher = createDecipheriv("aes-256-gcm", fileKey(shared, ephemeralRaw, Buffer.from(keys.publicKey, "base64url")), iv);
  decipher.setAuthTag(tag);
  if (size === SEALED_OVERHEAD) {
    await new Promise<void>((resolve, reject) => createWriteStream(target, { flags: "wx", mode: 0o600 }).end(decipher.final(), (error?: Error | null) => (error ? reject(error) : resolve())));
    return;
  }
  await pipeline(createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(target, { flags: "wx", mode: 0o600 }));
}
