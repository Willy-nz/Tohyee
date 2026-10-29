import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { isoDateAt, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "@/lib/errors";
import { canSeeFarm, visibleFarmIds } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { calibrationSummary, type CalibrationGroup, calibrationText, isEstimate, MAX_COVER, parseCalibrationWindow, parseCover, PHOTO_ESTIMATE_METHOD, type PastureMethod } from "@/lib/farming/pasture-rules";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { photoTakenAt } from "@/lib/safety/photo-date";
import { parsePhotoPlace, type PhotoPlace } from "@/lib/safety/files";
import { ESTIMATE_CONFIDENCES, ESTIMATE_STATUS_LABELS, type EstimateConfidence, type EstimateStatus } from "@/lib/farming/pasture-photos-shared";
import { optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/*
 * Photos with cover readings, and AI estimates from them (#503, decisions
 * 1160-1169; Jess, 30 October 2026: "Ok").
 *
 * - A photo is kept for a paddock, with the phone's time and, if asked,
 *   where the phone said it was (as safety photos are, decision 1012). Its
 *   id is the phone's operation id, so a photo sent again from the queue is
 *   found, not kept twice. A photo taken with a Log reading names that
 *   reading's operation id, so it's linked whichever reaches Tohyee first.
 * - Seen and added like cover readings (decision 904): farm staff, viewers
 *   (to look) and bookkeepers and above (to add), on farms they can see
 *   (decision 744). Removing one hides it and keeps it, like a reading.
 * - The person's own AI (their key or connected app) may propose a cover
 *   from a photo. It's a proposal, "AI estimate from a photo, not
 *   measured", never a reading, until a person accepts it (as proposed or
 *   changed), keeps it beside the photo's own reading for comparison, or
 *   declines it. Tohyee itself sends nothing anywhere.
 * - Calibration only reports how far estimates were from other readings of
 *   the same paddock close in time. Nothing is ever adjusted.
 */

export const MAX_PASTURE_PHOTO_BYTES = 10 * 1024 * 1024;
/** The most an AI is sent in one answer: a phone's copy is far smaller (1600 pixels, decision 1012). */
export const MAX_AI_PHOTO_BYTES = 3_500_000;

const TYPES: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
};

export { ESTIMATE_CONFIDENCE_LABELS, ESTIMATE_CONFIDENCES, ESTIMATE_LABEL, ESTIMATE_STATUS_LABELS, type EstimateConfidence, type EstimateStatus } from "@/lib/farming/pasture-photos-shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PhotoEstimate = {
  id: string;
  photoId: string;
  farmId: string;
  paddockId: string;
  paddockName: string;
  takenOn: string;
  cover: number;
  confidence: EstimateConfidence;
  reasoning: string;
  aiKeyName: string | null;
  proposedByEmail: string;
  createdAt: string;
  status: EstimateStatus;
  decidedCover: number | null;
  readingId: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  /** The reading the photo was taken with, if any: the estimate can be kept beside it, not accepted over it. */
  photoReading: { id: string; cover: number; method: PastureMethod; measuredOn: string } | null;
};

export type PasturePhoto = {
  id: string;
  farmId: string;
  paddockId: string;
  paddockName: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  photoTaken: string | null;
  phoneFileTime: string | null;
  takenOn: string;
  place: PhotoPlace | null;
  note: string | null;
  receivedAt: string;
  uploadedByEmail: string;
  /** The reading it was taken with, or the one made by accepting its estimate. */
  reading: { id: string; cover: number; method: PastureMethod; measuredOn: string; estimate: boolean } | null;
  estimate: PhotoEstimate | null;
};

type PhotoRow = {
  id: string;
  farm_id: string;
  paddock_id: string;
  paddock_name: string;
  reading_operation_id: string | null;
  uploaded_by_user_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  photo_taken: string | null;
  phone_file_time: string | null;
  taken_on: string;
  place: PhotoPlace | null;
  note: string | null;
  received_at: string;
  uploaded_by_email: string;
  status: string;
  reading_id: string | null;
  reading_cover: number | null;
  reading_method: PastureMethod | null;
  reading_on: string | null;
};

/** The photo's own reading: the Log reading it was taken with (same paddock, still active). */
const PHOTO_READING = `(select r.id from pasture_readings r where r.operation_id = p.reading_operation_id and r.paddock_id = p.paddock_id and r.status = 'active' order by r.id limit 1)`;

const PHOTO_SELECT = `select p.id::text, p.farm_id::text, p.paddock_id::text, d.name as paddock_name, p.reading_operation_id::text, p.uploaded_by_user_id::text,
       p.file_name, p.content_type, p.size_bytes, p.sha256, p.photo_taken, p.phone_file_time, p.taken_on::text, p.place, p.note, p.received_at,
       p.uploaded_by_email, p.status, r.id::text as reading_id, r.cover as reading_cover, r.method as reading_method, r.measured_on::text as reading_on
  from pasture_photos p
  join paddocks d on d.id = p.paddock_id
  left join pasture_photo_estimates e on e.photo_id = p.id
  left join pasture_readings r on r.id = coalesce(${PHOTO_READING}, case when e.status in ('accepted', 'changed') then e.reading_id end) and r.status = 'active'`;

type EstimateRow = {
  id: string;
  photo_id: string;
  farm_id: string;
  paddock_id: string;
  paddock_name: string;
  taken_on: string;
  request_hash: string;
  cover: number;
  confidence: EstimateConfidence;
  reasoning: string;
  ai_key_name: string | null;
  proposed_by_email: string;
  created_at: string;
  status: EstimateStatus;
  decided_cover: number | null;
  reading_id: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decline_reason: string | null;
  photo_reading_id: string | null;
  photo_reading_cover: number | null;
  photo_reading_method: PastureMethod | null;
  photo_reading_on: string | null;
};

const ESTIMATE_SELECT = `select e.id::text, e.photo_id::text, e.farm_id::text, e.paddock_id::text, d.name as paddock_name, p.taken_on::text, e.request_hash, e.cover, e.confidence, e.reasoning,
       e.ai_key_name, e.proposed_by_email, e.created_at, e.status, e.decided_cover, e.reading_id::text, e.decided_by_email, e.decided_at, e.decline_reason,
       r.id::text as photo_reading_id, r.cover as photo_reading_cover, r.method as photo_reading_method, r.measured_on::text as photo_reading_on
  from pasture_photo_estimates e
  join pasture_photos p on p.id = e.photo_id
  join paddocks d on d.id = e.paddock_id
  left join pasture_readings r on r.id = ${PHOTO_READING}`;

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

function toEstimate(row: EstimateRow): PhotoEstimate {
  return {
    id: row.id,
    photoId: row.photo_id,
    farmId: row.farm_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    takenOn: row.taken_on,
    cover: row.cover,
    confidence: row.confidence,
    reasoning: row.reasoning,
    aiKeyName: row.ai_key_name,
    proposedByEmail: row.proposed_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    status: row.status,
    decidedCover: row.decided_cover,
    readingId: row.reading_id,
    decidedByEmail: row.decided_by_email,
    decidedAt: iso(row.decided_at),
    declineReason: row.decline_reason,
    photoReading: row.photo_reading_id ? { id: row.photo_reading_id, cover: row.photo_reading_cover!, method: row.photo_reading_method!, measuredOn: row.photo_reading_on! } : null,
  };
}

async function loadEstimates(tx: OrgTx, where: string, params: unknown[], limit = 200): Promise<PhotoEstimate[]> {
  const rows = await tx.query<EstimateRow>(`${ESTIMATE_SELECT} where p.status = 'active' and ${where} order by e.created_at desc, e.id desc limit ${Math.trunc(limit)}`, params);
  return rows.rows.map(toEstimate);
}

async function loadPhotos(tx: OrgTx, where: string, params: unknown[], limit = 200): Promise<PasturePhoto[]> {
  const rows = await tx.query<PhotoRow>(`${PHOTO_SELECT} where ${where} order by p.taken_on desc, p.received_at desc, p.id limit ${Math.trunc(limit)}`, params);
  const estimates = rows.rows.length ? await loadEstimates(tx, "e.photo_id = any($1::uuid[])", [rows.rows.map((row) => row.id)]) : [];
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    photoTaken: row.photo_taken,
    phoneFileTime: iso(row.phone_file_time),
    takenOn: row.taken_on,
    place: row.place ?? null,
    note: row.note,
    receivedAt: new Date(row.received_at).toISOString(),
    uploadedByEmail: row.uploaded_by_email,
    reading: row.reading_id ? { id: row.reading_id, cover: row.reading_cover!, method: row.reading_method!, measuredOn: row.reading_on!, estimate: isEstimate(row.reading_method!) } : null,
    estimate: estimates.find((estimate) => estimate.photoId === row.id) ?? null,
  }));
}

function photoId(input: unknown): string {
  if (typeof input !== "string" || !UUID.test(input)) throw new NotFoundError("That photo wasn't found.");
  return input.toLowerCase();
}

/** The photo, if the person can see its farm (otherwise "not found", so it isn't given away). */
async function requirePhoto(tx: OrgTx, input: unknown): Promise<PasturePhoto> {
  await requireFarming(tx);
  const id = photoId(input);
  const photo = (await loadPhotos(tx, "p.id = $1 and p.status = 'active'", [id]))[0];
  if (!photo || !(await canSeeFarm(tx, photo.farmId))) throw new NotFoundError("That photo wasn't found.");
  return photo;
}

/**
 * The day a photo was taken: the phone's time, in New Zealand, when it's
 * sensible (not after it arrived, not more than a year before); otherwise
 * the day it reached Tohyee (decision 1161).
 */
export function takenOnFor(phoneFileTime: string | null, now: Date = new Date()): string {
  if (phoneFileTime) {
    const at = new Date(phoneFileTime);
    if (at.getTime() <= now.getTime() + 5 * 60_000 && at.getTime() >= now.getTime() - 366 * 86_400_000) return isoDateAt(at);
  }
  return isoDateAt(now);
}

/**
 * Keeps a photo for a paddock (decision 1160): `farmId`, `paddockId`,
 * `fileName`, `contentType`, `contentBase64`, `phoneFileTime`, `place`,
 * `note`, and from the phone's queue `operationId` (the photo's id) and
 * `readingOperationId` (the Log reading it was taken with).
 */
export async function uploadPasturePhoto(
  tx: OrgTx,
  input: { farmId?: unknown; paddockId?: unknown; fileName?: unknown; contentType?: unknown; contentBase64?: unknown; phoneFileTime?: unknown; place?: unknown; note?: unknown; operationId?: unknown; readingOperationId?: unknown },
): Promise<PasturePhoto> {
  await requireFarming(tx);
  const paddockId = requireId(input.paddockId, "paddockId");
  const paddock = (await tx.query<{ farm_id: string; name: string; status: string }>("select farm_id::text, name, status from paddocks where id = $1", [paddockId])).rows[0];
  if (!paddock || !(await canSeeFarm(tx, paddock.farm_id))) throw new NotFoundError("Paddock not found.");
  // Sent for one farm, it must be that farm's paddock (decision 902).
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "" && requireId(input.farmId, "farmId") !== paddock.farm_id) {
    throw new ConflictError(`${paddock.name} isn't on the farm this was recorded for. Nothing was saved: check the farm and try again.`);
  }
  if (paddock.status !== "active") throw new ValidationError(`${paddock.name} is retired.`);
  const contentType = String(input.contentType ?? "");
  if (!TYPES[contentType]) throw new ValidationError("Add a photo (JPEG, PNG or WebP).");
  if (typeof input.contentBase64 !== "string" || !input.contentBase64) throw new ValidationError("The photo is empty.");
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (!bytes.length) throw new ValidationError("The photo is empty.");
  if (bytes.length > MAX_PASTURE_PHOTO_BYTES) throw new PayloadTooLargeError("A photo can be at most 10 MB. Take it at a lower size.");
  if (!TYPES[contentType](bytes)) throw new ValidationError("That file isn't the kind it says it is.");
  const rawName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  const fileName = (rawName || "photo").replace(/[\\/\0\r\n]+/g, "_").slice(0, 200);
  let phoneFileTime: string | null = null;
  if (input.phoneFileTime != null && input.phoneFileTime !== "") {
    const parsed = new Date(String(input.phoneFileTime));
    if (Number.isNaN(parsed.getTime())) throw new ValidationError("The phone's file date isn't a date.");
    phoneFileTime = parsed.toISOString();
  }
  const place = parsePhotoPlace(input.place);
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const readingOperationId = input.readingOperationId === undefined || input.readingOperationId === null || input.readingOperationId === "" ? null : String(input.readingOperationId).toLowerCase();
  if (readingOperationId !== null && !UUID.test(readingOperationId)) throw new ValidationError("The reading's operation id isn't valid.");
  const operationId = input.operationId === undefined || input.operationId === null || input.operationId === "" ? null : String(input.operationId).toLowerCase();
  if (operationId !== null && !UUID.test(operationId)) throw new ValidationError("The operation id isn't valid.");
  if (operationId) {
    // Sent again from the queue (a dropped connection): the same photo is found instead of kept twice.
    const existing = await tx.query<{ uploaded_by_user_id: string | null; same: boolean; paddock_id: string; reading_operation_id: string | null }>(
      "select uploaded_by_user_id::text, sha256 = encode(sha256($2::bytea), 'hex') as same, paddock_id::text, reading_operation_id::text from pasture_photos where id = $1",
      [operationId, bytes],
    );
    const found = existing.rows[0];
    if (found) {
      if (found.uploaded_by_user_id !== tx.actor.userId || !found.same || found.paddock_id !== paddockId || found.reading_operation_id !== readingOperationId) throw new ConflictError("That operation id was already used for another photo.");
      return (await loadPhotos(tx, "p.id = $1", [operationId]))[0];
    }
  }
  const id = operationId ?? randomUUID();
  await tx.query(
    `insert into pasture_photos (id, farm_id, paddock_id, reading_operation_id, file_name, content_type, size_bytes, sha256, content, photo_taken, phone_file_time, taken_on, place, note, uploaded_by_user_id, uploaded_by_email)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, paddock.farm_id, paddockId, readingOperationId, fileName, contentType, "0".repeat(64), bytes, contentType === "image/jpeg" ? photoTakenAt(bytes) : null, phoneFileTime, takenOnFor(phoneFileTime), place === null ? null : JSON.stringify(place), note, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.pasture_photo_added", entityType: "pasture_photo", entityId: id, details: { paddockId, readingOperationId } });
  return (await loadPhotos(tx, "p.id = $1", [id]))[0];
}

/** A farm's photos, newest first (`paddockId` for one paddock's diary, `limit` up to 200). */
export async function listPasturePhotos(tx: OrgTx, input: { farmId: unknown; paddockId?: unknown; limit?: unknown }): Promise<PasturePhoto[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const limit = Math.min(Math.max(Number(input.limit) || 60, 1), 200);
  if (input.paddockId !== undefined && input.paddockId !== null && input.paddockId !== "") {
    return loadPhotos(tx, "p.farm_id = $1 and p.paddock_id = $2 and p.status = 'active'", [farmId, requireId(input.paddockId, "paddockId")], limit);
  }
  return loadPhotos(tx, "p.farm_id = $1 and p.status = 'active'", [farmId], limit);
}

/** A paddock's photo diary: its photos, newest first, with the farm worked out from the paddock. */
export async function paddockPhotos(tx: OrgTx, paddockIdInput: unknown, limitInput?: unknown): Promise<PasturePhoto[]> {
  await requireFarming(tx);
  const paddockId = requireId(paddockIdInput, "paddockId");
  const paddock = (await tx.query<{ farm_id: string }>("select farm_id::text from paddocks where id = $1", [paddockId])).rows[0];
  if (!paddock || !(await canSeeFarm(tx, paddock.farm_id))) throw new NotFoundError("Paddock not found.");
  return listPasturePhotos(tx, { farmId: paddock.farm_id, paddockId, limit: limitInput });
}

/** A photo's content, for those who may see its farm. */
export async function readPasturePhoto(tx: OrgTx, idInput: unknown): Promise<PasturePhoto & { content: Buffer }> {
  const photo = await requirePhoto(tx, idInput);
  const row = await tx.query<{ content: Buffer }>("select content from pasture_photos where id = $1", [photo.id]);
  return { ...photo, content: row.rows[0].content };
}

/** Hides a photo added by mistake; it's kept for the history, and its estimate with it. */
export async function removePasturePhoto(tx: OrgTx, idInput: unknown): Promise<void> {
  const photo = await requirePhoto(tx, idInput);
  await tx.query("update pasture_photos set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1 and status = 'active'", [photo.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.pasture_photo_removed", entityType: "pasture_photo", entityId: photo.id, details: { paddockId: photo.paddockId } });
}

// For the person's own AI (decision 1163) ----------------------------------------------------------------

export type PhotoForAi = { photoId: string; farmId: string; farmName: string; paddockId: string; paddockName: string; hectares: string | null; takenOn: string; phoneFileTime: string | null; cameraDate: string | null; contentType: string; sizeBytes: number; note: string | null; tooBigToSend: boolean };

/**
 * Photos with no estimate yet, on the farms the key's person can see,
 * newest first. Leaves out where the phone was and any reading, so an
 * estimate is the AI's own look at the photo (decision 1163).
 */
export async function photosAwaitingEstimate(tx: OrgTx, input: { farmId?: unknown; limit?: unknown }): Promise<PhotoForAi[]> {
  await requireFarming(tx);
  const visible = await visibleFarmIds(tx);
  const params: unknown[] = [visible];
  let where = "p.status = 'active' and not exists (select 1 from pasture_photo_estimates e where e.photo_id = p.id) and ($1::bigint[] is null or p.farm_id = any($1::bigint[]))";
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "") {
    const farmId = requireId(input.farmId, "farmId");
    if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
    params.push(farmId);
    where += " and p.farm_id = $2";
  }
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const rows = await tx.query<{ id: string; farm_id: string; farm_name: string; paddock_id: string; paddock_name: string; hectares: string | null; taken_on: string; phone_file_time: string | null; photo_taken: string | null; content_type: string; size_bytes: number; note: string | null }>(
    `select p.id::text, p.farm_id::text, f.name as farm_name, p.paddock_id::text, d.name as paddock_name, d.effective_ha::text as hectares, p.taken_on::text, p.phone_file_time, p.photo_taken,
            p.content_type, p.size_bytes, p.note
       from pasture_photos p join paddocks d on d.id = p.paddock_id join farms f on f.id = p.farm_id
      where ${where}
      order by p.taken_on desc, p.received_at desc, p.id limit ${limit}`,
    params,
  );
  return rows.rows.map((row) => ({
    photoId: row.id,
    farmId: row.farm_id,
    farmName: row.farm_name,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    hectares: row.hectares,
    takenOn: row.taken_on,
    phoneFileTime: iso(row.phone_file_time),
    cameraDate: row.photo_taken,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    note: row.note,
    tooBigToSend: row.size_bytes > MAX_AI_PHOTO_BYTES,
  }));
}

/** One photo for the AI: the image itself, refused when it's bigger than an AI is sent. */
export async function photoForAi(tx: OrgTx, idInput: unknown): Promise<{ photo: Omit<PhotoForAi, "farmName" | "hectares" | "tooBigToSend">; content: Buffer; contentType: string; fileName: string }> {
  const photo = await readPasturePhoto(tx, idInput);
  if (photo.sizeBytes > MAX_AI_PHOTO_BYTES) throw new PayloadTooLargeError(`That photo is ${(photo.sizeBytes / 1_000_000).toFixed(1)} MB, more than the ${(MAX_AI_PHOTO_BYTES / 1_000_000).toFixed(1)} MB an AI is sent. A person can look at it in Tohyee and enter the cover.`);
  return {
    photo: { photoId: photo.id, farmId: photo.farmId, paddockId: photo.paddockId, paddockName: photo.paddockName, takenOn: photo.takenOn, phoneFileTime: photo.phoneFileTime, cameraDate: photo.photoTaken, contentType: photo.contentType, sizeBytes: photo.sizeBytes, note: photo.note },
    content: photo.content,
    contentType: photo.contentType,
    fileName: photo.fileName,
  };
}

/**
 * The AI's cover estimate from a photo (decisions 1162, 1164): kg DM/ha,
 * how sure it is and why in a sentence or two. Saved as a proposal only;
 * one per photo. Sent again with the same idempotency key, the first is
 * found.
 */
export async function proposeCoverEstimate(tx: OrgTx, input: { idempotencyKey: unknown; photoId: unknown; cover: unknown; confidence: unknown; reasoning: unknown }): Promise<{ created: boolean; estimate: PhotoEstimate }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const photo = await requirePhoto(tx, input.photoId);
  const cover = parseCover(typeof input.cover === "number" ? String(input.cover) : typeof input.cover === "string" ? input.cover : "");
  if (cover === null) throw new ValidationError(`cover must be a whole number of kg DM/ha from 0 to ${MAX_COVER.toLocaleString("en-NZ")}.`);
  const confidence = requireOneOf(input.confidence, "confidence", ESTIMATE_CONFIDENCES);
  const reasoning = requireString(input.reasoning, "reasoning", { maxLength: 500 });
  const hash = requestHash("pasture_photo_estimate", { photoId: photo.id, cover, confidence, reasoning });
  const again = await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from pasture_photo_estimates where idempotency_key = $1", [idempotencyKey]);
  if (again.rows[0]) {
    assertSameRequest(again.rows[0].request_hash, hash, "photo estimate");
    return { created: false, estimate: (await loadEstimates(tx, "e.id = $1", [again.rows[0].id]))[0] };
  }
  if (photo.estimate) throw new ConflictError("That photo already has an estimate. list_pasture_photos_awaiting_estimate lists the photos without one.");
  const inserted = await tx.query<{ id: string }>(
    `insert into pasture_photo_estimates (photo_id, farm_id, paddock_id, idempotency_key, request_hash, cover, confidence, reasoning, ai_key_name, proposed_by_user_id, proposed_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id::text`,
    [photo.id, photo.farmId, photo.paddockId, idempotencyKey, hash, cover, confidence, reasoning, tx.actor.via ?? null, tx.actor.userId, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "farming.pasture_estimate_proposed", entityType: "pasture_photo_estimate", entityId: id, details: { photoId: photo.id, cover, confidence } });
  return { created: true, estimate: (await loadEstimates(tx, "e.id = $1", [id]))[0] };
}

// A person decides (decision 1165) ---------------------------------------------------------------------

/** A farm's estimates: those waiting first, then the latest decided (the history). */
export async function listEstimates(tx: OrgTx, input: { farmId: unknown; limit?: unknown }): Promise<{ waiting: PhotoEstimate[]; decided: PhotoEstimate[] }> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200);
  return {
    waiting: await loadEstimates(tx, "e.farm_id = $1 and e.status = 'waiting'", [farmId], 200),
    decided: await loadEstimates(tx, "e.farm_id = $1 and e.status <> 'waiting'", [farmId], limit),
  };
}

async function lockWaiting(tx: OrgTx, idInput: unknown): Promise<PhotoEstimate> {
  await requireFarming(tx);
  const id = requireId(idInput, "estimateId");
  await tx.query("select 1 from pasture_photo_estimates where id = $1 for update", [id]);
  const estimate = (await loadEstimates(tx, "e.id = $1", [id]))[0];
  if (!estimate || !(await canSeeFarm(tx, estimate.farmId))) throw new NotFoundError("That estimate wasn't found.");
  if (estimate.status !== "waiting") throw new ConflictError(`This estimate was already decided (${ESTIMATE_STATUS_LABELS[estimate.status].toLowerCase()}).`);
  return estimate;
}

/**
 * Accepts an estimate as a reading, at the AI's cover or one the person
 * typed instead ("changed"). The reading is dated the photo's day and
 * labelled "AI estimate from a photo, not measured". A photo taken with a
 * reading of its own can't make a second one: keep the estimate beside it.
 */
export async function acceptEstimate(tx: OrgTx, idInput: unknown, input: { cover?: unknown } = {}): Promise<PhotoEstimate> {
  const estimate = await lockWaiting(tx, idInput);
  if (estimate.photoReading) throw new ConflictError(`This photo was taken with a reading of ${estimate.photoReading.cover.toLocaleString("en-NZ")} kg DM/ha. Keep the estimate for comparison, or decline it.`);
  const typed = input.cover === undefined || input.cover === null || input.cover === "" ? estimate.cover : parseCover(typeof input.cover === "number" ? String(input.cover) : String(input.cover));
  if (typed === null) throw new ValidationError(`Cover must be a whole number of kg DM/ha from 0 to ${MAX_COVER.toLocaleString("en-NZ")}.`);
  const paddock = (await tx.query<{ status: string; name: string }>("select status, name from paddocks where id = $1", [estimate.paddockId])).rows[0];
  if (paddock.status !== "active") throw new ValidationError(`${paddock.name} is retired.`);
  const status: EstimateStatus = typed === estimate.cover ? "accepted" : "changed";
  const source = `${status === "accepted" ? "AI estimate from a photo" : `AI estimate from a photo (${estimate.cover.toLocaleString("en-NZ")}), changed`}${estimate.aiKeyName ? ` via ${estimate.aiKeyName}` : ""}; accepted by ${tx.actor.email}`.slice(0, 200);
  const reading = await tx.query<{ id: string }>(
    "insert into pasture_readings (farm_id, paddock_id, measured_on, cover, method, source, created_by_email) values ($1, $2, $3, $4, $5, $6, $7) returning id::text",
    [estimate.farmId, estimate.paddockId, estimate.takenOn, typed, PHOTO_ESTIMATE_METHOD, source, tx.actor.email],
  );
  await tx.query("update pasture_photo_estimates set status = $2, decided_cover = $3, reading_id = $4, decided_by_email = $5 where id = $1", [estimate.id, status, typed, reading.rows[0].id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.pasture_reading_added", entityType: "pasture_reading", entityId: reading.rows[0].id, details: { paddockId: estimate.paddockId, measuredOn: estimate.takenOn, cover: typed, method: PHOTO_ESTIMATE_METHOD, estimateId: estimate.id } });
  await writeAuditEvent(tx, { eventType: `farming.pasture_estimate_${status}`, entityType: "pasture_photo_estimate", entityId: estimate.id, details: { proposed: estimate.cover, saved: typed, readingId: reading.rows[0].id } });
  return (await loadEstimates(tx, "e.id = $1", [estimate.id]))[0];
}

/** Keeps the estimate beside the photo's reading (or the day's measured one) for comparison; no reading is made. */
export async function compareEstimate(tx: OrgTx, idInput: unknown): Promise<PhotoEstimate> {
  const estimate = await lockWaiting(tx, idInput);
  await tx.query("update pasture_photo_estimates set status = 'compared', decided_by_email = $2 where id = $1", [estimate.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.pasture_estimate_compared", entityType: "pasture_photo_estimate", entityId: estimate.id, details: {} });
  return (await loadEstimates(tx, "e.id = $1", [estimate.id]))[0];
}

/** Declines an estimate (the wrong paddock, a poor photo): it's kept, and left out of the comparison. */
export async function declineEstimate(tx: OrgTx, idInput: unknown, input: { reason?: unknown } = {}): Promise<PhotoEstimate> {
  const estimate = await lockWaiting(tx, idInput);
  const reason = optionalString(input.reason, "Reason", { maxLength: 500 });
  await tx.query("update pasture_photo_estimates set status = 'declined', decided_by_email = $2, decline_reason = $3 where id = $1", [estimate.id, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "farming.pasture_estimate_declined", entityType: "pasture_photo_estimate", entityId: estimate.id, details: { reason } });
  return (await loadEstimates(tx, "e.id = $1", [estimate.id]))[0];
}

// Calibration (decision 1166) --------------------------------------------------------------------------

export type PhotoCalibration = {
  windowDays: number;
  from: string;
  to: string;
  /** Estimates in the period (not declined), whether or not anything was close enough to compare. */
  estimates: number;
  groups: Array<Omit<CalibrationGroup, "pairs"> & { text: string; pairs: Array<CalibrationGroup["pairs"][number] & { paddockName: string }> }>;
};

/**
 * How far the farm's photo estimates (the AI's own figure, before any
 * change; declined ones left out) were from other readings of the same
 * paddock within `windowDays`, over the year to today, by method.
 */
export async function photoCalibration(tx: OrgTx, input: { farmId: unknown; windowDays?: unknown }): Promise<PhotoCalibration> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const windowDays = parseCalibrationWindow(input.windowDays);
  if (windowDays === null) throw new ValidationError("The window must be a whole number of days from 0 to 14.");
  const to = todayIsoDate();
  const from = isoDateAt(new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86_400_000), "UTC");
  const estimates = await tx.query<{ id: string; paddock_id: string; taken_on: string; cover: number }>(
    `select e.id::text, e.paddock_id::text, p.taken_on::text, e.cover from pasture_photo_estimates e join pasture_photos p on p.id = e.photo_id
      where e.farm_id = $1 and e.status <> 'declined' and p.status = 'active' and p.taken_on between $2 and $3`,
    [farmId, from, to],
  );
  const readings = await tx.query<{ id: string; paddock_id: string; measured_on: string; cover: number; method: PastureMethod }>(
    `select id::text, paddock_id::text, measured_on::text, cover, method from pasture_readings
      where farm_id = $1 and status = 'active' and method <> $4 and measured_on between ($2::date - 14) and ($3::date + 14)`,
    [farmId, from, to, PHOTO_ESTIMATE_METHOD],
  );
  const names = new Map((await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1", [farmId])).rows.map((row) => [row.id, row.name]));
  const groups = calibrationSummary(
    estimates.rows.map((row) => ({ id: row.id, paddockId: row.paddock_id, takenOn: row.taken_on, cover: row.cover })),
    readings.rows.map((row) => ({ id: row.id, paddockId: row.paddock_id, measuredOn: row.measured_on, cover: row.cover, method: row.method })),
    windowDays,
  );
  return {
    windowDays,
    from,
    to,
    estimates: estimates.rows.length,
    groups: groups.map((group) => ({ ...group, text: calibrationText(group, windowDays), pairs: group.pairs.map((pair) => ({ ...pair, paddockName: names.get(pair.paddockId) ?? "" })) })),
  };
}
