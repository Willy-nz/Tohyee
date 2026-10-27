import type { OrgTx } from "@/lib/db/org-transaction";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { dec, isDecimalString, isNegative, isZero, toPlainString } from "@/lib/money/decimal";
import { fileRefs } from "@/lib/safety/files";
import { appendEntry, currentRecord, currentRecords, requireSafetyRecorder } from "@/lib/safety/records";
import { type ChemicalData, type CurrentRecord, type SafetyChange, type SafetyPerson, sdsOutOfDate, type TrainingData, trainingState, type TrainingState } from "@/lib/safety/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * The training register and the chemicals inventory (#446, decisions
 * 956-957).
 *
 * - Training (WorkSafe's farm guide: keep training records and which jobs
 *   each person can and can't do) is per person, for every farm. Expiry
 *   dates show Expires soon (60 days) and Expired; the person can confirm
 *   their own record on their own login.
 * - Chemicals (WorkSafe's hazardous substances inventory) are per farm:
 *   name, UN number, the most likely on site, where, storage, hazards, the
 *   safety data sheet (a PDF) and its date; one more than five years old,
 *   or missing, says to get a new one.
 */

function personOf(tx: OrgTx, input: unknown, members: ReadonlyMap<string, string>): SafetyPerson {
  const value = (input ?? {}) as Record<string, unknown>;
  if (typeof value.userId === "string" && value.userId) {
    const userId = value.userId.toLowerCase();
    const name = members.get(userId);
    if (!name) throw new ValidationError("That person isn't a member of this organisation.");
    return { userId, name, company: null, phone: null };
  }
  return { userId: null, name: requireString(value.name, "Who", { maxLength: 150 }), company: optionalString(value.company, "Company", { maxLength: 150 }), phone: null };
}

// Training -------------------------------------------------------------------------------------------

export async function addTraining(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireSafetyRecorder(tx);
  const completedOn = parseIsoDate(input.completedOn, "Done on");
  if (completedOn > todayIsoDate()) throw new ValidationError("Done on can't be after today.");
  const data: TrainingData = {
    person: personOf(tx, input.person, members),
    what: requireString(input.what, "What training", { maxLength: 200 }),
    provider: optionalString(input.provider, "Who gave it", { maxLength: 150 }),
    expiresOn: parseOptionalIsoDate(input.expiresOn || null, "Expires"),
    certificate: optionalString(input.certificate, "Certificate number", { maxLength: 100 }),
    canDo: optionalString(input.canDo, "What it covers", { maxLength: 1000 }),
    files: await fileRefs(tx, input.files, null, false),
    confirmedByPerson: false,
  };
  if (data.expiresOn && data.expiresOn < completedOn) throw new ValidationError("It expires before it was done.");
  return appendEntry<TrainingData>(tx, { kind: "training", change: "created", farmId: null, happenedOn: completedOn, data: { ...data }, operationId: input.operationId });
}

/**
 * A new version: "update" or "correct" (fields), "withdraw" (entered by
 * mistake), or "confirm", which only the person it's about can do, on
 * their own login (decision 956).
 */
export async function changeTraining(tx: OrgTx, recordId: unknown, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  const current = await currentRecord<TrainingData>(tx, "training", recordId);
  if (input.step === "confirm") {
    if (!tx.actor.userId || current.data.person.userId !== tx.actor.userId || tx.actor.via) throw new ForbiddenError("Only the person it's about can confirm their training, on their own login.");
    if (current.data.confirmedByPerson) throw new ValidationError("It's already confirmed.");
    return appendEntry<TrainingData>(tx, { kind: "training", recordId: current.recordId, expectedVersion: input.expectedVersion, change: "updated", farmId: null, happenedOn: current.happenedOn, data: { ...current.data, why: undefined, confirmedByPerson: true } });
  }
  requireSafetyRecorder(tx);
  const change: SafetyChange = input.step === "correct" ? "corrected" : input.step === "withdraw" ? "withdrawn" : "updated";
  const merged = { ...current.data, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as Record<string, unknown>;
  const data: TrainingData = {
    person: input.person ? personOf(tx, input.person, members) : current.data.person,
    what: requireString(merged.what, "What training", { maxLength: 200 }),
    provider: optionalString(merged.provider, "Who gave it", { maxLength: 150 }),
    expiresOn: parseOptionalIsoDate(merged.expiresOn || null, "Expires"),
    certificate: optionalString(merged.certificate, "Certificate number", { maxLength: 100 }),
    canDo: optionalString(merged.canDo, "What it covers", { maxLength: 1000 }),
    files: input.files === undefined ? current.data.files : await fileRefs(tx, input.files, null, false),
    // A change to someone's record needs them to confirm it again.
    confirmedByPerson: false,
  };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (change !== "updated" && !why) throw new ValidationError("Say why.");
  if (why) data.why = why;
  return appendEntry<TrainingData>(tx, { kind: "training", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: null, happenedOn: current.happenedOn, data: { ...data }, operationId: input.operationId });
}

export type TrainingView = CurrentRecord<TrainingData> & { state: TrainingState };

/** The training register, soonest to expire first. `mine` limits it to the person's own. */
export async function listTraining(tx: OrgTx, options: { mine?: boolean } = {}): Promise<TrainingView[]> {
  const today = todayIsoDate();
  // Farm staff see only their own training (decision 961).
  if (tx.actor.role === "farm_worker") options = { mine: true };
  const records = await currentRecords<TrainingData>(tx, "training");
  return records
    .filter((record) => !options.mine || record.data.person.userId === tx.actor.userId)
    .map((record) => ({ ...record, state: trainingState(record, today) }))
    .sort((a, b) => (a.data.expiresOn ?? "9999").localeCompare(b.data.expiresOn ?? "9999") || a.data.person.name.localeCompare(b.data.person.name));
}

// Chemicals ------------------------------------------------------------------------------------------------

function quantity(input: unknown): string | null {
  if (input == null || input === "") return null;
  const text = String(input).trim();
  if (!isDecimalString(text)) throw new ValidationError("Enter the most on site as a number, like 200 or 12.5.");
  const value = dec(text);
  if (isNegative(value) || isZero(value)) throw new ValidationError("The most on site must be more than zero.");
  return toPlainString(value);
}

async function chemicalData(tx: OrgTx, farmId: string, input: Record<string, unknown>): Promise<ChemicalData> {
  const unNumber = optionalString(input.unNumber, "UN number", { maxLength: 10 });
  if (unNumber && !/^(UN ?)?\d{4}$/i.test(unNumber)) throw new ValidationError("A UN number is four digits, like 1203.");
  const sdsRefs = await fileRefs(tx, input.sds ? [input.sds] : [], farmId, false);
  const data: ChemicalData = {
    name: requireString(input.name, "Name", { maxLength: 150 }),
    unNumber: unNumber ? unNumber.replace(/^UN ?/i, "") : null,
    maxQuantity: quantity(input.maxQuantity),
    unit: optionalString(input.unit, "Unit", { maxLength: 20 }),
    location: optionalString(input.location, "Where it's kept", { maxLength: 200 }),
    storage: optionalString(input.storage, "Storage", { maxLength: 1000 }),
    hazards: optionalString(input.hazards, "Hazards", { maxLength: 1000 }),
    sds: sdsRefs[0] ?? null,
    sdsDate: parseOptionalIsoDate(input.sdsDate || null, "Safety data sheet date"),
    approvedHandler: input.approvedHandler === true,
    hazardousWaste: optionalString(input.hazardousWaste, "Hazardous waste", { maxLength: 1000 }),
    removed: input.removed === true,
  };
  if (data.sdsDate && data.sdsDate > todayIsoDate()) throw new ValidationError("The safety data sheet's date is after today.");
  if (data.maxQuantity && !data.unit) throw new ValidationError("Give the unit, like L or kg.");
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  return data;
}

export async function addChemical(tx: OrgTx, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  return appendEntry<ChemicalData>(tx, { kind: "chemical", change: "created", farmId, data: { ...(await chemicalData(tx, farmId, input)) }, operationId: input.operationId });
}

export async function changeChemical(tx: OrgTx, recordId: unknown, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<ChemicalData>(tx, "chemical", recordId);
  const change: SafetyChange = input.step === "correct" ? "corrected" : input.step === "withdraw" ? "withdrawn" : "updated";
  const merged: Record<string, unknown> = { ...current.data, why: undefined, sds: current.data.sds ? { id: current.data.sds.id } : null };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value;
  const data = await chemicalData(tx, current.farmId!, merged);
  if ((change !== "updated" || (data.removed && !current.data.removed)) && !data.why) throw new ValidationError("Say why.");
  return appendEntry<ChemicalData>(tx, { kind: "chemical", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: current.farmId, data: { ...data }, operationId: input.operationId });
}

export type ChemicalView = CurrentRecord<ChemicalData> & { sdsNeeded: boolean };

/** A farm's hazardous substances inventory (removed ones last). */
export async function listChemicals(tx: OrgTx, farmIdInput: unknown): Promise<ChemicalView[]> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const today = todayIsoDate();
  const chemicals = await currentRecords<ChemicalData>(tx, "chemical", { farmId });
  return chemicals
    .filter((chemical) => chemical.farmId === farmId)
    .map((chemical) => ({ ...chemical, sdsNeeded: !chemical.data.removed && sdsOutOfDate(chemical.data, today) }))
    .sort((a, b) => Number(a.data.removed) - Number(b.data.removed) || a.data.name.localeCompare(b.data.name));
}
