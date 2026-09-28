import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, promises as fs } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UnavailableError, ValidationError } from "@/lib/errors";

/**
 * A Tohyee backup file (`.tohyee-backup`): one database, dumped with
 * `pg_dump -Fc` and encrypted with AES-256-GCM.
 *
 *   TOHYEE-BACKUP 1\n
 *   {header as JSON}\n
 *   12-byte IV | ciphertext | 16-byte GCM tag
 *
 * The header says what's inside (so a file can be listed without the key) and
 * is authenticated with the data, so it can't be changed without the file
 * failing to open. The key is derived from the server's TOHYEE_SECRET_KEY, so
 * restoring needs that key: keep a copy of it somewhere safe, away from the
 * backups.
 */
export const BACKUP_MAGIC = "TOHYEE-BACKUP 1\n";
export const BACKUP_EXTENSION = ".tohyee-backup";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;

export type BackupHeader = {
  format: 1;
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
  /** Which TOHYEE_SECRET_KEY encrypted it (a fingerprint, not the key). */
  keyId: string;
};

function rawSecretKey(): string {
  const raw = process.env.TOHYEE_SECRET_KEY?.trim();
  if (!raw || raw.length < 32) {
    throw new UnavailableError(
      "Backups are encrypted with the server's TOHYEE_SECRET_KEY, and it isn't set (at least 32 characters). Set it in the server's environment and restart Tohyee.",
    );
  }
  return raw;
}

/** The backup key: HKDF from TOHYEE_SECRET_KEY, separate from the key for stored secrets. */
function backupKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(rawSecretKey(), "utf8"), Buffer.alloc(0), "tohyee backups v1", 32));
}

/** A short fingerprint of the backup key, so a wrong key is reported as such. */
export function backupKeyId(): string {
  return createHash("sha256").update("tohyee backup key id").update(backupKey()).digest("hex").slice(0, 16);
}

function headerBytes(header: BackupHeader): Buffer {
  return Buffer.from(`${BACKUP_MAGIC}${JSON.stringify(header)}\n`, "utf8");
}

/**
 * Encrypts `source` (pg_dump's output) into `target`. Resolves when everything
 * is written; the caller closes nothing.
 */
export async function writeEncrypted(source: Readable, target: Writable, header: Omit<BackupHeader, "cipher" | "keyId" | "format">): Promise<void> {
  const full: BackupHeader = { format: 1, ...header, cipher: "aes-256-gcm", keyId: backupKeyId() };
  const head = headerBytes(full);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", backupKey(), iv);
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

/** Reads a backup file's header (no key needed). */
export async function readBackupHeader(file: string): Promise<OpenedBackup> {
  const handle = await fs.open(file, "r").catch(() => {
    throw new ValidationError(`Can't open ${file}.`);
  });
  try {
    const { size } = await handle.stat();
    const start = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    await handle.read(start, 0, start.length, 0);
    if (!start.subarray(0, BACKUP_MAGIC.length).equals(Buffer.from(BACKUP_MAGIC))) {
      throw new ValidationError(`${file} isn't a Tohyee backup.`);
    }
    const end = start.indexOf(0x0a, BACKUP_MAGIC.length);
    if (end === -1) throw new ValidationError(`${file} is damaged (its header is incomplete).`);
    let header: BackupHeader;
    try {
      header = JSON.parse(start.subarray(BACKUP_MAGIC.length, end).toString("utf8")) as BackupHeader;
    } catch {
      throw new ValidationError(`${file} is damaged (its header can't be read).`);
    }
    if (header.format !== 1 || header.cipher !== "aes-256-gcm") {
      throw new ValidationError(`${file} was made by a newer version of Tohyee.`);
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
 * Decrypts a backup into `target` (e.g. pg_restore's input, or a file).
 * Throws if the key is wrong or the file was changed or damaged. The tag is
 * only checked at the very end, so decrypt to a throwaway place first
 * (`checkBackup`) before feeding anything that can't be undone.
 */
export async function readDecrypted(file: string, target: Writable): Promise<BackupHeader> {
  const opened = await readBackupHeader(file);
  if (opened.header.keyId !== backupKeyId()) {
    throw new ValidationError(
      "This backup was made with a different TOHYEE_SECRET_KEY, so it can't be opened with this server's key. Set the key the backup was made with.",
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", backupKey(), opened.iv);
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
