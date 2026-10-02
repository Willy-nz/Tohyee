import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { checkAttachment, formatFileSize, MAX_ATTACHMENTS_PER_RECORD } from "@/lib/records/file-types";
import {
  type RecordAttachment,
  type RecordExtras,
  type RecordHistoryEntry,
  type RecordNote,
  type RecordType,
  recordTypeFromSlug,
} from "@/lib/records/types";
import { optionalSource, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Notes, files and the history of journals, sales invoices, bills, credit
 * notes, supplier credit notes and contacts (examples NF1-NF14). Nothing here
 * posts to the ledger or changes a document. Every change is written to the
 * append-only audit log, which is where the history comes from.
 */

const MAX_NOTE_LENGTH = 5000;

const RECORD_TABLES: Record<RecordType, { table: string; label: string }> = {
  ledger_journal: { table: "ledger_journals", label: "Journal" },
  sales_invoice: { table: "sales_invoices", label: "Invoice" },
  bill: { table: "bills", label: "Bill" },
  sales_credit_note: { table: "sales_credit_notes", label: "Credit note" },
  supplier_credit_note: { table: "supplier_credit_notes", label: "Supplier credit note" },
  contact: { table: "contacts", label: "Contact" },
  expense_claim: { table: "expense_claims", label: "Expense claim" },
  fixed_asset: { table: "fixed_assets", label: "Fixed asset" },
};

/**
 * Audit events on things attached to a record (payments, credit applied,
 * refunds, corrections) that belong in its history, matched on a detail.
 */
const RELATED_EVENTS: Record<RecordType, { entityTypes: string[]; detailKeys: string[] } | null> = {
  sales_invoice: {
    entityTypes: ["customer_payment", "sales_credit_note_application", "customer_overpayment_application"],
    detailKeys: ["invoiceId"],
  },
  bill: { entityTypes: ["supplier_payment", "supplier_credit_note_application"], detailKeys: ["billId"] },
  sales_credit_note: {
    entityTypes: ["sales_credit_note_application", "sales_credit_note_refund"],
    detailKeys: ["creditNoteId"],
  },
  supplier_credit_note: {
    entityTypes: ["supplier_credit_note_application", "supplier_credit_note_refund"],
    detailKeys: ["creditNoteId"],
  },
  ledger_journal: { entityTypes: ["ledger_journal"], detailKeys: ["reversalJournalId", "replacementJournalId"] },
  contact: null,
  expense_claim: { entityTypes: ["expense_claim_payment"], detailKeys: ["claimId"] },
  fixed_asset: null,
};

/** The record type named in a URL (e.g. "invoice"), and the record's id, which must exist (NF14). */
export async function resolveRecord(
  tx: OrgTx,
  slugInput: unknown,
  recordIdInput: unknown,
): Promise<{ recordType: RecordType; recordId: string }> {
  const recordType = typeof slugInput === "string" ? recordTypeFromSlug(slugInput) : null;
  if (!recordType) {
    throw new ValidationError("Notes and files can only be added to journals, invoices, bills, credit notes, supplier credit notes, contacts, expense claims and fixed assets.");
  }
  const recordId = requireId(recordIdInput, "recordId");
  const { table, label } = RECORD_TABLES[recordType];
  const found = await tx.query(`select 1 from ${table} where id = $1`, [recordId]);
  if (found.rowCount === 0) {
    throw new NotFoundError(`${label} not found.`);
  }
  return { recordType, recordId };
}

function requireNoteBody(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ValidationError("A note can't be empty.");
  }
  const body = input.trim();
  if (body.length > MAX_NOTE_LENGTH) {
    throw new ValidationError(`A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en-NZ")} characters (this one is ${body.length.toLocaleString("en-NZ")}).`);
  }
  return body;
}

type NoteRow = {
  id: string;
  request_hash: string;
  body: string;
  version: number;
  created_by_user_id: string | null;
  created_by_email: string;
  created_at: string;
  updated_by_email: string | null;
  updated_at: string | null;
  deleted_at: string | null;
};

type AttachmentRow = {
  id: string;
  request_hash: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  created_by_user_id: string | null;
  created_by_email: string;
  created_at: string;
  removed_at: string | null;
};

const NOTE_COLUMNS = `id::text, request_hash, body, version, created_by_user_id::text, created_by_email, created_at,
  updated_by_email, updated_at, deleted_at`;
const ATTACHMENT_COLUMNS = `id::text, request_hash, file_name, content_type, byte_size, sha256, created_by_user_id::text,
  created_by_email, created_at, removed_at`;

/** Whether the signed-in person wrote the note or added the file. */
function isAuthor(tx: OrgTx, row: { created_by_user_id: string | null; created_by_email: string }): boolean {
  if (row.created_by_user_id && tx.actor.userId) return row.created_by_user_id === tx.actor.userId;
  return row.created_by_email.toLowerCase() === tx.actor.email.toLowerCase();
}

function canChange(tx: OrgTx, role: Role, row: { created_by_user_id: string | null; created_by_email: string }): boolean {
  return roleAtLeast(role, "admin") || (roleAtLeast(role, "bookkeeper") && isAuthor(tx, row));
}

function toNote(tx: OrgTx, role: Role, row: NoteRow): RecordNote {
  return {
    id: row.id,
    body: row.body,
    version: row.version,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
    canChange: canChange(tx, role, row),
  };
}

function toAttachment(tx: OrgTx, role: Role, row: AttachmentRow): RecordAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    canRemove: canChange(tx, role, row),
  };
}

// ---------------------------------------------------------------- history

const EVENT_WORDS: Record<string, string> = {
  created: "created",
  updated: "edited",
  approved: "approved",
  voided: "voided",
  deleted: "deleted",
  archived: "archived",
  unarchived: "unarchived",
  recorded: "recorded",
  applied: "applied",
  application_removed: "application removed",
  refunded: "refunded",
  refund_voided: "refund voided",
  journal_posted: "journal posted",
  journal_corrected: "journal corrected",
};

const SUBJECTS: Record<string, string> = {
  invoice: "Invoice",
  bill: "Bill",
  credit_note: "Credit note",
  supplier_credit_note: "Supplier credit note",
  contact: "Contact",
  customer_payment: "Payment",
  supplier_payment: "Payment",
  overpayment: "Overpayment",
  ledger: "Ledger",
};

function text(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function addresses(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : (text(value) ?? "");
}

/** A plain-English line for an audit event (NF11). */
function summarise(eventType: string, details: Record<string, unknown>): string {
  switch (eventType) {
    case "note.added":
      return "Note added";
    case "note.edited":
      return "Note edited";
    case "note.deleted":
      return "Note deleted";
    case "attachment.added":
      return `File added: ${text(details.fileName) ?? "file"} (${formatFileSize(Number(details.byteSize ?? 0))})`;
    case "attachment.removed":
      return `File removed: ${text(details.fileName) ?? "file"} (${formatFileSize(Number(details.byteSize ?? 0))})`;
    case "credit_note.applied":
    case "supplier_credit_note.applied":
    {
      const from = text(details.creditNoteNumber) ?? text(details.supplierCreditNoteNumber);
      return `Credit applied: ${text(details.amount) ?? ""}${from ? ` from ${from}` : ""}`.trim();
    }
    case "overpayment.applied":
      return `Overpayment applied: ${text(details.amount) ?? ""}`.trim();
    case "ledger.journal_corrected":
      return text(details.reversalJournalId)
        ? `Journal corrected (reversal #${text(details.reversalJournalId)}${text(details.replacementJournalId) ? `, replacement #${text(details.replacementJournalId)}` : ""})`
        : "Journal corrected";
    case "ledger.journal_posted":
      return "Journal posted";
    case "document_email.queued":
      return `Email to ${addresses(details.to)} asked for: "${text(details.subject) ?? ""}"`;
    case "document_email.sent": {
      const cc = addresses(details.cc);
      return `Emailed to ${addresses(details.to)}${cc ? ` (cc ${cc})` : ""} with ${text(details.attachmentName) ?? "the PDF"}; the email server accepted it (message id ${text(details.messageId) ?? "unknown"})`;
    }
    case "document_email.retrying":
      return `Email to ${addresses(details.to)} not sent yet (attempt ${text(details.attempt) ?? "1"}), trying again: ${text(details.error) ?? ""}`;
    case "document_email.failed":
      return `Email to ${addresses(details.to)} failed: ${text(details.error) ?? ""}`;
    default: {
      const [subject, action] = eventType.split(".");
      const who = SUBJECTS[subject] ?? subject.replace(/_/g, " ");
      const what = EVENT_WORDS[action] ?? (action ?? "").replace(/_/g, " ");
      const amount = text(details.amount);
      const line = `${who.charAt(0).toUpperCase()}${who.slice(1)} ${what}`.trim();
      return amount && /recorded|refunded|voided|removed/.test(what) && subject !== "invoice" && subject !== "bill"
        ? `${line}: ${amount}`
        : line;
    }
  }
}

async function historyFor(tx: OrgTx, recordType: RecordType, recordId: string): Promise<RecordHistoryEntry[]> {
  const related = RELATED_EVENTS[recordType];
  const params: unknown[] = [recordType, recordId];
  let relatedSql = "";
  if (related) {
    params.push(related.entityTypes, related.detailKeys);
    relatedSql = `or (entity_type = any($3::text[])
                      and exists (select 1 from unnest($4::text[]) as detail_key where details->>detail_key = $2))`;
  }
  const result = await tx.query<{
    id: string;
    event_type: string;
    actor_email: string | null;
    details: Record<string, unknown>;
    created_at: string;
  }>(
    `select id::text, event_type, actor_email, details, created_at
       from audit_events
      where (entity_type = $1 and entity_id = $2)
         or (entity_type in ('record_note', 'record_attachment')
             and details->>'recordType' = $1 and details->>'recordId' = $2)
         ${relatedSql}
      order by created_at, id`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    at: row.created_at,
    actorEmail: row.actor_email,
    via: typeof row.details?.via === "string" ? row.details.via : null,
    eventType: row.event_type,
    summary: summarise(row.event_type, row.details ?? {}),
    noteBefore: text(row.details?.before),
    noteAfter: text(row.details?.after),
  }));
}

// ---------------------------------------------------------------- reading

/** A record's notes, files and history. */
export async function getRecordExtras(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
): Promise<RecordExtras> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const notes = await tx.query<NoteRow>(
    `select ${NOTE_COLUMNS} from record_notes
      where record_type = $1 and record_id = $2 and deleted_at is null order by id`,
    [recordType, recordId],
  );
  const attachments = await tx.query<AttachmentRow>(
    `select ${ATTACHMENT_COLUMNS} from record_attachments
      where record_type = $1 and record_id = $2 and removed_at is null order by id`,
    [recordType, recordId],
  );
  return {
    recordType,
    recordId,
    notes: notes.rows.map((row) => toNote(tx, role, row)),
    attachments: attachments.rows.map((row) => toAttachment(tx, role, row)),
    history: await historyFor(tx, recordType, recordId),
    canAdd: roleAtLeast(role, "bookkeeper"),
  };
}

// ---------------------------------------------------------------- notes

/** Adds a note (NF1-NF3). Idempotent. */
export async function addNote(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; body: unknown },
): Promise<{ created: boolean; note: RecordNote }> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const body = requireNoteBody(input.body);
  const hash = requestHash("record_note", { recordType, recordId, body });
  const earlier = await tx.query<NoteRow>(
    `select ${NOTE_COLUMNS} from record_notes where command_source = $1 and idempotency_key = $2`,
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "note");
    return { created: false, note: toNote(tx, role, earlier.rows[0]) };
  }
  const inserted = await tx.query<NoteRow>(
    `insert into record_notes (command_source, idempotency_key, request_hash, record_type, record_id, body,
                               created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${NOTE_COLUMNS}`,
    [source, idempotencyKey, hash, recordType, recordId, body, tx.actor.userId, tx.actor.email],
  );
  const note = inserted.rows[0];
  await writeAuditEvent(tx, {
    eventType: "note.added",
    entityType: "record_note",
    entityId: note.id,
    details: { recordType, recordId, after: body },
  });
  return { created: true, note: toNote(tx, role, note) };
}

async function lockNote(tx: OrgTx, recordType: RecordType, recordId: string, noteIdInput: unknown): Promise<NoteRow> {
  const noteId = requireId(noteIdInput, "noteId");
  const result = await tx.query<NoteRow>(
    `select ${NOTE_COLUMNS} from record_notes
      where id = $1 and record_type = $2 and record_id = $3 and deleted_at is null for update`,
    [noteId, recordType, recordId],
  );
  if (!result.rows[0]) {
    throw new NotFoundError("Note not found.");
  }
  return result.rows[0];
}

function checkChange(tx: OrgTx, role: Role, note: NoteRow, versionInput: unknown): void {
  if (!canChange(tx, role, note)) {
    throw new ForbiddenError("Only the person who wrote a note, or an admin, can change it.");
  }
  if (typeof versionInput !== "number" || versionInput !== note.version) {
    throw new ConflictError("This note was changed by someone else. Reload and try again.");
  }
}

/** Edits a note (NF4, NF5). The old text goes to the history. */
export async function editNote(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
  noteIdInput: unknown,
  input: { body: unknown; version: unknown },
): Promise<{ note: RecordNote }> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const note = await lockNote(tx, recordType, recordId, noteIdInput);
  checkChange(tx, role, note, input.version);
  const body = requireNoteBody(input.body);
  if (body === note.body) {
    return { note: toNote(tx, role, note) };
  }
  const updated = await tx.query<NoteRow>(
    `update record_notes set body = $2, version = version + 1, updated_by_email = $3, updated_at = now()
      where id = $1 returning ${NOTE_COLUMNS}`,
    [note.id, body, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "note.edited",
    entityType: "record_note",
    entityId: note.id,
    details: { recordType, recordId, before: note.body, after: body },
  });
  return { note: toNote(tx, role, updated.rows[0]) };
}

/** Deletes a note (NF5, NF6). Its text stays in the history. */
export async function deleteNote(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
  noteIdInput: unknown,
  input: { version: unknown },
): Promise<void> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const note = await lockNote(tx, recordType, recordId, noteIdInput);
  checkChange(tx, role, note, input.version);
  await tx.query(
    `update record_notes set version = version + 1, deleted_by_email = $2, deleted_at = now() where id = $1`,
    [note.id, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "note.deleted",
    entityType: "record_note",
    entityId: note.id,
    details: { recordType, recordId, before: note.body },
  });
}

// ---------------------------------------------------------------- files

/** Attaches a file (NF7-NF9). Idempotent. */
export async function addAttachment(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
  input: { source?: unknown; idempotencyKey: unknown; fileName: unknown; content: Uint8Array },
): Promise<{ created: boolean; attachment: RecordAttachment }> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (typeof input.fileName !== "string") {
    throw new ValidationError("Choose a file to attach.");
  }
  const { fileName, contentType } = checkAttachment(input.fileName, input.content);
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const hash = requestHash("record_attachment", { recordType, recordId, fileName, sha256 });
  const earlier = await tx.query<AttachmentRow>(
    `select ${ATTACHMENT_COLUMNS} from record_attachments where command_source = $1 and idempotency_key = $2`,
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "file");
    return { created: false, attachment: toAttachment(tx, role, earlier.rows[0]) };
  }
  // One upload per record at a time, so two can't both take the 100th slot.
  await tx.query("select pg_advisory_xact_lock(hashtext('record_attachments:' || $1 || ':' || $2))", [recordType, recordId]);
  const count = await tx.query<{ count: number }>(
    `select count(*)::integer as count from record_attachments
      where record_type = $1 and record_id = $2 and removed_at is null`,
    [recordType, recordId],
  );
  if (count.rows[0].count >= MAX_ATTACHMENTS_PER_RECORD) {
    throw new ValidationError(`A record can have at most ${MAX_ATTACHMENTS_PER_RECORD} files. Remove one first.`);
  }
  const inserted = await tx.query<AttachmentRow>(
    `insert into record_attachments (command_source, idempotency_key, request_hash, record_type, record_id, file_name,
                                     content_type, byte_size, sha256, content, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning ${ATTACHMENT_COLUMNS}`,
    [
      source,
      idempotencyKey,
      hash,
      recordType,
      recordId,
      fileName,
      contentType,
      input.content.length,
      sha256,
      Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength),
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  const attachment = inserted.rows[0];
  await writeAuditEvent(tx, {
    eventType: "attachment.added",
    entityType: "record_attachment",
    entityId: attachment.id,
    details: { recordType, recordId, fileName, contentType, byteSize: attachment.byte_size, sha256 },
  });
  return { created: true, attachment: toAttachment(tx, role, attachment) };
}

/** A file's contents, to download (NF7). Removed files have none (NF10). */
export async function getAttachmentContent(
  tx: OrgTx,
  slugInput: unknown,
  recordIdInput: unknown,
  attachmentIdInput: unknown,
): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const attachmentId = requireId(attachmentIdInput, "attachmentId");
  const result = await tx.query<{ file_name: string; content_type: string; content: Buffer }>(
    `select file_name, content_type, content from record_attachments
      where id = $1 and record_type = $2 and record_id = $3 and removed_at is null`,
    [attachmentId, recordType, recordId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("File not found. It may have been removed.");
  }
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}

async function removeAttachmentRow(tx: OrgTx, recordType: RecordType, recordId: string, row: AttachmentRow): Promise<void> {
  await tx.query(
    `update record_attachments set content = null, removed_by_email = $2, removed_at = now() where id = $1`,
    [row.id, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "attachment.removed",
    entityType: "record_attachment",
    entityId: row.id,
    details: { recordType, recordId, fileName: row.file_name, byteSize: row.byte_size, sha256: row.sha256 },
  });
}

/** Removes a file (NF10): its contents are deleted; the history keeps its name and size. */
export async function removeAttachment(
  tx: OrgTx,
  role: Role,
  slugInput: unknown,
  recordIdInput: unknown,
  attachmentIdInput: unknown,
): Promise<void> {
  const { recordType, recordId } = await resolveRecord(tx, slugInput, recordIdInput);
  const attachmentId = requireId(attachmentIdInput, "attachmentId");
  const result = await tx.query<AttachmentRow>(
    `select ${ATTACHMENT_COLUMNS} from record_attachments
      where id = $1 and record_type = $2 and record_id = $3 and removed_at is null for update`,
    [attachmentId, recordType, recordId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("File not found. It may have been removed already.");
  }
  if (!canChange(tx, role, row)) {
    throw new ForbiddenError("Only the person who added a file, or an admin, can remove it.");
  }
  await removeAttachmentRow(tx, recordType, recordId, row);
}

/**
 * Deletes a record's notes and its files' contents, when a draft is deleted
 * (NF12). Called by the draft delete commands, in their transaction.
 */
export async function removeRecordExtras(tx: OrgTx, recordType: RecordType, recordId: string): Promise<void> {
  const notes = await tx.query<NoteRow>(
    `select ${NOTE_COLUMNS} from record_notes where record_type = $1 and record_id = $2 and deleted_at is null for update`,
    [recordType, recordId],
  );
  for (const note of notes.rows) {
    await tx.query(`update record_notes set version = version + 1, deleted_by_email = $2, deleted_at = now() where id = $1`, [
      note.id,
      tx.actor.email,
    ]);
    await writeAuditEvent(tx, {
      eventType: "note.deleted",
      entityType: "record_note",
      entityId: note.id,
      details: { recordType, recordId, before: note.body, reason: "draft deleted" },
    });
  }
  const attachments = await tx.query<AttachmentRow>(
    `select ${ATTACHMENT_COLUMNS} from record_attachments
      where record_type = $1 and record_id = $2 and removed_at is null for update`,
    [recordType, recordId],
  );
  for (const row of attachments.rows) {
    await removeAttachmentRow(tx, recordType, recordId, row);
  }
}
