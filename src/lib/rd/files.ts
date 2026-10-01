import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { checkAttachment } from "@/lib/records/file-types";
import { iso, requireUuid, writeHistory } from "@/lib/rd/common";
import { requireId, requireIdempotencyKey, requireOneOf } from "@/lib/validation";

/**
 * Files on R&D records (decision 45): approval letters, contractors'
 * statements, depreciation workings, floor plans. They're kept for 7 years
 * after the end of the income year, so a file can be replaced (the old one
 * stays, with who replaced it and when) but never deleted.
 */

export const RD_FILE_RECORD_TYPES = ["activity", "approval", "tag", "asset"] as const;
export type RdFileRecordType = (typeof RD_FILE_RECORD_TYPES)[number];
export const RD_FILE_PURPOSES = ["approval_letter", "contractor_statement", "workings", "other"] as const;
export type RdFilePurpose = (typeof RD_FILE_PURPOSES)[number];

export type RdFileVersion = {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  createdByEmail: string;
};

export type RdFile = RdFileVersion & {
  recordType: RdFileRecordType;
  recordId: string;
  purpose: RdFilePurpose;
  /** Earlier versions this one replaced, newest first. */
  replaced: RdFileVersion[];
};

type FileRow = {
  id: string;
  record_type: RdFileRecordType;
  record_id: string;
  purpose: RdFilePurpose;
  file_name: string;
  content_type: string;
  byte_size: number;
  replaces_id: string | null;
  created_at: Date;
  created_by_email: string;
};

const FILE_COLUMNS = "id, record_type, record_id, purpose, file_name, content_type, byte_size, replaces_id, created_at, created_by_email";

function version(row: FileRow): RdFileVersion {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: iso(row.created_at),
    createdByEmail: row.created_by_email,
  };
}

/** The record a file is on, checked to exist; returns its id as stored. */
export async function requireFileRecord(tx: OrgTx, recordTypeInput: unknown, recordIdInput: unknown): Promise<{ recordType: RdFileRecordType; recordId: string }> {
  const recordType = requireOneOf(recordTypeInput, "recordType", RD_FILE_RECORD_TYPES);
  if (recordType === "asset") {
    const recordId = requireId(recordIdInput, "recordId");
    const found = await tx.query("select 1 from fixed_assets where id = $1", [recordId]);
    if (!found.rows[0]) throw new NotFoundError("Fixed asset not found.");
    return { recordType, recordId };
  }
  const recordId = requireUuid(recordIdInput, "recordId");
  const table = { activity: "rd_activities", approval: "rd_approvals", tag: "rd_tags" }[recordType];
  const found = await tx.query(`select 1 from ${table} where id = $1`, [recordId]);
  if (!found.rows[0]) throw new NotFoundError(`That R&D ${recordType} doesn't exist.`);
  return { recordType, recordId };
}

/** Stores a checked file. The caller has checked the record and the key isn't used. */
export async function insertRdFile(
  tx: OrgTx,
  input: {
    idempotencyKey: string;
    hash: string;
    recordType: RdFileRecordType;
    recordId: string;
    purpose: RdFilePurpose;
    fileName: string;
    content: Uint8Array;
    replacesId: string | null;
  },
): Promise<string> {
  const checked = checkAttachment(input.fileName, input.content);
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const inserted = await tx.query<{ id: string }>(
    `insert into rd_files (idempotency_key, request_hash, record_type, record_id, purpose, file_name, content_type, byte_size, sha256, content,
                           replaces_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
    [
      input.idempotencyKey,
      input.hash,
      input.recordType,
      input.recordId,
      input.purpose,
      checked.fileName,
      checked.contentType,
      input.content.length,
      sha256,
      Buffer.from(input.content),
      input.replacesId,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const id = inserted.rows[0].id;
  await writeHistory(tx, "file", id, input.replacesId ? "replaced" : "created", {
    recordType: input.recordType,
    recordId: input.recordId,
    purpose: input.purpose,
    fileName: checked.fileName,
    contentType: checked.contentType,
    byteSize: input.content.length,
    sha256,
    replacesId: input.replacesId,
  });
  return id;
}

function fileHash(input: { recordType: string; recordId: string; purpose: string; fileName: string; content: Uint8Array; replacesId: string | null }): string {
  return requestHash("rd_file", {
    recordType: input.recordType,
    recordId: input.recordId,
    purpose: input.purpose,
    fileName: input.fileName,
    sha256: createHash("sha256").update(input.content).digest("hex"),
    replacesId: input.replacesId,
  });
}

async function existingByKey(tx: OrgTx, idempotencyKey: string): Promise<{ id: string; request_hash: string } | undefined> {
  return (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_files where idempotency_key = $1", [idempotencyKey])).rows[0];
}

/** Attaches a file to an R&D record or a fixed asset (bookkeepers and above). */
export async function addRdFile(
  tx: OrgTx,
  input: { idempotencyKey: unknown; recordType: unknown; recordId: unknown; purpose: unknown; fileName: string; content: Uint8Array },
): Promise<{ created: boolean; file: RdFile }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const { recordType, recordId } = await requireFileRecord(tx, input.recordType, input.recordId);
  const purpose = requireOneOf(input.purpose ?? "other", "purpose", RD_FILE_PURPOSES);
  if (purpose === "approval_letter" && recordType !== "approval") throw new ValidationError("An approval letter goes on an approval.");
  const hash = fileHash({ recordType, recordId, purpose, fileName: input.fileName, content: input.content, replacesId: null });
  const existing = await existingByKey(tx, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "file");
    return { created: false, file: await getRdFile(tx, existing.id) };
  }
  const id = await insertRdFile(tx, { idempotencyKey, hash, recordType, recordId, purpose, fileName: input.fileName, content: input.content, replacesId: null });
  await writeAuditEvent(tx, { eventType: "rd.file_added", entityType: "rd_file", entityId: id, details: { recordType, recordId, purpose } });
  return { created: true, file: await getRdFile(tx, id) };
}

/**
 * Replaces a file with a new version; the old one is kept and listed with
 * who replaced it and when (decision 45). Only the latest version can be
 * replaced.
 */
export async function replaceRdFile(
  tx: OrgTx,
  fileIdInput: unknown,
  input: { idempotencyKey: unknown; fileName: string; content: Uint8Array },
): Promise<{ created: boolean; file: RdFile }> {
  const fileId = requireUuid(fileIdInput, "fileId");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const old = (await tx.query<FileRow>(`select ${FILE_COLUMNS} from rd_files where id = $1 for update`, [fileId])).rows[0];
  if (!old) throw new NotFoundError("File not found.");
  const hash = fileHash({ recordType: old.record_type, recordId: old.record_id, purpose: old.purpose, fileName: input.fileName, content: input.content, replacesId: fileId });
  const existing = await existingByKey(tx, idempotencyKey);
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "file");
    return { created: false, file: await getRdFile(tx, existing.id) };
  }
  const newer = await tx.query("select 1 from rd_files where replaces_id = $1", [fileId]);
  if (newer.rows[0]) throw new ConflictError("That file has already been replaced; replace the latest version instead.");
  const id = await insertRdFile(tx, {
    idempotencyKey,
    hash,
    recordType: old.record_type,
    recordId: old.record_id,
    purpose: old.purpose,
    fileName: input.fileName,
    content: input.content,
    replacesId: fileId,
  });
  await writeAuditEvent(tx, { eventType: "rd.file_replaced", entityType: "rd_file", entityId: id, details: { replacesId: fileId } });
  return { created: true, file: await getRdFile(tx, id) };
}

/** A file with the versions it replaced. */
export async function getRdFile(tx: OrgTx, fileId: string): Promise<RdFile> {
  const files = await loadFiles(tx, "id = $1", [fileId]);
  if (!files[0]) throw new NotFoundError("File not found.");
  return files[0];
}

/** The current files on a record (each with the versions it replaced). */
export async function listRdFiles(tx: OrgTx, recordType: RdFileRecordType, recordIds: string[]): Promise<RdFile[]> {
  if (recordIds.length === 0) return [];
  return loadFiles(tx, "record_type = $1 and record_id = any($2::text[]) and not exists (select 1 from rd_files n where n.replaces_id = f.id)", [recordType, recordIds]);
}

async function loadFiles(tx: OrgTx, where: string, params: unknown[]): Promise<RdFile[]> {
  const current = await tx.query<FileRow>(`select ${FILE_COLUMNS} from rd_files f where ${where} order by created_at, id`, params);
  if (current.rows.length === 0) return [];
  // Each file's chain of earlier versions.
  const chains = await tx.query<FileRow & { head: string }>(
    `with recursive chain as (
       select f.id as head, f.replaces_id as id from rd_files f where f.id = any($1::uuid[]) and f.replaces_id is not null
       union all
       select chain.head, p.replaces_id from chain join rd_files p on p.id = chain.id where p.replaces_id is not null
     )
     select chain.head, ${FILE_COLUMNS.split(", ").map((column) => `o.${column}`).join(", ")}
       from chain join rd_files o on o.id = chain.id
      order by o.created_at desc, o.id desc`,
    [current.rows.map((row) => row.id)],
  );
  return current.rows.map((row) => ({
    ...version(row),
    recordType: row.record_type,
    recordId: row.record_id,
    purpose: row.purpose,
    replaced: chains.rows.filter((old) => old.head === row.id).map(version),
  }));
}

/** A file's content, for downloading (viewers and above). Replaced versions can be downloaded too. */
export async function getRdFileContent(tx: OrgTx, fileIdInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const fileId = requireUuid(fileIdInput, "fileId");
  const row = (await tx.query<{ file_name: string; content_type: string; content: Buffer }>("select file_name, content_type, content from rd_files where id = $1", [fileId])).rows[0];
  if (!row) throw new NotFoundError("File not found.");
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}
