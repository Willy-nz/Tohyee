import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { ValidationError } from "@/lib/errors";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_CHECK_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100;
const MAX_COMPRESSION_RATIO = 1000;
type ReportFile = { name: string; bytes: Buffer };

export class ReportCheckBudgetError extends ValidationError {
  constructor() {
    super("The report exceeds the remaining mailbox-check budget. Retry it in the next check.");
  }
}

function safeName(name: string): void {
  const device = name.split(".")[0].trimEnd();
  if (!name || Buffer.byteLength(name) > 180 || name !== name.trim() || name.includes("..") ||
      /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(device)) {
    throw new ValidationError("Report attachments must have a safe, flat filename.");
  }
}

export function reportFileKey(name: string): string {
  safeName(name);
  const key = name.normalize("NFC").toLowerCase();
  safeName(key);
  return key;
}

function safeArchiveEntry(name: string): boolean {
  if (!name || name.length > 512 || name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
  const parts = name.split("/");
  if (parts.at(-1) === "") parts.pop();
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function crc32(bytes: Buffer, initial = 0xffffffff): number {
  let crc = initial;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
}

export async function reportXlsxExpansionBytes(bytes: Buffer): Promise<number> {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new ValidationError("The Excel attachment exceeds the attachment size limit.");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) { reject(new ValidationError("The Excel attachment couldn't be read safely.")); return; }
      let failed = false;
      let count = 0;
      let total = 0;
      const names = new Set<string>();
      const fail = () => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(new ValidationError("The Excel attachment is damaged or exceeds the extraction limits."));
      };
      zip.on("error", fail);
      zip.on("end", () => {
        zip.close();
        if (!failed) resolve(total);
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const key = entry.fileName.normalize("NFC").toLowerCase();
          if (++count > MAX_ZIP_ENTRIES || !safeArchiveEntry(entry.fileName) || names.has(key) ||
              (entry.generalPurposeBitFlag & (1 | 64)) || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
              ((entry.externalFileAttributes & 0x10) !== 0 && !entry.fileName.endsWith("/")) || ![0, 8].includes(entry.compressionMethod) ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
              entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO ||
              entry.uncompressedSize > MAX_CHECK_BYTES || total + entry.uncompressedSize > MAX_CHECK_BYTES) {
            throw new ValidationError("Unsafe Excel ZIP.");
          }
          names.add(key);
          total += entry.uncompressedSize;
          const stream = await new Promise<import("node:stream").Readable>((accept, refuse) => {
            zip.openReadStream(entry, (streamError, content) => {
              if (streamError || !content) refuse(streamError);
              else accept(content);
            });
          });
          let size = 0;
          let crc = 0xffffffff;
          try {
            for await (const chunk of stream) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += buffer.length;
              if (size > entry.uncompressedSize || size + total - entry.uncompressedSize > MAX_CHECK_BYTES) {
                throw new ValidationError("Excel ZIP expansion exceeds the mailbox-check limit.");
              }
              crc = crc32(buffer, crc);
            }
          } finally {
            stream.destroy();
          }
          if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
            throw new ValidationError("The Excel attachment is damaged.");
          }
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

function budget(size: number, remaining: number): void {
  if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > MAX_CHECK_BYTES ||
      !Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError("Report attachments exceed the attachment or mailbox-check size limit.");
  }
  if (size > remaining) throw new ReportCheckBudgetError();
}

export async function extractReportAttachment(
  name: string, bytes: Buffer, remainingBytes: number, onExpandedBytes?: (bytes: number) => void,
): Promise<ReportFile[]> {
  safeName(name);
  budget(bytes.length, MAX_CHECK_BYTES);
  budget(0, remainingBytes);
  const extension = path.extname(name).toLowerCase();
  if ([".csv", ".tsv", ".txt"].includes(extension)) {
    budget(bytes.length, remainingBytes);
    return [{ name, bytes }];
  }
  if (extension === ".xlsx") {
    const expanded = await reportXlsxExpansionBytes(bytes);
    if (expanded > remainingBytes) throw new ReportCheckBudgetError();
    return [{ name, bytes }];
  }
  if (extension !== ".zip") return [];
  return new Promise((resolve, reject) => {
    // Validate sizes ourselves so even a dishonest-size chunk is charged before rejection.
    yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) { reject(new ValidationError("The report ZIP could not be read.")); return; }
      let failed = false;
      let count = 0;
      let total = 0;
      const names = new Set<string>();
      const files: ReportFile[] = [];
      const fail = (error?: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(error instanceof ReportCheckBudgetError
          ? error : new ValidationError("The report ZIP contains unsafe files or exceeds the extraction limits."));
      };
      zip.on("error", fail);
      zip.on("end", () => {
        zip.close();
        if (!failed) resolve(files);
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          safeName(entry.fileName);
          const key = reportFileKey(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (++count > MAX_ZIP_ENTRIES || names.has(key) ||
              (entry.generalPurposeBitFlag & (1 | 64)) || (mode !== 0 && mode !== 0x8000) ||
              (entry.externalFileAttributes & 0x10) || ![0, 8].includes(entry.compressionMethod) ||
              entry.uncompressedSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO) {
            throw new ValidationError("Unsafe report ZIP.");
          }
          names.add(key);
          const supported = [".csv", ".tsv"].includes(path.extname(entry.fileName).toLowerCase());
          budget(entry.uncompressedSize, supported ? remainingBytes - total : MAX_CHECK_BYTES);
          if (supported) {
            total += entry.uncompressedSize;
            const stream = await new Promise<import("node:stream").Readable>((accept, refuse) => {
              zip.openReadStream(entry, (streamError, content) => {
                if (streamError || !content) refuse(streamError);
                else accept(content);
              });
            });
            const chunks: Buffer[] = [];
            let size = 0;
            let crc = 0xffffffff;
            try {
              for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                onExpandedBytes?.(buffer.length);
                size += buffer.length;
                if (size > entry.uncompressedSize) throw new ValidationError("Incorrect ZIP entry size.");
                budget(size, remainingBytes - (total - entry.uncompressedSize));
                for (const byte of buffer) {
                  crc ^= byte;
                  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
                }
                chunks.push(buffer);
              }
            } finally { stream.destroy(); }
            if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
              throw new ValidationError("The ZIP entry is damaged.");
            }
            files.push({ name: entry.fileName, bytes: Buffer.concat(chunks, size) });
          }
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

async function directory(folder: string, create: boolean): Promise<FileHandle | null> {
  if (create) {
    try { await fs.mkdir(folder, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = await fs.lstat(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ValidationError("Report email folders must be real directories, not symbolic links.");
  if (process.platform === "win32") return null;
  return fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

// Pin each directory on Linux so changing a parent symlink cannot redirect a write.
function pinned(handle: FileHandle | null, fallback: string): string {
  return process.platform === "linux" && handle ? `/proc/self/fd/${handle.fd}` : fallback;
}

async function confinedDirectories(root: string, canonicalRoot: string, folders: { path: string; handle: FileHandle | null }[]): Promise<void> {
  const comparable = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : value;
  for (const folder of folders) {
    const stat = await fs.lstat(folder.path);
    const expected = path.join(canonicalRoot, path.relative(root, folder.path));
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        comparable(await fs.realpath(folder.path)) !== comparable(expected)) {
      throw new ValidationError("The report email folder changed or points outside its source folder.");
    }
    if (folder.handle) {
      const opened = await folder.handle.stat();
      if (stat.dev !== opened.dev || stat.ino !== opened.ino) throw new ValidationError("The report email folder changed while saving.");
    }
  }
}

async function existingFile(filename: string): Promise<FileHandle | null> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ValidationError("A report filename is occupied by a link or a non-file.");
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      await handle.close();
      throw new ValidationError("The report file changed while it was being checked.");
    }
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const writes = new Map<string, Promise<void>>();

export async function saveReportFile(
  sourceFolder: string, mailboxId: string, messageId: string, receivedAt: string, file: ReportFile, replace: boolean,
): Promise<string> {
  const key = JSON.stringify([path.resolve(sourceFolder), mailboxId, reportFileKey(file.name)]);
  const previous = writes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  writes.set(key, queued);
  await previous;
  try { return await writeReportFile(sourceFolder, mailboxId, messageId, receivedAt, file, replace); }
  finally {
    release();
    if (writes.get(key) === queued) writes.delete(key);
  }
}

async function writeReportFile(
  sourceFolder: string, mailboxId: string, messageId: string, receivedAt: string, file: ReportFile, replace: boolean,
): Promise<string> {
  const fileName = reportFileKey(file.name);
  budget(file.bytes.length, MAX_CHECK_BYTES);
  if (![".csv", ".tsv", ".txt", ".xlsx"].includes(path.extname(file.name).toLowerCase())) {
    throw new ValidationError("Only extracted data files can be saved.");
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(mailboxId) || !messageId || messageId.length > 1024 ||
      !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(receivedAt) || !Number.isFinite(Date.parse(receivedAt)) ||
      new Date(receivedAt).toISOString().slice(0, 10) !== receivedAt.slice(0, 10)) {
    throw new ValidationError("The report mailbox, message or received date is invalid.");
  }
  const messageHash = createHash("sha256").update(messageId).digest("hex");
  const name = replace ? fileName : `${receivedAt.slice(0, 10)}-${messageHash.slice(0, 16)}-${fileName}`;
  const root = path.resolve(sourceFolder);
  const handles: FileHandle[] = [];
  let staging: string | null = null;
  try {
    const rootHandle = await directory(root, false);
    if (rootHandle) handles.push(rootHandle);
    const canonicalRoot = await fs.realpath(root);
    const emailPath = path.join(root, "email");
    const emailHandle = await directory(path.join(pinned(rootHandle, root), "email"), true);
    if (emailHandle) handles.push(emailHandle);
    const mailboxPath = path.join(emailPath, mailboxId);
    const mailboxHandle = await directory(path.join(pinned(emailHandle, emailPath), mailboxId), true);
    if (mailboxHandle) handles.push(mailboxHandle);
    const folders = [{ path: root, handle: rootHandle }, { path: emailPath, handle: emailHandle }, { path: mailboxPath, handle: mailboxHandle }];
    await confinedDirectories(root, canonicalRoot, folders);
    const mailbox = pinned(mailboxHandle, mailboxPath);
    const target = path.join(mailbox, name);
    const existing = await existingFile(target);
    if (existing) {
      try {
        if (!replace) {
          const stat = await existing.stat();
          if (stat.size <= MAX_ATTACHMENT_BYTES && (await existing.readFile()).equals(file.bytes)) return `email/${mailboxId}/${name}`;
          throw new ValidationError("A different report already has this filename.");
        }
      } finally { await existing.close(); }
    }
    staging = path.join(mailbox, `.report-${randomUUID()}.partial`);
    const output = await fs.open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(file.bytes); await output.sync(); }
    finally { await output.close(); }
    await confinedDirectories(root, canonicalRoot, folders);
    const targetCheck = await existingFile(target);
    await targetCheck?.close();
    if (replace) {
      // rename replaces atomically on Windows too; never unlink the old report first.
      await fs.rename(staging, target);
      staging = null;
    } else {
      await fs.link(staging, target);
    }
    await mailboxHandle?.sync();
    return `email/${mailboxId}/${name}`;
  } finally {
    if (staging) await fs.unlink(staging).catch(() => {});
    for (const handle of handles.reverse()) await handle.close();
  }
}
