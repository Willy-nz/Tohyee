import type { OrgTx } from "@/lib/db/org-transaction";
import type { SyncDocumentType, SyncLogAction, SyncLogEntry, SyncRecordKind } from "@/lib/sales-platforms/types";

/** A line for the sync log (SPC1-SPC23). */
export type LogInput = {
  source: SyncLogEntry["source"];
  action: SyncLogAction;
  message: string;
  recordKind?: SyncRecordKind | null;
  externalId?: string | null;
  contactId?: string | null;
  itemId?: string | null;
  documentType?: SyncDocumentType | null;
  documentId?: string | null;
};

/** Lines that say a record is still in the same state: not repeated while nothing changes. */
const REPEATABLE: ReadonlySet<SyncLogAction> = new Set(["skipped", "failed", "kept", "waiting"]);

/**
 * Adds a line to the sync log. A skipped, failed or waiting record whose
 * last line says the same thing isn't logged again, so the catch-up sync
 * doesn't fill the log with the same line every 15 minutes (SPC4, SPC23).
 * Returns whether a line was added.
 */
export async function writeLog(tx: OrgTx, connectionId: string, entry: LogInput): Promise<boolean> {
  const message = entry.message.length > 1000 ? `${entry.message.slice(0, 997)}...` : entry.message;
  if (REPEATABLE.has(entry.action) && entry.externalId) {
    const last = await tx.query<{ action: string; message: string }>(
      `select action, message from sales_platform_sync_log
        where connection_id = $1 and record_kind is not distinct from $2 and external_id = $3
        order by id desc limit 1`,
      [connectionId, entry.recordKind ?? null, entry.externalId],
    );
    if (last.rows[0]?.action === entry.action && last.rows[0].message === message) return false;
  }
  await tx.query(
    `insert into sales_platform_sync_log (connection_id, source, action, record_kind, external_id, contact_id, item_id, document_type, document_id, message, actor_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      connectionId,
      entry.source,
      entry.action,
      entry.recordKind ?? null,
      entry.externalId ?? null,
      entry.contactId ?? null,
      entry.itemId ?? null,
      entry.documentType ?? null,
      entry.documentId ?? null,
      message,
      tx.actor.email,
    ],
  );
  return true;
}
