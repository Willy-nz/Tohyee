import type { OrgTx } from "@/lib/db/org-transaction";
import { parseOptionalIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { requireFarmAccess } from "@/lib/farming/access";
import { GeometryError, parseGeometry } from "@/lib/farming/geometry";
import { appendEntry, currentRecord, currentRecords, requireSafetyRecorder } from "@/lib/safety/records";
import { EMPTY_EMERGENCY, type EmergencyData, HAZARD_LEVELS, type HazardData, type HazardLevel, type Position, type SafetyChange, type ZoneGeometry } from "@/lib/safety/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Hazards and no-go zones, and each farm's emergency details (#446,
 * decisions 938-941). WorkSafe's farm guidance calls a hazard register "the
 * most basic document every farm needs" and suggests a farm map showing
 * hazards, no-go zones and safe routes; these are kept as safety records
 * (versions, nothing deleted) on a farm, placed by paddock, a point or a
 * drawn zone.
 */

export function point(input: unknown): Position | null {
  if (input == null) return null;
  if (!Array.isArray(input) || input.length !== 2 || !input.every((value) => typeof value === "number" && Number.isFinite(value))) throw new ValidationError("The place on the map isn't a longitude and latitude.");
  const [lon, lat] = input as [number, number];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ValidationError("The place on the map is outside longitude -180 to 180 and latitude -90 to 90.");
  return [lon, lat];
}

export function zone(input: unknown): ZoneGeometry | null {
  if (input == null) return null;
  try {
    const parsed = parseGeometry(input);
    if (parsed.type !== "Polygon") throw new ValidationError("A zone is one outline.");
    return parsed;
  } catch (error) {
    if (error instanceof GeometryError) throw new ValidationError(`The zone: ${error.message}`);
    throw error;
  }
}

export async function paddocksOnFarm(tx: OrgTx, farmId: string, input: unknown): Promise<string[]> {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 200) throw new ValidationError("Choose up to 200 paddocks.");
  const ids = [...new Set(input.map((value) => requireId(value, "Paddock")))];
  if (!ids.length) return [];
  const found = await tx.query<{ id: string }>("select id::text from paddocks where farm_id = $1 and id = any($2::bigint[])", [farmId, ids]);
  if (found.rows.length !== ids.length) throw new ValidationError("One of those paddocks isn't on this farm.");
  return ids.sort((a, b) => Number(a) - Number(b));
}

export type HazardInput = {
  title?: unknown;
  description?: unknown;
  level?: unknown;
  controls?: unknown;
  noGo?: unknown;
  paddockIds?: unknown;
  point?: unknown;
  zone?: unknown;
  reviewDue?: unknown;
  identifiedOn?: unknown;
  removed?: unknown;
  reviewed?: unknown;
  why?: unknown;
};

async function hazardData(tx: OrgTx, farmId: string, input: HazardInput): Promise<HazardData> {
  const level = input.level ?? "medium";
  if (!HAZARD_LEVELS.includes(level as HazardLevel)) throw new ValidationError("Choose how serious it is: low, medium or high.");
  const data: HazardData = {
    title: requireString(input.title, "What the hazard is", { maxLength: 150 }),
    description: optionalString(input.description, "Details", { maxLength: 2000 }),
    level: level as HazardLevel,
    controls: optionalString(input.controls, "What's done about it", { maxLength: 2000 }),
    noGo: input.noGo === true,
    paddockIds: await paddocksOnFarm(tx, farmId, input.paddockIds),
    point: point(input.point),
    zone: zone(input.zone),
    reviewDue: parseOptionalIsoDate(input.reviewDue || null, "Review by"),
    removed: input.removed === true,
  };
  if (input.reviewed === true) data.reviewed = true;
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  return data;
}

export async function listHazards(tx: OrgTx, farmId: unknown, options: { includeWithdrawn?: boolean } = {}) {
  const farm = requireId(farmId, "Farm");
  await requireFarmAccess(tx, farm);
  return currentRecords<HazardData>(tx, "hazard", { farmId: farm, includeWithdrawn: options.includeWithdrawn });
}

export async function addHazard(tx: OrgTx, input: HazardInput & { farmId?: unknown; operationId?: unknown }) {
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  return appendEntry<HazardData>(tx, {
    kind: "hazard",
    change: "created",
    farmId,
    happenedOn: parseOptionalIsoDate(input.identifiedOn || null, "Found on"),
    data: { ...(await hazardData(tx, farmId, input)) },
    operationId: input.operationId,
  });
}

/**
 * A new version of a hazard: changed, corrected (with why), withdrawn as a
 * mistake (with why), marked removed from the farm, or reviewed (it still
 * stands, decision 939). Unchanged fields carry over from the version the
 * person started from.
 */
export async function changeHazard(tx: OrgTx, recordId: unknown, input: HazardInput & { change: unknown; expectedVersion: unknown; operationId?: unknown }) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<HazardData>(tx, "hazard", recordId);
  const change = input.change as SafetyChange;
  if (!["updated", "corrected", "withdrawn"].includes(change)) throw new ValidationError("Choose change, correct or withdraw.");
  const merged: HazardInput = { ...current.data, reviewed: undefined, why: undefined };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && key !== "change" && key !== "expectedVersion" && key !== "operationId") (merged as Record<string, unknown>)[key] = value;
  }
  const data = await hazardData(tx, current.farmId!, merged);
  if ((data.removed && !current.data.removed) || change !== "updated") {
    if (!data.why) throw new ValidationError(change === "corrected" ? "Say what was wrong, so the history shows why it was corrected." : change === "withdrawn" ? "Say why it's withdrawn." : "Say how it was removed.");
  }
  return appendEntry<HazardData>(tx, {
    kind: "hazard",
    recordId: current.recordId,
    expectedVersion: input.expectedVersion,
    change,
    farmId: current.farmId,
    happenedOn: current.happenedOn,
    data: { ...data },
    operationId: input.operationId,
  });
}

// Emergency details -----------------------------------------------------------------------------

function lines<T>(input: unknown, max: number, label: string, each: (value: Record<string, unknown>, index: number) => T | null): T[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > max) throw new ValidationError(`${label}: up to ${max}.`);
  return input.map((value, index) => each((value ?? {}) as Record<string, unknown>, index)).filter((value): value is T => value !== null);
}

function emergencyData(input: Record<string, unknown>): EmergencyData {
  if (Array.isArray(input.firstAiders) && input.firstAiders.length > 20) throw new ValidationError("First aiders: up to 20.");
  return {
    address: optionalString(input.address, "Address", { maxLength: 300 }),
    entrance: optionalString(input.entrance, "Entrance", { maxLength: 300 }),
    assemblyPoint: optionalString(input.assemblyPoint, "Assembly point", { maxLength: 300 }),
    contacts: lines(input.contacts, 20, "Contacts", (value, index) => {
      if (!value.name && !value.phone) return null;
      return {
        name: requireString(value.name, `Contact ${index + 1}'s name`, { maxLength: 100 }),
        role: optionalString(value.role, `Contact ${index + 1}'s role`, { maxLength: 100 }),
        phone: requireString(value.phone, `Contact ${index + 1}'s phone`, { maxLength: 40, pattern: /^[0-9+() -]{3,40}$/, patternHint: `Contact ${index + 1}'s phone can only have numbers, spaces, + and brackets.` }),
      };
    }),
    firstAiders: Array.isArray(input.firstAiders)
      ? input.firstAiders.map((name) => optionalString(name, "First aider", { maxLength: 100 })).filter((name): name is string => name !== null)
      : [],
    equipment: lines(input.equipment, 30, "Emergency equipment", (value, index) => {
      if (!value.what && !value.where) return null;
      return { what: requireString(value.what, `Equipment ${index + 1}`, { maxLength: 100 }), where: requireString(value.where, `Where equipment ${index + 1} is`, { maxLength: 200 }) };
    }),
    noCoveragePlan: optionalString(input.noCoveragePlan, "No phone coverage plan", { maxLength: 2000 }),
    medicalCentre: optionalString(input.medicalCentre, "Nearest medical centre", { maxLength: 300 }),
    notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
  };
}

/** The farm's emergency details (the latest version), or empty ones if none yet. */
export async function getEmergency(tx: OrgTx, farmId: unknown) {
  const farm = requireId(farmId, "Farm");
  const records = await currentRecords<EmergencyData>(tx, "emergency_info", { farmId: farm });
  return records.find((record) => record.farmId === farm) ?? null;
}

/** Saves a farm's emergency details as a new version (one record per farm). */
export async function saveEmergency(tx: OrgTx, input: Record<string, unknown> & { farmId?: unknown; expectedVersion?: unknown; operationId?: unknown }) {
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  const data: EmergencyData = { ...EMPTY_EMERGENCY, ...emergencyData(input) };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  const existing = await getEmergency(tx, farmId);
  if (!existing) return appendEntry<EmergencyData>(tx, { kind: "emergency_info", change: "created", farmId, data: { ...data }, operationId: input.operationId });
  const change = input.change === "corrected" ? "corrected" : "updated";
  return appendEntry<EmergencyData>(tx, { kind: "emergency_info", recordId: existing.recordId, expectedVersion: input.expectedVersion, change, farmId, data: { ...data }, operationId: input.operationId });
}
