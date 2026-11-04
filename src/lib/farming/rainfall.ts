import { writeAuditEvent } from "@/lib/audit";
import { parseBankDate } from "@/lib/bank/formats/common";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import type { Position } from "@/lib/farming/geometry";
import { requireFarming } from "@/lib/farming/paddocks";
import { optionalOperationId } from "@/lib/farming/pasture";
import { type DayReading, monthTotals, parseMm, type Period, rainTotals, type RainTotals, seasonTotals, summaryFrom } from "@/lib/farming/rainfall-rules";
import { fileRows, importSource } from "@/lib/farming/soil";
import { requestHash } from "@/lib/idempotency";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Rainfall (decisions 1451-1456; examples RF1-RF8, not yet reviewed): rain
 * gauges on a farm and a reading a gauge a day. Records only: Tohyee
 * fetches no weather from anywhere, and judges nothing. Farm staff and up
 * add gauges and readings and edit readings (who and when is kept);
 * bookkeepers and up remove a reading entered by mistake (it's kept) and
 * import files.
 */

const MAX_IMPORT_ROWS = 5000;

export type RainGauge = {
  id: string;
  farmId: string;
  name: string;
  note: string | null;
  point: Position | null;
  isActive: boolean;
  readings: number;
  last: { readOn: string; mm: string } | null;
};

export type RainReading = {
  id: string;
  farmId: string;
  gaugeId: string;
  gaugeName: string;
  readOn: string;
  mm: string;
  note: string | null;
  source: string;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string | null;
  /** Added by the API from the member list (addPersonNames). */
  createdByName?: string;
  updatedByName?: string;
};

type GaugeRow = { id: string; farm_id: string; name: string; note: string | null; latitude: string | null; longitude: string | null; is_active: boolean; readings: number; last_on: string | null; last_mm: string | null };

async function loadGauges(tx: OrgTx, where: string, params: unknown[]): Promise<RainGauge[]> {
  const rows = await tx.query<GaugeRow>(
    `select g.id::text, g.farm_id::text, g.name, g.note, g.latitude::text, g.longitude::text, g.is_active,
            (select count(*)::int from rainfall_readings r where r.gauge_id = g.id and r.status = 'active') as readings,
            l.read_on::text as last_on, l.mm::text as last_mm
       from rain_gauges g
       left join lateral (select r.read_on, r.mm from rainfall_readings r where r.gauge_id = g.id and r.status = 'active' order by r.read_on desc limit 1) l on true
      where ${where}
      order by g.is_active desc, lower(g.name), g.id`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    name: row.name,
    note: row.note,
    point: row.latitude === null || row.longitude === null ? null : [Number(row.longitude), Number(row.latitude)],
    isActive: row.is_active,
    readings: row.readings,
    last: row.last_on && row.last_mm ? { readOn: row.last_on, mm: row.last_mm } : null,
  }));
}

async function requireFarm(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

async function requireGauge(tx: OrgTx, input: unknown, farmId?: string): Promise<RainGauge> {
  await requireFarming(tx);
  const gauge = (await loadGauges(tx, "g.id = $1", [requireId(input, "gaugeId")]))[0];
  if (!gauge) throw new NotFoundError("Rain gauge not found.");
  await requireFarmAccess(tx, gauge.farmId, "Rain gauge not found.");
  if (farmId && gauge.farmId !== farmId) throw new ConflictError(`${gauge.name} isn't on the farm this was recorded for. Nothing was saved: check the farm and try again.`);
  return gauge;
}

/** A point given as [longitude, latitude] (or { longitude, latitude }), to six places; null clears it. */
function parsePoint(input: unknown): { latitude: string; longitude: string } | null {
  if (input === null || input === "") return null;
  let lon: unknown;
  let lat: unknown;
  if (Array.isArray(input)) [lon, lat] = input;
  else if (input && typeof input === "object") ({ longitude: lon, latitude: lat } = input as Record<string, unknown>);
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new ValidationError("The place on the map must be a longitude and latitude.");
  }
  return { longitude: lon.toFixed(6), latitude: lat.toFixed(6) };
}

function cleanName(input: unknown): string {
  return requireString(input, "Name", { maxLength: 100 }).trim();
}

async function nameFree(tx: OrgTx, farmId: string, name: string, except: string | null) {
  const taken = await tx.query("select 1 from rain_gauges where farm_id = $1 and lower(name) = lower($2) and ($3::bigint is null or id <> $3)", [farmId, name, except]);
  if (taken.rowCount) throw new ConflictError(`There's already a rain gauge called ${name} on this farm.`);
}

// Gauges (RF1) ------------------------------------------------------------------------------------------

export async function listGauges(tx: OrgTx, farmIdInput: unknown, options: { includeRetired?: boolean } = {}): Promise<RainGauge[]> {
  const farmId = await requireFarm(tx, farmIdInput);
  return loadGauges(tx, options.includeRetired ? "g.farm_id = $1" : "g.farm_id = $1 and g.is_active", [farmId]);
}

export async function addGauge(tx: OrgTx, input: { farmId: unknown; name: unknown; note?: unknown; point?: unknown }): Promise<RainGauge> {
  const farmId = await requireFarm(tx, input.farmId);
  const name = cleanName(input.name);
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const point = input.point === undefined ? null : parsePoint(input.point);
  await nameFree(tx, farmId, name, null);
  const row = await tx.query<{ id: string }>(
    "insert into rain_gauges (farm_id, name, note, latitude, longitude, created_by_email) values ($1, $2, $3, $4, $5, $6) returning id::text",
    [farmId, name, note, point?.latitude ?? null, point?.longitude ?? null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.rain_gauge_added", entityType: "rain_gauge", entityId: row.rows[0].id, details: { farmId, name, placed: Boolean(point) } });
  return (await loadGauges(tx, "g.id = $1", [row.rows[0].id]))[0];
}

/** Renames a gauge, changes its note or place, or retires it (its readings stay) or brings it back. */
export async function updateGauge(tx: OrgTx, idInput: unknown, input: { name?: unknown; note?: unknown; point?: unknown; isActive?: unknown }): Promise<RainGauge> {
  const gauge = await requireGauge(tx, idInput);
  const name = input.name === undefined ? gauge.name : cleanName(input.name);
  if (name.toLowerCase() !== gauge.name.toLowerCase()) await nameFree(tx, gauge.farmId, name, gauge.id);
  const note = input.note === undefined ? gauge.note : optionalString(input.note, "Note", { maxLength: 500 });
  const point = input.point === undefined ? (gauge.point ? { longitude: gauge.point[0].toFixed(6), latitude: gauge.point[1].toFixed(6) } : null) : parsePoint(input.point);
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = input.isActive === undefined ? gauge.isActive : (input.isActive as boolean);
  await tx.query("update rain_gauges set name = $2, note = $3, latitude = $4, longitude = $5, is_active = $6, updated_by_email = $7, updated_at = now() where id = $1", [
    gauge.id,
    name,
    note,
    point?.latitude ?? null,
    point?.longitude ?? null,
    isActive,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.rain_gauge_changed", entityType: "rain_gauge", entityId: gauge.id, details: { before: { name: gauge.name, note: gauge.note, point: gauge.point, isActive: gauge.isActive }, after: { name, note, placed: Boolean(point), isActive } } });
  return (await loadGauges(tx, "g.id = $1", [gauge.id]))[0];
}

// Readings (RF2-RF4) ------------------------------------------------------------------------------------

type ReadingRow = { id: string; farm_id: string; gauge_id: string; gauge_name: string; read_on: string; mm: string; note: string | null; source: string; created_by_email: string; created_at: string; updated_by_email: string | null; updated_at: string | null };

async function loadReadings(tx: OrgTx, where: string, params: unknown[]): Promise<RainReading[]> {
  const rows = await tx.query<ReadingRow>(
    `select r.id::text, r.farm_id::text, r.gauge_id::text, g.name as gauge_name, r.read_on::text, r.mm::text, r.note, r.source,
            r.created_by_email, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, r.updated_by_email, to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
       from rainfall_readings r join rain_gauges g on g.id = r.gauge_id
      where r.status = 'active' and ${where}
      order by r.read_on desc, r.id desc`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    farmId: row.farm_id,
    gaugeId: row.gauge_id,
    gaugeName: row.gauge_name,
    readOn: row.read_on,
    mm: row.mm,
    note: row.note,
    source: row.source,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  }));
}

function readDate(input: unknown, today: string): string {
  const readOn = parseIsoDate(input, "Date");
  if (readOn > today) throw new ValidationError("A rain reading can't be for a day that hasn't happened yet.");
  return readOn;
}

async function dayFree(tx: OrgTx, gauge: RainGauge, readOn: string, except: string | null) {
  const taken = await tx.query<{ mm: string }>("select mm::text from rainfall_readings where gauge_id = $1 and read_on = $2 and status = 'active' and ($3::bigint is null or id <> $3)", [gauge.id, readOn, except]);
  if (taken.rowCount) throw new ConflictError(`${gauge.name} already has ${taken.rows[0].mm} mm on ${readOn}. Change that reading instead.`);
}

/**
 * A day's reading for a gauge (RF2): a date (today or earlier), the
 * millimetres and an optional note. Sent again with the same operation id
 * (a phone's queue after the signal dropped), it answers with the first.
 */
export async function addRainReading(tx: OrgTx, input: { farmId?: unknown; gaugeId: unknown; readOn: unknown; mm: unknown; note?: unknown; operationId?: unknown }, options: { today?: string } = {}): Promise<RainReading> {
  const farmId = input.farmId === undefined ? undefined : await requireFarm(tx, input.farmId);
  const gauge = await requireGauge(tx, input.gaugeId, farmId);
  const readOn = readDate(input.readOn, options.today ?? todayIsoDate());
  const mm = parseMm(input.mm);
  const note = optionalString(input.note, "Note", { maxLength: 200 });
  const operationId = optionalOperationId(input.operationId);
  const hash = requestHash("rainfall_reading", { gaugeId: gauge.id, readOn, mm, note });
  if (operationId) {
    const found = (await tx.query<{ id: string; request_hash: string; created_by_email: string; status: string }>("select id::text, request_hash, created_by_email, status from rainfall_readings where operation_id = $1", [operationId])).rows[0];
    if (found) {
      if (found.created_by_email !== tx.actor.email || found.request_hash !== hash) throw new ConflictError("This rain reading was already sent with different details. Nothing was changed: check it and record it again.");
      if (found.status !== "active") throw new ConflictError("This rain reading was saved and then removed. Nothing was changed.");
      return (await loadReadings(tx, "r.id = $1", [found.id]))[0];
    }
  }
  if (!gauge.isActive) throw new ValidationError(`${gauge.name} is retired. Bring it back under Rainfall › Gauges to add readings.`);
  await dayFree(tx, gauge, readOn, null);
  const row = await tx.query<{ id: string }>(
    "insert into rainfall_readings (farm_id, gauge_id, read_on, mm, note, source, created_by_email, operation_id, request_hash) values ($1, $2, $3, $4, $5, 'Typed', $6, $7, $8) returning id::text",
    [gauge.farmId, gauge.id, readOn, mm, note, tx.actor.email, operationId, operationId ? hash : null],
  );
  await writeAuditEvent(tx, { eventType: "farming.rainfall_added", entityType: "rainfall_reading", entityId: row.rows[0].id, details: { gaugeId: gauge.id, readOn, mm } });
  return (await loadReadings(tx, "r.id = $1", [row.rows[0].id]))[0];
}

async function requireReading(tx: OrgTx, idInput: unknown): Promise<RainReading> {
  await requireFarming(tx);
  const id = requireId(idInput, "readingId");
  const reading = (await loadReadings(tx, "r.id = $1", [id]))[0];
  if (!reading) throw new NotFoundError("Rain reading not found, or removed.");
  await requireFarmAccess(tx, reading.farmId, "Rain reading not found, or removed.");
  return reading;
}

/** Changes a reading's date, millimetres or note (RF3). Who changed it and when is kept, with the old values in the audit log. */
export async function updateRainReading(tx: OrgTx, idInput: unknown, input: { readOn?: unknown; mm?: unknown; note?: unknown }, options: { today?: string } = {}): Promise<RainReading> {
  const reading = await requireReading(tx, idInput);
  const gauge = await requireGauge(tx, reading.gaugeId);
  const readOn = input.readOn === undefined ? reading.readOn : readDate(input.readOn, options.today ?? todayIsoDate());
  const mm = input.mm === undefined ? reading.mm : parseMm(input.mm);
  const note = input.note === undefined ? reading.note : optionalString(input.note, "Note", { maxLength: 200 });
  if (readOn === reading.readOn && mm === reading.mm && note === reading.note) return reading;
  if (readOn !== reading.readOn) await dayFree(tx, gauge, readOn, reading.id);
  await tx.query("update rainfall_readings set read_on = $2, mm = $3, note = $4, updated_by_email = $5, updated_at = now() where id = $1", [reading.id, readOn, mm, note, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.rainfall_changed", entityType: "rainfall_reading", entityId: reading.id, details: { before: { readOn: reading.readOn, mm: reading.mm, note: reading.note }, after: { readOn, mm, note } } });
  return (await loadReadings(tx, "r.id = $1", [reading.id]))[0];
}

/** Removes a reading entered by mistake (RF3); it's kept, marked removed, with who and when. */
export async function removeRainReading(tx: OrgTx, idInput: unknown): Promise<void> {
  const reading = await requireReading(tx, idInput);
  await tx.query("update rainfall_readings set status = 'removed', removed_by_email = $2, removed_at = now() where id = $1 and status = 'active'", [reading.id, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.rainfall_removed", entityType: "rainfall_reading", entityId: reading.id, details: { gaugeId: reading.gaugeId, readOn: reading.readOn, mm: reading.mm } });
}

/** A gauge's readings from `from` to `to` (at most about two years at once), newest first. */
export async function listRainReadings(tx: OrgTx, input: { farmId: unknown; gaugeId?: unknown; from: unknown; to: unknown }): Promise<RainReading[]> {
  const farmId = await requireFarm(tx, input.farmId);
  const from = parseIsoDate(input.from, "From");
  const to = parseIsoDate(input.to, "To");
  if (to < from) throw new ValidationError("To can't be before From.");
  if (Date.parse(to) - Date.parse(from) > 800 * 86_400_000) throw new ValidationError("Choose at most two years at a time.");
  if (input.gaugeId !== undefined && input.gaugeId !== null && input.gaugeId !== "") {
    const gauge = await requireGauge(tx, input.gaugeId, farmId);
    return loadReadings(tx, "r.gauge_id = $1 and r.read_on between $2 and $3", [gauge.id, from, to]);
  }
  return loadReadings(tx, "r.farm_id = $1 and r.read_on between $2 and $3", [farmId, from, to]);
}

// History (RF5-RF6) -------------------------------------------------------------------------------------

export type RainfallSummary = {
  gauge: RainGauge;
  onDate: string;
  totals: RainTotals;
  months: Period[];
  seasons: Period[];
  /** The first reading this gauge has, so "no readings last year" can be told from "not kept then". */
  firstReadOn: string | null;
};

/** A gauge's totals to a date: this month, this season and the last 12 months, month by month and season by season, each with the same time last year. */
export async function rainfallSummary(tx: OrgTx, input: { gaugeId: unknown; onDate?: unknown }): Promise<RainfallSummary> {
  const gauge = await requireGauge(tx, input.gaugeId);
  const onDate = input.onDate === undefined || input.onDate === null || input.onDate === "" ? todayIsoDate() : parseIsoDate(input.onDate, "On date");
  const rows = await tx.query<DayReading>(
    "select read_on::text as \"readOn\", mm::text as mm from rainfall_readings where gauge_id = $1 and status = 'active' and read_on between $2 and $3 order by read_on",
    [gauge.id, summaryFrom(onDate), onDate],
  );
  const first = await tx.query<{ first: string | null }>("select min(read_on)::text as first from rainfall_readings where gauge_id = $1 and status = 'active'", [gauge.id]);
  return { gauge, onDate, totals: rainTotals(rows.rows, onDate), months: monthTotals(rows.rows, onDate, 12), seasons: seasonTotals(rows.rows, onDate, 4), firstReadOn: first.rows[0].first };
}

/** Every visible farm's active gauges with this month's and the last 12 months' totals (for the AI). */
export async function rainfallOverview(tx: OrgTx, input: { farmId?: unknown; onDate?: unknown }): Promise<RainfallSummary[]> {
  await requireFarming(tx);
  let where = "g.is_active";
  const params: unknown[] = [];
  if (input.farmId !== undefined && input.farmId !== null && input.farmId !== "") {
    params.push(await requireFarm(tx, input.farmId));
    where += ` and g.farm_id = $${params.length}`;
  } else {
    const visible = await visibleFarmIds(tx);
    if (visible) {
      params.push(visible);
      where += ` and g.farm_id = any($${params.length}::bigint[])`;
    }
  }
  const gauges = await loadGauges(tx, where, params);
  const out: RainfallSummary[] = [];
  for (const gauge of gauges) out.push(await rainfallSummary(tx, { gaugeId: gauge.id, onDate: input.onDate }));
  return out;
}

// Import (RF7) ------------------------------------------------------------------------------------------

type ImportInput = { fileName: unknown; content?: unknown; contentBase64?: unknown; columns?: unknown };
export type RainImportColumns = { date: number | null; mm: number | null };
export type RainImportRow = { line: number; readOn: string | null; mm: string | null; error: string | null };
export type RainImportPreview = { fileName: string; headings: string[]; columns: RainImportColumns; rows: RainImportRow[]; counts: { readings: number; errors: number }; alreadyImportedOn: string | null };

const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function guessColumns(headings: string[]): RainImportColumns {
  const find = (test: (heading: string) => boolean) => {
    const index = headings.findIndex((heading) => test(norm(heading)));
    return index < 0 ? null : index;
  };
  return {
    date: find((heading) => heading === "date" || heading.includes("date") || heading === "day"),
    mm: find((heading) => heading.includes("rain") || heading === "mm" || heading.includes(" mm") || heading.startsWith("mm ") || heading.includes("precip")),
  };
}

function chosenColumns(input: unknown, headings: string[]): RainImportColumns | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const pick = (key: string) => {
    const value = raw[key];
    if (value === null || value === undefined || value === "") return null;
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= headings.length) throw new ValidationError(`The ${key} column isn't in the file.`);
    return index;
  };
  return { date: pick("date"), mm: pick("mm") };
}

async function readImport(tx: OrgTx, gauge: RainGauge, input: ImportInput, today: string) {
  const fileName = requireString(input.fileName, "File name", { maxLength: 200 });
  const { rows: table, sha256 } = await fileRows(fileName, input);
  const start = table.findIndex((cells) => cells.filter((cell) => cell.trim()).length >= 2);
  if (start < 0 || table.length < start + 2) throw new ValidationError("The file needs a heading row and at least one reading.");
  if (table.length - start - 1 > MAX_IMPORT_ROWS) throw new ValidationError(`The file has more than ${MAX_IMPORT_ROWS.toLocaleString("en-NZ")} readings.`);
  const headings = table[start].map((cell) => cell.trim());
  const columns = chosenColumns(input.columns, headings) ?? guessColumns(headings);
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from rainfall_imports where gauge_id = $1 and sha256 = $2", [gauge.id, sha256]);
  const kept = new Map((await tx.query<{ read_on: string; mm: string }>("select read_on::text, mm::text from rainfall_readings where gauge_id = $1 and status = 'active'", [gauge.id])).rows.map((row) => [row.read_on, row.mm]));
  const seen = new Set<string>();
  const rows: RainImportRow[] = table
    .slice(start + 1)
    .map((cells, offset) => ({ cells, line: start + offset + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()))
    .map(({ cells, line }) => {
      const cell = (index: number | null) => (index === null ? "" : (cells[index] ?? "").trim());
      const dateText = cell(columns.date);
      const readOn = dateText ? parseBankDate(dateText) : null;
      const mmText = cell(columns.mm);
      let mm: string | null = null;
      let error: string | null = null;
      try {
        mm = mmText ? parseMm(mmText) : null;
      } catch {
        mm = null;
      }
      if (!readOn) error = dateText ? `"${dateText}" isn't a date.` : "No date.";
      else if (readOn > today) error = "A day that hasn't happened yet.";
      else if (mm === null) error = mmText ? `"${mmText}" isn't millimetres from 0 to 2,000 (one decimal place at most).` : "No rain figure. Type 0 for a dry day.";
      else if (seen.has(readOn)) error = "This day is in the file twice.";
      else if (kept.has(readOn)) error = `${gauge.name} already has ${kept.get(readOn)} mm on this day.`;
      if (readOn && !error) seen.add(readOn);
      return { line, readOn, mm, error };
    });
  return { fileName, sha256, headings, columns, rows, alreadyImportedOn: earlier.rows[0]?.created_at ?? null };
}

export async function previewRainImport(tx: OrgTx, gaugeIdInput: unknown, input: ImportInput, options: { today?: string } = {}): Promise<RainImportPreview> {
  const gauge = await requireGauge(tx, gaugeIdInput);
  const read = await readImport(tx, gauge, input, options.today ?? todayIsoDate());
  const errors = read.rows.filter((row) => row.error).length;
  return { fileName: read.fileName, headings: read.headings, columns: read.columns, rows: read.rows, counts: { readings: read.rows.length - errors, errors }, alreadyImportedOn: read.alreadyImportedOn };
}

/** Imports a gauge's readings from a CSV or .xlsx file (RF7): the good rows are added, the rest are skipped with their reasons. Once a file. */
export async function importRainReadings(tx: OrgTx, gaugeIdInput: unknown, input: ImportInput, options: { today?: string } = {}): Promise<{ imported: number; skipped: number }> {
  const gauge = await requireGauge(tx, gaugeIdInput);
  if (!gauge.isActive) throw new ValidationError(`${gauge.name} is retired. Bring it back to import readings.`);
  await tx.query("select 1 from rain_gauges where id = $1 for update", [gauge.id]);
  const read = await readImport(tx, gauge, input, options.today ?? todayIsoDate());
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported for ${gauge.name} on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (!good.length) throw new ValidationError("There are no readings without errors to import.");
  const source = importSource(read.fileName);
  for (const row of good) {
    await tx.query("insert into rainfall_readings (farm_id, gauge_id, read_on, mm, source, created_by_email) values ($1, $2, $3, $4, $5, $6)", [gauge.farmId, gauge.id, row.readOn, row.mm, source, tx.actor.email]);
  }
  const summary = { imported: good.length, skipped: read.rows.length - good.length };
  await tx.query("insert into rainfall_imports (gauge_id, file_name, sha256, imported, skipped, created_by_email) values ($1, $2, $3, $4, $5, $6)", [gauge.id, read.fileName, read.sha256, summary.imported, summary.skipped, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.rainfall_imported", entityType: "rain_gauge", entityId: gauge.id, details: { fileName: read.fileName, ...summary } });
  return summary;
}
