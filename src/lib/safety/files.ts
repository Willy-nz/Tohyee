import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { photoTakenAt } from "@/lib/safety/photo-date";
import { canSeeRestricted, isFarmStaff, requireSafetyReporter } from "@/lib/safety/records";
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

/** Where the phone said it was when the photo was taken (#472, decision 1012): as given, never checked against anything. */
export type PhotoPlace = { latitude: number; longitude: number; accuracyM: number | null; at: string | null };

export type SafetyFile = SafetyFileRef & { contentType: string; sizeBytes: number; photoTaken: string | null; phoneFileTime: string | null; receivedAt: string; uploadedByEmail: string; restricted: boolean; place: PhotoPlace | null };

type FileRow = { id: string; farm_id: string | null; restricted: boolean; file_name: string; content_type: string; size_bytes: number; sha256: string; photo_taken: string | null; phone_file_time: string | null; received_at: string; uploaded_by_user_id: string | null; uploaded_by_email: string; place: PhotoPlace | null };

const FILE_COLUMNS = "id::text, farm_id::text, restricted, file_name, content_type, size_bytes, sha256, photo_taken, phone_file_time, received_at, uploaded_by_user_id::text, uploaded_by_email, place";

function toFile(row: FileRow): SafetyFile {
  return { id: row.id, name: row.file_name, sha256: row.sha256, contentType: row.content_type, sizeBytes: row.size_bytes, photoTaken: row.photo_taken, phoneFileTime: row.phone_file_time, receivedAt: row.received_at, uploadedByEmail: row.uploaded_by_email, restricted: row.restricted, place: row.place ?? null };
}

/** The phone's place for a photo, if it sent one: numbers in range, or nothing. */
export function parsePhotoPlace(input: unknown): PhotoPlace | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "object") throw new ValidationError("The photo's place isn't a place.");
  const value = input as Record<string, unknown>;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new ValidationError("The photo's place isn't a place.");
  const accuracy = value.accuracyM === null || value.accuracyM === undefined ? null : Number(value.accuracyM);
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000)) throw new ValidationError("The photo's place accuracy isn't a distance.");
  let at: string | null = null;
  if (value.at !== null && value.at !== undefined && value.at !== "") {
    const parsed = new Date(String(value.at));
    if (Number.isNaN(parsed.getTime())) throw new ValidationError("The photo's place time isn't a time.");
    at = parsed.toISOString();
  }
  // Six decimal places is about 10 cm: more is only noise from the phone.
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6, accuracyM: accuracy === null ? null : Math.round(accuracy), at };
}

/**
 * Keeps a photo or PDF for a safety record on a farm. `restricted` files
 * (with incident or medical details) are seen like restricted details.
 */
export async function uploadSafetyFile(tx: OrgTx, input: { farmId?: unknown; fileName?: unknown; contentType?: unknown; contentBase64?: unknown; phoneFileTime?: unknown; restricted?: unknown; operationId?: unknown; place?: unknown }): Promise<SafetyFile> {
  await requireFarming(tx);
  requireSafetyReporter(tx);
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
  const place = parsePhotoPlace(input.place);
  // A photo sent from the phone's queue carries its operation id, which becomes the file's id: sent again
  // (a dropped connection), the same photo is found instead of kept twice (#472, decision 1012).
  const operationId = input.operationId === undefined || input.operationId === null || input.operationId === "" ? null : String(input.operationId);
  if (operationId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new ValidationError("The operation id isn't valid.");
  if (operationId) {
    const existing = await tx.query<FileRow & { same: boolean }>(`select ${FILE_COLUMNS}, sha256 = encode(sha256($2::bytea), 'hex') as same from safety_files where id = $1`, [operationId, bytes]);
    const found = existing.rows[0];
    if (found) {
      if (found.uploaded_by_user_id !== tx.actor.userId || !found.same || found.farm_id !== farmId || found.restricted !== restricted) throw new ConflictError("That operation id was already used for another file.");
      return toFile(found);
    }
  }
  const row = await tx.query<FileRow>(
    `insert into safety_files (id, farm_id, restricted, file_name, content_type, size_bytes, sha256, content, photo_taken, phone_file_time, uploaded_by_user_id, uploaded_by_email, place)
     values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12)
     returning ${FILE_COLUMNS}`,
    [operationId ?? randomUUID(), farmId, restricted, fileName, contentType, "0".repeat(64), bytes, contentType === "image/jpeg" ? photoTakenAt(bytes) : null, phoneFileTime, tx.actor.userId, tx.actor.email, place === null ? null : JSON.stringify(place)],
  );
  await writeAuditEvent(tx, { eventType: "safety.file_added", entityType: "safety_file", entityId: row.rows[0].id, details: { sha256: row.rows[0].sha256, restricted } });
  return toFile(row.rows[0]);
}

async function readable(tx: OrgTx, row: Pick<FileRow, "farm_id" | "restricted" | "uploaded_by_user_id">): Promise<boolean> {
  if (row.farm_id && !(await canSeeFarm(tx, row.farm_id))) return false;
  if (row.restricted && (isFarmStaff(tx) || row.uploaded_by_user_id !== tx.actor.userId) && !(await canSeeRestricted(tx))) return false;
  return true;
}

/** A file's content, if the person may see it. */
export async function readSafetyFile(tx: OrgTx, idInput: unknown): Promise<SafetyFile & { content: Buffer }> {
  await requireFarming(tx);
  const id = typeof idInput === "string" && /^[0-9a-f-]{36}$/i.test(idInput) ? idInput : null;
  const row = id
    ? await tx.query<FileRow & { content: Buffer }>(
        `select ${FILE_COLUMNS}, content from safety_files where id = $1`,
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
    `select ${FILE_COLUMNS} from safety_files where id = any($1::uuid[])`,
    [ids],
  );
  const found = new Map(rows.rows.map((row) => [row.id, row]));
  const refs: SafetyFileRef[] = [];
  for (const id of ids) {
    const row = found.get(id);
    // A record for every farm (e.g. training) may name a file kept on any farm the person sees.
    // Someone may name a file they added themselves, even a restricted one they can't open again (farm staff, decision 961).
    const own = row?.uploaded_by_user_id !== null && row?.uploaded_by_user_id === tx.actor.userId;
    if (!row || (farmId !== null && row.farm_id !== farmId) || !(own || (await readable(tx, row)))) throw new ValidationError("One of those files wasn't found.");
    if (row.restricted !== restricted) throw new ValidationError(restricted ? "Photos with restricted details must be added as restricted." : "A restricted photo can only go with restricted details.");
    refs.push({ id: row.id, name: row.file_name, sha256: row.sha256 });
  }
  return refs;
}

/** Details of files a record names (for showing them), leaving out any the person can't see. */
export async function describeFiles(tx: OrgTx, refs: readonly SafetyFileRef[]): Promise<SafetyFile[]> {
  if (!refs.length) return [];
  const rows = await tx.query<FileRow>(
    `select ${FILE_COLUMNS} from safety_files where id = any($1::uuid[])`,
    [refs.map((ref) => ref.id)],
  );
  const files: SafetyFile[] = [];
  for (const row of rows.rows) if (await readable(tx, row)) files.push(toFile(row));
  return files;
}
