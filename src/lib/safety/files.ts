import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, PayloadTooLargeError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { photoTakenAt } from "@/lib/safety/photo-date";
import { canSeeRestricted, requireSafetyRecorder } from "@/lib/safety/records";
import type { SafetyFileRef } from "@/lib/safety/shared";
import { requireId } from "@/lib/validation";

/*
 * Photos and documents kept with safety records (#446, decision 945). The
 * database works out each file's hash and when it arrived; the camera's own
 * date (EXIF) and the phone's file date are kept beside it as given, never
 * as the entry time. Files can't be changed or deleted (migration 0189).
 * A record names its files by id and hash, so the hash is in the record's
 * own chained version too.
 */

export const MAX_SAFETY_FILE_BYTES = 10 * 1024 * 1024;

const TYPES: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
};

export type SafetyFile = SafetyFileRef & { contentType: string; sizeBytes: number; photoTaken: string | null; phoneFileTime: string | null; receivedAt: string; uploadedByEmail: string; restricted: boolean };

type FileRow = { id: string; farm_id: string | null; restricted: boolean; file_name: string; content_type: string; size_bytes: number; sha256: string; photo_taken: string | null; phone_file_time: string | null; received_at: string; uploaded_by_user_id: string | null; uploaded_by_email: string };

function toFile(row: FileRow): SafetyFile {
  return { id: row.id, name: row.file_name, sha256: row.sha256, contentType: row.content_type, sizeBytes: row.size_bytes, photoTaken: row.photo_taken, phoneFileTime: row.phone_file_time, receivedAt: row.received_at, uploadedByEmail: row.uploaded_by_email, restricted: row.restricted };
}

/**
 * Keeps a photo or PDF for a safety record on a farm. `restricted` files
 * (with incident or medical details) are seen like restricted details.
 */
export async function uploadSafetyFile(tx: OrgTx, input: { farmId?: unknown; fileName?: unknown; contentType?: unknown; contentBase64?: unknown; phoneFileTime?: unknown; restricted?: unknown }): Promise<SafetyFile> {
  await requireFarming(tx);
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const contentType = String(input.contentType ?? "");
  if (!TYPES[contentType]) throw new ValidationError("Add a photo (JPEG, PNG or WebP) or a PDF.");
  if (typeof input.contentBase64 !== "string" || !input.contentBase64) throw new ValidationError("The file is empty.");
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (!bytes.length) throw new ValidationError("The file is empty.");
  if (bytes.length > MAX_SAFETY_FILE_BYTES) throw new PayloadTooLargeError("A file can be at most 10 MB. Take the photo at a lower size, or send a smaller PDF.");
  if (!TYPES[contentType](bytes)) throw new ValidationError("That file isn't the kind it says it is.");
  const rawName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  const fileName = (rawName || (contentType === "application/pdf" ? "document.pdf" : "photo")).replace(/[\\/\0\r\n]+/g, "_").slice(0, 200);
  let phoneFileTime: string | null = null;
  if (input.phoneFileTime != null && input.phoneFileTime !== "") {
    const parsed = new Date(String(input.phoneFileTime));
    if (Number.isNaN(parsed.getTime())) throw new ValidationError("The phone's file date isn't a date.");
    phoneFileTime = parsed.toISOString();
  }
  // Anyone recording may add a restricted photo (to details they're entering themselves); only they and those with restricted access see it.
  const restricted = input.restricted === true;
  const row = await tx.query<FileRow>(
    `insert into safety_files (id, farm_id, restricted, file_name, content_type, size_bytes, sha256, content, photo_taken, phone_file_time, uploaded_by_user_id, uploaded_by_email)
     values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
     returning id::text, farm_id::text, restricted, file_name, content_type, size_bytes, sha256, photo_taken, phone_file_time, received_at, uploaded_by_user_id::text, uploaded_by_email`,
    [randomUUID(), farmId, restricted, fileName, contentType, "0".repeat(64), bytes, contentType === "image/jpeg" ? photoTakenAt(bytes) : null, phoneFileTime, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "safety.file_added", entityType: "safety_file", entityId: row.rows[0].id, details: { sha256: row.rows[0].sha256, restricted } });
  return toFile(row.rows[0]);
}

async function readable(tx: OrgTx, row: Pick<FileRow, "farm_id" | "restricted" | "uploaded_by_user_id">): Promise<boolean> {
  if (row.farm_id && !(await canSeeFarm(tx, row.farm_id))) return false;
  if (row.restricted && row.uploaded_by_user_id !== tx.actor.userId && !(await canSeeRestricted(tx))) return false;
  return true;
}

/** A file's content, if the person may see it. */
export async function readSafetyFile(tx: OrgTx, idInput: unknown): Promise<SafetyFile & { content: Buffer }> {
  await requireFarming(tx);
  const id = typeof idInput === "string" && /^[0-9a-f-]{36}$/i.test(idInput) ? idInput : null;
  const row = id
    ? await tx.query<FileRow & { content: Buffer }>(
        "select id::text, farm_id::text, restricted, file_name, content_type, size_bytes, sha256, content, photo_taken, phone_file_time, received_at, uploaded_by_user_id::text, uploaded_by_email from safety_files where id = $1",
        [id],
      )
    : { rows: [] };
  if (!row.rows[0] || !(await readable(tx, row.rows[0]))) throw new NotFoundError("That file wasn't found.");
  return { ...toFile(row.rows[0]), content: row.rows[0].content };
}

/**
 * The files a record names, checked: each exists on the record's farm, may
 * be seen by the person, and is restricted exactly when the record is.
 * Returned as {id, name, sha256}, so the record's hash covers the file's.
 */
export async function fileRefs(tx: OrgTx, input: unknown, farmId: string | null, restricted: boolean): Promise<SafetyFileRef[]> {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 20) throw new ValidationError("Add up to 20 photos or documents.");
  const ids = [...new Set(input.map((file) => (file && typeof file === "object" ? String((file as { id?: unknown }).id ?? "") : String(file))))];
  if (!ids.length) return [];
  if (!ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) throw new ValidationError("One of those files wasn't found.");
  const rows = await tx.query<FileRow>(
    "select id::text, farm_id::text, restricted, file_name, content_type, size_bytes, sha256, photo_taken, phone_file_time, received_at, uploaded_by_user_id::text, uploaded_by_email from safety_files where id = any($1::uuid[])",
    [ids],
  );
  const found = new Map(rows.rows.map((row) => [row.id, row]));
  const refs: SafetyFileRef[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row || row.farm_id !== farmId || !(await readable(tx, row))) throw new ValidationError("One of those files wasn't found.");
    if (row.restricted !== restricted) throw new ValidationError(restricted ? "Photos with restricted details must be added as restricted." : "A restricted photo can only go with restricted details.");
    refs.push({ id: row.id, name: row.file_name, sha256: row.sha256 });
  }
  return refs;
}

/** Details of files a record names (for showing them), leaving out any the person can't see. */
export async function describeFiles(tx: OrgTx, refs: readonly SafetyFileRef[]): Promise<SafetyFile[]> {
  if (!refs.length) return [];
  const rows = await tx.query<FileRow>(
    "select id::text, farm_id::text, restricted, file_name, content_type, size_bytes, sha256, photo_taken, phone_file_time, received_at, uploaded_by_user_id::text, uploaded_by_email from safety_files where id = any($1::uuid[])",
    [refs.map((ref) => ref.id)],
  );
  const files: SafetyFile[] = [];
  for (const row of rows.rows) if (await readable(tx, row)) files.push(toFile(row));
  return files;
}
