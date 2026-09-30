import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { cleanFileName, formatFileSize } from "@/lib/records/file-types";

/**
 * The organisation's logo (Settings, admins): a PNG or JPEG of at most
 * 512 KB and 4000 pixels a side, kept in the organisation's own database so
 * its backup includes it. It's shown top left on printed documents and
 * statements, on the PDFs the server writes, and in the header of HTML
 * emails (as an inline attachment, never a link to a remote image).
 */

export const MAX_LOGO_BYTES = 512 * 1024;
export const MAX_LOGO_PIXELS = 4000;

export type LogoInfo = {
  fileName: string;
  contentType: "image/png" | "image/jpeg";
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  uploadedByEmail: string;
  uploadedAt: string;
};

export type Logo = LogoInfo & { content: Uint8Array };

type LogoRow = {
  file_name: string;
  content_type: "image/png" | "image/jpeg";
  byte_size: number;
  width: number;
  height: number;
  sha256: string;
  uploaded_by_email: string;
  uploaded_at: string | Date;
  content?: Buffer;
};

function toInfo(row: LogoRow): LogoInfo {
  return {
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    uploadedByEmail: row.uploaded_by_email,
    uploadedAt: new Date(row.uploaded_at).toISOString(),
  };
}

const INFO_COLUMNS = "file_name, content_type, byte_size, width, height, sha256, uploaded_by_email, uploaded_at";

export async function getLogoInfo(tx: OrgTx): Promise<LogoInfo | null> {
  const result = await tx.query<LogoRow>(`select ${INFO_COLUMNS} from organisation_logo where id = true`);
  return result.rows[0] ? toInfo(result.rows[0]) : null;
}

export async function getLogo(tx: OrgTx): Promise<Logo | null> {
  const result = await tx.query<LogoRow>(`select ${INFO_COLUMNS}, content from organisation_logo where id = true`);
  const row = result.rows[0];
  return row ? { ...toInfo(row), content: new Uint8Array(row.content!) } : null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image's type and size in pixels, from its header; null when it isn't a PNG or JPEG. */
export function imageSize(bytes: Uint8Array): { contentType: "image/png" | "image/jpeg"; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    // The first chunk is IHDR: width and height as 4-byte big-endian numbers.
    if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
    return { contentType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the JPEG's segments to the start-of-frame one, which has the size.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = view.getUint16(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { contentType: "image/jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Checks and saves a logo (admins), replacing any before it: a PNG or JPEG
 * by its contents (whatever its name says), at most 512 KB and 4000 pixels
 * a side, and one the PDF writer can read.
 */
export async function saveLogo(tx: OrgTx, input: { fileName?: unknown; content: Uint8Array }): Promise<LogoInfo> {
  const fileName = cleanFileName(typeof input.fileName === "string" ? input.fileName : "logo");
  const bytes = input.content;
  if (bytes.length === 0) throw new ValidationError("Choose a logo file.");
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new ValidationError(`${fileName} is ${formatFileSize(bytes.length)}. A logo can be at most 512 KB; save it smaller (a few hundred pixels wide is plenty).`);
  }
  const size = imageSize(bytes);
  if (!size) throw new ValidationError(`${fileName} isn't a PNG or JPEG image. Save the logo as PNG or JPEG.`);
  if (size.width < 1 || size.height < 1 || size.width > MAX_LOGO_PIXELS || size.height > MAX_LOGO_PIXELS) {
    throw new ValidationError(`${fileName} is ${size.width} x ${size.height} pixels. A logo can be at most ${MAX_LOGO_PIXELS} pixels a side.`);
  }
  try {
    const doc = await PDFDocument.create();
    if (size.contentType === "image/png") await doc.embedPng(bytes);
    else await doc.embedJpg(bytes);
  } catch {
    throw new ValidationError(`Tohyee couldn't read ${fileName} as an image. Save it again as a PNG or JPEG and try again.`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await tx.query(
    `insert into organisation_logo (id, file_name, content_type, byte_size, width, height, sha256, content, uploaded_by_email, uploaded_at)
     values (true, $1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (id) do update set file_name = excluded.file_name, content_type = excluded.content_type, byte_size = excluded.byte_size,
       width = excluded.width, height = excluded.height, sha256 = excluded.sha256, content = excluded.content,
       uploaded_by_email = excluded.uploaded_by_email, uploaded_at = now()`,
    [fileName, size.contentType, bytes.length, size.width, size.height, sha256, Buffer.from(bytes), tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "organisation.logo_saved",
    entityType: "organisation_logo",
    entityId: "logo",
    details: { fileName, contentType: size.contentType, byteSize: bytes.length, width: size.width, height: size.height, sha256 },
  });
  return (await getLogoInfo(tx))!;
}

export async function removeLogo(tx: OrgTx): Promise<void> {
  const removed = await tx.query("delete from organisation_logo");
  if ((removed.rowCount ?? 0) > 0) {
    await writeAuditEvent(tx, { eventType: "organisation.logo_removed", entityType: "organisation_logo", entityId: "logo" });
  }
}

/** The size to show a logo at inside a box, keeping its shape and never enlarging it. */
export function fitLogo(logo: { width: number; height: number }, box: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, box.width / logo.width, box.height / logo.height);
  return { width: Math.max(1, Math.round(logo.width * scale)), height: Math.max(1, Math.round(logo.height * scale)) };
}

/** The logo box in HTML emails, in pixels. */
export const EMAIL_LOGO_BOX = { width: 200, height: 64 };

/**
 * The logo for an HTML email: the inline image (Content-ID from its hash)
 * and the size to show it at. Null when there's no logo.
 */
export function emailLogo(logo: Logo | null): {
  html: { cid: string; width: number; height: number };
  inline: { cid: string; fileName: string; contentType: "image/png" | "image/jpeg"; bytes: Uint8Array };
} | null {
  if (!logo) return null;
  const cid = `logo-${logo.sha256.slice(0, 16)}@tohyee`;
  return {
    html: { cid, ...fitLogo(logo, EMAIL_LOGO_BOX) },
    inline: { cid, fileName: logo.contentType === "image/png" ? "logo.png" : "logo.jpg", contentType: logo.contentType, bytes: logo.content },
  };
}
