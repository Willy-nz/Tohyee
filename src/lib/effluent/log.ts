import type { OrgTx } from "@/lib/db/org-transaction";
import { isoDateAt, parseIsoDate, todayIsoDate } from "@/lib/dates";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { roleAtLeast } from "@/lib/auth/roles";
import { fileRefs } from "@/lib/safety/files";
import { paddocksOnFarm, point } from "@/lib/safety/hazards";
import { appendEntry, currentRecord, currentRecords } from "@/lib/safety/records";
import type { CurrentRecord, SafetyChange, SafetyKind, SafetyVersion } from "@/lib/safety/shared";
import { amount, effluentSetup, requireEffluentLogger, type EffluentSetup } from "@/lib/effluent/setup";
import { activeConsent, type BlockData, type PondData, type SystemData } from "@/lib/effluent/shared";
import {
  type ApplicationData,
  type ApplicationFlags,
  applicationFlags,
  DEFERRAL_REASONS,
  type DeferralData,
  type DeferralReason,
  limitsSummary,
  type LimitsSummary,
  PONDING_RESULTS,
  type PodPosition,
  type PondingCheck,
  type PondingResult,
  type PondReadingData,
  pondState,
  type PondState,
  positionHours,
  workedOutDepth,
  hoursBetween,
} from "@/lib/effluent/rules";
import { optionalString, requireId } from "@/lib/validation";

/*
 * The daily effluent log (#487, decisions 1080-1089): irrigation runs,
 * pond readings and days effluent wasn't applied. Phone first: everything
 * here can be sent from the device's queue, with the phone's own id, so a
 * save sent twice is kept once (decision 933); times are as the person or
 * phone gave them, and the database dates each version separately.
 *
 * Farm staff and bookkeepers and above record on their farms (decision
 * 1071). A record can be corrected or withdrawn by the person who entered
 * it, or by a bookkeeper or above; nothing is deleted.
 */

const LOG_KINDS = ["effluent_application", "effluent_pond_reading", "effluent_deferral"] as const satisfies readonly SafetyKind[];

/** A time as the person or phone gave it: ISO, not before 2000 and not more than 15 minutes ahead of Tohyee's clock. */
export function parseTime(input: unknown, field: string): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError(`${field} is required.`);
  const time = new Date(input);
  if (Number.isNaN(time.getTime())) throw new ValidationError(`${field} isn't a time.`);
  if (time.getUTCFullYear() < 2000) throw new ValidationError(`${field} is too long ago.`);
  if (time.getTime() > Date.now() + 15 * 60_000) throw new ValidationError(`${field} is in the future.`);
  return time.toISOString();
}

function positionsOf(input: unknown, paddocks: ReadonlySet<string>): PodPosition[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 60) throw new ValidationError("Record up to 60 positions.");
  return input.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const paddockId = value.paddockId ? requireId(value.paddockId, "Paddock") : null;
    if (paddockId && !paddocks.has(paddockId)) throw new ValidationError(`Position ${index + 1}: that paddock isn't on this farm.`);
    return { label: optionalString(value.label, `Position ${index + 1}'s name`, { maxLength: 60 }), paddockId, point: point(value.point ?? null), movedAt: parseTime(value.movedAt, `Position ${index + 1}'s time`) };
  });
}

function pondingOf(input: unknown): PondingCheck | null {
  if (input == null) return null;
  const value = input as Record<string, unknown>;
  const result = value.result as PondingResult;
  if (!PONDING_RESULTS.includes(result)) throw new ValidationError("Say what the ponding and runoff check found: none, ponding or runoff.");
  const note = optionalString(value.note, "What was seen", { maxLength: 1000 });
  if (result !== "none" && !note) throw new ValidationError("Say what was seen and what was done about it.");
  return { result, note, checkedAt: parseTime(value.checkedAt ?? new Date().toISOString(), "When it was checked") };
}

async function farmPaddocks(tx: OrgTx, farmId: string): Promise<Set<string>> {
  const rows = await tx.query<{ id: string }>("select id::text from paddocks where farm_id = $1", [farmId]);
  return new Set(rows.rows.map((row) => row.id));
}

async function farmOf(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  requireEffluentLogger(tx);
  const farmId = requireId(input, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  return farmId;
}

/** Correcting or withdrawing someone's log record: they themselves, or a bookkeeper or above. */
async function mayCorrect(tx: OrgTx, record: CurrentRecord<unknown> | { recordId: string }): Promise<void> {
  if (!tx.actor.userId || (tx.actor.role && roleAtLeast(tx.actor.role, "bookkeeper"))) return;
  const first = await tx.query<{ user_id: string | null }>("select entered_by_user_id::text as user_id from safety_entries where record_id = $1 and version = 1", [record.recordId]);
  if (first.rows[0]?.user_id !== tx.actor.userId) throw new ForbiddenError("Only the person who entered it, or a bookkeeper or above, can correct or withdraw it.");
}

// Applications ---------------------------------------------------------------------------------------

async function systemOn(tx: OrgTx, farmId: string, id: unknown): Promise<{ system: CurrentRecord<SystemData>; available: boolean; setup: EffluentSetup }> {
  const setup = await effluentSetup(tx, farmId);
  const system = setup.systems.find((each) => each.recordId === id && each.change !== "withdrawn");
  if (!system) throw new ValidationError("Choose a system on this farm.");
  if (system.data.retired) throw new ValidationError("That system isn't used any more.");
  return { system, available: system.available, setup };
}

function workOut(system: SystemData, data: Pick<ApplicationData, "startedAt" | "stoppedAt" | "positions" | "loads" | "areaHa">) {
  const until = data.stoppedAt;
  if (!until && system.type !== "travelling_irrigator") return null;
  const hours = until ? hoursBetween(data.startedAt, until) : null;
  const perPosition = until && data.positions.length ? positionHours(data.positions, until).map((each) => each.hours) : undefined;
  return workedOutDepth(system.type, system.settings, { hours, positionHours: perPosition, loads: data.loads, areaHa: data.areaHa });
}

async function blockOn(tx: OrgTx, farmId: string, id: unknown): Promise<SafetyVersion<BlockData> | null> {
  if (!id) return null;
  const block = await currentRecord<BlockData>(tx, "effluent_block", id).catch(() => null);
  if (!block || block.change === "withdrawn" || block.farmId !== farmId) throw new ValidationError("That block isn't on this farm.");
  return block;
}

/**
 * Records an irrigation, tanker or spreader run: started (it may still be
 * running) or already finished. Depth is kept as entered and as worked out
 * from the system's settings. A system out of use in Safety can still be
 * recorded, marked so (decision 1083): the record says what happened.
 */
export async function addApplication(tx: OrgTx, input: Record<string, unknown>) {
  const farmId = await farmOf(tx, input.farmId);
  if (input.operationId) {
    const existing = await tx.query<{ record_id: string }>("select record_id::text from safety_entries where operation_id = $1 and kind = 'effluent_application'", [String(input.operationId)]);
    if (existing.rows[0]) return currentRecord<ApplicationData>(tx, "effluent_application", existing.rows[0].record_id);
  }
  const { system, available } = await systemOn(tx, farmId, input.systemId);
  const paddocks = await farmPaddocks(tx, farmId);
  const block = await blockOn(tx, farmId, input.blockId);
  const startedAt = parseTime(input.startedAt, "Started");
  const stoppedAt = input.stoppedAt ? parseTime(input.stoppedAt, "Stopped") : null;
  if (stoppedAt && stoppedAt < startedAt) throw new ValidationError("It stopped before it started.");
  const positions = positionsOf(input.positions, paddocks);
  if (positions.some((position) => position.movedAt < startedAt || (stoppedAt && position.movedAt > stoppedAt))) throw new ValidationError("Each position's time must be between the start and the stop.");
  const paddockIds = await paddocksOnFarm(tx, farmId, [...new Set([...(Array.isArray(input.paddockIds) ? input.paddockIds : []), ...positions.map((position) => position.paddockId).filter(Boolean)])]);
  const loads = input.loads === undefined || input.loads === null || input.loads === "" ? null : Number(input.loads);
  if (loads !== null && (!Number.isInteger(loads) || loads < 1 || loads > 500)) throw new ValidationError("Loads must be a whole number from 1 to 500.");
  const data: ApplicationData = {
    systemId: system.recordId,
    blockId: block?.recordId ?? null,
    paddockIds,
    startedAt,
    stoppedAt,
    positions,
    depthEnteredMm: amount(input.depthEnteredMm, "Depth (mm)", { scale: 1 }),
    depthWorkedOut: null,
    settings: system.data.settings,
    loads: system.data.type === "slurry_tanker" ? loads : null,
    areaHa: system.data.type === "slurry_tanker" ? amount(input.areaHa, "Area (ha)", { scale: 2 }) : null,
    ponding: pondingOf(input.ponding),
    weather: optionalString(input.weather, "Weather", { maxLength: 500 }),
    soil: optionalString(input.soil, "Soil", { maxLength: 500 }),
    files: await fileRefs(tx, input.files, farmId, false),
    usedWhileOutOfUse: !available,
  };
  if (input.tractorJobId) data.tractorJobId = String(input.tractorJobId);
  if (stoppedAt && !data.ponding) throw new ValidationError("Do the ponding and runoff check before saying it's stopped.");
  if (!paddockIds.length && !block) throw new ValidationError("Say where: the block, a paddock or a position.");
  data.depthWorkedOut = workOut(system.data, data);
  return appendEntry<ApplicationData>(tx, { kind: "effluent_application", change: "created", farmId, happenedOn: isoDateAt(new Date(startedAt)), data: { ...data }, operationId: input.operationId });
}

const APPLICATION_STEPS = ["shift", "stop", "update", "correct", "withdraw"] as const;

/**
 * A new version of a run: "shift" (pods or irrigator moved: a new
 * position), "stop" (with the ponding check, depth worked out again),
 * "update" (notes, photos, weather, soil, depth entered), "correct" or
 * "withdraw" (with why).
 */
export async function changeApplication(tx: OrgTx, recordId: unknown, input: Record<string, unknown>) {
  await requireFarming(tx);
  requireEffluentLogger(tx);
  const current = await currentRecord<ApplicationData>(tx, "effluent_application", recordId);
  const step = (input.step ?? "update") as (typeof APPLICATION_STEPS)[number];
  if (!APPLICATION_STEPS.includes(step)) throw new ValidationError("That isn't a change Tohyee knows.");
  if (input.operationId) {
    const existing = await tx.query("select 1 from safety_entries where operation_id = $1 and record_id = $2", [String(input.operationId), current.recordId]);
    if (existing.rowCount) return current;
  }
  const farmId = current.farmId!;
  const data: ApplicationData = { ...current.data, why: undefined };
  let change: SafetyChange = "updated";
  const system = await currentRecord<SystemData>(tx, "effluent_system", current.data.systemId);
  const paddocks = await farmPaddocks(tx, farmId);
  if (step === "withdraw" || step === "correct") {
    await mayCorrect(tx, current);
    change = step === "withdraw" ? "withdrawn" : "corrected";
    data.why = optionalString(input.why, "Why", { maxLength: 1000 }) ?? undefined;
    if (!data.why) throw new ValidationError(step === "withdraw" ? "Say why it's withdrawn." : "Say what was wrong, so the history shows why it was corrected.");
  }
  if (step === "shift") {
    if (current.data.stoppedAt) throw new ValidationError("It's already stopped.");
    const [position] = positionsOf([input.position], paddocks);
    if (position.movedAt < current.data.startedAt) throw new ValidationError("The move is before the run started.");
    data.positions = [...current.data.positions, position];
    if (position.paddockId && !data.paddockIds.includes(position.paddockId)) data.paddockIds = [...data.paddockIds, position.paddockId].sort((a, b) => Number(a) - Number(b));
  }
  if (step === "stop") {
    if (current.data.stoppedAt) throw new ValidationError("It's already stopped.");
    data.stoppedAt = parseTime(input.stoppedAt, "Stopped");
    if (data.stoppedAt < current.data.startedAt) throw new ValidationError("It stopped before it started.");
    data.ponding = pondingOf(input.ponding);
    if (!data.ponding) throw new ValidationError("Do the ponding and runoff check before saying it's stopped.");
  }
  if (step !== "withdraw") {
    for (const key of ["weather", "soil"] as const) if (input[key] !== undefined) data[key] = optionalString(input[key], key === "weather" ? "Weather" : "Soil", { maxLength: 500 });
    if (input.depthEnteredMm !== undefined) data.depthEnteredMm = amount(input.depthEnteredMm, "Depth (mm)", { scale: 1 });
    if (input.files !== undefined) data.files = await fileRefs(tx, input.files, farmId, false);
    if (step === "correct") {
      if (input.startedAt !== undefined) data.startedAt = parseTime(input.startedAt, "Started");
      if (input.stoppedAt !== undefined) data.stoppedAt = input.stoppedAt ? parseTime(input.stoppedAt, "Stopped") : null;
      if (input.positions !== undefined) data.positions = positionsOf(input.positions, paddocks);
      if (input.paddockIds !== undefined) data.paddockIds = await paddocksOnFarm(tx, farmId, input.paddockIds);
      if (input.ponding !== undefined) data.ponding = pondingOf(input.ponding);
      if (input.loads !== undefined) data.loads = input.loads ? Number(input.loads) : null;
      if (input.areaHa !== undefined) data.areaHa = amount(input.areaHa, "Area (ha)", { scale: 2 });
      if (data.stoppedAt && data.stoppedAt < data.startedAt) throw new ValidationError("It stopped before it started.");
    }
    // Worked out again from the settings the run was saved with, never from today's settings.
    data.depthWorkedOut = workOut({ ...system.data, settings: current.data.settings }, data);
  }
  return appendEntry<ApplicationData>(tx, { kind: "effluent_application", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId, happenedOn: isoDateAt(new Date(data.startedAt)), data: { ...data }, operationId: input.operationId });
}

// Pond readings and days not applied ------------------------------------------------------------------

export async function addPondReading(tx: OrgTx, input: Record<string, unknown>) {
  const farmId = await farmOf(tx, input.farmId);
  const pond = await currentRecord<PondData>(tx, "effluent_pond", input.pondId).catch(() => null);
  if (!pond || pond.change === "withdrawn" || pond.farmId !== farmId) throw new ValidationError("Choose a pond or sump on this farm.");
  const levelMm = amount(input.levelMm, "Level (mm)", { scale: 0, zero: true });
  if (levelMm === null) throw new ValidationError("Enter the level on the gauge, in mm.");
  const readAt = parseTime(input.readAt ?? new Date().toISOString(), "Read at");
  const data: PondReadingData = { pondId: pond.recordId, levelMm, readAt, note: optionalString(input.note, "Note", { maxLength: 1000 }), files: await fileRefs(tx, input.files, farmId, false) };
  return appendEntry<PondReadingData>(tx, { kind: "effluent_pond_reading", change: "created", farmId, happenedOn: isoDateAt(new Date(readAt)), data: { ...data }, operationId: input.operationId });
}

export async function addDeferral(tx: OrgTx, input: Record<string, unknown>) {
  const farmId = await farmOf(tx, input.farmId);
  const reason = input.reason as DeferralReason;
  if (!DEFERRAL_REASONS.includes(reason)) throw new ValidationError("Say why effluent wasn't applied.");
  const on = parseIsoDate(input.on ?? todayIsoDate(), "On");
  if (on > todayIsoDate()) throw new ValidationError("That day hasn't come yet.");
  const note = optionalString(input.note, "Note", { maxLength: 1000 });
  if (reason === "other" && !note) throw new ValidationError("Say why.");
  let systemId: string | null = null;
  if (input.systemId) systemId = (await systemOn(tx, farmId, input.systemId)).system.recordId;
  const data: DeferralData = { on, reason, note, systemId };
  return appendEntry<DeferralData>(tx, { kind: "effluent_deferral", change: "created", farmId, happenedOn: on, data: { ...data }, operationId: input.operationId });
}

/** Corrects or withdraws a pond reading or a day not applied (the person who entered it, or a bookkeeper or above). */
export async function changeLogRecord(tx: OrgTx, kind: "effluent_pond_reading" | "effluent_deferral", recordId: unknown, input: Record<string, unknown>) {
  await requireFarming(tx);
  requireEffluentLogger(tx);
  const current = await currentRecord<Record<string, unknown>>(tx, kind, recordId);
  await mayCorrect(tx, current);
  const step = input.step === "withdraw" ? "withdrawn" : "corrected";
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (!why) throw new ValidationError(step === "withdrawn" ? "Say why it's withdrawn." : "Say what was wrong, so the history shows why it was corrected.");
  const data: Record<string, unknown> = { ...current.data, why };
  if (step === "corrected") {
    if (kind === "effluent_pond_reading") {
      if (input.levelMm !== undefined) data.levelMm = amount(input.levelMm, "Level (mm)", { scale: 0, zero: true });
      if (input.readAt !== undefined) data.readAt = parseTime(input.readAt, "Read at");
      if (input.note !== undefined) data.note = optionalString(input.note, "Note", { maxLength: 1000 });
    } else {
      if (input.reason !== undefined) {
        if (!DEFERRAL_REASONS.includes(input.reason as DeferralReason)) throw new ValidationError("Say why effluent wasn't applied.");
        data.reason = input.reason;
      }
      if (input.note !== undefined) data.note = optionalString(input.note, "Note", { maxLength: 1000 });
    }
  }
  return appendEntry(tx, { kind, recordId: current.recordId, expectedVersion: input.expectedVersion, change: step as SafetyChange, farmId: current.farmId, happenedOn: current.happenedOn, data, operationId: input.operationId });
}

// Reading --------------------------------------------------------------------------------------------

export type ApplicationView = CurrentRecord<ApplicationData> & { flags: ApplicationFlags; running: boolean };
export type PondView = CurrentRecord<PondData> & { latest: (CurrentRecord<PondReadingData> & { state: PondState }) | null; readToday: boolean };
export type LastMoved = { systemId: string; systemName: string; point: [number, number] | null; label: string | null; paddockId: string | null; movedAt: string; running: boolean; applicationId: string; shiftDue: string | null };

export type EffluentLog = {
  applications: ApplicationView[];
  readings: Array<CurrentRecord<PondReadingData> & { state: PondState | null }>;
  deferrals: Array<CurrentRecord<DeferralData>>;
  ponds: PondView[];
  lastMoved: LastMoved[];
  summary: LimitsSummary;
  setup: EffluentSetup;
};

const inRange = (date: string | null, from: string, to: string) => date !== null && date >= from && date <= to;

/**
 * A farm's log between two dates (by the day it happened), newest first,
 * with each run's comparison with the consent, each pond's latest reading
 * and state, and where each system's pods or irrigator was last moved.
 */
export async function effluentLog(tx: OrgTx, farmIdInput: unknown, range: { from?: unknown; to?: unknown; includeWithdrawn?: boolean } = {}): Promise<EffluentLog> {
  const setup = await effluentSetup(tx, farmIdInput);
  const farmId = String(farmIdInput);
  const today = todayIsoDate();
  const from = range.from ? parseIsoDate(range.from, "From") : isoDateAt(new Date(Date.now() - 30 * 86_400_000));
  const to = range.to ? parseIsoDate(range.to, "To") : today;
  if (to < from) throw new ValidationError("The end date is before the start date.");
  const own = <T>(records: Array<CurrentRecord<T>>) => records.filter((record) => record.farmId === farmId);
  const filter = { farmId, includeWithdrawn: range.includeWithdrawn };
  const allApplications = own(await currentRecords<ApplicationData>(tx, "effluent_application", filter));
  const readings = own(await currentRecords<PondReadingData>(tx, "effluent_pond_reading", filter));
  const deferrals = own(await currentRecords<DeferralData>(tx, "effluent_deferral", filter));
  const consent = activeConsent(setup.consents)?.data ?? null;
  const zones = setup.zones.filter((zone) => zone.change !== "withdrawn");
  const live = allApplications.filter((application) => application.change !== "withdrawn");
  const shown = allApplications.filter((application) => inRange(application.happenedOn, from, to) || (!application.data.stoppedAt && application.change !== "withdrawn"));
  const pondOf = new Map(setup.ponds.map((pond) => [pond.recordId, pond]));
  const liveReadings = readings.filter((reading) => reading.change !== "withdrawn").sort((a, b) => a.data.readAt.localeCompare(b.data.readAt));
  const lastMoved: LastMoved[] = [];
  for (const system of setup.systems.filter((each) => each.change !== "withdrawn" && !each.data.retired && each.data.type !== "slurry_tanker")) {
    const runs = live.filter((application) => application.data.systemId === system.recordId && application.data.positions.length).sort((a, b) => a.data.startedAt.localeCompare(b.data.startedAt));
    const last = runs.at(-1);
    const position = last ? [...last.data.positions].sort((a, b) => a.movedAt.localeCompare(b.movedAt)).at(-1)! : null;
    if (!last || !position) continue;
    const running = !last.data.stoppedAt;
    const shiftDue = running && system.data.shiftEveryHours ? new Date(Date.parse(position.movedAt) + Number(system.data.shiftEveryHours) * 3_600_000).toISOString() : null;
    lastMoved.push({ systemId: system.recordId, systemName: system.data.name, point: position.point, label: position.label, paddockId: position.paddockId, movedAt: position.movedAt, running, applicationId: last.recordId, shiftDue });
  }
  return {
    applications: shown
      .map((application) => ({ ...application, running: !application.data.stoppedAt && application.change !== "withdrawn", flags: applicationFlags(application, live, consent, zones) }))
      .sort((a, b) => b.data.startedAt.localeCompare(a.data.startedAt)),
    readings: readings
      .filter((reading) => inRange(reading.happenedOn, from, to))
      .map((reading) => {
        const pond = pondOf.get(reading.data.pondId);
        return { ...reading, state: pond ? pondState(pond.data, reading.data.levelMm) : null };
      })
      .sort((a, b) => b.data.readAt.localeCompare(a.data.readAt)),
    deferrals: deferrals.filter((deferral) => inRange(deferral.data.on, from, to)).sort((a, b) => b.data.on.localeCompare(a.data.on)),
    ponds: setup.ponds
      .filter((pond) => pond.change !== "withdrawn" && !pond.data.retired)
      .map((pond) => {
        const latest = liveReadings.filter((reading) => reading.data.pondId === pond.recordId).at(-1) ?? null;
        return { ...pond, latest: latest ? { ...latest, state: pondState(pond.data, latest.data.levelMm) } : null, readToday: Boolean(latest && isoDateAt(new Date(latest.data.readAt)) === today) };
      }),
    lastMoved,
    summary: limitsSummary(
      shown.filter((application) => inRange(application.happenedOn, from, to)),
      live,
      consent,
      zones,
    ),
    setup,
  };
}

export { LOG_KINDS };
