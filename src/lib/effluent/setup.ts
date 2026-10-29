import type { OrgTx } from "@/lib/db/org-transaction";
import { parseOptionalIsoDate } from "@/lib/dates";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { parseDecimalInput } from "@/lib/money/decimal";
import { addChecklist, addEquipment, listEquipment } from "@/lib/safety/equipment";
import { paddocksOnFarm, point, zone } from "@/lib/safety/hazards";
import { appendEntry, canReportSafety, currentRecord, currentRecords } from "@/lib/safety/records";
import type { CurrentRecord, EquipmentData, SafetyChange, SafetyKind } from "@/lib/safety/shared";
import {
  type BlockData,
  type Buffer,
  CHECK_EVERY,
  type CheckEvery,
  CONSENT_TEMPLATES,
  type ConsentData,
  type Council,
  COUNCILS,
  type CouncilNotice,
  EMPTY_SETTINGS,
  POND_KINDS,
  type PondData,
  type PondKind,
  type PondMarker,
  RISK_LEVELS,
  type RiskLevel,
  SETTINGS_FOR,
  STARTING_CHECKLISTS,
  type SystemData,
  type SystemSettings,
  SYSTEM_TYPE_LABELS,
  SYSTEM_TYPES,
  type SystemType,
  TEMPLATE_FIELDS,
  ZONE_FEATURES,
  type ZoneData,
  type ZoneFeature,
} from "@/lib/effluent/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Effluent setup (#487, decisions 1070-1079): the farm's systems, ponds and
 * sumps, effluent blocks, no-apply zones and buffers, and its consent
 * conditions. Each is a record in the safety history (versions dated by the
 * database, nothing deleted, corrections marked).
 *
 * - Owners and admins keep the setup and the consent conditions (decision
 *   1071); everyone who sees the farm reads them. Farm staff log, check and
 *   report on their assigned farms (src/lib/effluent/log.ts).
 * - A system is a machine in Safety's equipment register, so its checks,
 *   faults, "out of use" and release follow Safety's rules (decision 1075).
 *   Adding a system with no machine makes one, with a starting checklist.
 */

export const SETUP_PARTS = { systems: "effluent_system", ponds: "effluent_pond", blocks: "effluent_block", zones: "effluent_zone", consents: "effluent_consent" } as const satisfies Record<string, SafetyKind>;
export type SetupPart = keyof typeof SETUP_PARTS;

export function isSetupPart(value: unknown): value is SetupPart {
  return typeof value === "string" && Object.hasOwn(SETUP_PARTS, value);
}

/** Owners and admins keep the setup and consent conditions (decision 1071). Work Tohyee does itself counts too. */
export function canManageEffluent(tx: OrgTx): boolean {
  return !tx.actor.userId || tx.actor.role === "owner" || tx.actor.role === "admin";
}

export function requireEffluentManager(tx: OrgTx): void {
  if (!canManageEffluent(tx)) throw new ForbiddenError("Only an owner or an admin can change the effluent setup and consent conditions.");
}

/** Logging, checks and reports: farm staff and bookkeepers and above, on their farms (decision 1071). */
export function canLogEffluent(tx: OrgTx): boolean {
  return canReportSafety(tx);
}

export function requireEffluentLogger(tx: OrgTx): void {
  if (!canLogEffluent(tx)) throw new ForbiddenError("Recording effluent work needs the farm staff or bookkeeper role or higher in this organisation.");
}

export type EffluentAccess = { canManage: boolean; canLog: boolean; farmStaff: boolean };

export function effluentAccess(tx: OrgTx): EffluentAccess {
  return { canManage: canManageEffluent(tx), canLog: canLogEffluent(tx), farmStaff: tx.actor.role === "farm_worker" };
}

// Field parsing --------------------------------------------------------------------------------------

/** A positive decimal (or empty), at most `scale` places. */
export function amount(input: unknown, field: string, options: { scale?: number; zero?: boolean } = {}): string | null {
  if (input === null || input === undefined || input === "") return null;
  return parseDecimalInput(input, field, { maxScale: options.scale ?? 2, allowZero: options.zero ?? false });
}

function whole(input: unknown, field: string, max: number): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new ValidationError(`${field} must be a whole number from 1 to ${max}.`);
  return value;
}

function lines(input: unknown, field: string, max = 20): string[] {
  if (input == null) return [];
  const raw = typeof input === "string" ? input.split(/\r?\n/) : input;
  if (!Array.isArray(raw)) throw new ValidationError(`${field}: one per line.`);
  const out = raw.map((line) => (typeof line === "string" ? line.trim() : "")).filter(Boolean);
  if (out.length > max) throw new ValidationError(`${field}: at most ${max}.`);
  for (const line of out) if (line.length > 500) throw new ValidationError(`${field}: each at most 500 characters.`);
  return out;
}

function withWhy<T extends { why?: string | null }>(data: T, input: Record<string, unknown>): T {
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  else delete data.why;
  return data;
}

function changeOf(input: Record<string, unknown>): SafetyChange {
  return input.step === "correct" ? "corrected" : input.step === "withdraw" ? "withdrawn" : "updated";
}

async function sameFarmRecord(tx: OrgTx, kind: SafetyKind, id: unknown, farmId: string, label: string): Promise<string> {
  const record = await currentRecord(tx, kind, id).catch(() => null);
  if (!record || record.change === "withdrawn" || record.farmId !== farmId) throw new ValidationError(`That ${label} isn't on this farm.`);
  return record.recordId;
}

// Systems ---------------------------------------------------------------------------------------------

function settingsOf(type: SystemType, input: unknown): SystemSettings {
  const value = (input ?? {}) as Record<string, unknown>;
  const settings: SystemSettings = { ...EMPTY_SETTINGS };
  for (const key of SETTINGS_FOR[type]) settings[key] = amount(value[key], key === "pulsePercent" ? "Share of time running" : key === "tankM3" ? "Tank volume" : "That setting", { scale: 3 });
  if (settings.pulsePercent && Number(settings.pulsePercent) > 100) throw new ValidationError("The share of time running can be at most 100%.");
  return settings;
}

async function systemData(tx: OrgTx, farmId: string, input: Record<string, unknown>, equipmentId: string): Promise<SystemData> {
  const type = input.type as SystemType;
  if (!SYSTEM_TYPES.includes(type)) throw new ValidationError("Choose the kind of system: travelling irrigator, pods or K-line, slurry tanker or spreader, or fixed sprinklers or rain gun.");
  const checkEvery = (input.checkEvery ?? "day") as CheckEvery;
  if (!CHECK_EVERY.includes(checkEvery)) throw new ValidationError("Choose how often it's checked: each day it's used, or each week.");
  let tractorEquipmentId: string | null = null;
  if (input.tractorEquipmentId) {
    tractorEquipmentId = requireId(input.tractorEquipmentId, "Tractor mode machine");
    const found = await tx.query("select 1 from tractor_equipment where id = $1", [tractorEquipmentId]);
    if (!found.rowCount) throw new ValidationError("That tractor mode machine wasn't found.");
  }
  const blockIds: string[] = [];
  for (const id of Array.isArray(input.blockIds) ? input.blockIds.slice(0, 50) : []) blockIds.push(await sameFarmRecord(tx, "effluent_block", id, farmId, "block"));
  blockIds.splice(0, blockIds.length, ...[...new Set(blockIds)].sort());
  return withWhy<SystemData>(
    {
      name: requireString(input.name, "Name", { maxLength: 150 }),
      type,
      equipmentId,
      tractorEquipmentId: type === "slurry_tanker" ? tractorEquipmentId : null,
      pondId: input.pondId ? await sameFarmRecord(tx, "effluent_pond", input.pondId, farmId, "pond") : null,
      blockIds,
      settings: settingsOf(type, input.settings),
      shiftEveryHours: type === "slurry_tanker" ? null : amount(input.shiftEveryHours, "Shift every (hours)", { scale: 1 }),
      checkEvery,
      serviceEveryMonths: whole(input.serviceEveryMonths, "Service every (months)", 60),
      wofDue: parseOptionalIsoDate(input.wofDue || null, "Next Effluent WoF"),
      notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
      retired: input.retired === true,
    },
    input,
  );
}

/**
 * Adds a system. With `equipmentId` it uses that machine from Safety's
 * register (on the same farm); without, it adds one named after the system
 * with a starting checklist for its type (decision 1076).
 */
export async function addSystem(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireEffluentManager(tx);
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const type = input.type as SystemType;
  if (!SYSTEM_TYPES.includes(type)) throw new ValidationError("Choose the kind of system: travelling irrigator, pods or K-line, slurry tanker or spreader, or fixed sprinklers or rain gun.");
  // Sent again from a phone: the first save is found without making a second machine.
  if (input.operationId) {
    const existing = await tx.query<{ record_id: string }>("select record_id::text from safety_entries where operation_id = $1 and kind = 'effluent_system'", [String(input.operationId)]);
    if (existing.rows[0]) return currentRecord<SystemData>(tx, "effluent_system", existing.rows[0].record_id);
  }
  let equipmentId: string;
  if (input.equipmentId) {
    const equipment = await currentRecord<EquipmentData>(tx, "equipment", input.equipmentId).catch(() => null);
    if (!equipment || equipment.change === "withdrawn" || equipment.farmId !== farmId) throw new ValidationError("That machine isn't in this farm's equipment register.");
    equipmentId = equipment.recordId;
  } else {
    const name = requireString(input.name, "Name", { maxLength: 150 });
    const checklist = await addChecklist(tx, { farmId, title: `${name} pre-start (effluent)`, items: STARTING_CHECKLISTS[type] });
    const equipment = await addEquipment(
      tx,
      { farmId, name, type: `Effluent: ${SYSTEM_TYPE_LABELS[type].toLowerCase()}`, owner: "owned", fixedAssetId: input.fixedAssetId || null, checklistId: checklist.recordId, responsibleUserId: input.responsibleUserId || null, releaserUserIds: [] },
      members,
    );
    equipmentId = equipment.recordId;
  }
  const data = await systemData(tx, farmId, input, equipmentId);
  return appendEntry<SystemData>(tx, { kind: "effluent_system", change: "created", farmId, data: { ...data }, operationId: input.operationId });
}

// Ponds -----------------------------------------------------------------------------------------------

function pondData(input: Record<string, unknown>): PondData {
  const kind = (input.kind ?? "pond") as PondKind;
  if (!POND_KINDS.includes(kind)) throw new ValidationError("Choose what it is: storage pond, sump, tank, weeping wall or other.");
  const markers: PondMarker[] = (Array.isArray(input.markers) ? input.markers : []).slice(0, 10).map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    return { label: requireString(value.label, `Mark ${index + 1}'s name`, { maxLength: 40 }), mm: amount(value.mm, `Mark ${index + 1}'s reading (mm)`, { scale: 0, zero: true }) ?? "0" };
  });
  if (Array.isArray(input.markers) && input.markers.length > 10) throw new ValidationError("Add at most 10 marks.");
  const data: PondData = {
    name: requireString(input.name, "Name", { maxLength: 150 }),
    kind,
    capacityM3: amount(input.capacityM3, "What it holds (m³)", { scale: 1 }) ?? (() => { throw new ValidationError("Say what it holds when full, in m³."); })(),
    fullAtMm: amount(input.fullAtMm, "Gauge reading when full (mm)", { scale: 0 }),
    markers: markers.sort((a, b) => Number(a.mm) - Number(b.mm)),
    highAtMm: amount(input.highAtMm, "Warn at or above (mm)", { scale: 0 }),
    lowAtMm: amount(input.lowAtMm, "Warn at or below (mm)", { scale: 0, zero: true }),
    dailyInflowM3: amount(input.dailyInflowM3, "Goes in each day (m³)", { scale: 2 }),
    point: point(input.point),
    notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
    retired: input.retired === true,
  };
  if (data.highAtMm && data.lowAtMm && Number(data.lowAtMm) >= Number(data.highAtMm)) throw new ValidationError("The low warning must be below the high warning.");
  if (data.fullAtMm && data.highAtMm && Number(data.highAtMm) > Number(data.fullAtMm)) throw new ValidationError("The high warning can't be above full.");
  return withWhy(data, input);
}

// Blocks and zones ------------------------------------------------------------------------------------

async function blockData(tx: OrgTx, farmId: string, input: Record<string, unknown>): Promise<BlockData> {
  const risk = input.risk === null || input.risk === undefined || input.risk === "" ? null : (input.risk as RiskLevel);
  if (risk !== null && !RISK_LEVELS.includes(risk)) throw new ValidationError("Choose lower- or higher-risk soils, or leave it empty.");
  const data: BlockData = {
    name: requireString(input.name, "Name", { maxLength: 150 }),
    paddockIds: await paddocksOnFarm(tx, farmId, input.paddockIds),
    zone: zone(input.zone),
    areaHa: amount(input.areaHa, "Area (ha)", { scale: 2 }),
    risk,
    notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
    retired: input.retired === true,
  };
  if (!data.paddockIds.length && !data.zone) throw new ValidationError("Choose the block's paddocks, or draw it on the map.");
  return withWhy(data, input);
}

function zoneData(input: Record<string, unknown>): ZoneData {
  const feature = input.feature as ZoneFeature;
  if (!ZONE_FEATURES.includes(feature)) throw new ValidationError("Choose what it is: a waterway, drain, wetland, bore, boundary, house, road, public place or other.");
  const data: ZoneData = {
    name: requireString(input.name, "Name", { maxLength: 150 }),
    feature,
    point: point(input.point),
    zone: zone(input.zone),
    bufferM: amount(input.bufferM, "Buffer (m)", { scale: 1, zero: true }),
    notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
    removed: input.removed === true,
  };
  if (!data.point && !data.zone) throw new ValidationError("Put it on the map: tap where it is, or draw its outline.");
  return withWhy(data, input);
}

// Consent conditions ----------------------------------------------------------------------------------

function buffersOf(input: unknown): Buffer[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 20) throw new ValidationError("Add up to 20 buffers.");
  return input.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const feature = value.feature as ZoneFeature;
    if (!ZONE_FEATURES.includes(feature)) throw new ValidationError(`Buffer ${index + 1}: choose what it's from.`);
    return { feature, metres: amount(value.metres, `Buffer ${index + 1} (m)`, { scale: 1 }) ?? (() => { throw new ValidationError(`Buffer ${index + 1}: give the distance in metres.`); })() };
  });
}

function noticeOf(input: unknown): CouncilNotice | null {
  if (input == null || input === "") return null;
  const value = input as Record<string, unknown>;
  const who = optionalString(value.who, "Who to tell", { maxLength: 150 });
  const when = optionalString(value.when, "When to tell them", { maxLength: 1000 });
  if (!who && !when) return null;
  return { who: who ?? "The regional council", phone: optionalString(value.phone, "Their phone", { maxLength: 40 }), when: when ?? "As your consent says." };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The consent's conditions as entered. Starting from a template fills in
 * what that council's pages say (decision 1073) and lists those fields in
 * `fromTemplate`; a field changed from the template's text comes off the
 * list. Depth, rate and return period are always the farm's to enter.
 */
function consentData(input: Record<string, unknown>, previous: ConsentData | null): ConsentData {
  const council = (input.council ?? previous?.council ?? "other") as Council;
  if (!COUNCILS.includes(council)) throw new ValidationError("Choose the regional council.");
  const templateKey = input.template === undefined ? (previous?.template ?? null) : input.template === null || input.template === "" ? null : (input.template as Council);
  if (templateKey !== null && templateKey !== "orc" && templateKey !== "es") throw new ValidationError("There's a starting template for Otago Regional Council and Environment Southland only.");
  const template = templateKey ? CONSENT_TEMPLATES[templateKey] : null;
  const starting = template && !previous;
  const pick = (key: string, fallback: unknown) => (input[key] !== undefined ? input[key] : starting ? fallback : (previous as Record<string, unknown> | null)?.[key]);
  const data: ConsentData = {
    title: requireString(pick("title", template?.title), "What the consent is", { maxLength: 200 }),
    consentNumber: optionalString(pick("consentNumber", null), "Consent number", { maxLength: 60 }),
    council,
    expiresOn: parseOptionalIsoDate(pick("expiresOn", null) || null, "Expires"),
    maxDepthMm: amount(pick("maxDepthMm", null), "Most depth (mm)", { scale: 1 }),
    maxRateMmPerHour: amount(pick("maxRateMmPerHour", null), "Most rate (mm an hour)", { scale: 1 }),
    returnPeriodDays: whole(pick("returnPeriodDays", null), "Days between applications", 365),
    maxNitrogenKgHaYr: amount(pick("maxNitrogenKgHaYr", null), "Most nitrogen (kg N/ha a year)", { scale: 0 }),
    storageM3: amount(pick("storageM3", null), "Storage needed (m³)", { scale: 0 }),
    buffers: buffersOf(pick("buffers", template?.buffers)),
    deferWhen: lines(pick("deferWhen", template?.deferWhen), "When not to apply"),
    recordsRequired: lines(pick("recordsRequired", template?.recordsRequired), "Records the consent needs"),
    notifyCouncil: noticeOf(pick("notifyCouncil", template?.notifyCouncil)),
    otherConditions: optionalString(pick("otherConditions", template?.otherConditions), "Other conditions", { maxLength: 8000 }),
    template: templateKey,
    fromTemplate: [],
    sources: template?.sources ?? previous?.sources ?? [],
    replaced: input.replaced === undefined ? (previous?.replaced ?? false) : input.replaced === true,
  };
  if (template) {
    const was = new Set(starting ? TEMPLATE_FIELDS : (previous?.fromTemplate ?? []));
    data.fromTemplate = TEMPLATE_FIELDS.filter((key) => was.has(key) && same(data[key], key === "notifyCouncil" ? template.notifyCouncil : template[key]));
  }
  return withWhy(data, input);
}

// Adding and changing ---------------------------------------------------------------------------------

/** Adds a pond, block, zone or consent (systems: `addSystem`). */
export async function addSetup(tx: OrgTx, part: Exclude<SetupPart, "systems">, input: Record<string, unknown>) {
  requireEffluentManager(tx);
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const data = part === "ponds" ? pondData(input) : part === "blocks" ? await blockData(tx, farmId, input) : part === "zones" ? zoneData(input) : consentData(input, null);
  return appendEntry(tx, { kind: SETUP_PARTS[part], change: "created", farmId, data: { ...data }, operationId: input.operationId });
}

/**
 * A new version of a setup record: `step` "update" (the default),
 * "correct" (a mistake, with why) or "withdraw" (entered by mistake, with
 * why). Only the fields given change.
 */
export async function changeSetup(tx: OrgTx, part: SetupPart, recordId: unknown, input: Record<string, unknown>) {
  requireEffluentManager(tx);
  const kind = SETUP_PARTS[part];
  const current = await currentRecord<Record<string, unknown>>(tx, kind, recordId);
  const change = changeOf(input);
  const farmId = current.farmId!;
  const merged: Record<string, unknown> = { ...current.data, why: undefined };
  for (const [key, value] of Object.entries(input)) if (value !== undefined && key !== "step" && key !== "expectedVersion" && key !== "organisationId" && key !== "operationId") merged[key] = value;
  let data: Record<string, unknown>;
  if (change === "withdrawn") data = { ...current.data, why: requireString(input.why, "Why", { maxLength: 1000 }) };
  else if (part === "systems") data = { ...(await systemData(tx, farmId, merged, (current.data as SystemData).equipmentId)) };
  else if (part === "ponds") data = { ...pondData(merged) };
  else if (part === "blocks") data = { ...(await blockData(tx, farmId, merged)) };
  else if (part === "zones") data = { ...zoneData(merged) };
  else data = { ...consentData({ ...input, why: input.why }, current.data as ConsentData) };
  if (change === "corrected" && !data.why) throw new ValidationError("Say what was wrong, so the history shows why it was corrected.");
  return appendEntry(tx, { kind, recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId, data, operationId: input.operationId });
}

// Reading ---------------------------------------------------------------------------------------------

export type SystemView = CurrentRecord<SystemData> & {
  /** From Safety's equipment register: out of use after a failed critical check until released (decision 1075). */
  available: boolean;
  outOfUseBecause: string | null;
  canRelease: boolean;
  checklistId: string | null;
  checklistVersion: number | null;
  lastCheckedAt: string | null;
};

export type EffluentSetup = {
  systems: SystemView[];
  ponds: Array<CurrentRecord<PondData>>;
  blocks: Array<CurrentRecord<BlockData>>;
  zones: Array<CurrentRecord<ZoneData>>;
  consents: Array<CurrentRecord<ConsentData>>;
  access: EffluentAccess;
};

/** A farm's effluent setup, with each system's in-use state from Safety. */
export async function effluentSetup(tx: OrgTx, farmIdInput: unknown, options: { includeWithdrawn?: boolean } = {}): Promise<EffluentSetup> {
  await requireFarming(tx);
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const own = <T>(records: Array<CurrentRecord<T>>) => records.filter((record) => record.farmId === farmId);
  const filter = { farmId, includeWithdrawn: options.includeWithdrawn };
  // One after another: they share the transaction's connection.
  const systems = await currentRecords<SystemData>(tx, "effluent_system", filter);
  const ponds = await currentRecords<PondData>(tx, "effluent_pond", filter);
  const blocks = await currentRecords<BlockData>(tx, "effluent_block", filter);
  const zones = await currentRecords<ZoneData>(tx, "effluent_zone", filter);
  const consents = await currentRecords<ConsentData>(tx, "effluent_consent", filter);
  const { equipment } = await listEquipment(tx, farmId);
  return {
    systems: own(systems).map((system) => {
      const machine = equipment.find((item) => item.recordId === system.data.equipmentId);
      const faults = machine?.failedCheck?.data.answers.filter((answer) => answer.critical && answer.result === "fault").map((answer) => (answer.note ? `${answer.text}: ${answer.note}` : answer.text));
      return {
        ...system,
        available: machine ? machine.available : true,
        outOfUseBecause: machine && !machine.available ? (faults?.join("; ") ?? "A failed check") : null,
        canRelease: machine?.canRelease ?? false,
        checklistId: machine?.checklist?.recordId ?? null,
        checklistVersion: machine?.checklist?.version ?? null,
        lastCheckedAt: machine?.lastCheck?.enteredAt ?? null,
      };
    }),
    ponds: own(ponds),
    blocks: own(blocks),
    zones: own(zones),
    consents: own(consents),
    access: effluentAccess(tx),
  };
}
