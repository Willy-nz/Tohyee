import { ValidationError } from "@/lib/errors";

/**
 * The files that can be attached to a record (examples NF7, NF8): PDF,
 * images, Word, Excel and CSV, 10 MB at most. The type comes from the file's
 * name and is checked against its contents, so a renamed program or a PDF
 * called `.png` is refused. Shared with the browser, so no server imports.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_RECORD = 100;

type FileKind = {
  contentType: string;
  label: string;
  /** Whether the browser may show it (it's still served with a sandbox). */
  inline: boolean;
  matches: (bytes: Uint8Array) => boolean;
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Whether a zip (Office file) names an entry under `folder` (entry names aren't compressed). */
function zipHasFolder(bytes: Uint8Array, folder: string): boolean {
  if (!startsWith(bytes, ZIP)) return false;
  const needle = ascii(folder);
  for (let index = bytes.indexOf(needle[0]); index !== -1; index = bytes.indexOf(needle[0], index + 1)) {
    if (startsWith(bytes, needle, index)) return true;
  }
  return false;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"]);

const KINDS: Record<string, FileKind> = {
  pdf: { contentType: "application/pdf", label: "PDF", inline: true, matches: (b) => startsWith(b, ascii("%PDF-")) },
  jpg: { contentType: "image/jpeg", label: "JPG", inline: true, matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  png: {
    contentType: "image/png",
    label: "PNG",
    inline: true,
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  heic: {
    contentType: "image/heic",
    label: "HEIC",
    inline: false,
    matches: (b) => startsWith(b, ascii("ftyp"), 4) && HEIC_BRANDS.has(String.fromCharCode(...b.slice(8, 12))),
  },
  doc: { contentType: "application/msword", label: "Word", inline: false, matches: (b) => startsWith(b, OLE) },
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
    inline: false,
    matches: (b) => zipHasFolder(b, "word/"),
  },
  xls: { contentType: "application/vnd.ms-excel", label: "Excel", inline: false, matches: (b) => startsWith(b, OLE) },
  xlsx: {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel",
    inline: false,
    matches: (b) => zipHasFolder(b, "xl/"),
  },
  // Text never contains a NUL byte; a file that does isn't a CSV.
  csv: { contentType: "text/csv", label: "CSV", inline: false, matches: (b) => !b.includes(0) },
};

const EXTENSION_ALIASES: Record<string, string> = { jpeg: "jpg", heif: "heic" };

export const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

/** A short label for a stored content type (e.g. "PDF"). */
export function fileTypeLabel(contentType: string): string {
  return Object.values(KINDS).find((kind) => kind.contentType === contentType)?.label ?? "File";
}

/** Whether a stored content type may be shown in the browser rather than downloaded. */
export function showsInline(contentType: string): boolean {
  return Object.values(KINDS).some((kind) => kind.contentType === contentType && kind.inline);
}

/** "250 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file name as the person gave it, without any folder part or control
 * characters, at most 255 characters (keeping the extension).
 */
export function cleanFileName(input: string): string {
  const base = input.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base || base === "." || base === "..") {
    throw new ValidationError("The file needs a name.");
  }
  if (base.length <= 255) return base;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
  return base.slice(0, 255 - extension.length) + extension;
}

/**
 * Checks a file (NF8) and returns its content type: an allowed extension,
 * 1 byte to 10 MB, and contents that match the extension.
 */
export function checkAttachment(fileName: string, bytes: Uint8Array): { fileName: string; contentType: string } {
  const name = cleanFileName(fileName);
  const dot = name.lastIndexOf(".");
  const rawExtension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const extension = EXTENSION_ALIASES[rawExtension] ?? rawExtension;
  const kind = KINDS[extension];
  if (!kind) {
    throw new ValidationError(
      `${name} can't be attached: only PDF, JPG, PNG, HEIC, Word (.doc, .docx), Excel (.xls, .xlsx) and CSV files are allowed.`,
    );
  }
  if (bytes.length === 0) {
    throw new ValidationError(`${name} is empty.`);
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(`${name} is ${formatFileSize(bytes.length)}. Files can be at most 10 MB.`);
  }
  if (!kind.matches(bytes)) {
    throw new ValidationError(`${name} doesn't look like a ${kind.label} file, so it can't be attached.`);
  }
  return { fileName: name, contentType: kind.contentType };
}
