import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { add, dec, type Decimal, isNegative, isZero, neg, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { financialYearEndMonth } from "@/lib/reports/financial";
import { optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";
import { requireFarming } from "./paddocks";

/*
 * The co-op share register (#327; examples CSR1-CSR10, decisions 630-633;
 * Codex, delegated by owner, 20 October 2026, not yet reviewed). A farming
 * organisation's shares in co-operatives, one holding per co-op and share
 * class, with each movement and each dividend, rebate and retention as the
 * co-op's statements show them. It's a factual register: Tohyee adds up what
 * was entered and checks it never goes below nothing. It doesn't post to the
 * ledger, value shares or work out how many shares a co-op requires.
 */

export const MOVEMENT_KINDS = [
  { key: "brought_forward", label: "Brought forward" },
  { key: "bought", label: "Bought or issued for payment" },
  { key: "issued", label: "Issued without payment" },
  { key: "sold", label: "Sold, surrendered or redeemed" },
  { key: "adjusted", label: "Adjustment" },
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number]["key"];

export const DISTRIBUTION_KINDS = [
  { key: "dividend", label: "Dividend" },
  { key: "rebate", label: "Rebate" },
  { key: "retention", label: "Retention" },
] as const;
export type DistributionKind = (typeof DISTRIBUTION_KINDS)[number]["key"];

const MOVEMENT_LABELS = new Map<string, string>(MOVEMENT_KINDS.map((kind) => [kind.key, kind.label]));
const DISTRIBUTION_LABELS = new Map<string, string>(DISTRIBUTION_KINDS.map((kind) => [kind.key, kind.label]));

export type CoopSourceFile = { id: string; fileName: string; removed: boolean };

export type CoopMovement = {
  id: string;
  date: string;
  kind: MovementKind;
  kindLabel: string;
  /** Signed: a sale is negative. Quantity to 4 places, value to the cent. */
  quantity: string;
  value: string;
  sourceReference: string | null;
  file: CoopSourceFile | null;
};

export type CoopDistribution = {
  id: string;
  date: string;
  kind: DistributionKind;
  kindLabel: string;
  amount: string;
  imputationCredits: string | null;
  sourceReference: string | null;
  file: CoopSourceFile | null;
};

export type CoopDistributionTotals = { dividends: string; imputationCredits: string; rebates: string; retentions: string };

export type CoopHoldingSchedule = {
  id: string;
  coopName: string;
  shareClass: string;
  notes: string | null;
  opening: { quantity: string; value: string };
  movements: CoopMovement[];
  closing: { quantity: string; value: string };
  distributions: CoopDistribution[];
  totals: CoopDistributionTotals;
  /** Whether it has entries left (it can only be removed when it has none). */
  hasEntries: boolean;
};

export type CoopShareSchedule = {
  /** The current financial year's end and the four before it, newest first. */
  yearEnds: string[];
  yearStart: string;
  yearEnd: string;
  holdings: CoopHoldingSchedule[];
  totals: { openingValue: string; closingValue: string } & CoopDistributionTotals;
};

const quantityText = (value: Decimal) => toFixedString(value, 4).replace(/\.?0+$/, "") || "0";
const money = (value: Decimal) => toFixedString(value, 2);

function yearEnds(today: string, yearEndMonth: number): string[] {
  const ends = [financialYearEnd(today, yearEndMonth)];
  while (ends.length < 5) ends.push(financialYearEnd(addDays(financialYearStart(ends[ends.length - 1], yearEndMonth), -1), yearEndMonth));
  return ends;
}

async function activeHolding(tx: OrgTx, idInput: unknown): Promise<{ id: string; coop_name: string; share_class: string }> {
  const id = requireId(idInput, "holdingId");
  const row = (
    await tx.query<{ id: string; coop_name: string; share_class: string }>(
      "select id::text, coop_name, share_class from coop_shareholdings where id = $1 and status = 'active' for update",
      [id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("That co-op shareholding wasn't found.");
  return row;
}

/** The source statement: a reference, a file on this holding, or both (CSR5). */
async function sourceOf(tx: OrgTx, holdingId: string, input: { sourceReference?: unknown; attachmentId?: unknown }): Promise<{ reference: string | null; attachmentId: string | null }> {
  const reference = optionalString(input.sourceReference, "Source statement", { maxLength: 200 });
  const attachmentId = optionalId(input.attachmentId, "attachmentId");
  if (attachmentId) {
    const found = await tx.query(
      "select 1 from record_attachments where id = $1 and record_type = 'coop_shareholding' and record_id = $2 and removed_at is null",
      [attachmentId, holdingId],
    );
    if (found.rowCount === 0) throw new ValidationError("That file isn't one of this holding's statements.");
  }
  if (!reference && !attachmentId) throw new ValidationError("Say which statement this comes from, or choose its file.");
  return { reference, attachmentId };
}

/** Adds a co-op and share class to the register (CSR1). Farming only. */
export async function addHolding(tx: OrgTx, input: { coopName: unknown; shareClass: unknown; notes?: unknown }): Promise<{ id: string }> {
  await requireFarming(tx);
  const coopName = requireString(input.coopName, "Co-op", { maxLength: 100 });
  const shareClass = requireString(input.shareClass, "Share class", { maxLength: 100 });
  const notes = optionalString(input.notes, "Notes", { maxLength: 1000 });
  const same = await tx.query(
    "select 1 from coop_shareholdings where lower(coop_name) = lower($1) and lower(share_class) = lower($2) and status = 'active'",
    [coopName, shareClass],
  );
  if (same.rowCount) throw new ValidationError(`${coopName} ${shareClass} is already in the register.`);
  const id = (
    await tx.query<{ id: string }>(
      "insert into coop_shareholdings (coop_name, share_class, notes, created_by_email) values ($1, $2, $3, $4) returning id::text",
      [coopName, shareClass, notes, tx.actor.email],
    )
  ).rows[0].id;
  await writeAuditEvent(tx, { eventType: "farming.coop_holding_added", entityType: "coop_shareholding", entityId: id, details: { coopName, shareClass } });
  return { id };
}

/** Removes a holding added by mistake, once its entries are removed (CSR8). It's kept for the history. */
export async function removeHolding(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const holding = await activeHolding(tx, idInput);
  const entries = await tx.query(
    `select 1 from coop_share_movements where holding_id = $1 and status = 'active'
     union all select 1 from coop_share_distributions where holding_id = $1 and status = 'active' limit 1`,
    [holding.id],
  );
  if (entries.rowCount) throw new ValidationError(`Remove ${holding.coop_name} ${holding.share_class}'s movements and payments first.`);
  await tx.query("update coop_shareholdings set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1", [holding.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.coop_holding_removed", entityType: "coop_shareholding", entityId: holding.id, details: {} });
}

/**
 * Checks the holding never goes below nothing (CSR4): the running quantity
 * and value, in date order, after every movement. Run after each change.
 */
async function checkRunningBalance(tx: OrgTx, holding: { id: string; coop_name: string; share_class: string }): Promise<void> {
  const rows = await tx.query<{ movement_date: string; kind: string; quantity: string; value: string }>(
    `select movement_date::text, kind, quantity::text, value::text from coop_share_movements
      where holding_id = $1 and status = 'active' order by movement_date, (kind <> 'brought_forward'), id`,
    [holding.id],
  );
  const broughtForward = rows.rows.filter((row) => row.kind === "brought_forward");
  if (broughtForward.length > 1) throw new ValidationError(`${holding.coop_name} ${holding.share_class} already has a brought-forward balance.`);
  if (broughtForward.length === 1 && rows.rows[0].kind !== "brought_forward") {
    throw new ValidationError("The brought-forward balance must be dated on or before every other movement.");
  }
  let quantity = ZERO_DECIMAL;
  let value = ZERO_DECIMAL;
  for (const row of rows.rows) {
    quantity = add(quantity, dec(row.quantity));
    value = add(value, dec(row.value));
    if (isNegative(quantity)) throw new ValidationError(`That would leave ${holding.coop_name} ${holding.share_class} with fewer than no shares on ${row.movement_date}.`);
    if (isNegative(value)) throw new ValidationError(`That would leave ${holding.coop_name} ${holding.share_class} with a value below nothing on ${row.movement_date}.`);
  }
}

/**
 * Adds a movement (CSR2-CSR5). Quantities and values are entered as
 * positive numbers; a sale is stored negative. An adjustment takes signed
 * numbers, and at least one of them isn't zero.
 */
export async function addMovement(
  tx: OrgTx,
  input: { holdingId: unknown; date: unknown; kind: unknown; quantity: unknown; value: unknown; sourceReference?: unknown; attachmentId?: unknown },
): Promise<{ id: string }> {
  await requireFarming(tx);
  const holding = await activeHolding(tx, input.holdingId);
  const date = parseIsoDate(input.date, "Date");
  const kind = requireOneOf(input.kind, "kind", MOVEMENT_KINDS.map((entry) => entry.key));
  const adjusted = kind === "adjusted";
  let quantity = dec(parseDecimalInput(input.quantity, "Quantity", { maxScale: 4, allowNegative: adjusted, allowZero: kind === "brought_forward" || adjusted }));
  let value = dec(parseDecimalInput(input.value, "Value", { maxScale: 2, allowNegative: adjusted, allowZero: true }));
  if (adjusted && isZero(quantity) && isZero(value)) throw new ValidationError("An adjustment changes the quantity, the value or both.");
  if (kind === "sold") {
    quantity = neg(quantity);
    value = neg(value);
  }
  const source = await sourceOf(tx, holding.id, input);
  const id = (
    await tx.query<{ id: string }>(
      `insert into coop_share_movements (holding_id, movement_date, kind, quantity, value, source_reference, attachment_id, created_by_email)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8) returning id::text`,
      [holding.id, date, kind, toFixedString(quantity, 4), money(value), source.reference, source.attachmentId, tx.actor.email],
    )
  ).rows[0].id;
  await checkRunningBalance(tx, holding);
  await writeAuditEvent(tx, {
    eventType: "farming.coop_movement_added",
    entityType: "coop_shareholding",
    entityId: holding.id,
    details: { movementId: id, date, kind, quantity: quantityText(quantity), value: money(value) },
  });
  return { id };
}

/** Removes a movement entered by mistake (CSR8); refused if a later sale relies on it (CSR4). */
export async function removeMovement(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "movementId");
  const row = (await tx.query<{ holding_id: string }>("select holding_id::text from coop_share_movements where id = $1 and status = 'active'", [id])).rows[0];
  if (!row) throw new NotFoundError("That movement wasn't found.");
  const holding = await activeHolding(tx, row.holding_id);
  await tx.query("update coop_share_movements set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1", [id, tx.actor.email]);
  await checkRunningBalance(tx, holding);
  await writeAuditEvent(tx, { eventType: "farming.coop_movement_removed", entityType: "coop_shareholding", entityId: holding.id, details: { movementId: id } });
}

/** Adds a dividend, rebate or retention (CSR6, CSR7). Imputation credits only on dividends. */
export async function addDistribution(
  tx: OrgTx,
  input: { holdingId: unknown; date: unknown; kind: unknown; amount: unknown; imputationCredits?: unknown; sourceReference?: unknown; attachmentId?: unknown },
): Promise<{ id: string }> {
  await requireFarming(tx);
  const holding = await activeHolding(tx, input.holdingId);
  const date = parseIsoDate(input.date, "Date");
  const kind = requireOneOf(input.kind, "kind", DISTRIBUTION_KINDS.map((entry) => entry.key));
  const amount = parseDecimalInput(input.amount, "Amount", { maxScale: 2 });
  const blank = input.imputationCredits === undefined || input.imputationCredits === null || input.imputationCredits === "";
  if (!blank && kind !== "dividend") throw new ValidationError("Only dividends carry imputation credits.");
  const credits = blank ? null : parseDecimalInput(input.imputationCredits, "Imputation credits", { maxScale: 2, allowZero: true });
  const source = await sourceOf(tx, holding.id, input);
  const id = (
    await tx.query<{ id: string }>(
      `insert into coop_share_distributions (holding_id, paid_on, kind, amount, imputation_credits, source_reference, attachment_id, created_by_email)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $8) returning id::text`,
      [holding.id, date, kind, amount, credits, source.reference, source.attachmentId, tx.actor.email],
    )
  ).rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "farming.coop_distribution_added",
    entityType: "coop_shareholding",
    entityId: holding.id,
    details: { distributionId: id, date, kind, amount, imputationCredits: credits },
  });
  return { id };
}

/** Removes a dividend, rebate or retention entered by mistake (CSR8). */
export async function removeDistribution(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "distributionId");
  const row = (
    await tx.query<{ holding_id: string }>(
      "update coop_share_distributions set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1 and status = 'active' returning holding_id::text",
      [id, tx.actor.email],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("That payment wasn't found.");
  await writeAuditEvent(tx, { eventType: "farming.coop_distribution_removed", entityType: "coop_shareholding", entityId: row.holding_id, details: { distributionId: id } });
}

type FileColumns = { attachment_id: string | null; file_name: string | null; file_removed: boolean | null };
const fileOf = (row: FileColumns): CoopSourceFile | null =>
  row.attachment_id ? { id: row.attachment_id, fileName: row.file_name ?? "", removed: row.file_removed === true } : null;

/**
 * The register for a financial year (CSR2-CSR7): each holding's opening
 * quantity and value (everything dated before the year), the year's
 * movements, the closing quantity and value, and the year's dividends,
 * rebates and retentions apart. With no year given, the last finished one.
 */
export async function coopShareSchedule(tx: OrgTx, input: { yearEnd?: unknown }): Promise<CoopShareSchedule> {
  await requireFarming(tx);
  const yearEndMonth = await financialYearEndMonth(tx);
  const ends = yearEnds(todayIsoDate(), yearEndMonth);
  let yearEnd = ends[1];
  if (input.yearEnd !== undefined && input.yearEnd !== null && input.yearEnd !== "") {
    yearEnd = parseIsoDate(input.yearEnd, "The year end");
    if (financialYearEnd(yearEnd, yearEndMonth) !== yearEnd) throw new ValidationError("That isn't a financial year end.");
  }
  const yearStart = financialYearStart(yearEnd, yearEndMonth);
  const holdings = await tx.query<{ id: string; coop_name: string; share_class: string; notes: string | null; has_entries: boolean }>(
    `select h.id::text, h.coop_name, h.share_class, h.notes,
            exists (select 1 from coop_share_movements m where m.holding_id = h.id and m.status = 'active')
              or exists (select 1 from coop_share_distributions d where d.holding_id = h.id and d.status = 'active') as has_entries
       from coop_shareholdings h where h.status = 'active' order by lower(h.coop_name), lower(h.share_class), h.id`,
  );
  const movements = await tx.query<
    { id: string; holding_id: string; movement_date: string; kind: MovementKind; quantity: string; value: string; source_reference: string | null } & FileColumns
  >(
    `select m.id::text, m.holding_id::text, m.movement_date::text, m.kind, m.quantity::text, m.value::text, m.source_reference,
            m.attachment_id::text, a.file_name, a.removed_at is not null as file_removed
       from coop_share_movements m left join record_attachments a on a.id = m.attachment_id
      where m.status = 'active' and m.movement_date <= $1
      order by m.movement_date, (m.kind <> 'brought_forward'), m.id`,
    [yearEnd],
  );
  const distributions = await tx.query<
    { id: string; holding_id: string; paid_on: string; kind: DistributionKind; amount: string; imputation_credits: string | null; source_reference: string | null } & FileColumns
  >(
    `select d.id::text, d.holding_id::text, d.paid_on::text, d.kind, d.amount::text, d.imputation_credits::text, d.source_reference,
            d.attachment_id::text, a.file_name, a.removed_at is not null as file_removed
       from coop_share_distributions d left join record_attachments a on a.id = d.attachment_id
      where d.status = 'active' and d.paid_on between $1 and $2
      order by d.paid_on, d.id`,
    [yearStart, yearEnd],
  );
  const grand = { opening: ZERO_DECIMAL, closing: ZERO_DECIMAL, dividends: ZERO_DECIMAL, credits: ZERO_DECIMAL, rebates: ZERO_DECIMAL, retentions: ZERO_DECIMAL };
  const result: CoopHoldingSchedule[] = holdings.rows.map((holding) => {
    let openingQuantity = ZERO_DECIMAL;
    let openingValue = ZERO_DECIMAL;
    let quantity = ZERO_DECIMAL;
    let value = ZERO_DECIMAL;
    const inYear: CoopMovement[] = [];
    for (const row of movements.rows) {
      if (row.holding_id !== holding.id) continue;
      if (row.movement_date < yearStart) {
        openingQuantity = add(openingQuantity, dec(row.quantity));
        openingValue = add(openingValue, dec(row.value));
      } else {
        inYear.push({
          id: row.id,
          date: row.movement_date,
          kind: row.kind,
          kindLabel: MOVEMENT_LABELS.get(row.kind) ?? row.kind,
          quantity: quantityText(dec(row.quantity)),
          value: money(dec(row.value)),
          sourceReference: row.source_reference,
          file: fileOf(row),
        });
      }
      quantity = add(quantity, dec(row.quantity));
      value = add(value, dec(row.value));
    }
    const totals = { dividends: ZERO_DECIMAL, credits: ZERO_DECIMAL, rebates: ZERO_DECIMAL, retentions: ZERO_DECIMAL };
    const paid: CoopDistribution[] = [];
    for (const row of distributions.rows) {
      if (row.holding_id !== holding.id) continue;
      const amount = dec(row.amount);
      if (row.kind === "dividend") {
        totals.dividends = add(totals.dividends, amount);
        if (row.imputation_credits) totals.credits = add(totals.credits, dec(row.imputation_credits));
      } else if (row.kind === "rebate") totals.rebates = add(totals.rebates, amount);
      else totals.retentions = add(totals.retentions, amount);
      paid.push({
        id: row.id,
        date: row.paid_on,
        kind: row.kind,
        kindLabel: DISTRIBUTION_LABELS.get(row.kind) ?? row.kind,
        amount: money(amount),
        imputationCredits: row.imputation_credits === null ? null : money(dec(row.imputation_credits)),
        sourceReference: row.source_reference,
        file: fileOf(row),
      });
    }
    grand.opening = add(grand.opening, openingValue);
    grand.closing = add(grand.closing, value);
    grand.dividends = add(grand.dividends, totals.dividends);
    grand.credits = add(grand.credits, totals.credits);
    grand.rebates = add(grand.rebates, totals.rebates);
    grand.retentions = add(grand.retentions, totals.retentions);
    return {
      id: holding.id,
      coopName: holding.coop_name,
      shareClass: holding.share_class,
      notes: holding.notes,
      opening: { quantity: quantityText(openingQuantity), value: money(openingValue) },
      movements: inYear,
      closing: { quantity: quantityText(quantity), value: money(value) },
      distributions: paid,
      totals: { dividends: money(totals.dividends), imputationCredits: money(totals.credits), rebates: money(totals.rebates), retentions: money(totals.retentions) },
      hasEntries: holding.has_entries,
    };
  });
  return {
    yearEnds: ends,
    yearStart,
    yearEnd,
    holdings: result,
    totals: {
      openingValue: money(grand.opening),
      closingValue: money(grand.closing),
      dividends: money(grand.dividends),
      imputationCredits: money(grand.credits),
      rebates: money(grand.rebates),
      retentions: money(grand.retentions),
    },
  };
}

/** The files the year's entries name, with their contents, for the year-end pack (CSR9). Removed files have none. */
export async function scheduleSourceFiles(tx: OrgTx, schedule: CoopShareSchedule): Promise<Array<{ id: string; fileName: string; content: Buffer }>> {
  const ids = new Set<string>();
  for (const holding of schedule.holdings) {
    for (const entry of [...holding.movements, ...holding.distributions]) if (entry.file && !entry.file.removed) ids.add(entry.file.id);
  }
  if (ids.size === 0) return [];
  const rows = await tx.query<{ id: string; file_name: string; content: Buffer }>(
    `select id::text, file_name, content from record_attachments
      where id = any($1::bigint[]) and record_type = 'coop_shareholding' and removed_at is null order by record_attachments.id`,
    [[...ids]],
  );
  return rows.rows.map((row) => ({ id: row.id, fileName: row.file_name, content: row.content }));
}

/** Whether there's a register to put in the year-end pack: farming is on and a holding exists. */
export async function hasCoopShareRegister(tx: OrgTx): Promise<boolean> {
  const farming = await tx.query<{ enabled: boolean }>("select coalesce((select enabled from farming_settings where id = true), false) as enabled");
  if (!farming.rows[0]?.enabled) return false;
  return ((await tx.query("select 1 from coop_shareholdings where status = 'active' limit 1")).rowCount ?? 0) > 0;
}
