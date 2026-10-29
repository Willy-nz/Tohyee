import { isoDateAt, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { listEquipment } from "@/lib/safety/equipment";
import { listInductions, listSignoffs, onSite } from "@/lib/safety/inductions";
import { canRecordSafety, currentRecords } from "@/lib/safety/records";
import { listTraining } from "@/lib/safety/register";
import { openActions } from "@/lib/safety/reports";
import { type HazardData, hazardState, reviewOverdue } from "@/lib/safety/shared";
import { requireId } from "@/lib/validation";

/*
 * What Today and the farm calendar show from Safety (#446 with #447,
 * decision 962): the person's own open actions, overdue ones (for those who
 * keep the registers), high and no-go hazards, hazards due for review,
 * machines out of use or not checked today, training to renew, and
 * inductions to sign again. Worked out from the records each time; nothing
 * here is stored.
 */

export type SafetyDueItem = { date: string; title: string; kind: "action" | "training" | "hazard_review"; farmId: string | null };

export async function safetyToday(tx: OrgTx, farmIdInput: unknown) {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const today = todayIsoDate();
  const manager = canRecordSafety(tx);
  const actions = (await openActions(tx)).filter((action) => action.farmId === farmId);
  const mine = actions.filter((action) => action.data.assignedToUserId === tx.actor.userId && action.state !== "done");
  const overdue = manager ? actions.filter((action) => action.state === "overdue") : [];
  const toCheck = manager ? actions.filter((action) => action.state === "done") : [];
  const hazards = (await currentRecords<HazardData>(tx, "hazard", { farmId })).filter((hazard) => hazard.farmId === farmId && hazardState(hazard) === "active");
  const { equipment } = await listEquipment(tx, farmId);
  const inUse = equipment.filter((item) => item.change !== "withdrawn" && !item.data.retired);
  // Effluent systems checked each week (#487, decision 1076) aren't "not checked today"; Effluent reminds about them.
  const weekly = new Set(
    (await currentRecords<{ equipmentId: string; checkEvery?: string }>(tx, "effluent_system", { farmId })).filter((system) => system.data.checkEvery === "week").map((system) => system.data.equipmentId),
  );
  const training = (await listTraining(tx, { mine: !manager })).filter((record) => record.state === "expired" || record.state === "expiring");
  const inductions = (await listInductions(tx, farmId)).filter((induction) => induction.change !== "withdrawn" && induction.data.audiences.includes("worker"));
  const signoffs = (await listSignoffs(tx, farmId)).filter((signoff) => signoff.data.person.userId === tx.actor.userId);
  const toSign = tx.actor.userId
    ? inductions
        .map((induction) => {
          const mineSigned = signoffs.find((signoff) => signoff.data.inductionId === induction.recordId);
          return !mineSigned ? { id: induction.recordId, title: induction.data.title, reason: "Not signed yet." } : !mineSigned.current ? { id: induction.recordId, title: induction.data.title, reason: mineSigned.reasons[0] } : null;
        })
        .filter((entry): entry is { id: string; title: string; reason: string } => entry !== null)
    : [];
  // Contractors on site who signed in through the gate link: self-declared, no login (decision 965).
  const selfDeclared = manager ? (await onSite(tx, farmId)).here.filter((visit) => visit.data.signedHow === "link" && visit.data.audience === "contractor") : [];
  return {
    selfDeclaredOnSite: selfDeclared.map((visit) => ({ id: visit.recordId, name: visit.data.person.name, company: visit.data.person.company })),
    // Each action carries its report or hazard, so Today and Safety can open it (decision 979).
    myActions: mine.map((action) => ({ id: action.recordId, title: action.data.title, due: action.data.due, state: action.state, reportId: action.data.reportId, hazardId: action.data.hazardId })),
    overdueActions: overdue.map((action) => ({ id: action.recordId, title: action.data.title, due: action.data.due, reportId: action.data.reportId, hazardId: action.data.hazardId })),
    actionsToCheck: toCheck.map((action) => ({ id: action.recordId, title: action.data.title, reportId: action.data.reportId, hazardId: action.data.hazardId })),
    importantHazards: hazards.filter((hazard) => hazard.data.noGo || hazard.data.level === "high").map((hazard) => ({ id: hazard.recordId, title: hazard.data.title, noGo: hazard.data.noGo })),
    reviewsDue: manager ? hazards.filter((hazard) => reviewOverdue(hazard.data, today)).map((hazard) => ({ id: hazard.recordId, title: hazard.data.title, reviewDue: hazard.data.reviewDue })) : [],
    outOfUse: inUse.filter((item) => !item.available).map((item) => ({ id: item.recordId, name: item.data.name })),
    notCheckedToday: inUse.filter((item) => item.available && item.checklist && !weekly.has(item.recordId) && (!item.lastCheck || isoDateAt(new Date(item.lastCheck.enteredAt)) < today)).map((item) => ({ id: item.recordId, name: item.data.name })),
    training: training.map((record) => ({ id: record.recordId, who: record.data.person.name, what: record.data.what, expiresOn: record.data.expiresOn, state: record.state })),
    toSign,
  };
}

/** Safety dates in a range for the farm calendar: actions due, training expiring and hazard reviews (decision 962). */
export async function safetyDue(tx: OrgTx, input: { from: string; to: string; farmId?: string | null }): Promise<SafetyDueItem[]> {
  const farmId = input.farmId ? requireId(input.farmId, "Farm") : null;
  if (farmId && !(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const manager = canRecordSafety(tx);
  const inRange = (date: string | null): date is string => date !== null && date >= input.from && date <= input.to;
  const items: SafetyDueItem[] = [];
  for (const action of await openActions(tx)) {
    if ((!farmId || action.farmId === farmId) && action.state !== "done" && (manager || action.data.assignedToUserId === tx.actor.userId) && inRange(action.data.due)) items.push({ date: action.data.due, title: action.data.title, kind: "action", farmId: action.farmId });
  }
  for (const record of await listTraining(tx, { mine: !manager })) {
    if (record.state !== "withdrawn" && inRange(record.data.expiresOn)) items.push({ date: record.data.expiresOn, title: `${record.data.person.name}: ${record.data.what} expires`, kind: "training", farmId: null });
  }
  if (manager) {
    const hazards = await currentRecords<HazardData>(tx, "hazard", farmId ? { farmId } : {});
    for (const hazard of hazards) if (hazardState(hazard) === "active" && inRange(hazard.data.reviewDue)) items.push({ date: hazard.data.reviewDue, title: `Review hazard: ${hazard.data.title}`, kind: "hazard_review", farmId: hazard.farmId });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

