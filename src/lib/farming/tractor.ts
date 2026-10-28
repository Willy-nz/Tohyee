import { createHash } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess } from "@/lib/farming/access";
import { computeCoverage } from "@/lib/farming/coverage";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import { requireFarming } from "@/lib/farming/paddocks";
import {
  type EquipmentSettings,
  EQUIPMENT_KINDS,
  type JobSettings,
  type JobTrack,
  OPERATIONS,
  type PackedPoint,
  QUANTITY_UNITS,
  RATE_UNITS,
  toCoverageTrack,
  TRACK_EVENTS,
  type TrackEvent,
  type TractorEquipment,
  type TractorJob,
  type TractorJobListItem,
} from "@/lib/farming/tractor-shared";
import { parseDecimalInput } from "@/lib/money/decimal";
import { currentRecord } from "@/lib/safety/records";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * Tractor and spreader jobs (#472 stage 5, decisions 1020-1027).
 *
 * Who sees what (decision 1025): farm staff run jobs on the farms they're
 * assigned to and see their own jobs; viewers and above see every job on the
 * farms they can see. Recording needs the farm work "record" level (farm
 * staff, or bookkeeper and above). Linking a job to a fertiliser plan needs
 * bookkeeper or above, as fertiliser plans do.
 *
 * A job's id comes from the phone. Sending the same job again returns the
 * one already saved; a different job under the same id is refused, so a
 * retry never makes a second job (decision 1026).
 */

export const MAX_POINTS = 100_000;
export const MAX_JOB_BYTES = 12 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireUuid(input: unknown, field: string): string {
  if (typeof input !== "string" || !UUID.test(input.toLowerCase())) throw new ValidationError(`${field} isn't valid.`);
  return input.toLowerCase();
}

function canRecord(tx: OrgTx): boolean {
  const role = tx.actor.role;
  return role === "farm_worker" || (role != null && roleAtLeast(role, "bookkeeper")) || !tx.actor.userId;
}

function requireRecorder(tx: OrgTx): void {
  if (!canRecord(tx)) throw new ForbiddenError("Recording tractor jobs needs the farm staff or bookkeeper role or higher.");
}

const isStaff = (tx: OrgTx) => tx.actor.role === "farm_worker";

function canLink(tx: OrgTx): boolean {
  return tx.actor.role != null && roleAtLeast(tx.actor.role, "bookkeeper");
}

/** Metres as a decimal string with up to 2 places, within ±limit (or 0 < width ≤ limit). */
function metres(input: unknown, field: string, options: { min: number; max: number; allowZero: boolean }): string {
  const text = parseDecimalInput(input ?? "0", field, { maxScale: 2, allowNegative: options.min < 0, allowZero: options.allowZero });
  const value = Number(text);
  if (value < options.min || value > options.max) throw new ValidationError(`${field} must be from ${options.min} to ${options.max} metres.`);
  return text;
}

// Equipment ------------------------------------------------------------------------------------------------

type EquipmentRow = { id: string; name: string; kind: TractorEquipment["kind"]; safety_equipment_id: string | null; fixed_asset_id: string | null; is_active: boolean };
type SettingsRow = { id: string; equipment_id: string; width_m: string; lateral_offset_m: string; back_offset_m: string; note: string | null; created_by_email: string; created_at: string };

function toSettings(row: SettingsRow): EquipmentSettings {
  return { id: row.id, widthM: row.width_m, lateralM: row.lateral_offset_m, backM: row.back_offset_m, note: row.note, createdByEmail: row.created_by_email, createdAt: row.created_at };
}

export async function listTractorEquipment(tx: OrgTx, options: { includeRetired?: boolean } = {}): Promise<TractorEquipment[]> {
  await requireFarming(tx);
  const rows = await tx.query<EquipmentRow>(
    "select id::text, name, kind, safety_equipment_id::text, fixed_asset_id::text, is_active from tractor_equipment where $1 or is_active order by is_active desc, lower(name), tractor_equipment.id",
    [options.includeRetired === true],
  );
  const settings = await tx.query<SettingsRow>(
    `select id::text, equipment_id::text, width_m::text, lateral_offset_m::text, back_offset_m::text, note, created_by_email,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
       from tractor_equipment_settings order by tractor_equipment_settings.id desc`,
  );
  return rows.rows.map((row) => {
    const history = settings.rows.filter((entry) => entry.equipment_id === row.id).map(toSettings);
    return { id: row.id, name: row.name, kind: row.kind, safetyEquipmentId: row.safety_equipment_id, fixedAssetId: canLink(tx) ? row.fixed_asset_id : null, isActive: row.is_active, current: history[0] ?? null, history };
  });
}

async function checkEquipmentLinks(tx: OrgTx, input: { safetyEquipmentId?: unknown; fixedAssetId?: unknown }): Promise<{ safetyEquipmentId: string | null; fixedAssetId: string | null }> {
  let safetyEquipmentId: string | null = null;
  if (input.safetyEquipmentId != null && input.safetyEquipmentId !== "") {
    const record = await currentRecord<{ name: string }>(tx, "equipment", requireUuid(input.safetyEquipmentId, "The machine in Safety"));
    if (record.farmId && !(await canSeeFarm(tx, record.farmId))) throw new NotFoundError("That safety record wasn't found.");
    safetyEquipmentId = record.recordId;
  }
  let fixedAssetId: string | null = null;
  if (input.fixedAssetId != null && input.fixedAssetId !== "") {
    if (!canLink(tx)) throw new ForbiddenError("Linking a fixed asset needs the bookkeeper role or higher.");
    fixedAssetId = requireId(input.fixedAssetId, "Fixed asset");
    const found = await tx.query("select 1 from fixed_assets where id = $1", [fixedAssetId]);
    if (!found.rows[0]) throw new ValidationError("That fixed asset wasn't found.");
  }
  return { safetyEquipmentId, fixedAssetId };
}

/** Adds a spreader, sprayer or mower with its width and offsets. */
export async function addTractorEquipment(tx: OrgTx, input: Record<string, unknown>): Promise<TractorEquipment> {
  await requireFarming(tx);
  requireRecorder(tx);
  const name = requireString(input.name, "Name", { maxLength: 100 });
  const kind = requireOneOf(input.kind, "Kind", EQUIPMENT_KINDS);
  const links = await checkEquipmentLinks(tx, input);
  const clash = await tx.query("select 1 from tractor_equipment where lower(name) = lower($1) and is_active", [name]);
  if (clash.rows[0]) throw new ConflictError(`There's already equipment called ${name}.`);
  const row = await tx.query<{ id: string }>(
    "insert into tractor_equipment (name, kind, safety_equipment_id, fixed_asset_id, created_by_email) values ($1, $2, $3, $4, $5) returning id::text",
    [name, kind, links.safetyEquipmentId, links.fixedAssetId, tx.actor.email],
  );
  const id = row.rows[0].id;
  await insertSettings(tx, id, input);
  await writeAuditEvent(tx, { eventType: "farming.tractor_equipment_added", entityType: "tractor_equipment", entityId: id, details: { name, kind } });
  return (await listTractorEquipment(tx, { includeRetired: true })).find((entry) => entry.id === id)!;
}

async function insertSettings(tx: OrgTx, equipmentId: string, input: Record<string, unknown>): Promise<void> {
  const width = metres(input.widthM, "Working width", { min: 0.1, max: 60, allowZero: false });
  const lateral = metres(input.lateralM, "Offset to the side", { min: -30, max: 30, allowZero: true });
  const back = metres(input.backM, "Offset behind", { min: -30, max: 30, allowZero: true });
  await tx.query("insert into tractor_equipment_settings (equipment_id, width_m, lateral_offset_m, back_offset_m, note, created_by_email) values ($1, $2, $3, $4, $5, $6)", [
    equipmentId,
    width,
    lateral,
    back,
    optionalString(input.note, "Note", { maxLength: 500 }),
    tx.actor.email,
  ]);
}

/**
 * Changes equipment: a new width or offsets (`widthM`, `lateralM`, `backM`)
 * add a new timestamped version; `name`, `kind`, links and `retired` change
 * the equipment itself. Old jobs keep the settings they were driven with.
 */
export async function changeTractorEquipment(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<TractorEquipment> {
  await requireFarming(tx);
  requireRecorder(tx);
  const id = requireId(idInput, "Equipment");
  const existing = await tx.query<EquipmentRow>("select id::text, name, kind, safety_equipment_id::text, fixed_asset_id::text, is_active from tractor_equipment where id = $1 for update", [id]);
  const row = existing.rows[0];
  if (!row) throw new NotFoundError("That equipment wasn't found.");
  if (input.widthM !== undefined || input.lateralM !== undefined || input.backM !== undefined) {
    const current = (await listTractorEquipment(tx, { includeRetired: true })).find((entry) => entry.id === id)?.current;
    await insertSettings(tx, id, { widthM: input.widthM ?? current?.widthM, lateralM: input.lateralM ?? current?.lateralM ?? "0", backM: input.backM ?? current?.backM ?? "0", note: input.note });
  }
  const name = input.name !== undefined ? requireString(input.name, "Name", { maxLength: 100 }) : row.name;
  const kind = input.kind !== undefined ? requireOneOf(input.kind, "Kind", EQUIPMENT_KINDS) : row.kind;
  const links =
    input.safetyEquipmentId !== undefined || input.fixedAssetId !== undefined
      ? await checkEquipmentLinks(tx, {
          safetyEquipmentId: input.safetyEquipmentId !== undefined ? input.safetyEquipmentId : row.safety_equipment_id,
          fixedAssetId: input.fixedAssetId !== undefined ? input.fixedAssetId : row.fixed_asset_id && canLink(tx) ? row.fixed_asset_id : null,
        })
      : { safetyEquipmentId: row.safety_equipment_id, fixedAssetId: row.fixed_asset_id };
  const active = input.retired === true ? false : input.retired === false ? true : row.is_active;
  await tx.query("update tractor_equipment set name = $2, kind = $3, safety_equipment_id = $4, fixed_asset_id = $5, is_active = $6, updated_by_email = $7, updated_at = now() where id = $1", [
    id,
    name,
    kind,
    links.safetyEquipmentId,
    links.fixedAssetId,
    active,
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.tractor_equipment_changed", entityType: "tractor_equipment", entityId: id, details: { name, kind, active, settings: input.widthM !== undefined || input.lateralM !== undefined || input.backM !== undefined } });
  return (await listTractorEquipment(tx, { includeRetired: true })).find((entry) => entry.id === id)!;
}

// Checking a job as sent ----------------------------------------------------------------------------------

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Checks the track's shape and limits; returns it in a fixed form so its hash is stable. */
export function parseTrack(input: unknown): JobTrack {
  if (!input || typeof input !== "object") throw new ValidationError("The job has no track.");
  const raw = input as { version?: unknown; settings?: unknown; points?: unknown; events?: unknown };
  if (raw.version !== 1) throw new ValidationError("This track is from a newer version of Tohyee. Update the app and send it again.");
  if (!Array.isArray(raw.settings) || raw.settings.length < 1 || raw.settings.length > 200) throw new ValidationError("The track needs between 1 and 200 width settings.");
  const settings: JobSettings[] = raw.settings.map((entry, index) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    if (!finite(value.widthM, 0.1, 60) || !finite(value.lateralM, -30, 30) || !finite(value.backM, -30, 30)) throw new ValidationError(`Width setting ${index + 1} isn't valid.`);
    const settingsId = value.settingsId == null ? null : requireId(value.settingsId, "Settings");
    return { widthM: value.widthM, lateralM: value.lateralM, backM: value.backM, settingsId };
  });
  if (!Array.isArray(raw.points)) throw new ValidationError("The track has no points.");
  if (raw.points.length > MAX_POINTS) throw new ValidationError(`A job can have up to ${MAX_POINTS.toLocaleString("en-NZ")} GPS points. Finish long jobs in parts.`);
  const points: PackedPoint[] = raw.points.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 8) throw new ValidationError(`GPS point ${index + 1} isn't valid.`);
    const [t, lon, lat, acc, w, s, spd, b] = entry as unknown[];
    if (!finite(t, Date.UTC(2020, 0, 1), Date.UTC(2100, 0, 1)) || !finite(lon, -180, 180) || !finite(lat, -90, 90)) throw new ValidationError(`GPS point ${index + 1} isn't a time, longitude and latitude.`);
    if (!(acc === null || finite(acc, 0, 100_000))) throw new ValidationError(`GPS point ${index + 1}'s accuracy isn't valid.`);
    if ((w !== 0 && w !== 1) || (b !== 0 && b !== 1) || !Number.isInteger(s) || (s as number) < 0 || (s as number) >= settings.length) throw new ValidationError(`GPS point ${index + 1} isn't valid.`);
    if (!(spd === null || finite(spd, 0, 1000))) throw new ValidationError(`GPS point ${index + 1}'s speed isn't valid.`);
    return [t, lon, lat, acc as number | null, w as 0 | 1, s as number, spd as number | null, b as 0 | 1];
  });
  const rawEvents = Array.isArray(raw.events) ? raw.events : [];
  if (rawEvents.length > 20_000) throw new ValidationError("The track has too many events.");
  const events: TrackEvent[] = rawEvents.map((entry, index) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    if (!finite(value.t, Date.UTC(2020, 0, 1), Date.UTC(2100, 0, 1)) || !TRACK_EVENTS.includes(value.kind as TrackEvent["kind"])) throw new ValidationError(`Event ${index + 1} isn't valid.`);
    return { t: value.t, kind: value.kind as TrackEvent["kind"] };
  });
  return { version: 1, settings, points, events };
}

/**
 * The track as sent: `track` (JSON in the body), or `trackBase64` (the
 * track's JSON as a file, which is how the device's queue sends it so a long
 * track isn't held in memory with the queue's items; decision 1028).
 */
export function trackFromInput(input: Record<string, unknown>): unknown {
  if (input.track !== undefined && input.track !== null) return input.track;
  if (typeof input.trackBase64 !== "string") return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.trackBase64)) throw new ValidationError("The job's track file isn't valid.");
  try {
    return JSON.parse(Buffer.from(input.trackBase64, "base64").toString("utf8"));
  } catch {
    throw new ValidationError("The job's track file isn't valid.");
  }
}

export function trackHash(track: JobTrack): string {
  return createHash("sha256").update(JSON.stringify(track)).digest("hex");
}

async function paddocksOnFarm(tx: OrgTx, farmId: string, input: unknown): Promise<string[]> {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 100) throw new ValidationError("Choose up to 100 paddocks.");
  const ids = [...new Set(input.map((value) => requireId(value, "Paddock")))].sort((a, b) => Number(a) - Number(b));
  if (!ids.length) return [];
  const found = await tx.query<{ id: string }>("select id::text from paddocks where farm_id = $1 and id = any($2::bigint[])", [farmId, ids]);
  if (found.rows.length !== ids.length) throw new ValidationError("One of those paddocks isn't on this farm.");
  return ids;
}

/** The chosen paddocks' current boundaries (paddocks with no shape are left out). */
async function currentBoundaries(tx: OrgTx, paddockIds: string[]): Promise<Array<{ paddockId: string; boundaryId: string; geometry: PaddockGeometry }>> {
  if (!paddockIds.length) return [];
  const rows = await tx.query<{ paddock_id: string; id: string; geometry: PaddockGeometry }>(
    "select distinct on (paddock_id) paddock_id::text, id::text, geometry from paddock_boundaries where paddock_id = any($1::bigint[]) order by paddock_id, paddock_boundaries.id desc",
    [paddockIds],
  );
  return rows.rows.map((row) => ({ paddockId: row.paddock_id, boundaryId: row.id, geometry: row.geometry }));
}

async function boundariesById(tx: OrgTx, boundaryIds: string[]): Promise<Array<{ paddockId: string; boundaryId: string; geometry: PaddockGeometry }>> {
  if (!boundaryIds.length) return [];
  const rows = await tx.query<{ paddock_id: string; id: string; geometry: PaddockGeometry }>("select paddock_id::text, id::text, geometry from paddock_boundaries where id = any($1::bigint[]) order by paddock_boundaries.id", [boundaryIds]);
  return rows.rows.map((row) => ({ paddockId: row.paddock_id, boundaryId: row.id, geometry: row.geometry }));
}

type LinkInput = { fertiliserPlanId?: unknown; fertiliserApplicationId?: unknown; chemicalRecordId?: unknown };

async function checkLinks(tx: OrgTx, farmId: string, input: LinkInput, previous: { plan: string | null; application: string | null; chemical: string | null }) {
  let plan = previous.plan;
  let application = previous.application;
  let chemical = previous.chemical;
  if (input.fertiliserPlanId !== undefined || input.fertiliserApplicationId !== undefined) {
    if (!canLink(tx)) throw new ForbiddenError("Linking a job to a fertiliser plan needs the bookkeeper role or higher.");
    plan = input.fertiliserPlanId == null || input.fertiliserPlanId === "" ? null : requireId(input.fertiliserPlanId, "Fertiliser plan");
    application = input.fertiliserApplicationId == null || input.fertiliserApplicationId === "" ? null : requireId(input.fertiliserApplicationId, "Fertiliser application");
    if (plan) {
      const found = await tx.query("select 1 from fertiliser_plans where id = $1 and farm_id = $2", [plan, farmId]);
      if (!found.rows[0]) throw new ValidationError("That fertiliser plan isn't on this farm.");
    }
    if (application) {
      if (!plan) throw new ValidationError("Choose the fertiliser plan for that application.");
      const found = await tx.query("select 1 from fertiliser_applications where id = $1 and plan_id = $2 and status = 'active'", [application, plan]);
      if (!found.rows[0]) throw new ValidationError("That application isn't on the fertiliser plan.");
    }
  }
  if (input.chemicalRecordId !== undefined) {
    chemical = input.chemicalRecordId == null || input.chemicalRecordId === "" ? null : (await currentRecord<{ name: string }>(tx, "chemical", requireUuid(input.chemicalRecordId, "Chemical"))).recordId;
  }
  return { plan, application, chemical };
}

function declared(input: Record<string, unknown>, previous: { product: string | null; rate: string | null; rateUnit: string | null; quantity: string | null; quantityUnit: string | null }) {
  const out = { ...previous };
  if (input.product !== undefined) out.product = optionalString(input.product, "Product", { maxLength: 150 });
  if (input.declaredRate !== undefined) {
    out.rate = input.declaredRate == null || input.declaredRate === "" ? null : parseDecimalInput(input.declaredRate, "Rate", { maxScale: 3 });
    out.rateUnit = out.rate ? requireOneOf(input.declaredRateUnit, "Rate unit", RATE_UNITS) : null;
  }
  if (input.declaredQuantity !== undefined) {
    out.quantity = input.declaredQuantity == null || input.declaredQuantity === "" ? null : parseDecimalInput(input.declaredQuantity, "Quantity", { maxScale: 3 });
    out.quantityUnit = out.quantity ? requireOneOf(input.declaredQuantityUnit, "Quantity unit", QUANTITY_UNITS) : null;
  }
  return out;
}

// Saving ---------------------------------------------------------------------------------------------------

/**
 * Saves a finished job. Returns `created: false` with the saved job when
 * the same job was sent before.
 */
export async function saveTractorJob(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; job: TractorJob }> {
  await requireFarming(tx);
  requireRecorder(tx);
  if (!tx.actor.userId) throw new ForbiddenError("A tractor job needs a person.");
  const id = requireUuid(input.id, "Job id");
  const farmId = requireId(input.farmId, "Farm");
  await requireFarmAccess(tx, farmId);
  const track = parseTrack(trackFromInput(input));
  const hash = trackHash(track);
  const existing = await tx.query<{ farm_id: string; track_sha256: string; operator_user_id: string }>("select farm_id::text, track_sha256, operator_user_id::text from tractor_jobs where id = $1", [id]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.track_sha256 === hash && row.farm_id === farmId && row.operator_user_id === tx.actor.userId) return { created: false, job: await getTractorJob(tx, id) };
    throw new ConflictError("A different job was already saved under this job's id. Nothing was changed; the job is still on this device.");
  }
  const operation = requireOneOf(input.operation, "Operation", OPERATIONS);
  const paddockIds = await paddocksOnFarm(tx, farmId, input.paddockIds);
  let equipmentId: string | null = null;
  if (input.equipmentId != null && input.equipmentId !== "") {
    equipmentId = requireId(input.equipmentId, "Equipment");
    const found = await tx.query("select 1 from tractor_equipment where id = $1", [equipmentId]);
    if (!found.rows[0]) throw new ValidationError("That equipment wasn't found.");
  }
  const times = track.points.map((point) => point[0]).concat(track.events.map((event) => event.t));
  const startedAt = typeof input.startedAt === "number" && Number.isFinite(input.startedAt) ? input.startedAt : times.length ? Math.min(...times) : NaN;
  const finishedAt = typeof input.finishedAt === "number" && Number.isFinite(input.finishedAt) ? input.finishedAt : times.length ? Math.max(...times) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) throw new ValidationError("The job's start and finish times aren't valid.");
  const links = await checkLinks(tx, farmId, input, { plan: null, application: null, chemical: null });
  const typed = declared(input, { product: null, rate: null, rateUnit: null, quantity: null, quantityUnit: null });
  const boundaries = await currentBoundaries(tx, paddockIds);
  const { summary, ...coverage } = computeCoverage(toCoverageTrack(track), boundaries.map((entry) => entry.geometry));
  await tx.query(
    `insert into tractor_jobs (id, farm_id, paddock_ids, boundary_ids, operation, equipment_id, operator_user_id, operator_email, started_at, finished_at,
                               point_count, track, track_sha256, summary, coverage, worked_ha, notes, fertiliser_plan_id, fertiliser_application_id, chemical_record_id,
                               product, declared_rate, declared_rate_unit, declared_quantity, declared_quantity_unit)
     values ($1, $2, $3::bigint[], $4::bigint[], $5, $6, $7, $8, to_timestamp($9::double precision / 1000), to_timestamp($10::double precision / 1000),
             $11, $12::jsonb, $13, $14::jsonb, $15::jsonb, round($16::numeric, 2), $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
    [
      id,
      farmId,
      paddockIds,
      boundaries.map((entry) => entry.boundaryId),
      operation,
      equipmentId,
      tx.actor.userId,
      tx.actor.email,
      startedAt,
      finishedAt,
      track.points.length,
      JSON.stringify(track),
      hash,
      JSON.stringify(summary),
      JSON.stringify(coverage),
      summary.workedHa,
      optionalString(input.notes, "Notes", { maxLength: 2000 }),
      links.plan,
      links.application,
      links.chemical,
      typed.product,
      typed.rate,
      typed.rateUnit,
      typed.quantity,
      typed.quantityUnit,
    ],
  );
  await writeAuditEvent(tx, { eventType: "farming.tractor_job_saved", entityType: "tractor_job", entityId: id, details: { farmId, paddockIds, operation, points: track.points.length, workedHa: summary.workedHa } });
  return { created: true, job: await getTractorJob(tx, id) };
}

// Reading -------------------------------------------------------------------------------------------------

type JobRow = {
  id: string;
  farm_id: string;
  paddock_ids: string[];
  boundary_ids: string[];
  operation: TractorJob["operation"];
  equipment_id: string | null;
  equipment_name: string | null;
  operator_user_id: string;
  operator_email: string;
  started_at: string;
  finished_at: string;
  received_at: string;
  worked_ha: string;
  summary: TractorJob["summary"];
  status: TractorJob["status"];
};

const LIST_COLUMNS = `j.id::text, j.farm_id::text, j.paddock_ids::text[], j.boundary_ids::text[], j.operation, j.equipment_id::text, e.name as equipment_name,
  j.operator_user_id::text, j.operator_email,
  to_char(j.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
  to_char(j.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at,
  to_char(j.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as received_at,
  j.worked_ha::text, j.summary, j.status`;

async function paddockNames(tx: OrgTx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where id = any($1::bigint[])", [ids]);
  return new Map(rows.rows.map((row) => [row.id, row.name]));
}

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

function toListItem(row: JobRow, names: Map<string, string>): TractorJobListItem {
  return {
    id: row.id,
    farmId: row.farm_id,
    paddockIds: row.paddock_ids,
    paddockNames: row.paddock_ids.map((id) => names.get(id) ?? `#${id}`).sort(NATURAL.compare),
    operation: row.operation,
    equipmentId: row.equipment_id,
    equipmentName: row.equipment_name,
    operatorUserId: row.operator_user_id,
    operatorEmail: row.operator_email,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    receivedAt: row.received_at,
    workedHa: row.worked_ha,
    summary: row.summary,
    status: row.status,
  };
}

/** A farm's jobs, newest first: farm staff see their own. */
export async function listTractorJobs(tx: OrgTx, input: { farmId: unknown; limit?: unknown; before?: unknown }): Promise<TractorJobListItem[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "Farm");
  await requireFarmAccess(tx, farmId);
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
  const before = typeof input.before === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(input.before) ? input.before : null;
  const rows = await tx.query<JobRow>(
    `select ${LIST_COLUMNS} from tractor_jobs j left join tractor_equipment e on e.id = j.equipment_id
      where j.farm_id = $1 and ($2::uuid is null or j.operator_user_id = $2) and ($3::timestamptz is null or j.started_at < $3)
      order by j.started_at desc, j.id limit $4`,
    [farmId, isStaff(tx) ? tx.actor.userId : null, before, limit],
  );
  const names = await paddockNames(tx, [...new Set(rows.rows.flatMap((row) => row.paddock_ids))]);
  return rows.rows.map((row) => toListItem(row, names));
}

/** One job with its track, if the person may see it (otherwise "not found"). */
export async function getTractorJob(tx: OrgTx, idInput: unknown): Promise<TractorJob> {
  await requireFarming(tx);
  const id = typeof idInput === "string" && UUID.test(idInput.toLowerCase()) ? idInput.toLowerCase() : null;
  if (!id) throw new NotFoundError("That job wasn't found.");
  const rows = await tx.query<
    JobRow & {
      track: JobTrack;
      coverage: TractorJob["coverage"];
      notes: string | null;
      fertiliser_plan_id: string | null;
      plan_name: string | null;
      fertiliser_application_id: string | null;
      chemical_record_id: string | null;
      product: string | null;
      declared_rate: string | null;
      declared_rate_unit: string | null;
      declared_quantity: string | null;
      declared_quantity_unit: string | null;
      withdrawn_reason: string | null;
      updated_by_email: string | null;
      updated_at: string | null;
    }
  >(
    `select ${LIST_COLUMNS}, j.track, j.coverage, j.notes, j.fertiliser_plan_id::text, p.name as plan_name, j.fertiliser_application_id::text, j.chemical_record_id::text,
            j.product, j.declared_rate::text, j.declared_rate_unit, j.declared_quantity::text, j.declared_quantity_unit, j.withdrawn_reason, j.updated_by_email,
            to_char(j.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
       from tractor_jobs j left join tractor_equipment e on e.id = j.equipment_id left join fertiliser_plans p on p.id = j.fertiliser_plan_id
      where j.id = $1`,
    [id],
  );
  const row = rows.rows[0];
  if (!row || !(await canSeeFarm(tx, row.farm_id)) || (isStaff(tx) && row.operator_user_id !== tx.actor.userId)) throw new NotFoundError("That job wasn't found.");
  const names = await paddockNames(tx, row.paddock_ids);
  let chemicalName: string | null = null;
  if (row.chemical_record_id) {
    try {
      chemicalName = (await currentRecord<{ name: string }>(tx, "chemical", row.chemical_record_id)).data.name;
    } catch {
      chemicalName = null;
    }
  }
  const mine = row.operator_user_id === tx.actor.userId;
  return {
    ...toListItem(row, names),
    track: row.track,
    coverage: row.coverage,
    boundaries: await boundariesById(tx, row.boundary_ids),
    notes: row.notes,
    fertiliserPlanId: canLink(tx) ? row.fertiliser_plan_id : null,
    fertiliserPlanName: canLink(tx) ? row.plan_name : null,
    fertiliserApplicationId: canLink(tx) ? row.fertiliser_application_id : null,
    chemicalRecordId: row.chemical_record_id,
    chemicalName,
    product: row.product,
    declaredRate: row.declared_rate,
    declaredRateUnit: row.declared_rate_unit,
    declaredQuantity: row.declared_quantity,
    declaredQuantityUnit: row.declared_quantity_unit,
    withdrawnReason: row.withdrawn_reason,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
    canChange: canRecord(tx) && (mine || !isStaff(tx)),
    canLink: canLink(tx),
  };
}

/**
 * Changes a saved job's paddocks, notes, declared product, rate and
 * quantity, links, or withdraws it (`withdraw: "why"`). New paddocks clip
 * the same track to their current boundaries; the track never changes.
 */
export async function changeTractorJob(tx: OrgTx, idInput: unknown, input: Record<string, unknown>): Promise<TractorJob> {
  const job = await getTractorJob(tx, idInput);
  if (!job.canChange) throw new ForbiddenError("Only the person who drove it, or a bookkeeper or above, can change this job.");
  if (job.status === "withdrawn") throw new ValidationError("This job was withdrawn, so it can't be changed.");
  const row = await tx.query<{ fertiliser_plan_id: string | null; fertiliser_application_id: string | null }>("select fertiliser_plan_id::text, fertiliser_application_id::text from tractor_jobs where id = $1 for update", [job.id]);
  const links = await checkLinks(tx, job.farmId, input, { plan: row.rows[0].fertiliser_plan_id, application: row.rows[0].fertiliser_application_id, chemical: job.chemicalRecordId });
  const typed = declared(input, { product: job.product, rate: job.declaredRate, rateUnit: job.declaredRateUnit, quantity: job.declaredQuantity, quantityUnit: job.declaredQuantityUnit });
  const notes = input.notes !== undefined ? optionalString(input.notes, "Notes", { maxLength: 2000 }) : job.notes;
  let paddockIds = job.paddockIds;
  let boundaryIds = job.boundaries.map((entry) => entry.boundaryId);
  let summary = job.summary;
  let coverage = job.coverage;
  const repaddock = input.paddockIds !== undefined;
  if (repaddock) {
    paddockIds = await paddocksOnFarm(tx, job.farmId, input.paddockIds);
    const boundaries = await currentBoundaries(tx, paddockIds);
    boundaryIds = boundaries.map((entry) => entry.boundaryId);
    const result = computeCoverage(toCoverageTrack(job.track), boundaries.map((entry) => entry.geometry));
    ({ summary, ...coverage } = result);
  }
  const withdraw = input.withdraw !== undefined ? requireString(input.withdraw, "Why it's withdrawn", { maxLength: 1000 }) : null;
  await tx.query(
    `update tractor_jobs set paddock_ids = $2::bigint[], boundary_ids = $3::bigint[], summary = $4::jsonb, coverage = $5::jsonb, worked_ha = round($6::numeric, 2), notes = $7,
            fertiliser_plan_id = $8, fertiliser_application_id = $9, chemical_record_id = $10, product = $11, declared_rate = $12, declared_rate_unit = $13,
            declared_quantity = $14, declared_quantity_unit = $15, status = $16, withdrawn_reason = $17, updated_by_email = $18, updated_at = now()
      where id = $1`,
    [
      job.id,
      paddockIds,
      boundaryIds,
      JSON.stringify(summary),
      JSON.stringify(coverage),
      summary.workedHa,
      notes,
      links.plan,
      links.application,
      links.chemical,
      typed.product,
      typed.rate,
      typed.rateUnit,
      typed.quantity,
      typed.quantityUnit,
      withdraw ? "withdrawn" : "active",
      withdraw,
      tx.actor.email,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: withdraw ? "farming.tractor_job_withdrawn" : "farming.tractor_job_changed",
    entityType: "tractor_job",
    entityId: job.id,
    details: { paddockIds: repaddock ? paddockIds : undefined, workedHa: repaddock ? summary.workedHa : undefined, why: withdraw ?? undefined },
  });
  return getTractorJob(tx, job.id);
}
