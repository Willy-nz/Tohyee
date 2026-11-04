import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { toCsv } from "@/lib/csv";
import { isoDateAt, parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { MOB_EVENT_LABELS } from "@/lib/farming/mob-rules";
import { getMob, loadEvents } from "@/lib/farming/mobs";
import { requireFarming } from "@/lib/farming/paddocks";
import { LABEL_NOTE, meatSafeOn, milkSafeFrom, STOCK_UNITS, toBase } from "@/lib/farming/treatment-rules";
import { requestHash } from "@/lib/idempotency";
import { className } from "@/lib/livestock/classes";
import { add, dec, parseDecimalInput, sub, toPlainString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";
import { PdfWriter, type Column } from "@/lib/pdf/writer";
import { currentRecord, currentRecords } from "@/lib/safety/records";
import type { ChemicalData } from "@/lib/safety/shared";
import { optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * Animal treatments, paddock withholding after spraying, and animal-health
 * and chemical product stock (decisions 1431-1438; TRT1-TRT8, common NZ
 * practice, not yet reviewed). Withholding periods are typed from the
 * product's label; Tohyee never supplies one. Products are Safety's
 * chemical register, so there's one product list. Records only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Treatment = {
  id: string;
  farmId: string;
  mobId: string | null;
  mobName: string | null;
  animals: string | null;
  head: number;
  treatedOn: string;
  product: string;
  chemicalRecordId: string | null;
  batch: string | null;
  dose: string;
  quantity: string | null;
  quantityUnit: string | null;
  meatWithholdingDays: number | null;
  milkWithholdingHours: number | null;
  meatSafeOn: string | null;
  milkSafeFrom: string | null;
  reason: string | null;
  givenBy: string;
  status: "active" | "removed";
  removedReason: string | null;
  createdByEmail: string;
  createdAt: string;
};

async function requireFarmId(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

function optionalWhole(input: unknown, label: string, max: number): number | null {
  if (input === undefined || input === null || input === "") return null;
  const value = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isInteger(value) || value < 0 || value > max) throw new ValidationError(`${label} must be a whole number from 0 to ${max.toLocaleString("en-NZ")}.`);
  return value;
}

type TreatmentRow = {
  id: string;
  farm_id: string;
  mob_id: string | null;
  mob_name: string | null;
  mob_kind: string | null;
  mob_class: string | null;
  animals: string | null;
  head: number;
  treated_on: string;
  product: string;
  chemical_record_id: string | null;
  batch: string | null;
  dose: string;
  quantity: string | null;
  quantity_unit: string | null;
  meat: number | null;
  milk: number | null;
  reason: string | null;
  given_by: string;
  status: "active" | "removed";
  removed_reason: string | null;
  created_by_email: string;
  created_at: string;
};

async function loadTreatments(tx: OrgTx, where: string, params: unknown[], limit = 2000): Promise<Treatment[]> {
  const rows = await tx.query<TreatmentRow>(
    `select t.id::text, t.farm_id::text, t.mob_id::text, m.name as mob_name, m.kind as mob_kind, m.class_code as mob_class, t.animals, t.head, t.treated_on::text,
            t.product, t.chemical_record_id::text, t.batch, t.dose, t.quantity::text, t.quantity_unit, t.meat_withholding_days as meat,
            t.milk_withholding_hours as milk, t.reason, t.given_by, t.status, t.removed_reason, t.created_by_email, t.created_at::text
       from animal_treatments t left join mobs m on m.id = t.mob_id
      where ${where}
      order by t.treated_on desc, t.id desc limit ${Math.trunc(limit)}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    mobId: row.mob_id,
    mobName: row.mob_id ? (row.mob_name ?? className(row.mob_kind ?? "", row.mob_class ?? "")) : null,
    animals: row.animals,
    head: row.head,
    treatedOn: row.treated_on,
    product: row.product,
    chemicalRecordId: row.chemical_record_id,
    batch: row.batch,
    dose: row.dose,
    quantity: row.quantity === null ? null : toPlainString(dec(row.quantity)),
    quantityUnit: row.quantity_unit,
    meatWithholdingDays: row.meat,
    milkWithholdingHours: row.milk,
    meatSafeOn: meatSafeOn(row.treated_on, row.meat),
    milkSafeFrom: milkSafeFrom(row.treated_on, row.milk),
    reason: row.reason,
    givenBy: row.given_by,
    status: row.status,
    removedReason: row.removed_reason,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  }));
}

/**
 * Records a treatment (TRT1-TRT2): a mob (all or some of it) or animals by
 * tag, the product (from Safety's chemical register, or typed), dose,
 * quantity used, batch, who gave it, and the meat and milk withholding
 * from the label. A blank withholding is "not entered", never nil: enter 0
 * for nil. Farm staff can record treatments.
 */
export async function recordTreatment(tx: OrgTx, input: Record<string, unknown>): Promise<{ treatment: Treatment; message: string }> {
  const farmId = await requireFarmId(tx, input.farmId);
  const mobId = optionalId(input.mobId, "mobId");
  let mobHead: number | null = null;
  if (mobId) {
    const { mob } = await getMob(tx, mobId);
    if (mob.farmId !== farmId) throw new ConflictError(`${mob.name} isn't on the farm this was recorded for. Nothing was saved.`);
    if (mob.status !== "active") throw new ValidationError(`${mob.name} is closed.`);
    mobHead = mob.head;
  }
  const animals = optionalString(input.animals, "Animals", { maxLength: 500 });
  if (!mobId && !animals) throw new ValidationError("Choose a mob, or say which animals (tags).");
  const head = input.head === undefined || input.head === null || input.head === "" ? mobHead : optionalWhole(input.head, "Head treated", 100000);
  if (!head) throw new ValidationError("Say how many were treated.");
  if (mobHead !== null && head > mobHead) throw new ValidationError(`The mob has ${mobHead} head; ${head} can't be treated.`);
  const treatedOn = input.treatedOn === undefined || input.treatedOn === null || input.treatedOn === "" ? todayIsoDate() : parseIsoDate(input.treatedOn, "Treated on");
  let chemicalRecordId: string | null = null;
  let product = optionalString(input.product, "Product", { maxLength: 150 });
  if (input.chemicalRecordId) {
    if (typeof input.chemicalRecordId !== "string" || !UUID.test(input.chemicalRecordId)) throw new ValidationError("Choose a product from the chemical register.");
    const chemical = await currentRecord<ChemicalData>(tx, "chemical", input.chemicalRecordId);
    chemicalRecordId = chemical.recordId;
    product = product ?? chemical.data.name.slice(0, 150);
  }
  if (!product) throw new ValidationError("Say which product was used.");
  const dose = requireString(input.dose, "Dose", { maxLength: 100 });
  const batch = optionalString(input.batch, "Batch", { maxLength: 60 });
  const quantity = input.quantity === undefined || input.quantity === null || input.quantity === "" ? null : parseDecimalInput(input.quantity, "Quantity used", { maxScale: 3 });
  const quantityUnit = quantity ? requireOneOf(input.quantityUnit, "Quantity unit", STOCK_UNITS) : null;
  const meat = optionalWhole(input.meatWithholdingDays, "Meat withholding (days)", 1000);
  const milk = optionalWhole(input.milkWithholdingHours, "Milk withholding (hours)", 24000);
  const reason = optionalString(input.reason, "Reason", { maxLength: 200 });
  const givenBy = requireString(input.givenBy, "Who gave it", { maxLength: 100 });
  const operationId = input.operationId === undefined || input.operationId === null || input.operationId === "" ? null : typeof input.operationId === "string" && UUID.test(input.operationId) ? input.operationId.toLowerCase() : null;
  if (input.operationId && !operationId) throw new ValidationError("operationId must be a UUID.");
  const hash = requestHash("animal_treatment", { farmId, mobId, animals, head, treatedOn, product, chemicalRecordId, dose, batch, quantity, quantityUnit, meat, milk, reason, givenBy });
  if (operationId) {
    const earlier = await tx.query<{ id: string; request_hash: string | null; created_by_email: string }>("select id::text, request_hash, created_by_email from animal_treatments where operation_id = $1", [operationId]);
    if (earlier.rows[0]) {
      if (earlier.rows[0].request_hash !== hash || earlier.rows[0].created_by_email !== tx.actor.email) throw new ConflictError("This treatment was already sent with different details. Nothing was changed.");
      return { treatment: (await loadTreatments(tx, "t.id = $1", [earlier.rows[0].id]))[0], message: "Already recorded." };
    }
  }
  const row = await tx.query<{ id: string }>(
    `insert into animal_treatments (farm_id, mob_id, animals, head, treated_on, product, chemical_record_id, batch, dose, quantity, quantity_unit,
       meat_withholding_days, milk_withholding_hours, reason, given_by, operation_id, request_hash, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12, $13, $14, $15, $16, $17, $18) returning id::text`,
    [farmId, mobId, animals, head, treatedOn, product, chemicalRecordId, batch, dose, quantity, quantityUnit, meat, milk, reason, givenBy, operationId, operationId ? hash : null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.treatment_recorded", entityType: "animal_treatment", entityId: row.rows[0].id, details: { farmId, mobId, head, treatedOn, product, meat, milk } });
  const treatment = (await loadTreatments(tx, "t.id = $1", [row.rows[0].id]))[0];
  const safe = [treatment.meatSafeOn ? `safe for slaughter from ${treatment.meatSafeOn}` : null, treatment.milkSafeFrom ? `milk safe from ${treatment.milkSafeFrom}` : null].filter(Boolean);
  return { treatment, message: `Treatment recorded${safe.length ? `: ${safe.join(", ")}` : ". No withholding was entered"}.` };
}

/** Removes a treatment recorded by mistake (kept, marked removed, with why). Bookkeepers and up. */
export async function removeTreatment(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<Treatment> {
  await requireFarming(tx);
  const role = tx.actor.role;
  if (role && !roleAtLeast(role, "bookkeeper")) throw new ForbiddenError("Removing a treatment needs the bookkeeper role or higher.");
  const id = requireId(idInput, "treatmentId");
  const found = (await loadTreatments(tx, "t.id = $1", [id]))[0];
  if (!found) throw new NotFoundError("Treatment not found.");
  await requireFarmAccess(tx, found.farmId, "Treatment not found.");
  if (found.status === "removed") return found;
  const reason = requireString(input.reason, "Why it's removed", { maxLength: 500 });
  await tx.query("update animal_treatments set status = 'removed', removed_reason = $2 where id = $1", [id, reason]);
  await writeAuditEvent(tx, { eventType: "farming.treatment_removed", entityType: "animal_treatment", entityId: id, details: { reason } });
  return (await loadTreatments(tx, "t.id = $1", [id]))[0];
}

/** The treatment register for a farm (TRT6): newest first, `from`/`to`, a mob, removed ones with `includeRemoved`. */
export async function listTreatments(tx: OrgTx, input: { farmId: unknown; from?: unknown; to?: unknown; mobId?: unknown; includeRemoved?: unknown }): Promise<Treatment[]> {
  const farmId = await requireFarmId(tx, input.farmId);
  const from = input.from ? parseIsoDate(input.from, "From") : null;
  const to = input.to ? parseIsoDate(input.to, "To") : null;
  const mobId = optionalId(input.mobId, "mobId");
  const removed = input.includeRemoved === true || input.includeRemoved === "true" || input.includeRemoved === "1";
  return loadTreatments(
    tx,
    `t.farm_id = $1 and ($2::date is null or t.treated_on >= $2) and ($3::date is null or t.treated_on <= $3) and ($4::bigint is null or t.mob_id = $4) and ($5 or t.status = 'active')`,
    [farmId, from, to, mobId, removed],
  );
}

// Spray withholding -------------------------------------------------------------------------------

export type SprayWithholding = { id: string; jobId: string; fromOn: string; days: number; safeOn: string; note: string | null; createdByEmail: string };

/**
 * Sets a spray job's grazing withholding from the label (TRT5): the job's
 * paddocks aren't safe to graze until the day spraying finished plus the
 * days. A new figure replaces the old one (kept, marked removed). Anyone
 * who records tractor jobs can set it.
 */
export async function setSprayWithholding(tx: OrgTx, jobIdInput: unknown, input: { days: unknown; note?: unknown }): Promise<SprayWithholding | null> {
  await requireFarming(tx);
  const role = tx.actor.role;
  if (role && role !== "farm_worker" && !roleAtLeast(role, "bookkeeper")) throw new ForbiddenError("Setting a spray job's withholding needs the farm staff or bookkeeper role or higher.");
  if (typeof jobIdInput !== "string" || !UUID.test(jobIdInput)) throw new NotFoundError("Tractor job not found.");
  const job = await tx.query<{ id: string; farm_id: string; operation: string; status: string; finished_at: Date }>("select id::text, farm_id::text, operation, status, finished_at from tractor_jobs where id = $1", [jobIdInput]);
  const row = job.rows[0];
  if (!row) throw new NotFoundError("Tractor job not found.");
  await requireFarmAccess(tx, row.farm_id, "Tractor job not found.");
  if (row.operation !== "spraying") throw new ValidationError("Only a spraying job has a grazing withholding.");
  if (row.status !== "active") throw new ValidationError("That job is withdrawn.");
  await tx.query("update paddock_withholdings set status = 'removed' where tractor_job_id = $1 and status = 'active'", [row.id]);
  if (input.days === null || input.days === "" || input.days === undefined) {
    await writeAuditEvent(tx, { eventType: "farming.spray_withholding_removed", entityType: "tractor_job", entityId: row.id, details: {} });
    return null;
  }
  const days = optionalWhole(input.days, "Grazing withholding (days)", 365)!;
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const fromOn = isoDateAt(new Date(row.finished_at));
  const made = await tx.query<{ id: string }>("insert into paddock_withholdings (farm_id, tractor_job_id, from_on, days, note, created_by_email) values ($1, $2, $3, $4, $5, $6) returning id::text", [
    row.farm_id,
    row.id,
    fromOn,
    days,
    note,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.spray_withholding_set", entityType: "tractor_job", entityId: row.id, details: { days, fromOn } });
  return { id: made.rows[0].id, jobId: row.id, fromOn, days, safeOn: addDaysIso(fromOn, days), note, createdByEmail: tx.actor.email };
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export async function getSprayWithholding(tx: OrgTx, jobIdInput: unknown): Promise<SprayWithholding | null> {
  await requireFarming(tx);
  if (typeof jobIdInput !== "string" || !UUID.test(jobIdInput)) throw new NotFoundError("Tractor job not found.");
  const row = await tx.query<{ id: string; farm_id: string; from_on: string; days: number; note: string | null; created_by_email: string }>(
    "select id::text, farm_id::text, from_on::text, days, note, created_by_email from paddock_withholdings where tractor_job_id = $1 and status = 'active'",
    [jobIdInput],
  );
  const found = row.rows[0];
  if (!found) return null;
  await requireFarmAccess(tx, found.farm_id, "Tractor job not found.");
  return { id: found.id, jobId: jobIdInput, fromOn: found.from_on, days: found.days, safeOn: addDaysIso(found.from_on, found.days), note: found.note, createdByEmail: found.created_by_email };
}

// Product stock -----------------------------------------------------------------------------------

export type ProductUse = { date: string; kind: "received" | "counted" | "disposed" | "treatment" | "spray"; quantity: string; unit: string; text: string };

export type ProductStock = {
  chemicalRecordId: string;
  name: string;
  farmId: string | null;
  /** On hand in `unit`, from the last count plus what came in less what was used or thrown out since. Null before anything is recorded. */
  onHand: string | null;
  unit: string | null;
  lastCountedOn: string | null;
  /** Uses in a unit that can't be added to this stock (e.g. doses against litres): listed, not taken off. */
  notCounted: ProductUse[];
  history: ProductUse[];
};

/**
 * Each chemical's stock on hand (TRT7-TRT8): the last count, plus received,
 * less thrown out, less what treatments and spray jobs since then say they
 * used. mL and g are counted as L and kg. Safety's register is the product
 * list: one product, one place.
 */
export async function productStock(tx: OrgTx, input: { farmId?: unknown } = {}): Promise<ProductStock[]> {
  await requireFarming(tx);
  const farmId = input.farmId ? await requireFarmId(tx, input.farmId) : null;
  const chemicals = (await currentRecords<ChemicalData>(tx, "chemical", { farmId })).filter((record) => !record.data.removed);
  if (!chemicals.length) return [];
  const ids = chemicals.map((record) => record.recordId);
  const moves = await tx.query<{ chemical_record_id: string; movement_type: "received" | "counted" | "disposed"; moved_on: string; quantity: string; unit: string; batch: string | null; note: string | null; id: string }>(
    "select chemical_record_id::text, movement_type, moved_on::text, quantity::text, unit, batch, note, id::text from farm_product_stock s where s.chemical_record_id = any($1::uuid[]) order by s.moved_on, s.id",
    [ids],
  );
  const treatments = await tx.query<{ chemical_record_id: string; treated_on: string; quantity: string; quantity_unit: string; product: string; head: number; mob: string | null }>(
    `select t.chemical_record_id::text, t.treated_on::text, t.quantity::text, t.quantity_unit, t.product, t.head, coalesce(m.name, t.animals) as mob
       from animal_treatments t left join mobs m on m.id = t.mob_id
      where t.chemical_record_id = any($1::uuid[]) and t.status = 'active' and t.quantity is not null order by t.treated_on, t.id`,
    [ids],
  );
  const sprays = await tx.query<{ chemical_record_id: string; finished_at: Date; quantity: string; unit: string; paddocks: number }>(
    `select j.chemical_record_id::text, j.finished_at, j.declared_quantity::text as quantity, j.declared_quantity_unit as unit, cardinality(j.paddock_ids) as paddocks
       from tractor_jobs j where j.chemical_record_id = any($1::uuid[]) and j.status = 'active' and j.declared_quantity is not null order by j.finished_at`,
    [ids],
  );
  return chemicals.map((record) => {
    const history: ProductUse[] = [
      ...moves.rows
        .filter((row) => row.chemical_record_id === record.recordId)
        .map((row) => ({ date: row.moved_on, kind: row.movement_type, quantity: toPlainString(dec(row.quantity)), unit: row.unit, text: [row.movement_type === "counted" ? "Counted" : row.movement_type === "received" ? "Received" : "Thrown out", row.batch ? `batch ${row.batch}` : null, row.note].filter(Boolean).join(", "), order: Number(row.id) })),
      ...treatments.rows
        .filter((row) => row.chemical_record_id === record.recordId)
        .map((row) => ({ date: row.treated_on, kind: "treatment" as const, quantity: toPlainString(dec(row.quantity)), unit: row.quantity_unit, text: `Treated ${row.head} head${row.mob ? ` (${row.mob})` : ""}`, order: 0 })),
      ...sprays.rows
        .filter((row) => row.chemical_record_id === record.recordId)
        .map((row) => ({ date: isoDateAt(new Date(row.finished_at)), kind: "spray" as const, quantity: toPlainString(dec(row.quantity)), unit: row.unit, text: `Sprayed ${row.paddocks} paddock${row.paddocks === 1 ? "" : "s"}`, order: 0 })),
    ]
      // A count is what was there at the end of its day: that day's use and receipts come before it.
      .sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date) : (a.kind === "counted" ? 1 : 0) - (b.kind === "counted" ? 1 : 0)))
      .map(({ order: _order, ...rest }) => {
        void _order;
        return rest;
      });
    const stockMoves = history.filter((entry) => entry.kind === "received" || entry.kind === "counted" || entry.kind === "disposed");
    const baseUnit = stockMoves.length ? toBase("1", stockMoves[stockMoves.length - 1].unit)?.unit ?? stockMoves[stockMoves.length - 1].unit : (record.data.unit ? (toBase("1", record.data.unit)?.unit ?? null) : null);
    let onHand: Decimal | null = null;
    let lastCountedOn: string | null = null;
    const notCounted: ProductUse[] = [];
    for (const entry of history) {
      const base = toBase(entry.quantity, entry.unit);
      if (!base || base.unit !== baseUnit) {
        if (entry.kind === "treatment" || entry.kind === "spray") notCounted.push(entry);
        continue;
      }
      const amount = dec(base.quantity);
      if (entry.kind === "counted") {
        onHand = amount;
        lastCountedOn = entry.date;
      } else if (entry.kind === "received") onHand = add(onHand ?? ZERO_DECIMAL, amount);
      else if (onHand !== null || stockMoves.length) onHand = sub(onHand ?? ZERO_DECIMAL, amount);
    }
    return {
      chemicalRecordId: record.recordId,
      name: record.data.name,
      farmId: record.farmId,
      onHand: onHand === null ? null : toPlainString(onHand),
      unit: baseUnit,
      lastCountedOn,
      notCounted,
      history: history.reverse(),
    };
  });
}

/** Records product received, counted or thrown out (TRT7). Bookkeepers and farm staff. */
export async function recordProductStock(tx: OrgTx, input: Record<string, unknown>): Promise<ProductStock[]> {
  await requireFarming(tx);
  if (typeof input.chemicalRecordId !== "string" || !UUID.test(input.chemicalRecordId)) throw new ValidationError("Choose a product from the chemical register.");
  const chemical = await currentRecord<ChemicalData>(tx, "chemical", input.chemicalRecordId);
  const movementType = requireOneOf(input.movementType, "What happened", ["received", "counted", "disposed"] as const);
  const movedOn = input.movedOn ? parseIsoDate(input.movedOn, "Date") : todayIsoDate();
  const quantity = parseDecimalInput(input.quantity, "Quantity", { maxScale: 3, allowZero: movementType === "counted" });
  const unit = requireOneOf(input.unit, "Unit", STOCK_UNITS);
  const batch = optionalString(input.batch, "Batch", { maxLength: 60 });
  const expiresOn = input.expiresOn ? parseIsoDate(input.expiresOn, "Expiry date") : null;
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  await tx.query(
    "insert into farm_product_stock (chemical_record_id, farm_id, movement_type, moved_on, quantity, unit, batch, expires_on, note, created_by_email) values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)",
    [chemical.recordId, chemical.farmId, movementType, movedOn, quantity, unit, batch, expiresOn, note, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.product_stock_recorded", entityType: "chemical", entityId: chemical.recordId, details: { movementType, movedOn, quantity, unit } });
  return productStock(tx, {});
}

// Exports for farm assurance and processor audits (TRT6) ------------------------------------------

export type ExportFormat = "csv" | "pdf";

async function farmName(tx: OrgTx, farmId: string): Promise<string> {
  return (await tx.query<{ name: string }>("select name from farms where id = $1", [farmId])).rows[0]?.name ?? "Farm";
}

async function pdfOf(title: string, farm: string, period: string, notes: string[], columns: Column[], rows: string[][]): Promise<Uint8Array> {
  const writer = await PdfWriter.create({ title, author: farm, footer: `${farm} · ${title}` });
  writer.text(title, { size: 16, bold: true, gap: 4 });
  writer.text(farm, { size: 11, gap: 2 });
  writer.text(period);
  for (const note of notes) writer.text(note, { muted: true });
  writer.space(8);
  writer.table(columns, rows.length ? rows : [columns.map((_, index) => (index === 0 ? "Nothing recorded" : ""))], { size: 8 });
  return writer.finish();
}

const period = (from: string | null, to: string | null) => (from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `To ${to}` : "All dates");

/** The treatment register as CSV or PDF: every active treatment in the dates, with its withholding and safe dates. */
export async function treatmentRegisterFile(tx: OrgTx, input: { farmId: unknown; from?: unknown; to?: unknown; format: unknown }): Promise<{ fileName: string; contentType: string; content: Uint8Array | string }> {
  const format = requireOneOf(input.format, "format", ["csv", "pdf"] as const);
  const treatments = await listTreatments(tx, { farmId: input.farmId, from: input.from, to: input.to });
  const farm = await farmName(tx, treatments[0]?.farmId ?? requireId(input.farmId, "farmId"));
  const from = input.from ? String(input.from) : null;
  const to = input.to ? String(input.to) : null;
  const header = ["Date", "Mob or animals", "Head", "Product", "Batch", "Dose", "Quantity used", "Reason", "Given by", "Meat WHP (days)", "Safe for slaughter from", "Milk WHP (hours)", "Milk safe from", "Recorded by"];
  const rows = treatments
    .slice()
    .reverse()
    .map((t) => [t.treatedOn, [t.mobName, t.animals].filter(Boolean).join(": "), String(t.head), t.product, t.batch ?? "", t.dose, t.quantity ? `${t.quantity} ${t.quantityUnit}` : "", t.reason ?? "", t.givenBy, t.meatWithholdingDays === null ? "not entered" : String(t.meatWithholdingDays), t.meatSafeOn ?? "", t.milkWithholdingHours === null ? "not entered" : String(t.milkWithholdingHours), t.milkSafeFrom ?? "", t.createdByEmail]);
  const base = `treatment-register-${farm.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
  if (format === "csv") return { fileName: `${base}.csv`, contentType: "text/csv; charset=utf-8", content: toCsv([header, ...rows]) };
  const columns: Column[] = [
    { header: "Date", width: 1 },
    { header: "Mob or animals", width: 1.6 },
    { header: "Head", width: 0.6, align: "right" },
    { header: "Product, batch", width: 1.8 },
    { header: "Dose", width: 1.1 },
    { header: "Given by", width: 1.1 },
    { header: "Meat safe from", width: 1 },
    { header: "Milk safe from", width: 1 },
  ] as Column[];
  const pdfRows = treatments
    .slice()
    .reverse()
    .map((t) => [t.treatedOn, [t.mobName, t.animals].filter(Boolean).join(": "), String(t.head), `${t.product}${t.batch ? `, ${t.batch}` : ""}`, t.dose, t.givenBy, t.meatSafeOn ?? (t.meatWithholdingDays === null ? "not entered" : ""), t.milkSafeFrom ?? (t.milkWithholdingHours === null ? "not entered" : "")]);
  return { fileName: `${base}.pdf`, contentType: "application/pdf", content: await pdfOf("Animal treatment register", farm, period(from, to), [LABEL_NOTE], columns, pdfRows) };
}

/** Stock movement history as CSV or PDF (TRT6): every mob event in the dates (moves, sales, purchases, deaths, births, splits, merges, class changes). */
export async function stockMovementFile(tx: OrgTx, input: { farmId: unknown; from?: unknown; to?: unknown; format: unknown }): Promise<{ fileName: string; contentType: string; content: Uint8Array | string }> {
  const format = requireOneOf(input.format, "format", ["csv", "pdf"] as const);
  const farmId = await requireFarmId(tx, input.farmId);
  const from = input.from ? parseIsoDate(input.from, "From") : null;
  const to = input.to ? parseIsoDate(input.to, "To") : null;
  const events = (await loadEvents(tx, "e.farm_id = $1 and ($2::date is null or e.event_date >= $2) and ($3::date is null or e.event_date <= $3) and e.event_type <> 'weighed'", [farmId, from, to], 20000)).reverse();
  const farm = await farmName(tx, farmId);
  const what = (e: (typeof events)[number]) =>
    [
      MOB_EVENT_LABELS[e.eventType],
      e.fromPaddockName ? `from ${e.fromPaddockName}` : null,
      e.toPaddockName ? `to ${e.toPaddockName}` : null,
      e.otherMobName ? (e.eventType.startsWith("split") || e.eventType.startsWith("merged") ? e.otherMobName : null) : null,
      e.toClassCode ? `to ${className(e.kind, e.toClassCode)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
  const header = ["Date", "Mob", "What", "Head change", "Head after", "Amount excl. GST", "In the livestock head count", "Note", "Recorded by"];
  const rows = events.map((e) => [e.eventDate, e.mobName, what(e), e.headChange ? String(e.headChange) : "", String(e.headAfter), e.amount ?? "", e.livestockMovementId ? "Yes" : "", e.note ?? "", e.createdByEmail]);
  const base = `stock-movements-${farm.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
  if (format === "csv") return { fileName: `${base}.csv`, contentType: "text/csv; charset=utf-8", content: toCsv([header, ...rows]) };
  const columns = [
    { header: "Date", width: 1 },
    { header: "Mob", width: 1.4 },
    { header: "What", width: 2.4 },
    { header: "Change", width: 0.8, align: "right" },
    { header: "Head after", width: 0.8, align: "right" },
  ] as Column[];
  return { fileName: `${base}.pdf`, contentType: "application/pdf", content: await pdfOf("Stock movement history", farm, period(from, to), [], columns, rows.map((row) => row.slice(0, 5))) };
}
