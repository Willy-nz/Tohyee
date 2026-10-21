import { writeAuditEvent } from "@/lib/audit";
import { parseBankDate } from "@/lib/bank/formats/common";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { dec, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import {
  farmCover,
  type FarmCover,
  type Grazing as GrazingSpan,
  grazingEaten,
  growthBetween,
  type Growth,
  isEstimate,
  MAX_COVER,
  parseCover,
  PASTURE_METHODS,
  type PastureMethod,
  type Reading,
  SUPPLEMENT_UNITS,
  type SupplementUnit,
  supplementTotals,
} from "@/lib/farming/pasture-rules";
import { requireFarming } from "@/lib/farming/paddocks";
import { fileRows, type ImportOrigin, importSource } from "@/lib/farming/soil";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * Pasture and feed records (#249 stage 4; examples PF1-PF8, decision 559):
 * cover readings, grazings and supplements fed. Records only: nothing posts,
 * judges a cover or makes a feed plan. Removed records are kept.
 */

const MAX_IMPORT_ROWS = 5000;

type PaddockRow = { id: string; farm_id: string; name: string; status: string; hectares: string | null };

async function paddockRows(tx: OrgTx, where: string, params: unknown[]): Promise<PaddockRow[]> {
  const rows = await tx.query<PaddockRow>(
    `select p.id::text, p.farm_id::text, p.name, p.status,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares
       from paddocks p where ${where} order by p.name, p.id`,
    params,
  );
  return rows.rows;
}

async function requireFarm(tx: OrgTx, farmIdInput: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  return farmId;
}

async function requireActivePaddock(tx: OrgTx, input: unknown): Promise<PaddockRow> {
  await requireFarming(tx);
  const paddock = (await paddockRows(tx, "p.id = $1", [requireId(input, "paddockId")]))[0];
  if (!paddock) throw new NotFoundError("Paddock not found.");
  if (paddock.status !== "active") throw new ValidationError(`${paddock.name} is retired.`);
  return paddock;
}

function requireCover(input: unknown, label: string): number {
  const cover = parseCover(typeof input === "number" ? String(input) : typeof input === "string" ? input : "");
  if (cover === null) throw new ValidationError(`${label} must be a whole number of kg DM/ha from 0 to ${MAX_COVER.toLocaleString("en-NZ")}.`);
  return cover;
}

function optionalCover(input: unknown, label: string): number | null {
  return input === undefined || input === null || input === "" ? null : requireCover(input, label);
}

// Readings (PF1-PF4, PF7) ------------------------------------------------------------------------------

export type PastureReading = Reading & { farmId: string; paddockName: string; estimate: boolean; note: string | null; source: string; createdByEmail: string };

type ReadingRow = { id: string; farm_id: string; paddock_id: string; paddock_name: string; measured_on: string; cover: number; method: PastureMethod; note: string | null; source: string; created_by_email: string };

async function loadReadings(tx: OrgTx, where: string, params: unknown[]): Promise<PastureReading[]> {
  const rows = await tx.query<ReadingRow>(
    `select r.id::text, r.farm_id::text, r.paddock_id::text, p.name as paddock_name, r.measured_on::text, r.cover, r.method, r.note, r.source, r.created_by_email
       from pasture_readings r join paddocks p on p.id = r.paddock_id
      where r.status = 'active' and ${where}
      order by r.measured_on desc, r.id desc`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    measuredOn: row.measured_on,
    cover: row.cover,
    method: row.method,
    estimate: isEstimate(row.method),
    note: row.note,
    source: row.source,
    createdByEmail: row.created_by_email,
  }));
}

export async function listReadings(tx: OrgTx, input: { farmId: unknown; paddockId?: unknown }): Promise<PastureReading[]> {
  const farmId = await requireFarm(tx, input.farmId);
  if (input.paddockId) return loadReadings(tx, "r.farm_id = $1 and r.paddock_id = $2", [farmId, requireId(input.paddockId, "paddockId")]);
  return loadReadings(tx, "r.farm_id = $1", [farmId]);
}

export async function addReading(tx: OrgTx, input: { paddockId: unknown; measuredOn: unknown; cover: unknown; method: unknown; note?: unknown }): Promise<PastureReading> {
  const paddock = await requireActivePaddock(tx, input.paddockId);
  const measuredOn = parseIsoDate(input.measuredOn, "Measured on");
  const cover = requireCover(input.cover, "Cover");
  const method = requireOneOf(input.method, "Method", PASTURE_METHODS);
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const row = await tx.query<{ id: string }>(
    "insert into pasture_readings (farm_id, paddock_id, measured_on, cover, method, note, source, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text",
    // Recorded by a farm app, the record says which (FA3).
    [paddock.farm_id, paddock.id, measuredOn, cover, method, note, (tx.actor.via ? `Recorded via ${tx.actor.via}` : "Entered in Tohyee").slice(0, 200), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.pasture_reading_added", entityType: "pasture_reading", entityId: row.rows[0].id, details: { paddockId: paddock.id, measuredOn, cover, method } });
  return (await loadReadings(tx, "r.id = $1", [row.rows[0].id]))[0];
}

export async function removeReading(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "readingId");
  const removed = await tx.query("update pasture_readings set status = 'removed' where id = $1 and status = 'active' returning id", [id]);
  if (!removed.rowCount) throw new NotFoundError("Pasture reading not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "farming.pasture_reading_removed", entityType: "pasture_reading", entityId: id, details: {} });
}

export type ReadingImportColumns = { paddock: number | null; date: number | null; cover: number | null; method: number | null };
export type ReadingImportRow = { line: number; paddockText: string; paddockId: string | null; measuredOn: string | null; cover: number | null; method: PastureMethod | null; error: string | null };
export type ReadingImportPreview = { fileName: string; headings: string[]; columns: ReadingImportColumns; rows: ReadingImportRow[]; counts: { readings: number; errors: number }; alreadyImportedOn: string | null };

type ImportInput = { fileName: unknown; content?: unknown; contentBase64?: unknown; columns?: unknown; method?: unknown };

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();

function guessColumns(headings: string[]): ReadingImportColumns {
  const find = (test: (heading: string) => boolean) => {
    const index = headings.findIndex((heading) => test(norm(heading)));
    return index < 0 ? null : index;
  };
  return {
    paddock: find((heading) => heading === "paddock" || heading.startsWith("paddock ") || heading === "name" || heading === "block"),
    date: find((heading) => heading === "date" || heading.includes("date") || heading === "measured" || heading === "measured on"),
    cover: find((heading) => heading.includes("cover") || heading.includes("kg dm/ha") || heading.includes("kgdm/ha") || heading === "kg dm"),
    method: find((heading) => heading === "method" || heading === "source"),
  };
}

function chosenColumns(input: unknown, headings: string[]): ReadingImportColumns | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const pick = (key: string) => {
    const value = raw[key];
    if (value === null || value === undefined || value === "") return null;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= headings.length) throw new ValidationError(`The ${key} column isn't in the file.`);
    return index;
  };
  return { paddock: pick("paddock"), date: pick("date"), cover: pick("cover"), method: pick("method") };
}

function methodFrom(text: string): PastureMethod | null {
  const value = norm(text);
  if (!value) return null;
  if (value.includes("plate") || value.includes("rpm") || value.includes("meter")) return "plate_meter";
  if (value.includes("visual") || value.includes("eye")) return "visual";
  if (value.includes("satellite")) return "satellite";
  if (value.includes("model")) return "model";
  if (value.includes("measured") || value.includes("other")) return "measured_other";
  return null;
}

async function readImport(tx: OrgTx, farmId: string, input: ImportInput) {
  const fileName = requireString(input.fileName, "File name", { maxLength: 200 });
  const { rows: table, sha256 } = await fileRows(fileName, input);
  const start = table.findIndex((cells) => cells.filter((cell) => cell.trim()).length >= 2);
  if (start < 0 || table.length < start + 2) throw new ValidationError("The file needs a heading row and at least one reading.");
  if (table.length - start - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`The file has more than ${MAX_IMPORT_ROWS} readings.`);
  const headings = table[start].map((cell) => cell.trim());
  const columns = chosenColumns(input.columns, headings) ?? guessColumns(headings);
  const fileMethod = input.method === undefined || input.method === null || input.method === "" ? null : requireOneOf(input.method, "Method", PASTURE_METHODS);
  const paddocks = await paddockRows(tx, "p.farm_id = $1 and p.status = 'active'", [farmId]);
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = 'pasture_readings' and sha256 = $2", [farmId, sha256]);
  const rows: ReadingImportRow[] = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, line }) => {
      const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
      const paddockText = cell(columns.paddock);
      const paddock = paddocks.find((row) => row.name.toLowerCase() === paddockText.toLowerCase()) ?? null;
      const dateText = cell(columns.date);
      const measuredOn = dateText ? parseBankDate(dateText) : null;
      const coverText = cell(columns.cover);
      const cover = parseCover(coverText);
      const methodText = cell(columns.method);
      const method = methodFrom(methodText) ?? fileMethod;
      let error: string | null = null;
      if (!paddockText) error = "No paddock.";
      else if (!paddock) error = `No paddock called "${paddockText}" on this farm.`;
      else if (!measuredOn) error = dateText ? `"${dateText}" isn't a date.` : "No date.";
      else if (cover === null) error = coverText ? `"${coverText}" isn't a whole number of kg DM/ha from 0 to 20,000.` : "No cover.";
      else if (!method) error = methodText ? `"${methodText}" isn't a method Tohyee knows; choose one for the file.` : "No method: choose one for the file.";
      return { line, paddockText, paddockId: paddock?.id ?? null, measuredOn, cover, method, error };
    });
  return { fileName, sha256, headings, columns, rows, alreadyImportedOn: earlier.rows[0]?.created_at ?? null };
}

export async function previewReadingImport(tx: OrgTx, farmIdInput: unknown, input: ImportInput): Promise<ReadingImportPreview> {
  const farmId = await requireFarm(tx, farmIdInput);
  const read = await readImport(tx, farmId, input);
  const errors = read.rows.filter((row) => row.error).length;
  return { fileName: read.fileName, headings: read.headings, columns: read.columns, rows: read.rows, counts: { readings: read.rows.length - errors, errors }, alreadyImportedOn: read.alreadyImportedOn };
}

export async function importReadings(tx: OrgTx, farmIdInput: unknown, input: ImportInput, options: ImportOrigin = {}): Promise<{ imported: number; skipped: number }> {
  const farmId = await requireFarm(tx, farmIdInput);
  await tx.query("select 1 from farms where id = $1 for update", [farmId]);
  const read = await readImport(tx, farmId, input);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (good.length === 0) throw new ValidationError("There are no readings without errors to import.");
  for (const row of good) {
    await tx.query(
      "insert into pasture_readings (farm_id, paddock_id, measured_on, cover, method, source, created_by_email) values ($1, $2, $3, $4, $5, $6, $7)",
      [farmId, row.paddockId, row.measuredOn, row.cover, row.method, importSource(read.fileName, options), tx.actor.email],
    );
  }
  const summary = { imported: good.length, skipped: read.rows.length - good.length };
  const origin = options.filedFromPrivateMail ? { filedFromPrivateMail: true } : {};
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'pasture_readings', $2, $3, $4::jsonb, $5)", [farmId, read.fileName, read.sha256, JSON.stringify({ ...summary, ...origin }), tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.pasture_readings_imported", entityType: "farm", entityId: farmId, details: { fileName: read.fileName, ...summary, ...origin } });
  return summary;
}

// Grazings (PF5) ----------------------------------------------------------------------------------------

export type GrazingRecord = {
  id: string;
  paddockId: string;
  paddockName: string;
  mob: string;
  head: number | null;
  inOn: string;
  outOn: string | null;
  preCover: number | null;
  postCover: number | null;
  note: string | null;
  eaten: ReturnType<typeof grazingEaten>;
  createdByEmail: string;
};

type GrazingRow = { id: string; paddock_id: string; paddock_name: string; hectares: string | null; mob: string; head: number | null; in_on: string; out_on: string | null; pre_cover: number | null; post_cover: number | null; note: string | null; created_by_email: string };

async function loadGrazings(tx: OrgTx, where: string, params: unknown[]): Promise<GrazingRecord[]> {
  const rows = await tx.query<GrazingRow>(
    `select g.id::text, g.paddock_id::text, p.name as paddock_name,
            coalesce(p.effective_ha, round((select b.mapped_ha from paddock_boundaries b where b.paddock_id = p.id order by b.id desc limit 1), 2))::text as hectares,
            g.mob, g.head, g.in_on::text, g.out_on::text, g.pre_cover, g.post_cover, g.note, g.created_by_email
       from grazings g join paddocks p on p.id = g.paddock_id
      where g.status = 'active' and ${where}
      order by g.in_on desc, g.id desc`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    mob: row.mob,
    head: row.head,
    inOn: row.in_on,
    outOn: row.out_on,
    preCover: row.pre_cover,
    postCover: row.post_cover,
    note: row.note,
    eaten: grazingEaten({ preCover: row.pre_cover, postCover: row.post_cover, hectares: row.hectares, head: row.head }),
    createdByEmail: row.created_by_email,
  }));
}

export async function listGrazings(tx: OrgTx, input: { farmId: unknown; paddockId?: unknown }): Promise<GrazingRecord[]> {
  const farmId = await requireFarm(tx, input.farmId);
  if (input.paddockId) return loadGrazings(tx, "g.farm_id = $1 and g.paddock_id = $2", [farmId, requireId(input.paddockId, "paddockId")]);
  return loadGrazings(tx, "g.farm_id = $1", [farmId]);
}

function optionalHead(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return null;
  const value = typeof input === "number" ? input : Number(String(input).replace(/,/g, ""));
  if (!Number.isInteger(value) || value < 1 || value > 100000) throw new ValidationError("Head must be a whole number from 1 to 100,000.");
  return value;
}

export async function addGrazing(tx: OrgTx, input: { paddockId: unknown; mob: unknown; head?: unknown; inOn: unknown; outOn?: unknown; preCover?: unknown; postCover?: unknown; note?: unknown }): Promise<GrazingRecord> {
  const paddock = await requireActivePaddock(tx, input.paddockId);
  const mob = requireString(input.mob, "Mob", { maxLength: 100 });
  const inOn = parseIsoDate(input.inOn, "Day in");
  const outOn = input.outOn === undefined || input.outOn === null || input.outOn === "" ? null : parseIsoDate(input.outOn, "Day out");
  if (outOn !== null && outOn < inOn) throw new ValidationError("The day out can't be before the day in.");
  if (outOn === null) {
    const open = await tx.query("select 1 from grazings where paddock_id = $1 and status = 'active' and out_on is null", [paddock.id]);
    if (open.rowCount) throw new ConflictError(`${paddock.name} already has a mob in it. Record the day out first.`);
  }
  const row = await tx.query<{ id: string }>(
    "insert into grazings (farm_id, paddock_id, mob, head, in_on, out_on, pre_cover, post_cover, note, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text",
    [paddock.farm_id, paddock.id, mob, optionalHead(input.head), inOn, outOn, optionalCover(input.preCover, "Cover before"), optionalCover(input.postCover, "Cover after"), optionalString(input.note, "Note", { maxLength: 200 }), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.grazing_added", entityType: "grazing", entityId: row.rows[0].id, details: { paddockId: paddock.id, mob, inOn, outOn } });
  return (await loadGrazings(tx, "g.id = $1", [row.rows[0].id]))[0];
}

/** Records the day out (and optionally the cover after) for a mob still in a paddock. */
export async function closeGrazing(tx: OrgTx, idInput: unknown, input: { outOn: unknown; postCover?: unknown }): Promise<GrazingRecord> {
  await requireFarming(tx);
  const id = requireId(idInput, "grazingId");
  const current = await tx.query<{ in_on: string; out_on: string | null }>("select in_on::text, out_on::text from grazings where id = $1 and status = 'active' for update", [id]);
  if (!current.rows[0]) throw new NotFoundError("Grazing not found.");
  if (current.rows[0].out_on !== null) throw new ConflictError("That mob's day out is already recorded.");
  const outOn = parseIsoDate(input.outOn, "Day out");
  if (outOn < current.rows[0].in_on) throw new ValidationError("The day out can't be before the day in.");
  const postCover = optionalCover(input.postCover, "Cover after");
  await tx.query("update grazings set out_on = $2, post_cover = coalesce($3, post_cover) where id = $1", [id, outOn, postCover]);
  await writeAuditEvent(tx, { eventType: "farming.grazing_closed", entityType: "grazing", entityId: id, details: { outOn, postCover } });
  return (await loadGrazings(tx, "g.id = $1", [id]))[0];
}

export async function removeGrazing(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "grazingId");
  const removed = await tx.query("update grazings set status = 'removed' where id = $1 and status = 'active' returning id", [id]);
  if (!removed.rowCount) throw new NotFoundError("Grazing not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "farming.grazing_removed", entityType: "grazing", entityId: id, details: {} });
}

// Supplements (PF6) -------------------------------------------------------------------------------------

export type Supplement = { id: string; paddockId: string | null; paddockName: string | null; fedOn: string; feed: string; quantity: string; unit: SupplementUnit; kgDm: string | null; counted: boolean; mob: string | null; note: string | null; createdByEmail: string };

type SupplementRow = { id: string; paddock_id: string | null; paddock_name: string | null; fed_on: string; feed: string; quantity: string; unit: SupplementUnit; kg_dm: string | null; mob: string | null; note: string | null; created_by_email: string };

async function loadSupplements(tx: OrgTx, where: string, params: unknown[]): Promise<Supplement[]> {
  const rows = await tx.query<SupplementRow>(
    `select s.id::text, s.paddock_id::text, p.name as paddock_name, s.fed_on::text, s.feed, s.quantity::text, s.unit, s.kg_dm::text, s.mob, s.note, s.created_by_email
       from supplements_fed s left join paddocks p on p.id = s.paddock_id
      where s.status = 'active' and ${where}
      order by s.fed_on desc, s.id desc`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    fedOn: row.fed_on,
    feed: row.feed,
    quantity: toFixedString(dec(row.quantity), 2),
    unit: row.unit,
    kgDm: row.kg_dm === null ? null : toFixedString(dec(row.kg_dm), 2),
    counted: row.unit === "kg_dm" || row.kg_dm !== null,
    mob: row.mob,
    note: row.note,
    createdByEmail: row.created_by_email,
  }));
}

export async function listSupplements(tx: OrgTx, input: { farmId: unknown }): Promise<Supplement[]> {
  const farmId = await requireFarm(tx, input.farmId);
  return loadSupplements(tx, "s.farm_id = $1", [farmId]);
}

export async function addSupplement(tx: OrgTx, input: { farmId: unknown; paddockId?: unknown; fedOn: unknown; feed: unknown; quantity: unknown; unit: unknown; kgDm?: unknown; mob?: unknown; note?: unknown }): Promise<Supplement> {
  const farmId = await requireFarm(tx, input.farmId);
  let paddockId: string | null = null;
  if (input.paddockId !== undefined && input.paddockId !== null && input.paddockId !== "") {
    const paddock = await requireActivePaddock(tx, input.paddockId);
    if (paddock.farm_id !== farmId) throw new ValidationError(`${paddock.name} isn't on this farm.`);
    paddockId = paddock.id;
  }
  const unit = requireOneOf(input.unit, "Unit", SUPPLEMENT_UNITS);
  const quantity = parseDecimalInput(input.quantity, "Quantity", { maxScale: 2 });
  const kgDm = input.kgDm === undefined || input.kgDm === null || input.kgDm === "" ? null : parseDecimalInput(input.kgDm, "kg DM", { maxScale: 2, allowZero: true });
  if (unit === "kg_dm") {
    if (kgDm !== null) throw new ValidationError("A quantity in kg DM is its own kg DM; leave kg DM blank.");
  }
  const row = await tx.query<{ id: string }>(
    "insert into supplements_fed (farm_id, paddock_id, fed_on, feed, quantity, unit, kg_dm, mob, note, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text",
    [farmId, paddockId, parseIsoDate(input.fedOn, "Fed on"), requireString(input.feed, "Feed", { maxLength: 100 }), quantity, unit, kgDm, optionalString(input.mob, "Mob", { maxLength: 100 }), optionalString(input.note, "Note", { maxLength: 200 }), tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.supplement_added", entityType: "supplement_fed", entityId: row.rows[0].id, details: { farmId, unit, quantity, kgDm } });
  return (await loadSupplements(tx, "s.id = $1", [row.rows[0].id]))[0];
}

export async function removeSupplement(tx: OrgTx, idInput: unknown): Promise<void> {
  await requireFarming(tx);
  const id = requireId(idInput, "supplementId");
  const removed = await tx.query("update supplements_fed set status = 'removed' where id = $1 and status = 'active' returning id", [id]);
  if (!removed.rowCount) throw new NotFoundError("Supplement not found, or already removed.");
  await writeAuditEvent(tx, { eventType: "farming.supplement_removed", entityType: "supplement_fed", entityId: id, details: {} });
}

// Summary (PF2-PF4, PF6) --------------------------------------------------------------------------------

export type PaddockPasture = { paddockId: string; name: string; hectares: string | null; latest: PastureReading | null; growth: Growth | null; inNow: GrazingRecord | null };

export type PastureSummary = {
  cover: FarmCover;
  paddocks: PaddockPasture[];
  /** kg DM of supplements fed in each month, newest first (PF6). */
  supplementMonths: Array<{ month: string; kgDm: string; notCounted: Array<{ fedOn: string; feed: string; quantity: string; unit: SupplementUnit }> }>;
};

/** The farm's cover on a date, each paddock's latest reading and growth, who's in, and supplements by month. */
export async function pastureSummary(tx: OrgTx, input: { farmId: unknown; onDate: unknown }): Promise<PastureSummary> {
  const farmId = await requireFarm(tx, input.farmId);
  const onDate = parseIsoDate(input.onDate, "On date");
  const paddocks = await paddockRows(tx, "p.farm_id = $1 and p.status = 'active'", [farmId]);
  const readings = (await loadReadings(tx, "r.farm_id = $1 and r.measured_on <= $2", [farmId, onDate])).sort((a, b) => b.measuredOn.localeCompare(a.measuredOn) || Number(b.id) - Number(a.id));
  const grazings = await loadGrazings(tx, "g.farm_id = $1", [farmId]);
  const spans: GrazingSpan[] = grazings.map((grazing) => ({ paddockId: grazing.paddockId, inOn: grazing.inOn, outOn: grazing.outOn }));
  const result: PaddockPasture[] = paddocks.map((paddock) => {
    const own = readings.filter((reading) => reading.paddockId === paddock.id);
    const latest = own[0] ?? null;
    const previous = own[1] ?? null;
    return {
      paddockId: paddock.id,
      name: paddock.name,
      hectares: paddock.hectares,
      latest,
      growth: latest && previous ? growthBetween(previous, latest, spans) : null,
      inNow: grazings.find((grazing) => grazing.paddockId === paddock.id && grazing.inOn <= onDate && (grazing.outOn === null || grazing.outOn >= onDate)) ?? null,
    };
  });
  const cover = farmCover(onDate, result.map((paddock) => ({ paddockId: paddock.paddockId, name: paddock.name, hectares: paddock.hectares, latest: paddock.latest })));
  const supplements = await loadSupplements(tx, "s.farm_id = $1", [farmId]);
  const months = new Map<string, Supplement[]>();
  for (const line of supplements) months.set(line.fedOn.slice(0, 7), [...(months.get(line.fedOn.slice(0, 7)) ?? []), line]);
  const supplementMonths = [...months.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, lines]) => {
      const totals = supplementTotals(lines);
      return { month, kgDm: totals.kgDm, notCounted: totals.notCounted.map((line) => ({ fedOn: line.fedOn, feed: line.feed, quantity: line.quantity, unit: line.unit })) };
    });
  return { cover, paddocks: result, supplementMonths };
}

/** A paddock's readings (with growth from each to the one before) and grazings, newest first. */
export async function paddockPasture(tx: OrgTx, paddockIdInput: unknown): Promise<{ readings: Array<PastureReading & { growth: Growth | null }>; grazings: GrazingRecord[] }> {
  await requireFarming(tx);
  const paddockId = requireId(paddockIdInput, "paddockId");
  const found = await tx.query("select 1 from paddocks where id = $1", [paddockId]);
  if (!found.rowCount) throw new NotFoundError("Paddock not found.");
  const readings = await loadReadings(tx, "r.paddock_id = $1", [paddockId]);
  const grazings = await loadGrazings(tx, "g.paddock_id = $1", [paddockId]);
  const spans = grazings.map((grazing) => ({ paddockId: grazing.paddockId, inOn: grazing.inOn, outOn: grazing.outOn }));
  return { readings: readings.map((reading, index) => ({ ...reading, growth: readings[index + 1] ? growthBetween(readings[index + 1], reading, spans) : null })), grazings };
}
