import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { linesAsSent } from "@/lib/invoices/service";
import { add, cmp, dec, divide, isPositive, mul, parseDecimalInput, roundHalfUp, sub, toFixedString, type Decimal } from "@/lib/money/decimal";
import { getRepeatingInvoice, type RepeatingInvoice, templateTotalsWith, updateRepeatingInvoice } from "@/lib/repeating/service";
import { optionalId, optionalString, requireArray, requireId, requireOneOf } from "@/lib/validation";

/*
 * Price changes on repeating invoices (examples RP1-RP8, decision 535): a
 * rise or fall saved once for many templates. It changes the templates'
 * unit prices from a date; nothing posts, and invoices already made keep
 * their prices. See docs/ACCOUNTING-EXAMPLES.md for the rules.
 */

export const PRICE_METHODS = ["percent", "fixed"] as const;
export type PriceMethod = (typeof PRICE_METHODS)[number];
export const PRICE_ROUNDING = ["cent", "0.50", "1", "5", "10"] as const;
export type PriceRounding = (typeof PRICE_ROUNDING)[number];

export type PriceRule = {
  method: PriceMethod;
  /** The percentage up (or down, negative), for "percent". */
  percent: string | null;
  /** The new price, for "fixed". */
  fixedPrice: string | null;
  rounding: PriceRounding;
  /** Percentage rises only: a line goes up by at least this much (RP3). */
  minimumIncrease: string | null;
};

/**
 * A line's new unit price under a rule (RP1-RP4): the percentage (or the
 * fixed price), then the minimum increase, then the rounding, halves up.
 * Never below zero.
 */
export function newUnitPrice(oldPrice: string, rule: PriceRule): string {
  const old = dec(oldPrice);
  let price: Decimal;
  if (rule.method === "fixed") {
    price = dec(rule.fixedPrice!);
  } else {
    price = add(old, divide(mul(old, dec(rule.percent!)), dec("100"), 6));
    if (rule.minimumIncrease !== null && isPositive(dec(rule.percent!)) && cmp(sub(price, old), dec(rule.minimumIncrease)) < 0) {
      price = add(old, dec(rule.minimumIncrease));
    }
  }
  if (rule.rounding === "cent") {
    price = roundHalfUp(price, 2);
  } else {
    const step = dec(rule.rounding);
    price = mul(divide(price, step, 0), step);
  }
  if (cmp(price, dec("0")) < 0) price = dec("0");
  return toFixedString(price, 2);
}

export type PriceChangeInput = {
  repeatingInvoiceIds: unknown;
  method: unknown;
  percent?: unknown;
  fixedPrice?: unknown;
  itemId?: unknown;
  rounding?: unknown;
  minimumIncrease?: unknown;
  effectiveDate: unknown;
  note?: unknown;
};

/** The fields of a request body that make up a price change. */
export function priceChangeInput(body: Record<string, unknown>): PriceChangeInput {
  return {
    repeatingInvoiceIds: body.repeatingInvoiceIds,
    method: body.method,
    percent: body.percent,
    fixedPrice: body.fixedPrice,
    itemId: body.itemId,
    rounding: body.rounding,
    minimumIncrease: body.minimumIncrease,
    effectiveDate: body.effectiveDate,
    note: body.note,
  };
}

type Parsed = PriceRule & { templateIds: string[]; itemId: string | null; effectiveDate: string; note: string | null };

const blank = (value: unknown) => value === undefined || value === null || value === "";

function parseInput(input: PriceChangeInput): Parsed {
  const templateIds = [...new Set(requireArray(input.repeatingInvoiceIds, "repeatingInvoiceIds", 500).map((id) => requireId(id, "repeatingInvoiceIds")))];
  if (templateIds.length === 0) throw new ValidationError("Choose at least one repeating invoice.");
  const method = requireOneOf(input.method, "method", PRICE_METHODS);
  const itemId = optionalId(input.itemId, "itemId");
  const rounding = blank(input.rounding) ? "cent" : requireOneOf(input.rounding, "rounding", PRICE_ROUNDING);
  let percent: string | null = null;
  let fixedPrice: string | null = null;
  let minimumIncrease: string | null = null;
  if (method === "percent") {
    percent = parseDecimalInput(input.percent, "The percentage", { maxScale: 2, allowNegative: true });
    if (cmp(dec(percent), dec("-100")) < 0 || cmp(dec(percent), dec("1000")) > 0) throw new ValidationError("The percentage must be from -100 to 1000.");
    if (!blank(input.minimumIncrease)) minimumIncrease = parseDecimalInput(input.minimumIncrease, "The minimum increase", { maxScale: 2 });
  } else {
    if (itemId === null) throw new ValidationError("Choose the item whose price to set.");
    fixedPrice = parseDecimalInput(input.fixedPrice, "The new price", { maxScale: 4, allowZero: true });
    if (!blank(input.minimumIncrease)) throw new ValidationError("A minimum increase is only for a percentage rise.");
  }
  return {
    templateIds,
    method,
    percent,
    fixedPrice,
    itemId,
    rounding,
    minimumIncrease,
    effectiveDate: parseIsoDate(input.effectiveDate, "The date"),
    note: optionalString(input.note, "note", { maxLength: 500 }),
  };
}

export type PreviewLine = {
  lineOrder: number;
  description: string;
  oldUnitPrice: string;
  newUnitPrice: string;
  /** Why a line isn't changed, or null when it is. */
  notChanged: string | null;
};

export type PreviewTemplate = {
  repeatingInvoiceId: string;
  contactName: string;
  reference: string | null;
  amountsMode: string;
  currencyCode: string;
  nextDate: string | null;
  totalBefore: string;
  totalAfter: string;
  lines: PreviewLine[];
};

export type PriceChangePreview = { templates: PreviewTemplate[]; linesChanged: number };

const plainPrice = (value: string) => toFixedString(dec(value), 2);

async function workOut(tx: OrgTx, parsed: Parsed): Promise<{ preview: PriceChangePreview; templates: RepeatingInvoice[] }> {
  const templates: RepeatingInvoice[] = [];
  const result: PreviewTemplate[] = [];
  let linesChanged = 0;
  for (const id of parsed.templateIds) {
    const template = await getRepeatingInvoice(tx, id);
    if (template.status === "ended") throw new ValidationError(`The repeating invoice for ${template.contactName} has ended, so its prices can't change.`);
    const lines: PreviewLine[] = template.lines.map((line) => {
      const base = { lineOrder: line.lineOrder, description: line.description, oldUnitPrice: plainPrice(line.unitPrice), newUnitPrice: plainPrice(line.unitPrice) };
      if (parsed.itemId !== null && line.itemId !== parsed.itemId) return { ...base, notChanged: "Not this item" };
      if (!isPositive(dec(line.unitPrice))) return { ...base, notChanged: "A zero price isn't changed" };
      const next = newUnitPrice(line.unitPrice, parsed);
      if (cmp(dec(next), dec(line.unitPrice)) === 0) return { ...base, notChanged: "Already this price" };
      return { ...base, newUnitPrice: next, notChanged: null };
    });
    const changed = lines.filter((line) => line.notChanged === null);
    linesChanged += changed.length;
    const sent = linesAsSent(template.lines).map((line, index) => (lines[index].notChanged === null ? { ...line, unitPrice: lines[index].newUnitPrice } : line));
    const after = changed.length > 0 ? (await templateTotalsWith(tx, template, sent)).total : template.total;
    templates.push(template);
    result.push({
      repeatingInvoiceId: template.id,
      contactName: template.contactName,
      reference: template.reference,
      amountsMode: template.amountsMode,
      currencyCode: template.currencyCode,
      nextDate: template.nextDate,
      totalBefore: template.total,
      totalAfter: after,
      lines,
    });
  }
  return { preview: { templates: result, linesChanged }, templates };
}

/** What a price change would do (RP1-RP4), without saving anything. */
export async function previewPriceChange(tx: OrgTx, input: PriceChangeInput): Promise<PriceChangePreview> {
  return (await workOut(tx, parseInput(input))).preview;
}

export type PriceChangeLine = {
  repeatingInvoiceId: string;
  contactName: string;
  lineOrder: number;
  description: string;
  oldUnitPrice: string;
  newUnitPrice: string;
  status: "waiting" | "made" | "skipped" | "cancelled" | "undone" | "kept";
  message: string | null;
  doneAt: string | null;
};

export type PriceChange = PriceRule & {
  id: string;
  itemId: string | null;
  itemName: string | null;
  effectiveDate: string;
  note: string | null;
  status: "saved" | "cancelled" | "undone";
  createdByEmail: string;
  createdAt: string;
  endedByEmail: string | null;
  endedAt: string | null;
  lines: PriceChangeLine[];
};

type ChangeRow = {
  id: string;
  method: PriceMethod;
  percent: string | null;
  fixed_price: string | null;
  item_id: string | null;
  item_name: string | null;
  rounding: PriceRounding;
  minimum_increase: string | null;
  effective_date: string;
  note: string | null;
  status: PriceChange["status"];
  created_by_email: string;
  created_at: string;
  ended_by_email: string | null;
  ended_at: string | null;
};

const CHANGE_SQL = `select p.id::text, p.method, p.percent::text, p.fixed_price::text, p.item_id::text, i.name as item_name, p.rounding,
       p.minimum_increase::text, p.effective_date::text, p.note, p.status, p.created_by_email,
       to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, p.ended_by_email,
       to_char(p.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ended_at
  from repeating_price_changes p left join items i on i.id = p.item_id`;

async function changeLines(tx: OrgTx, ids: string[]): Promise<Map<string, PriceChangeLine[]>> {
  const rows = await tx.query<{
    price_change_id: string;
    repeating_invoice_id: string;
    contact_name: string;
    line_order: number;
    description: string;
    old_unit_price: string;
    new_unit_price: string;
    status: PriceChangeLine["status"];
    message: string | null;
    done_at: string | null;
  }>(
    `select l.price_change_id::text, l.repeating_invoice_id::text, c.name as contact_name, l.line_order, l.description,
            l.old_unit_price::text, l.new_unit_price::text, l.status, l.message,
            to_char(l.done_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as done_at
       from repeating_price_change_lines l
       join repeating_invoices r on r.id = l.repeating_invoice_id
       join contacts c on c.id = r.contact_id
      where l.price_change_id = any($1::bigint[])
      order by l.price_change_id, l.repeating_invoice_id, l.line_order`,
    [ids],
  );
  const byChange = new Map<string, PriceChangeLine[]>();
  for (const row of rows.rows) {
    const list = byChange.get(row.price_change_id) ?? [];
    list.push({
      repeatingInvoiceId: row.repeating_invoice_id,
      contactName: row.contact_name,
      lineOrder: row.line_order,
      description: row.description,
      oldUnitPrice: plainPrice(row.old_unit_price),
      newUnitPrice: plainPrice(row.new_unit_price),
      status: row.status,
      message: row.message,
      doneAt: row.done_at,
    });
    byChange.set(row.price_change_id, list);
  }
  return byChange;
}

function toChange(row: ChangeRow, lines: PriceChangeLine[]): PriceChange {
  return {
    id: row.id,
    method: row.method,
    percent: row.percent,
    fixedPrice: row.fixed_price === null ? null : plainPrice(row.fixed_price),
    itemId: row.item_id,
    itemName: row.item_name,
    rounding: row.rounding,
    minimumIncrease: row.minimum_increase,
    effectiveDate: row.effective_date,
    note: row.note,
    status: row.status,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    endedByEmail: row.ended_by_email,
    endedAt: row.ended_at,
    lines,
  };
}

export async function listPriceChanges(tx: OrgTx): Promise<PriceChange[]> {
  const rows = await tx.query<ChangeRow>(`${CHANGE_SQL} order by p.id desc limit 100`);
  const lines = await changeLines(tx, rows.rows.map((row) => row.id));
  return rows.rows.map((row) => toChange(row, lines.get(row.id) ?? []));
}

export async function getPriceChange(tx: OrgTx, idInput: unknown): Promise<PriceChange> {
  const id = requireId(idInput, "priceChangeId");
  const row = (await tx.query<ChangeRow>(`${CHANGE_SQL} where p.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError("Price change not found.");
  return toChange(row, (await changeLines(tx, [id])).get(id) ?? []);
}

/**
 * Sets template lines to new prices where they're still at the price
 * expected (RP6): `pairs` maps a waiting line's id to its line order, the
 * price it should be at and the price to set. Lines edited since are left
 * alone and marked with why. Returns the ids changed and those left alone.
 */
async function setPrices(
  tx: OrgTx,
  templateId: string,
  pairs: Array<{ id: string; lineOrder: number; expected: string; next: string }>,
): Promise<{ changed: string[]; left: Array<{ id: string; message: string }> }> {
  const template = await getRepeatingInvoice(tx, templateId);
  const sent = linesAsSent(template.lines);
  const changed: string[] = [];
  const left: Array<{ id: string; message: string }> = [];
  for (const pair of pairs) {
    const index = template.lines.findIndex((line) => line.lineOrder === pair.lineOrder);
    if (index < 0) {
      left.push({ id: pair.id, message: "The line was removed from the template." });
      continue;
    }
    const current = template.lines[index].unitPrice;
    if (cmp(dec(current), dec(pair.expected)) !== 0) {
      left.push({ id: pair.id, message: `Changed to ${plainPrice(current)} after this price change was saved.` });
      continue;
    }
    sent[index] = { ...sent[index], unitPrice: pair.next };
    changed.push(pair.id);
  }
  if (changed.length > 0) {
    if (template.status === "ended") {
      return { changed: [], left: pairs.map((pair) => ({ id: pair.id, message: "The repeating invoice has ended." })) };
    }
    await updateRepeatingInvoice(tx, templateId, { lines: sent });
  }
  return { changed, left };
}

/**
 * Makes the waiting price changes from `onDate` or earlier on a template
 * (RP5, RP6), oldest change first. Called just before the template's
 * invoice for `onDate` is made, and when a change is saved. Returns whether
 * anything changed.
 */
export async function makeWaitingPriceChanges(tx: OrgTx, templateId: string, onDate: string): Promise<boolean> {
  const waiting = await tx.query<{ id: string; line_order: number; old_unit_price: string; new_unit_price: string; price_change_id: string }>(
    `select l.id::text, l.line_order, l.old_unit_price::text, l.new_unit_price::text, l.price_change_id::text
       from repeating_price_change_lines l join repeating_price_changes p on p.id = l.price_change_id
      where l.repeating_invoice_id = $1 and l.status = 'waiting' and p.status = 'saved' and p.effective_date <= $2
      order by l.price_change_id, l.line_order
      for update of l`,
    [templateId, onDate],
  );
  if (waiting.rows.length === 0) return false;
  let any = false;
  const changes = [...new Set(waiting.rows.map((row) => row.price_change_id))];
  for (const changeId of changes) {
    const rows = waiting.rows.filter((row) => row.price_change_id === changeId);
    const { changed, left } = await setPrices(
      tx,
      templateId,
      rows.map((row) => ({ id: row.id, lineOrder: row.line_order, expected: row.old_unit_price, next: plainPrice(row.new_unit_price) })),
    );
    if (changed.length > 0) {
      any = true;
      await tx.query("update repeating_price_change_lines set status = 'made', message = null, done_at = now() where id = any($1::bigint[])", [changed]);
    }
    for (const line of left) {
      await tx.query("update repeating_price_change_lines set status = 'skipped', message = $2, done_at = now() where id = $1", [line.id, line.message]);
    }
    await writeAuditEvent(tx, {
      eventType: "repeating_price_change.made",
      entityType: "repeating_invoice",
      entityId: templateId,
      details: { priceChangeId: changeId, onDate, linesChanged: changed.length, linesLeft: left.length },
    });
  }
  return any;
}

/**
 * Saves a price change (RP1-RP5). Each template changes straight away when
 * no invoice before the change's date is still to be made; otherwise the
 * change waits for the first invoice dated on or after it.
 */
export async function savePriceChange(tx: OrgTx, input: PriceChangeInput): Promise<PriceChange> {
  const parsed = parseInput(input);
  const { preview } = await workOut(tx, parsed);
  if (preview.linesChanged === 0) throw new ValidationError("No line's price would change.");
  const inserted = await tx.query<{ id: string }>(
    `insert into repeating_price_changes (method, percent, fixed_price, item_id, rounding, minimum_increase, effective_date, note, created_by_email)
     values ($1, $2::numeric, $3::numeric, $4, $5, $6::numeric, $7, $8, $9) returning id::text`,
    [parsed.method, parsed.percent, parsed.fixedPrice, parsed.itemId, parsed.rounding, parsed.minimumIncrease, parsed.effectiveDate, parsed.note, tx.actor.email],
  );
  const id = inserted.rows[0].id;
  for (const template of preview.templates) {
    for (const line of template.lines.filter((entry) => entry.notChanged === null)) {
      await tx.query(
        `insert into repeating_price_change_lines (price_change_id, repeating_invoice_id, line_order, description, old_unit_price, new_unit_price)
         values ($1, $2, $3, $4, $5::numeric, $6::numeric)`,
        [id, template.repeatingInvoiceId, line.lineOrder, line.description.slice(0, 1000), line.oldUnitPrice, line.newUnitPrice],
      );
    }
  }
  await writeAuditEvent(tx, {
    eventType: "repeating_price_change.saved",
    entityType: "repeating_price_change",
    entityId: id,
    details: { method: parsed.method, percent: parsed.percent, fixedPrice: parsed.fixedPrice, effectiveDate: parsed.effectiveDate, templates: parsed.templateIds.length, lines: preview.linesChanged },
  });
  for (const template of preview.templates) {
    // Straight away when the next invoice to be made is dated on or after the change (RP5).
    if (template.nextDate !== null && template.nextDate >= parsed.effectiveDate) {
      await makeWaitingPriceChanges(tx, template.repeatingInvoiceId, template.nextDate);
    }
  }
  return getPriceChange(tx, id);
}

/**
 * Cancels what's still waiting and undoes what was made (RP7): lines still
 * at the new price go back to the old one; lines edited since are kept as
 * they are, with why. Invoices already made keep their prices.
 */
export async function undoPriceChange(tx: OrgTx, idInput: unknown): Promise<PriceChange> {
  const id = requireId(idInput, "priceChangeId");
  const locked = await tx.query<{ status: string }>("select status from repeating_price_changes where id = $1 for update", [id]);
  if (!locked.rows[0]) throw new NotFoundError("Price change not found.");
  if (locked.rows[0].status !== "saved") throw new ConflictError(`This price change was already ${locked.rows[0].status}.`);
  await tx.query("update repeating_price_change_lines set status = 'cancelled', done_at = now() where price_change_id = $1 and status = 'waiting'", [id]);
  const made = await tx.query<{ id: string; repeating_invoice_id: string; line_order: number; old_unit_price: string; new_unit_price: string }>(
    `select id::text, repeating_invoice_id::text, line_order, old_unit_price::text, new_unit_price::text
       from repeating_price_change_lines where price_change_id = $1 and status = 'made' order by repeating_invoice_id, line_order`,
    [id],
  );
  for (const templateId of [...new Set(made.rows.map((row) => row.repeating_invoice_id))]) {
    const rows = made.rows.filter((row) => row.repeating_invoice_id === templateId);
    const { changed, left } = await setPrices(
      tx,
      templateId,
      rows.map((row) => ({ id: row.id, lineOrder: row.line_order, expected: row.new_unit_price, next: plainPrice(row.old_unit_price) })),
    );
    if (changed.length > 0) {
      await tx.query("update repeating_price_change_lines set status = 'undone', done_at = now() where id = any($1::bigint[])", [changed]);
    }
    for (const line of left) {
      await tx.query("update repeating_price_change_lines set status = 'kept', message = $2, done_at = now() where id = $1", [line.id, line.message]);
    }
  }
  const status = made.rows.length > 0 ? "undone" : "cancelled";
  await tx.query("update repeating_price_changes set status = $2, ended_by_email = $3, ended_at = now() where id = $1", [id, status, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: `repeating_price_change.${status}`, entityType: "repeating_price_change", entityId: id, details: { linesMade: made.rows.length } });
  return getPriceChange(tx, id);
}
