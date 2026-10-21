import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, promises as fs } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { looksLikeRecoveryCode, parseRecoveryCode } from "@/lib/backups/recovery-code";
import { liveKeyId, type RecoveryKey, recoveryKeyId, serverRecoveryKey } from "@/lib/backups/recovery-key";
import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A Tohyee backup file (`.tohyee-backup`): one database, dumped with
 * `pg_dump -Fc` and encrypted with AES-256-GCM (docs/BACKUP-RECOVERY.md).
 *
 *   TOHYEE-BACKUP 2\n
 *   {header as JSON}\n
 *   12-byte IV | ciphertext | 16-byte GCM tag
 *
 * The header says what's inside (so a file can be listed without a key) and
 * is authenticated with the data, so it can't be changed without the file
 * failing to open.
 *
 * Format 2 (#389, decision 734) is encrypted with a key from the server's
 * backup recovery key (HKDF with a random salt in the header), and carries
 * the live key (TOHYEE_SECRET_KEY) its database's stored secrets were
 * encrypted with, itself encrypted with the recovery key, so a restore on
 * another computer can re-encrypt them. Opening it on another computer
 * needs the recovery kit.
 *
 * Format 1 (before #389) is encrypted with a key from TOHYEE_SECRET_KEY
 * itself; it stays readable with the key it was made with.
 */
export const BACKUP_MAGIC = "TOHYEE-BACKUP 1\n";
export const BACKUP_MAGIC_V2 = "TOHYEE-BACKUP 2\n";
export const BACKUP_EXTENSION = ".tohyee-backup";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;

type CommonHeader = {
  /** An organisation's database, or the server's own (users, organisations, settings). */
  kind: "organisation" | "server";
  organisationId: string | null;
  displayName: string | null;
  databaseName: string;
  /** The organisation's tenant schema version (null for the server's database). */
  schemaVersion: string | null;
  createdAt: string;
  tohyeeVersion: string;
  cipher: "aes-256-gcm";
};

export type BackupHeaderV1 = CommonHeader & {
  format: 1;
  /** Which TOHYEE_SECRET_KEY encrypted it (a fingerprint, not the key). */
  keyId: string;
};

export type BackupHeaderV2 = CommonHeader & {
  format: 2;
  kdf: "hkdf-sha256";
  /** Which recovery key opens it: its version and fingerprint (not the key). */
  recoveryKey: { version: number; id: string };
  /** 32 random bytes, base64: the file's own key is HKDF(recovery key, salt). */
  salt: string;
  /** The live key the database's stored secrets were encrypted with, encrypted with the recovery key. */
  liveKey: { id: string; iv: string; tag: string; data: string };
};

export type BackupHeader = BackupHeaderV1 | BackupHeaderV2;

type HeaderFields = Omit<CommonHeader, "cipher">;

/** This server's TOHYEE_SECRET_KEY: the live key, which format 1 backups were encrypted with. */
export function rawSecretKey(): string {
  const raw = process.env.TOHYEE_SECRET_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new UnavailableError(
      "Backups need the server's TOHYEE_SECRET_KEY, and it isn't set (at least 32 characters). Set it in the server's environment and restart Tohyee.",
    );
  }
  return raw;
}

/**
 * The format 1 backup key: HKDF from TOHYEE_SECRET_KEY (or, to open a backup
 * made on another server, that server's key), separate from the key for stored secrets.
 */
function legacyKey(otherKey?: string): Buffer {
  const raw = otherKey === undefined ? rawSecretKey() : otherKey.trim();
  return Buffer.from(hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.alloc(0), "tohyee backups v1", 32));
}

/** A short fingerprint of the format 1 backup key, so a wrong key is reported as such. */
export function backupKeyId(otherKey?: string): string {
  return createHash("sha256").update("tohyee backup key id").update(legacyKey(otherKey)).digest("hex").slice(0, 16);
}

function derive(recoveryKey: Buffer, salt: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", recoveryKey, salt, label, 32));
}

function liveKeyAad(recoveryId: string, salt: string): Buffer {
  return Buffer.from(`tohyee backup v2 live key|${recoveryId}|${salt}`, "utf8");
}

function headerBytes(magic: string, header: BackupHeader): Buffer {
  return Buffer.from(`${magic}${JSON.stringify(header)}\n`, "utf8");
}

/**
 * Encrypts `source` (pg_dump's output) into `target` as a format 2 file,
 * with the given recovery key (the server's current one). Resolves when
 * everything is written; the caller closes nothing.
 */
export async function writeEncrypted(source: Readable, target: Writable, fields: HeaderFields, recovery: RecoveryKey): Promise<BackupHeaderV2> {
  const live = rawSecretKey();
  const salt = randomBytes(32);
  const saltText = salt.toString("base64");
  const wrapIv = randomBytes(IV_BYTES);
  const wrap = createCipheriv("aes-256-gcm", derive(recovery.key, salt, "tohyee backup v2 live key"), wrapIv);
  wrap.setAAD(liveKeyAad(recovery.id, saltText));
  const wrapped = Buffer.concat([wrap.update(live, "utf8"), wrap.final()]);
  const header: BackupHeaderV2 = {
    format: 2,
    ...fields,
    cipher: "aes-256-gcm",
    kdf: "hkdf-sha256",
    recoveryKey: { version: recovery.version, id: recovery.id },
    salt: saltText,
    liveKey: { id: liveKeyId(live), iv: wrapIv.toString("base64"), tag: wrap.getAuthTag().toString("base64"), data: wrapped.toString("base64") },
  };
  const head = headerBytes(BACKUP_MAGIC_V2, header);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(recovery.key, salt, "tohyee backup v2 data"), iv);
  cipher.setAAD(head);
  if (!target.write(Buffer.concat([head, iv]))) await once(target, "drain");
  await pipeline(source, cipher, target, { end: false });
  target.end(cipher.getAuthTag());
  await once(target, "finish");
  return header;
}

/** Writes a format 1 file. Only for tests that prove older backups still open. */
export async function writeLegacyEncryptedForTests(source: Readable, target: Writable, fields: HeaderFields): Promise<void> {
  const full: BackupHeaderV1 = { format: 1, ...fields, cipher: "aes-256-gcm", keyId: backupKeyId() };
  const head = headerBytes(BACKUP_MAGIC, full);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", legacyKey(), iv);
  cipher.setAAD(head);
  if (!target.write(Buffer.concat([head, iv]))) await once(target, "drain");
  await pipeline(source, cipher, target, { end: false });
  target.end(cipher.getAuthTag());
  await once(target, "finish");
}

export type OpenedBackup = {
  header: BackupHeader;
  /** Where the ciphertext starts and ends (inclusive) in the file. */
  dataStart: number;
  dataEnd: number;
  headerBytes: Buffer;
  iv: Buffer;
  tag: Buffer;
};

function validV2(header: BackupHeaderV2): boolean {
  const k = header.recoveryKey;
  const l = header.liveKey;
  return (
    header.kdf === "hkdf-sha256" &&
    !!k &&
    Number.isInteger(k.version) &&
    k.version >= 1 &&
    typeof k.id === "string" &&
    typeof header.salt === "string" &&
    !!l &&
    typeof l.id === "string" &&
    typeof l.iv === "string" &&
    typeof l.tag === "string" &&
    typeof l.data === "string"
  );
}

/** Reads a backup file's header (no key needed). */
export async function readBackupHeader(file: string): Promise<OpenedBackup> {
  const handle = await fs.open(file, "r").catch(() => {
    throw new ValidationError(`Can't open ${file}.`);
  });
  try {
    const { size } = await handle.stat();
    const start = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    await handle.read(start, 0, start.length, 0);
    const magic = start.subarray(0, BACKUP_MAGIC.length).toString("utf8");
    if (!/^TOHYEE-BACKUP \d+\n$/.test(magic)) throw new ValidationError(`${file} isn't a Tohyee backup.`);
    if (magic !== BACKUP_MAGIC && magic !== BACKUP_MAGIC_V2) throw new ValidationError(`${file} was made by a newer version of Tohyee. Update this server first.`);
    const end = start.indexOf(0x0a, BACKUP_MAGIC.length);
    if (end === -1) throw new ValidationError(`${file} is damaged (its header is incomplete).`);
    let header: BackupHeader;
    try {
      header = JSON.parse(start.subarray(BACKUP_MAGIC.length, end).toString("utf8")) as BackupHeader;
    } catch {
      throw new ValidationError(`${file} is damaged (its header can't be read).`);
    }
    const expectedFormat = magic === BACKUP_MAGIC ? 1 : 2;
    if (header.format !== expectedFormat || header.cipher !== "aes-256-gcm" || (header.format === 2 && !validV2(header))) {
      throw new ValidationError(`${file} is damaged or was made by a newer version of Tohyee.`);
    }
    const head = start.subarray(0, end + 1);
    const ivStart = head.length;
    const dataStart = ivStart + IV_BYTES;
    const dataEnd = size - TAG_BYTES - 1;
    if (dataEnd < dataStart - 1) throw new ValidationError(`${file} is damaged (it's too short).`);
    const iv = Buffer.alloc(IV_BYTES);
    await handle.read(iv, 0, IV_BYTES, ivStart);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    return { header, dataStart, dataEnd, headerBytes: Buffer.from(head), iv, tag };
  } finally {
    await handle.close();
  }
}

/**
 * What can open a backup made somewhere else: a recovery kit's key (format
 * 2) or the older backup key, the TOHYEE_SECRET_KEY of the server that made
 * it (format 1). Nothing given means this server's own keys.
 */
export type RecoveryMaterial = { recoveryKey?: { version: number; key: Buffer }; legacyKey?: string };

/** Typed or pasted text: a recovery code if it looks like one, otherwise the older backup key. */
export function materialFromText(text: unknown): RecoveryMaterial | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  if (looksLikeRecoveryCode(text)) return { recoveryKey: parseRecoveryCode(text) };
  return { legacyKey: text.trim() };
}

export type BackupKeys = {
  header: BackupHeader;
  /** The file's own key. */
  dataKey: Buffer;
  /**
   * The live key the database's stored secrets were encrypted with (the
   * server that made it): for re-encrypting them on this server.
   */
  sourceLiveKey: string;
};

const NEEDS_KIT = (header: BackupHeaderV2) =>
  `This backup was made with recovery key version ${header.recoveryKey.version} (fingerprint ${header.recoveryKey.id}) of another Tohyee server, or of this one before it was set up again. Give that server's recovery kit: its recovery code, or its recovery file and passphrase.`;

/** Works out the keys for a backup from what's given (or this server's own), or says what's needed. */
export async function backupKeys(opened: OpenedBackup, material?: RecoveryMaterial): Promise<BackupKeys> {
  const { header } = opened;
  if (header.format === 1) {
    if (material?.recoveryKey) {
      throw new ValidationError(
        "This backup was made before recovery kits (an older format), so a recovery code can't open it. It needs the backup key of the server that made it: that server's TOHYEE_SECRET_KEY.",
      );
    }
    const otherKey = material?.legacyKey;
    if (header.keyId !== backupKeyId(otherKey)) {
      throw new ValidationError(
        otherKey === undefined
          ? "This backup was made with a different key (another server's, or before the key was changed), so this server's key can't open it. Give the backup key it was made with."
          : "That isn't the key this backup was made with.",
      );
    }
    return { header, dataKey: legacyKey(otherKey), sourceLiveKey: otherKey ?? rawSecretKey() };
  }
  if (material?.legacyKey !== undefined && !material.recoveryKey) {
    throw new ValidationError(`This backup needs a recovery kit (recovery key version ${header.recoveryKey.version}), not a backup key. Give its recovery code, or its recovery file and passphrase.`);
  }
  let recovery: { version: number; key: Buffer } | null = material?.recoveryKey ?? null;
  if (recovery) {
    if (recovery.version !== header.recoveryKey.version || recoveryKeyId(recovery.key) !== header.recoveryKey.id) {
      throw new ValidationError(
        `That recovery kit (version ${recovery.version}, fingerprint ${recoveryKeyId(recovery.key)}) isn't the one this backup was made with: it needs version ${header.recoveryKey.version}, fingerprint ${header.recoveryKey.id}.`,
      );
    }
  } else {
    // Keys this server can't read (its TOHYEE_SECRET_KEY was changed) count as not having them.
    recovery = await serverRecoveryKey(header.recoveryKey.version).catch(() => null);
    if (!recovery || recoveryKeyId(recovery.key) !== header.recoveryKey.id) throw new ValidationError(NEEDS_KIT(header));
  }
  const salt = Buffer.from(header.salt, "base64");
  let sourceLiveKey: string;
  try {
    const unwrap = createDecipheriv("aes-256-gcm", derive(recovery.key, salt, "tohyee backup v2 live key"), Buffer.from(header.liveKey.iv, "base64"));
    unwrap.setAAD(liveKeyAad(header.recoveryKey.id, header.salt));
    unwrap.setAuthTag(Buffer.from(header.liveKey.tag, "base64"));
    sourceLiveKey = Buffer.concat([unwrap.update(Buffer.from(header.liveKey.data, "base64")), unwrap.final()]).toString("utf8");
  } catch {
    throw new ValidationError("This backup is damaged or was changed after it was made, so it can't be trusted.");
  }
  return { header, dataKey: derive(recovery.key, salt, "tohyee backup v2 data"), sourceLiveKey };
}

/** Opens a backup's keys from a file name: the header, then backupKeys. */
export async function openBackupKeys(file: string, material?: RecoveryMaterial): Promise<BackupKeys> {
  return backupKeys(await readBackupHeader(file), material);
}

/**
 * Decrypts a backup into `target` (e.g. pg_restore's input, or a file).
 * Throws if the key is wrong or the file was changed or damaged. The tag is
 * only checked at the very end, so decrypt to a throwaway place first
 * (`checkBackup`) before feeding anything that can't be undone.
 */
export async function readDecrypted(file: string, target: Writable, material?: RecoveryMaterial): Promise<BackupHeader> {
  const opened = await readBackupHeader(file);
  const keys = await backupKeys(opened, material);
  const decipher = createDecipheriv("aes-256-gcm", keys.dataKey, opened.iv);
  decipher.setAAD(opened.headerBytes);
  decipher.setAuthTag(opened.tag);
  const source = createReadStream(file, { start: opened.dataStart, end: opened.dataEnd });
  try {
    await pipeline(source, decipher, target);
  } catch (error) {
    if (error instanceof Error && /auth|unable to authenticate/i.test(error.message)) {
      throw new ValidationError("This backup is damaged or was changed after it was made, so it can't be trusted.");
    }
    throw error;
  }
  return opened.header;
}
