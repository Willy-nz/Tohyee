import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { Role } from "@/lib/auth/roles";
import { type Bill, type BillInput, createBill, getBill } from "@/lib/bills/service";
import type { ForeignOption } from "@/lib/invoices/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { addAttachment } from "@/lib/records/extras";
import { checkAttachment } from "@/lib/records/file-types";
import { optionalSource, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * The bills inbox (BI1-BI7, decisions 404-406): supplier bills and receipts
 * that have arrived but aren't bills yet, uploaded by hand, read from a
 * mailbox folder or label, or added by the organisation's connected AI.
 * Nothing here posts. An item waits until a bill is made from it (the file
 * is attached to the new draft) or someone removes it with a reason. Tohyee
 * reads no document itself: the person's own AI does, through its tools
 * (question 1).
 */

/** The kinds of file a bill can have (NF7): PDF and pictures. */
export const INBOX_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic"] as const;
const INBOX_FILE = /\.(pdf|jpe?g|png|heic|heif)$/i;

export function isInboxFileName(name: string): boolean {
  return INBOX_FILE.test(name);
}

export type InboxStatus = "waiting" | "made" | "removed";

export type InboxItem = {
  id: string;
  status: InboxStatus;
  source: "upload" | "mailbox" | "ai";
  fileName: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  emailFrom: string | null;
  emailSubject: string | null;
  emailDate: string | null;
  billId: string | null;
  billNumber: string | null;
  billStatus: Bill["status"] | null;
  billContactName: string | null;
  madeByEmail: string | null;
  madeVia: string | null;
  madeAt: string | null;
  removedAt: string | null;
  removedByEmail: string | null;
  removedReason: string | null;
  createdByEmail: string;
  createdVia: string | null;
  createdAt: string;
  /** The same file elsewhere (DU1): other inbox items and files on bills. */
  sameFile: { itemId: string | null; billId: string | null; billNumber: string | null; text: string }[];
};

type ItemRow = {
  id: string;
  source: InboxItem["source"];
  file_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  email_from: string | null;
  email_subject: string | null;
  email_date: string | null;
  bill_id: string | null;
  bill_number: string | null;
  bill_status: Bill["status"] | null;
  bill_contact_name: string | null;
  made_by_email: string | null;
  made_via: string | null;
  made_at: string | null;
  removed_at: string | null;
  removed_by_email: string | null;
  removed_reason: string | null;
  created_by_email: string;
  created_via: string | null;
  created_at: string;
};

const SELECT = `
  select i.id::text, i.source, i.file_name, i.content_type, i.byte_size, i.sha256, i.email_from, i.email_subject, i.email_date,
         i.bill_id::text, b.supplier_invoice_number as bill_number, b.status as bill_status, c.name as bill_contact_name,
         i.made_by_email, i.made_via, i.made_at, i.removed_at, i.removed_by_email, i.removed_reason, i.created_by_email,
         (select a.details->>'via' from audit_events a where a.entity_type = 'bill_inbox_item' and a.entity_id = i.id::text
           and a.event_type = 'bill_inbox_item.added' limit 1) as created_via,
         i.created_at
    from bill_inbox_items i
    left join bills b on b.id = i.bill_id
    left join contacts c on c.id = b.contact_id`;

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

function toItem(row: ItemRow, sameFile: InboxItem["sameFile"]): InboxItem {
  return {
    id: row.id,
    status: row.removed_at ? "removed" : row.bill_id ? "made" : "waiting",
    source: row.source,
    fileName: row.file_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    emailFrom: row.email_from,
    emailSubject: row.email_subject,
    emailDate: iso(row.email_date),
    billId: row.bill_id,
    billNumber: row.bill_number,
    billStatus: row.bill_status,
    billContactName: row.bill_contact_name,
    madeByEmail: row.made_by_email,
    madeVia: row.made_via,
    madeAt: iso(row.made_at),
    removedAt: iso(row.removed_at),
    removedByEmail: row.removed_by_email,
    removedReason: row.removed_reason,
    createdByEmail: row.created_by_email,
    createdVia: row.created_via,
    createdAt: iso(row.created_at)!,
    sameFile,
  };
}

function billWords(number: string | null, status: string | null, billId: string): string {
  if (status === "draft") return number ? `draft bill ${number}` : `a draft bill (#${billId})`;
  return `bill ${number ?? `#${billId}`}${status === "voided" ? " (voided)" : ""}`;
}

/** The same file elsewhere (DU1): earlier inbox items with the same contents, and bills it's attached to. */
async function sameFiles(tx: OrgTx, rows: readonly ItemRow[]): Promise<Map<string, InboxItem["sameFile"]>> {
  const result = new Map<string, InboxItem["sameFile"]>();
  if (rows.length === 0) return result;
  const hashes = [...new Set(rows.map((row) => row.sha256))];
  const items = await tx.query<{ id: string; sha256: string; bill_id: string | null; bill_number: string | null; bill_status: string | null; removed: boolean }>(
    `select i.id::text, i.sha256, i.bill_id::text, b.supplier_invoice_number as bill_number, b.status as bill_status, i.removed_at is not null as removed
       from bill_inbox_items i left join bills b on b.id = i.bill_id
      where i.sha256 = any($1::text[]) order by i.id`,
    [hashes],
  );
  const attached = await tx.query<{ sha256: string; bill_id: string; bill_number: string | null; bill_status: string }>(
    `select a.sha256, b.id::text as bill_id, b.supplier_invoice_number as bill_number, b.status as bill_status
       from record_attachments a join bills b on b.id = a.record_id
      where a.record_type = 'bill' and a.removed_at is null and a.sha256 = any($1::text[])
      order by b.id`,
    [hashes],
  );
  for (const row of rows) {
    const entries: InboxItem["sameFile"] = [];
    const billsSeen = new Set<string>(row.bill_id ? [row.bill_id] : []);
    for (const other of items.rows) {
      if (other.sha256 !== row.sha256 || other.id === row.id) continue;
      if (other.bill_id) billsSeen.add(other.bill_id);
      entries.push({
        itemId: other.id,
        billId: other.bill_id,
        billNumber: other.bill_number,
        text: `Same file as item ${other.id}${
          other.bill_id ? `, made into ${billWords(other.bill_number, other.bill_status, other.bill_id)}` : other.removed ? " (removed)" : " (waiting)"
        }`,
      });
    }
    for (const bill of attached.rows) {
      if (bill.sha256 !== row.sha256 || billsSeen.has(bill.bill_id)) continue;
      billsSeen.add(bill.bill_id);
      entries.push({
        itemId: null,
        billId: bill.bill_id,
        billNumber: bill.bill_number,
        text: `Same file as one attached to ${billWords(bill.bill_number, bill.bill_status, bill.bill_id)}`,
      });
    }
    result.set(row.id, entries);
  }
  return result;
}

async function withSameFiles(tx: OrgTx, rows: ItemRow[]): Promise<InboxItem[]> {
  const same = await sameFiles(tx, rows);
  return rows.map((row) => toItem(row, same.get(row.id) ?? []));
}

/** The inbox: waiting items oldest first, or made / removed / all newest first (BI1, BI7). */
export async function listInbox(tx: OrgTx, filters: { status?: unknown; limit?: unknown } = {}): Promise<InboxItem[]> {
  const status = filters.status == null || filters.status === "" ? "waiting" : String(filters.status);
  if (!["waiting", "made", "removed", "all"].includes(status)) throw new ValidationError("status must be waiting, made, removed or all.");
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  const where =
    status === "waiting"
      ? "i.bill_id is null and i.removed_at is null"
      : status === "made"
        ? "i.bill_id is not null"
        : status === "removed"
          ? "i.removed_at is not null"
          : "true";
  const found = await tx.query<ItemRow>(`${SELECT} where ${where} order by i.id ${status === "waiting" ? "" : "desc"} limit $1`, [limit]);
  return withSameFiles(tx, found.rows);
}

export async function getInboxItem(tx: OrgTx, idInput: unknown): Promise<InboxItem> {
  const id = requireId(idInput, "itemId");
  const found = await tx.query<ItemRow>(`${SELECT} where i.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Inbox item not found.");
  return (await withSameFiles(tx, found.rows))[0];
}

/** The item's file (BI4: the AI reads it with read_bill_inbox_item). A removed item has none. */
export async function getInboxItemContent(tx: OrgTx, idInput: unknown): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const id = requireId(idInput, "itemId");
  const found = await tx.query<{ file_name: string; content_type: string; content: Buffer | null }>(
    "select file_name, content_type, content from bill_inbox_items where id = $1",
    [id],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Inbox item not found.");
  if (!row.content) throw new NotFoundError("This item was removed, so its file is gone.");
  return { fileName: row.file_name, contentType: row.content_type, content: row.content };
}

/** Checks a file for the inbox: a PDF or picture (NF7), up to 10 MB, whose contents match its name. */
export function checkInboxFile(fileName: string, content: Uint8Array): { fileName: string; contentType: string } {
  const checked = checkAttachment(fileName, content);
  if (!(INBOX_CONTENT_TYPES as readonly string[]).includes(checked.contentType)) {
    throw new ValidationError(`${checked.fileName} can't go in the bills inbox: only PDF, JPG, PNG and HEIC files can.`);
  }
  return checked;
}

export type NewInboxItem = {
  source?: unknown;
  idempotencyKey: unknown;
  fileName: unknown;
  content: Uint8Array;
  /** How it arrived (BI1, BI2, BI4). */
  via: "upload" | "mailbox" | "ai";
  mailboxId?: string | null;
  emailFrom?: string | null;
  emailSubject?: string | null;
  emailDate?: string | null;
};

/** Adds a file to the inbox. Idempotent. Nothing is posted (BI1). */
export async function addInboxItem(tx: OrgTx, input: NewInboxItem): Promise<{ created: boolean; item: InboxItem }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (typeof input.fileName !== "string") throw new ValidationError("Choose a file.");
  const { fileName, contentType } = checkInboxFile(input.fileName, input.content);
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const hash = requestHash("bill_inbox_item", { fileName, sha256, via: input.via });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from bill_inbox_items where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "inbox file");
    return { created: false, item: await getInboxItem(tx, earlier.rows[0].id) };
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into bill_inbox_items (command_source, idempotency_key, request_hash, source, file_name, content_type, byte_size, sha256, content,
                                   mailbox_id, email_from, email_subject, email_date, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     on conflict (command_source, idempotency_key) do nothing
     returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      input.via,
      fileName,
      contentType,
      input.content.length,
      sha256,
      Buffer.from(input.content.buffer, input.content.byteOffset, input.content.byteLength),
      input.mailboxId ?? null,
      input.emailFrom?.slice(0, 500) ?? null,
      input.emailSubject?.slice(0, 1000) ?? null,
      input.emailDate ?? null,
      tx.actor.userId,
      tx.actor.email,
    ],
  );
  if (!inserted.rows[0]) throw new ConflictError("That file is being added by another request. Try again.");
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "bill_inbox_item.added",
    entityType: "bill_inbox_item",
    entityId: id,
    details: { fileName, contentType, byteSize: input.content.length, sha256, source: input.via },
  });
  return { created: true, item: await getInboxItem(tx, id) };
}

async function lockItem(tx: OrgTx, id: string): Promise<{ id: string; bill_id: string | null; removed_at: string | null; file_name: string; content: Buffer | null }> {
  const found = await tx.query<{ id: string; bill_id: string | null; removed_at: string | null; file_name: string; content: Buffer | null }>(
    "select id::text, bill_id::text, removed_at, file_name, content from bill_inbox_items where id = $1 for update",
    [id],
  );
  if (!found.rows[0]) throw new NotFoundError("Inbox item not found.");
  return found.rows[0];
}

/** Removes an item that isn't a bill, with a reason (BI6). Its file is dropped; the history keeps who, when and why. */
export async function removeInboxItem(tx: OrgTx, idInput: unknown, input: { reason?: unknown }): Promise<InboxItem> {
  const id = requireId(idInput, "itemId");
  const reason = requireString(input.reason, "The reason", { maxLength: 500 });
  const item = await lockItem(tx, id);
  if (item.removed_at) throw new ConflictError("This item has already been removed.");
  if (item.bill_id) throw new ConflictError("A bill was made from this item. Delete or void the bill instead.");
  await tx.query(
    "update bill_inbox_items set removed_at = now(), removed_by_email = $2, removed_reason = $3, content = null where id = $1",
    [id, tx.actor.email, reason],
  );
  await writeAuditEvent(tx, {
    eventType: "bill_inbox_item.removed",
    entityType: "bill_inbox_item",
    entityId: id,
    details: { fileName: item.file_name, reason },
  });
  return getInboxItem(tx, id);
}

/**
 * Makes a draft bill from a waiting item (BI3, BI4): the bill is saved as
 * any new draft is (the supplier's defaults fill what isn't given), the
 * item's file is attached to it, and the item is marked as used by it.
 * Idempotent with the bill's own key. Nothing is posted.
 */
export async function createBillFromInboxItem(
  tx: OrgTx,
  role: Role,
  itemIdInput: unknown,
  input: BillInput & { source?: unknown; idempotencyKey: unknown },
  foreign: ForeignOption = { foreignCurrency: true },
): Promise<{ created: boolean; bill: Bill; item: InboxItem }> {
  const itemId = requireId(itemIdInput, "inboxItemId");
  const item = await lockItem(tx, itemId);
  if (item.removed_at) throw new ConflictError("This inbox item was removed, so a bill can't be made from it.");
  const result = await createBill(tx, input, null, foreign);
  if (!result.created) {
    // A retry of the same request: the item already points at its bill.
    if (item.bill_id === result.bill.id) return { ...result, item: await getInboxItem(tx, itemId) };
  }
  if (item.bill_id) {
    const made = await getBill(tx, item.bill_id);
    throw new ConflictError(`This item was already made into ${billWords(made.supplierInvoiceNumber, made.status, made.id)}.`);
  }
  const bill = result.bill;
  await tx.query("update bill_inbox_items set bill_id = $2, made_by_email = $3, made_via = $4, made_at = now() where id = $1", [
    itemId,
    bill.id,
    tx.actor.email,
    tx.actor.via ?? null,
  ]);
  await addAttachment(tx, role, "bill", bill.id, {
    source: "inbox",
    idempotencyKey: `inbox-item-${itemId}-bill-${bill.id}`,
    fileName: item.file_name,
    content: item.content!,
  });
  await writeAuditEvent(tx, {
    eventType: "bill.made_from_inbox",
    entityType: "bill",
    entityId: bill.id,
    details: { inboxItemId: itemId, fileName: item.file_name },
  });
  await writeAuditEvent(tx, {
    eventType: "bill_inbox_item.made_into_bill",
    entityType: "bill_inbox_item",
    entityId: itemId,
    details: { billId: bill.id, supplierInvoiceNumber: bill.supplierInvoiceNumber },
  });
  return { created: result.created, bill: await getBill(tx, bill.id), item: await getInboxItem(tx, itemId) };
}

/** The inbox item a bill was made from, if any (shown on the bill). */
export async function inboxItemForBill(tx: OrgTx, billIdInput: unknown): Promise<{ id: string; fileName: string } | null> {
  const billId = requireId(billIdInput, "billId");
  const found = await tx.query<{ id: string; file_name: string }>("select id::text, file_name from bill_inbox_items where bill_id = $1", [billId]);
  return found.rows[0] ? { id: found.rows[0].id, fileName: found.rows[0].file_name } : null;
}
