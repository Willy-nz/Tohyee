import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { dec, isZero, toPlainString } from "@/lib/money/decimal";
import { requireId } from "@/lib/validation";

/**
 * Lossless line edits for AI tools (#537, decision 1263). A document's
 * lines are read with a `lineId` each, and an edit sends the new list of
 * lines in order: a line with a `lineId` keeps everything saved on it and
 * changes only the fields sent (null clears), a line without one is new,
 * and a saved line is only taken off when its `lineId` is in
 * `removeLineIds`. A saved line that's in neither is refused, with no
 * change, so an item, unit, tracking, custom field or order link is never
 * dropped by a line the AI didn't send back. The services still replace
 * the lines, so line ids change after each edit: the answer has the new
 * ones, and an old id is refused (someone else may have changed it).
 */

export type LineDocument =
  | "invoice"
  | "bill"
  | "quote"
  | "sales_order"
  | "purchase_order"
  | "credit_note"
  | "supplier_credit_note"
  | "repeating_invoice"
  | "repeating_bill";

const TABLES: Record<LineDocument, { parent: string; lines: string; parentColumn: string; noun: string }> = {
  invoice: { parent: "sales_invoices", lines: "sales_invoice_lines", parentColumn: "invoice_id", noun: "invoice" },
  bill: { parent: "bills", lines: "bill_lines", parentColumn: "bill_id", noun: "bill" },
  quote: { parent: "quotes", lines: "quote_lines", parentColumn: "quote_id", noun: "quote" },
  sales_order: { parent: "sales_orders", lines: "sales_order_lines", parentColumn: "sales_order_id", noun: "sales order" },
  purchase_order: { parent: "purchase_orders", lines: "purchase_order_lines", parentColumn: "purchase_order_id", noun: "purchase order" },
  credit_note: { parent: "sales_credit_notes", lines: "sales_credit_note_lines", parentColumn: "credit_note_id", noun: "credit note" },
  supplier_credit_note: { parent: "supplier_credit_notes", lines: "supplier_credit_note_lines", parentColumn: "credit_note_id", noun: "supplier credit note" },
  repeating_invoice: { parent: "repeating_invoices", lines: "repeating_invoice_lines", parentColumn: "repeating_invoice_id", noun: "repeating invoice" },
  repeating_bill: { parent: "repeating_bills", lines: "repeating_bill_lines", parentColumn: "repeating_bill_id", noun: "repeating bill" },
};

/** A saved line as the services return it. */
export type SavedLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  accountCode: string;
  taxCode: string | null;
  tracking?: Record<string, string>;
  customFields?: Record<string, unknown>;
  itemId: string | null;
  unitId: string | null;
  salesOrderLineId?: string | null;
  purchaseOrderLineId?: string | null;
};

/** The ids of a document's lines, in line order (the order the services return lines in). */
export async function lineIdsOf(tx: OrgTx, document: LineDocument, parentId: string): Promise<string[]> {
  const table = TABLES[document];
  const found = await tx.query<{ id: string }>(
    `select l.id::text as id from ${table.lines} l where l.${table.parentColumn} = $1 order by l.line_order, l.id`,
    [parentId],
  );
  return found.rows.map((row) => row.id);
}

/** Each line with its `lineId` first, for an AI to send back. */
export async function withLineIds<L extends object>(
  tx: OrgTx,
  document: LineDocument,
  parentId: string,
  lines: readonly L[],
): Promise<Array<{ lineId: string } & L>> {
  const ids = await lineIdsOf(tx, document, parentId);
  if (ids.length !== lines.length) throw new Error(`The ${TABLES[document].noun}'s lines changed while they were read.`);
  return lines.map((line, index) => ({ lineId: ids[index], ...line }));
}

/** A document with `lineId` on each line. */
export async function documentWithLineIds<D extends { id: string; lines: readonly object[] }>(tx: OrgTx, document: LineDocument, doc: D) {
  return { ...doc, lines: await withLineIds(tx, document, doc.id, doc.lines) };
}

/** A saved line in the shape the services take, keeping everything on it. */
function lineAsSent(line: SavedLine): Record<string, unknown> {
  return {
    description: line.description,
    quantity: toPlainString(dec(line.quantity)),
    unitPrice: toPlainString(dec(line.unitPrice)),
    ...(line.discountPercent !== undefined && !isZero(dec(line.discountPercent)) ? { discountPercent: line.discountPercent } : {}),
    accountCode: line.accountCode,
    taxCode: line.taxCode,
    tracking: { ...(line.tracking ?? {}) },
    customFields: { ...(line.customFields ?? {}) },
    itemId: line.itemId,
    unitId: line.unitId,
    ...(line.salesOrderLineId ? { salesOrderLineId: line.salesOrderLineId } : {}),
    ...(line.purchaseOrderLineId ? { purchaseOrderLineId: line.purchaseOrderLineId } : {}),
  };
}

/** What an AI may set on a line. Order links (sales or purchase order lines) are kept, never set here. */
const LINE_FIELDS = ["description", "quantity", "unitPrice", "discountPercent", "accountCode", "taxCode", "itemId", "unitId", "tracking", "customFields"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A map patched key by key: a key sent as null or "" is cleared, others are set. Anything not a map is left for the service to refuse. */
function patchMap(saved: Record<string, unknown>, sent: unknown): unknown {
  if (sent === null) return {};
  if (!isObject(sent)) return sent;
  const out: Record<string, unknown> = { ...saved };
  for (const [key, value] of Object.entries(sent)) {
    if (value === null || value === "") delete out[key];
    else out[key] = value;
  }
  return out;
}

function lineLabel(index: number, line: SavedLine, lineId: string): string {
  const what = line.description.trim() ? ` "${line.description.trim().slice(0, 40)}"` : "";
  return `line ${index + 1}${what} (lineId ${lineId})`;
}

/** What a saved line carries that a plain replacement line would lose. */
function carries(line: SavedLine): string[] {
  const kept: string[] = [];
  if (line.itemId) kept.push(line.unitId ? "an item and unit" : "an item");
  if (line.tracking && Object.keys(line.tracking).length > 0) kept.push("tracking");
  if (line.customFields && Object.keys(line.customFields).length > 0) kept.push("custom fields");
  if (line.salesOrderLineId) kept.push("a sales order link");
  if (line.purchaseOrderLineId) kept.push("a purchase order link");
  return kept;
}

/**
 * The full new list of lines for the service, from the saved lines and
 * what the AI sent; undefined when neither `lines` nor `removeLineIds` was
 * sent (the service then keeps the saved lines). Throws, before anything is
 * written, when a saved line would be dropped without being named.
 */
export function mergeLines(
  document: LineDocument,
  saved: ReadonlyArray<{ lineId: string; line: SavedLine }>,
  linesInput: unknown,
  removeInput: unknown,
): Record<string, unknown>[] | undefined {
  if (linesInput === undefined && (removeInput === undefined || removeInput === null)) return undefined;
  const noun = TABLES[document].noun;
  const byId = new Map(saved.map((entry, index) => [entry.lineId, { ...entry, index }]));
  const stale = (id: string) =>
    new ValidationError(`lineId ${id} isn't one of this ${noun}'s lines now. Line ids change after each edit: read the ${noun} again and use its lineIds.`);

  const removed = new Set<string>();
  if (removeInput !== undefined && removeInput !== null) {
    if (!Array.isArray(removeInput)) throw new ValidationError("removeLineIds must be a list of lineIds.");
    for (const raw of removeInput) {
      const id = String(raw ?? "").trim();
      if (!byId.has(id)) throw stale(id);
      removed.add(id);
    }
  }

  const sent = linesInput === undefined ? saved.filter((entry) => !removed.has(entry.lineId)).map((entry) => ({ lineId: entry.lineId })) : linesInput;
  if (!Array.isArray(sent)) throw new ValidationError("lines must be a list.");
  const used = new Set<string>();
  const merged = sent.map((raw, index) => {
    if (!isObject(raw)) throw new ValidationError(`Line ${index + 1} must be an object.`);
    const hasId = raw.lineId !== undefined && raw.lineId !== null && raw.lineId !== "";
    if (!hasId) {
      const line: Record<string, unknown> = {};
      for (const field of LINE_FIELDS) if (raw[field] !== undefined) line[field] = raw[field];
      return line;
    }
    const id = String(raw.lineId).trim();
    const found = byId.get(id);
    if (!found) throw stale(id);
    if (removed.has(id)) throw new ValidationError(`lineId ${id} is in both lines and removeLineIds. Keep it or remove it, not both.`);
    if (used.has(id)) throw new ValidationError(`lineId ${id} is in lines twice. Send each saved line once; add a new line without a lineId.`);
    used.add(id);
    const line = lineAsSent(found.line);
    for (const field of LINE_FIELDS) {
      const value = raw[field];
      if (value === undefined) continue;
      if (field === "tracking" || field === "customFields") line[field] = patchMap(line[field] as Record<string, unknown>, value);
      else line[field] = value;
    }
    // A unit belongs to its item: a different item (or none) without a unit sent uses the item's base unit.
    if (raw.itemId !== undefined && raw.unitId === undefined && String(raw.itemId ?? "") !== String(found.line.itemId ?? "")) line.unitId = null;
    return line;
  });

  const missing = saved.filter((entry) => !used.has(entry.lineId) && !removed.has(entry.lineId));
  if (missing.length > 0) {
    const named = missing.map((entry) => {
      const index = byId.get(entry.lineId)!.index;
      const what = carries(entry.line);
      return `${lineLabel(index, entry.line, entry.lineId)}${what.length > 0 ? `, which has ${what.join(", ")}` : ""}`;
    });
    throw new ValidationError(
      `Nothing was changed: ${named.join("; ")} ${missing.length === 1 ? "isn't" : "aren't"} in lines or removeLineIds. ` +
        `To keep a saved line, send {"lineId": "..."} with only the fields to change (null clears a field). To take it off, list its lineId in removeLineIds.`,
    );
  }
  return merged;
}

/**
 * Locks the document, reads its saved lines and works out the lines to
 * send to the service's update. `load` is the service's own getter.
 */
export async function linesForEdit(
  tx: OrgTx,
  document: LineDocument,
  idInput: unknown,
  idName: string,
  load: (tx: OrgTx, id: string) => Promise<{ lines: readonly SavedLine[] }>,
  args: { lines?: unknown; removeLineIds?: unknown },
): Promise<Record<string, unknown>[] | undefined> {
  if (args.lines === undefined && (args.removeLineIds === undefined || args.removeLineIds === null)) return undefined;
  const id = requireId(idInput, idName);
  const table = TABLES[document];
  const locked = await tx.query(`select id from ${table.parent} where id = $1 for update`, [id]);
  if (locked.rowCount === 0) throw new NotFoundError(`There's no ${table.noun} #${id}.`);
  const doc = await load(tx, id);
  const ids = await lineIdsOf(tx, document, id);
  if (ids.length !== doc.lines.length) throw new Error(`The ${table.noun}'s lines changed while they were read.`);
  return mergeLines(
    document,
    doc.lines.map((line, index) => ({ lineId: ids[index], line })),
    args.lines,
    args.removeLineIds,
  );
}
