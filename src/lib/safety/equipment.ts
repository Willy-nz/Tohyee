import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { fileRefs } from "@/lib/safety/files";
import { appendEntry, currentRecord, currentRecords, requireSafetyRecorder } from "@/lib/safety/records";
import { addAction } from "@/lib/safety/reports";
import {
  type CheckAnswer,
  type CheckData,
  type ChecklistData,
  type ChecklistItem,
  type CurrentRecord,
  EQUIPMENT_OWNERS,
  type EquipmentData,
  type EquipmentOwner,
  type ReleaseData,
  type SafetyChange,
} from "@/lib/safety/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Equipment and pre-start checks (#446, decisions 953-955; William's
 * review: "Scan an equipment QR code, complete a short checklist,
 * photograph faults and record the result").
 *
 * - Equipment is a safety record on a farm. It may name a fixed asset in
 *   the books but doesn't need one: hired and contractors' machines count.
 * - A check copies in the checklist's questions as asked, so changing the
 *   checklist never changes an answer already given (decision 954).
 * - A failed critical item puts the equipment out of use and makes an
 *   action for whoever's responsible. Only an owner, an admin or a member
 *   named on the equipment can release it, with what was done and when
 *   (recorded by the database), never through an AI or app. Out of use is
 *   worked out from the checks and releases, not typed in, and it isn't a
 *   physical lockout (decision 955).
 */

// Checklists ---------------------------------------------------------------------------------------------

function checklistData(input: Record<string, unknown>, previous: ChecklistData | null): ChecklistData {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 60) throw new ValidationError("Add between 1 and 60 things to check.");
  const used = new Set<string>();
  const items: ChecklistItem[] = input.items.map((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>;
    const text = requireString(value.text, `Check ${index + 1}`, { maxLength: 300 });
    // Keep an item's key across versions when it's given back (so answers line up), else make one.
    let key = typeof value.key === "string" && /^[a-z0-9-]{1,40}$/.test(value.key) ? value.key : "";
    if (!key || used.has(key)) {
      const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "item";
      key = base;
      for (let n = 2; used.has(key) || previous?.items.some((item) => item.key === key && item.text !== text); n += 1) key = `${base}-${n}`;
    }
    used.add(key);
    return { key, text, critical: value.critical === true };
  });
  const data: ChecklistData = { title: requireString(input.title, "Checklist name", { maxLength: 150 }), items };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  return data;
}

export async function addChecklist(tx: OrgTx, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const farmId = input.farmId ? requireId(input.farmId, "Farm") : null;
  return appendEntry<ChecklistData>(tx, { kind: "checklist", change: "created", farmId, data: { ...checklistData(input, null) }, operationId: input.operationId });
}

export async function changeChecklist(tx: OrgTx, recordId: unknown, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<ChecklistData>(tx, "checklist", recordId);
  const change: SafetyChange = input.change === "corrected" ? "corrected" : input.change === "withdrawn" ? "withdrawn" : "updated";
  const data = change === "withdrawn" ? { ...current.data, why: requireString(input.why, "Why", { maxLength: 1000 }) } : checklistData({ ...current.data, why: undefined, ...input }, current.data);
  return appendEntry<ChecklistData>(tx, { kind: "checklist", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: current.farmId, data: { ...data }, operationId: input.operationId });
}

// Equipment ----------------------------------------------------------------------------------------------

async function equipmentData(tx: OrgTx, farmId: string, input: Record<string, unknown>, members: ReadonlyMap<string, string>): Promise<EquipmentData> {
  const owner = (input.owner ?? "owned") as EquipmentOwner;
  if (!EQUIPMENT_OWNERS.includes(owner)) throw new ValidationError("Say whose it is: ours, hired or a contractor's.");
  let fixedAssetId: string | null = null;
  if (input.fixedAssetId) {
    fixedAssetId = requireId(input.fixedAssetId, "Fixed asset");
    const asset = await tx.query("select 1 from fixed_assets where id = $1", [fixedAssetId]);
    if (!asset.rowCount) throw new ValidationError("That fixed asset wasn't found.");
  }
  let checklistId: string | null = null;
  if (input.checklistId) {
    const checklist = await currentRecord<ChecklistData>(tx, "checklist", input.checklistId);
    if (checklist.change === "withdrawn" || (checklist.farmId && checklist.farmId !== farmId)) throw new ValidationError("That checklist can't be used here.");
    checklistId = checklist.recordId;
  }
  const member = (value: unknown) => {
    const id = typeof value === "string" && value ? value.toLowerCase() : null;
    if (id && !members.has(id)) throw new ValidationError("That person isn't a member of this organisation.");
    return id;
  };
  const releasers = Array.isArray(input.releaserUserIds) ? [...new Set(input.releaserUserIds.map((value) => member(value)).filter((value): value is string => value !== null))] : [];
  const data: EquipmentData = {
    name: requireString(input.name, "Name", { maxLength: 150 }),
    type: optionalString(input.type, "Type", { maxLength: 100 }),
    owner,
    ownerName: owner === "owned" ? null : optionalString(input.ownerName, "Whose", { maxLength: 150 }),
    fixedAssetId,
    checklistId,
    responsibleUserId: member(input.responsibleUserId),
    releaserUserIds: releasers.sort(),
    notes: optionalString(input.notes, "Notes", { maxLength: 2000 }),
    retired: input.retired === true,
  };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  return data;
}

export async function addEquipment(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireSafetyRecorder(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  return appendEntry<EquipmentData>(tx, { kind: "equipment", change: "created", farmId, data: { ...(await equipmentData(tx, farmId, input, members)) }, operationId: input.operationId });
}

export async function changeEquipment(tx: OrgTx, recordId: unknown, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<EquipmentData>(tx, "equipment", recordId);
  const change: SafetyChange = input.change === "corrected" ? "corrected" : input.change === "withdrawn" ? "withdrawn" : "updated";
  const data = await equipmentData(tx, current.farmId!, { ...current.data, why: undefined, ...input }, members);
  if (change !== "updated" && !data.why) throw new ValidationError("Say why.");
  return appendEntry<EquipmentData>(tx, { kind: "equipment", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: current.farmId, data: { ...data }, operationId: input.operationId });
}

export type EquipmentStatus = { available: boolean; failedCheck: CurrentRecord<CheckData> | null; lastCheck: CurrentRecord<CheckData> | null; lastRelease: CurrentRecord<ReleaseData> | null };

/** Out of use when the latest critical failure has no release after it (decision 955). */
export function equipmentStatus(equipmentId: string, checks: Array<CurrentRecord<CheckData>>, releases: Array<CurrentRecord<ReleaseData>>): EquipmentStatus {
  const own = checks.filter((check) => check.data.equipmentId === equipmentId && check.change !== "withdrawn");
  const freed = releases.filter((release) => release.data.equipmentId === equipmentId && release.change !== "withdrawn");
  const lastCheck = own.at(-1) ?? null;
  const lastRelease = freed.at(-1) ?? null;
  const failedCheck = [...own].reverse().find((check) => check.data.criticalFault) ?? null;
  const released = failedCheck && freed.some((release) => release.data.checkId === failedCheck.recordId);
  return { available: !failedCheck || Boolean(released), failedCheck: failedCheck && !released ? failedCheck : null, lastCheck, lastRelease };
}

export type EquipmentView = CurrentRecord<EquipmentData> & EquipmentStatus & { checklist: CurrentRecord<ChecklistData> | null; canRelease: boolean };

function mayRelease(tx: OrgTx, equipment: EquipmentData): boolean {
  if (tx.actor.via) return false;
  if (tx.actor.role === "owner" || tx.actor.role === "admin") return true;
  return Boolean(tx.actor.userId && equipment.releaserUserIds.includes(tx.actor.userId));
}

/** A farm's equipment with whether each is in use, and the checklists that can be used there. */
export async function listEquipment(tx: OrgTx, farmIdInput: unknown): Promise<{ equipment: EquipmentView[]; checklists: Array<CurrentRecord<ChecklistData>> }> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const equipment = await currentRecords<EquipmentData>(tx, "equipment", { farmId });
  const checklists = await currentRecords<ChecklistData>(tx, "checklist", { farmId });
  const checks = await currentRecords<CheckData>(tx, "check", { farmId });
  const releases = await currentRecords<ReleaseData>(tx, "equipment_release", { farmId });
  return {
    equipment: equipment.map((item) => ({
      ...item,
      ...equipmentStatus(item.recordId, checks, releases),
      checklist: checklists.find((checklist) => checklist.recordId === item.data.checklistId) ?? null,
      canRelease: mayRelease(tx, item.data),
    })),
    checklists,
  };
}

/** One piece of equipment's checks, newest first. */
export async function equipmentChecks(tx: OrgTx, equipmentIdInput: unknown) {
  const equipment = await currentRecord<EquipmentData>(tx, "equipment", equipmentIdInput);
  const checks = await currentRecords<CheckData>(tx, "check", { farmId: equipment.farmId });
  return checks.filter((check) => check.data.equipmentId === equipment.recordId).reverse();
}

// Pre-start checks -------------------------------------------------------------------------------------

/**
 * Records a pre-start check on the checker's own login, against the
 * checklist version they were shown. A fault on a critical item puts the
 * equipment out of use and adds an action for whoever's responsible (or
 * the checker), due today.
 */
export async function recordCheck(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireSafetyRecorder(tx);
  const equipment = await currentRecord<EquipmentData>(tx, "equipment", input.equipmentId);
  if (equipment.change === "withdrawn" || equipment.data.retired) throw new ValidationError("That equipment isn't in use any more.");
  const checklistId = typeof input.checklistId === "string" ? input.checklistId : equipment.data.checklistId;
  if (!checklistId) throw new ValidationError("Choose a checklist for this equipment first.");
  const checklist = await currentRecord<ChecklistData>(tx, "checklist", checklistId);
  if (String(input.checklistVersion ?? "") !== String(checklist.version)) throw new ValidationError("The checklist has changed since it was opened. Open it again.");
  const given = new Map((Array.isArray(input.answers) ? input.answers : []).map((answer) => [String((answer as { key?: unknown })?.key ?? ""), answer as Record<string, unknown>]));
  const answers: CheckAnswer[] = checklist.data.items.map((item) => {
    const answer = given.get(item.key);
    const result = answer?.result;
    if (result !== "ok" && result !== "fault" && result !== "na") throw new ValidationError(`Answer "${item.text}".`);
    if (result === "na" && item.critical) throw new ValidationError(`"${item.text}" must be checked: it can't be not applicable.`);
    const note = optionalString(answer?.note, `Note on "${item.text}"`, { maxLength: 1000 });
    if (result === "fault" && !note) throw new ValidationError(`Say what's wrong with "${item.text}".`);
    return { key: item.key, text: item.text, critical: item.critical, result, note };
  });
  const criticalFault = answers.some((answer) => answer.critical && answer.result === "fault");
  const data: CheckData = {
    equipmentId: equipment.recordId,
    checklistId: checklist.recordId,
    checklistVersion: checklist.version,
    answers,
    hoursOrKm: optionalString(input.hoursOrKm, "Hours or km", { maxLength: 30 }),
    passed: answers.every((answer) => answer.result !== "fault"),
    criticalFault,
    files: await fileRefs(tx, input.files, equipment.farmId, false),
  };
  const check = await appendEntry<CheckData>(tx, { kind: "check", change: "created", farmId: equipment.farmId, data: { ...data }, operationId: input.operationId });
  let action = null;
  if (criticalFault && check.version === 1) {
    const already = await tx.query("select 1 from safety_entries where kind = 'action' and version = 1 and body::jsonb->>'checkId' = $1", [check.recordId]);
    if (!already.rowCount) {
      const faults = answers.filter((answer) => answer.critical && answer.result === "fault").map((answer) => answer.text);
      const assignee = equipment.data.responsibleUserId ?? tx.actor.userId;
      action = await addAction(tx, { farmId: equipment.farmId, title: `Fix ${equipment.data.name}: ${faults.join("; ")}`.slice(0, 200), assignedToUserId: assignee, assignedToName: assignee ? null : "Whoever looks after it", due: todayIsoDate() }, new Map([...members, ...(tx.actor.userId ? [[tx.actor.userId, "me"] as [string, string]] : [])]), { checkId: check.recordId });
    }
  }
  return { check, action, outOfUse: criticalFault };
}

/** Releases equipment after a failed check: what was done, by someone allowed, never an AI or app. */
export async function releaseEquipment(tx: OrgTx, input: Record<string, unknown>) {
  requireSafetyRecorder(tx);
  const equipment = await currentRecord<EquipmentData>(tx, "equipment", input.equipmentId);
  if (tx.actor.via) throw new ForbiddenError("Releasing equipment is for a person in Tohyee, not an AI or app.");
  if (!mayRelease(tx, equipment.data)) throw new ForbiddenError("Only an owner, an admin or someone named on this equipment can release it.");
  const checks = await currentRecords<CheckData>(tx, "check", { farmId: equipment.farmId });
  const releases = await currentRecords<ReleaseData>(tx, "equipment_release", { farmId: equipment.farmId });
  const status = equipmentStatus(equipment.recordId, checks, releases);
  if (!status.failedCheck) throw new ValidationError("It isn't out of use.");
  const data: ReleaseData = {
    equipmentId: equipment.recordId,
    checkId: status.failedCheck.recordId,
    whatWasDone: requireString(input.whatWasDone, "What was done to make it safe", { maxLength: 2000 }),
    files: await fileRefs(tx, input.files, equipment.farmId, false),
  };
  return appendEntry<ReleaseData>(tx, { kind: "equipment_release", change: "created", farmId: equipment.farmId, data: { ...data }, operationId: input.operationId });
}
