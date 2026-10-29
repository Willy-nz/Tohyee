import type { OrgTx } from "@/lib/db/org-transaction";
import { isoDateAt, parseIsoDate, todayIsoDate } from "@/lib/dates";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { requireFarming } from "@/lib/farming/paddocks";
import { addAction } from "@/lib/safety/reports";
import { fileRefs } from "@/lib/safety/files";
import { paddocksOnFarm, point } from "@/lib/safety/hazards";
import { appendEntry, currentRecord, currentRecords } from "@/lib/safety/records";
import { type ActionData, actionState, type CheckData, type CurrentRecord, type EquipmentData, type SafetyChange, type SafetyVersion } from "@/lib/safety/shared";
import { effluentLog, parseTime } from "@/lib/effluent/log";
import { effluentSetup, requireEffluentLogger, type SystemView } from "@/lib/effluent/setup";
import { activeConsent, type CouncilTold, COUNCIL_TOLD_HOW, INCIDENT_TYPES, type IncidentData, type IncidentType, type SystemData } from "@/lib/effluent/shared";
import { effluentDates, effluentReminders, type Reminder, SERVICE_KINDS, type ServiceData, type ServiceKind, serviceDue } from "@/lib/effluent/reminders";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Effluent maintenance, faults, servicing and incidents (#487, decisions
 * 1090-1097).
 *
 * - Checks are Safety's pre-start checks on the system's machine (decision
 *   1075). A fault noticed between checks is reported here as a Safety
 *   check with one critical fault, so "out of use" and its release are
 *   exactly Safety's (decision 1090): only an owner, an admin or someone
 *   named on the machine releases it, in person.
 * - Servicing, repairs and the Effluent WoF are records of work done, with
 *   who did it and the report (decision 1091); the next one is worked out.
 * - Incidents have actions (Safety's actions, so they're on the person's
 *   Today and in Safety too) and a prompt to tell the council when the
 *   consent says to. Tohyee never tells anyone itself (decision 1092).
 */

async function farmFor(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  requireEffluentLogger(tx);
  const farmId = requireId(input, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  return farmId;
}

async function systemOnFarm(tx: OrgTx, farmId: string, id: unknown): Promise<SafetyVersion<SystemData>> {
  const system = await currentRecord<SystemData>(tx, "effluent_system", id).catch(() => null);
  if (!system || system.change === "withdrawn" || system.farmId !== farmId) throw new ValidationError("Choose a system on this farm.");
  return system;
}

function notAutomatic(tx: OrgTx, what: string) {
  if (tx.actor.via) throw new ForbiddenError(`${what} is for a person in Tohyee, not an AI or app.`);
}

// Faults ---------------------------------------------------------------------------------------------

/**
 * A fault noticed on a system (decision 1090): kept as a Safety check on
 * its machine with the fault as a critical item when it shouldn't be used,
 * which puts it out of use until released in Safety, and an action for
 * whoever looks after it.
 */
export async function reportFault(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  const farmId = await farmFor(tx, input.farmId);
  const system = await systemOnFarm(tx, farmId, input.systemId);
  const machine = await currentRecord<EquipmentData>(tx, "equipment", system.data.equipmentId);
  if (!machine.data.checklistId) throw new ValidationError("This system's machine has no checklist in Safety. Choose one there first.");
  const checklist = await currentRecord(tx, "checklist", machine.data.checklistId);
  const what = requireString(input.what, "What's wrong", { maxLength: 1000 });
  const outOfUse = input.outOfUse !== false;
  const data: CheckData = {
    equipmentId: machine.recordId,
    checklistId: checklist.recordId,
    checklistVersion: checklist.version,
    answers: [{ key: "fault-reported", text: "Fault reported", critical: outOfUse, result: "fault", note: what }],
    hoursOrKm: null,
    passed: false,
    criticalFault: outOfUse,
    files: await fileRefs(tx, input.files, farmId, false),
    faultReport: true,
  };
  const check = await appendEntry<CheckData>(tx, { kind: "check", change: "created", farmId, data: { ...data }, operationId: input.operationId });
  let action = null;
  if (check.version === 1) {
    const already = await tx.query("select 1 from safety_entries where kind = 'action' and version = 1 and body::jsonb->>'checkId' = $1", [check.recordId]);
    if (!already.rowCount) {
      const assignee = machine.data.responsibleUserId ?? tx.actor.userId;
      const known = new Map([...members, ...(tx.actor.userId ? [[tx.actor.userId, "me"] as [string, string]] : [])]);
      action = await addAction(tx, { farmId, title: `Fix ${system.data.name}: ${what}`.slice(0, 200), assignedToUserId: assignee, assignedToName: assignee ? null : "Whoever looks after it", due: todayIsoDate() }, known, { checkId: check.recordId });
    }
  }
  return { check, action, outOfUse };
}

// Servicing and the Effluent WoF --------------------------------------------------------------------

export async function addService(tx: OrgTx, input: Record<string, unknown>) {
  const farmId = await farmFor(tx, input.farmId);
  const system = await systemOnFarm(tx, farmId, input.systemId);
  const kind = input.kind as ServiceKind;
  if (!SERVICE_KINDS.includes(kind)) throw new ValidationError("Say what it was: a service, an Effluent WoF or a repair.");
  const doneOn = parseIsoDate(input.doneOn ?? todayIsoDate(), "Done on");
  if (doneOn > todayIsoDate()) throw new ValidationError("Done on can't be after today.");
  const nextDue = input.nextDue ? parseIsoDate(input.nextDue, "Next due") : null;
  if (nextDue && nextDue <= doneOn) throw new ValidationError("The next one is due after this one.");
  const data: ServiceData = { systemId: system.recordId, kind, doneOn, by: optionalString(input.by, "Who did it", { maxLength: 150 }), notes: optionalString(input.notes, "What was done", { maxLength: 4000 }), nextDue, files: await fileRefs(tx, input.files, farmId, false) };
  if (kind !== "repair" && !data.by && !data.notes && !data.files.length) throw new ValidationError("Say who did it or what was done, or add the report.");
  return appendEntry<ServiceData>(tx, { kind: "effluent_service", change: "created", farmId, happenedOn: doneOn, data: { ...data }, operationId: input.operationId });
}

// Incidents ------------------------------------------------------------------------------------------

function councilToldOf(input: unknown): CouncilTold {
  const value = (input ?? {}) as Record<string, unknown>;
  const how = value.how as CouncilTold["how"];
  if (!Object.hasOwn(COUNCIL_TOLD_HOW, how)) throw new ValidationError("Say how the council was told.");
  const on = parseIsoDate(value.on, "When the council was told");
  if (on > todayIsoDate()) throw new ValidationError("That day hasn't come yet.");
  return { on, how, who: optionalString(value.who, "Who you spoke to", { maxLength: 150 }), reference: optionalString(value.reference, "Their reference", { maxLength: 100 }) };
}

/**
 * Records an incident (farm staff and above), optionally with its first
 * action. The reporter may name who's responsible for each action.
 */
export async function addIncident(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  const farmId = await farmFor(tx, input.farmId);
  if (input.operationId) {
    const existing = await tx.query<{ record_id: string }>("select record_id::text from safety_entries where operation_id = $1 and kind = 'effluent_incident'", [String(input.operationId)]);
    if (existing.rows[0]) return { incident: await currentRecord<IncidentData>(tx, "effluent_incident", existing.rows[0].record_id), actions: [] };
  }
  const type = input.type as IncidentType;
  if (!INCIDENT_TYPES.includes(type)) throw new ValidationError("Say what happened: a spill, ponding, runoff, a buffer or rate, a power or pump failure, or other.");
  const occurredAt = parseTime(input.occurredAt ?? new Date().toISOString(), "When it happened");
  let applicationId: string | null = null;
  if (input.applicationId) {
    const application = await currentRecord(tx, "effluent_application", input.applicationId).catch(() => null);
    if (!application || application.farmId !== farmId) throw new ValidationError("That run isn't on this farm.");
    applicationId = application.recordId;
  }
  const data: IncidentData = {
    type,
    title: requireString(input.title, "What happened, in a few words", { maxLength: 150 }),
    whatHappened: optionalString(input.whatHappened, "What happened", { maxLength: 4000 }),
    systemId: input.systemId ? (await systemOnFarm(tx, farmId, input.systemId)).recordId : null,
    applicationId,
    paddockIds: await paddocksOnFarm(tx, farmId, input.paddockIds),
    point: point(input.point ?? null),
    occurredAt,
    immediateAction: optionalString(input.immediateAction, "What was done straight away", { maxLength: 2000 }),
    reachedWater: input.reachedWater === true,
    files: await fileRefs(tx, input.files, farmId, false),
    councilTold: null,
    closed: null,
  };
  const incident = await appendEntry<IncidentData>(tx, { kind: "effluent_incident", change: "created", farmId, happenedOn: isoDateAt(new Date(occurredAt)), data: { ...data }, operationId: input.operationId });
  const actions = [];
  for (const raw of Array.isArray(input.actions) ? input.actions.slice(0, 10) : []) {
    const action = (raw ?? {}) as Record<string, unknown>;
    if (!action.title) continue;
    actions.push(await addAction(tx, { farmId, title: action.title, assignedToUserId: action.assignedToUserId || null, assignedToName: action.assignedToUserId ? null : action.assignedToName || null, due: action.due || null }, members, { effluentIncidentId: incident.recordId }));
  }
  return { incident, actions };
}

/** Another action on an incident: the person responsible and when it's due. */
export async function addIncidentAction(tx: OrgTx, incidentId: unknown, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  requireEffluentLogger(tx);
  const incident = await currentRecord<IncidentData>(tx, "effluent_incident", incidentId);
  if (incident.change === "withdrawn" || incident.data.closed) throw new ValidationError("That incident is closed or withdrawn.");
  return addAction(tx, { farmId: incident.farmId, title: input.title, assignedToUserId: input.assignedToUserId || null, assignedToName: input.assignedToUserId ? null : input.assignedToName || null, due: input.due || null, operationId: input.operationId }, members, { effluentIncidentId: incident.recordId });
}

const INCIDENT_STEPS = ["update", "council_told", "close", "reopen", "correct", "withdraw"] as const;

/**
 * A new version of an incident: "update" (details, photos), "council_told"
 * (recorded by a person after they told the council), "close" (bookkeeper
 * or above, in person, once its actions are checked and closed), "reopen",
 * "correct" or "withdraw" (with why).
 */
export async function changeIncident(tx: OrgTx, recordId: unknown, input: Record<string, unknown>) {
  await requireFarming(tx);
  requireEffluentLogger(tx);
  const current = await currentRecord<IncidentData>(tx, "effluent_incident", recordId);
  const step = (input.step ?? "update") as (typeof INCIDENT_STEPS)[number];
  if (!INCIDENT_STEPS.includes(step)) throw new ValidationError("That isn't a change Tohyee knows.");
  const farmId = current.farmId!;
  const data: IncidentData = { ...current.data, why: undefined };
  let change: SafetyChange = "updated";
  const manager = !tx.actor.userId || (tx.actor.role !== undefined && roleAtLeast(tx.actor.role, "bookkeeper"));
  if (step === "council_told") {
    notAutomatic(tx, "Saying the council was told");
    data.councilTold = councilToldOf(input.councilTold);
  } else if (step === "close" || step === "reopen") {
    notAutomatic(tx, step === "close" ? "Closing an incident" : "Reopening an incident");
    if (!manager) throw new ForbiddenError("Closing or reopening an incident needs the bookkeeper role or higher.");
    if (step === "close") {
      const actions = (await currentRecords<ActionData>(tx, "action", { farmId })).filter((action) => action.data.effluentIncidentId === current.recordId && action.change !== "withdrawn");
      if (actions.some((action) => !action.data.verified)) throw new ValidationError("Check and close its actions first (in Safety › Reports and actions, or on Today).");
      data.closed = { why: requireString(input.why, "Why it's closed", { maxLength: 1000 }) };
    } else {
      data.closed = null;
      data.why = requireString(input.why, "Why it's reopened", { maxLength: 1000 });
    }
  } else {
    if (step === "correct" || step === "withdraw") {
      if (!manager) {
        const first = await tx.query<{ user_id: string | null }>("select entered_by_user_id::text as user_id from safety_entries where record_id = $1 and version = 1", [current.recordId]);
        if (first.rows[0]?.user_id !== tx.actor.userId) throw new ForbiddenError("Only the person who reported it, or a bookkeeper or above, can correct or withdraw it.");
      }
      change = step === "withdraw" ? "withdrawn" : "corrected";
      data.why = requireString(input.why, "Why", { maxLength: 1000 });
    }
    if (step !== "withdraw") {
      if (input.title !== undefined) data.title = requireString(input.title, "What happened, in a few words", { maxLength: 150 });
      if (input.whatHappened !== undefined) data.whatHappened = optionalString(input.whatHappened, "What happened", { maxLength: 4000 });
      if (input.immediateAction !== undefined) data.immediateAction = optionalString(input.immediateAction, "What was done straight away", { maxLength: 2000 });
      if (input.reachedWater !== undefined) data.reachedWater = input.reachedWater === true;
      if (input.files !== undefined) data.files = await fileRefs(tx, input.files, farmId, false);
      if (input.paddockIds !== undefined) data.paddockIds = await paddocksOnFarm(tx, farmId, input.paddockIds);
      if (step === "correct" && input.type !== undefined) {
        if (!INCIDENT_TYPES.includes(input.type as IncidentType)) throw new ValidationError("Say what happened.");
        data.type = input.type as IncidentType;
      }
      if (step === "correct" && input.occurredAt !== undefined) data.occurredAt = parseTime(input.occurredAt, "When it happened");
    }
  }
  return appendEntry<IncidentData>(tx, { kind: "effluent_incident", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId, happenedOn: isoDateAt(new Date(data.occurredAt)), data: { ...data }, operationId: input.operationId });
}

// Reading --------------------------------------------------------------------------------------------

export type IncidentView = CurrentRecord<IncidentData> & { actions: Array<CurrentRecord<ActionData> & { state: string }>; state: "open" | "actions" | "closed" | "withdrawn"; tellCouncil: { who: string; phone: string | null; when: string } | null };
export type SystemCare = SystemView & { nextService: string | null; nextWof: string | null; lastService: string | null; lastWof: string | null; services: Array<CurrentRecord<ServiceData>>; faults: Array<CurrentRecord<CheckData>> };

export type EffluentCare = { systems: SystemCare[]; incidents: IncidentView[]; reminders: Reminder[]; canClose: boolean };

/** A farm's systems with their checks, faults and servicing, its incidents with their actions, and what's due. */
export async function effluentCare(tx: OrgTx, farmIdInput: unknown): Promise<EffluentCare> {
  const log = await effluentLog(tx, farmIdInput);
  const setup = log.setup;
  const farmId = String(farmIdInput);
  const today = todayIsoDate();
  const own = <T>(records: Array<CurrentRecord<T>>) => records.filter((record) => record.farmId === farmId);
  const services = own(await currentRecords<ServiceData>(tx, "effluent_service", { farmId }));
  const incidents = own(await currentRecords<IncidentData>(tx, "effluent_incident", { farmId, includeWithdrawn: true }));
  const actions = own(await currentRecords<ActionData>(tx, "action", { farmId }));
  const checks = own(await currentRecords<CheckData>(tx, "check", { farmId }));
  const consent = activeConsent(setup.consents);
  const usedToday = new Set(log.applications.filter((application) => application.running || isoDateAt(new Date(application.data.startedAt)) === today).map((application) => application.data.systemId));
  const systems: SystemCare[] = setup.systems.map((system) => {
    const due = serviceDue(system, services);
    // A fault reported between checks isn't a check (decision 1090): the last whole check counts for reminders.
    const lastCheck = checks.filter((check) => check.data.equipmentId === system.data.equipmentId && !check.data.faultReport && check.change !== "withdrawn").at(-1);
    return {
      ...system,
      lastCheckedAt: lastCheck?.enteredAt ?? null,
      nextService: due.service,
      nextWof: due.wof,
      lastService: due.lastService,
      lastWof: due.lastWof,
      services: services.filter((service) => service.data.systemId === system.recordId).reverse(),
      faults: checks.filter((check) => check.data.equipmentId === system.data.equipmentId && !check.data.passed).reverse().slice(0, 10),
    };
  });
  return {
    systems,
    incidents: incidents
      .map((incident) => {
        const own = actions.filter((action) => action.data.effluentIncidentId === incident.recordId).map((action) => ({ ...action, state: actionState(action, today) }));
        const state: IncidentView["state"] = incident.change === "withdrawn" ? "withdrawn" : incident.data.closed ? "closed" : own.some((action) => action.change !== "withdrawn" && !action.data.verified) ? "actions" : "open";
        const notice = consent?.data.notifyCouncil ?? null;
        return { ...incident, actions: own, state, tellCouncil: notice && !incident.data.councilTold && incident.change !== "withdrawn" && !incident.data.closed ? notice : null };
      })
      .sort((a, b) => b.data.occurredAt.localeCompare(a.data.occurredAt)),
    reminders: effluentReminders({ systems, ponds: log.ponds, lastMoved: log.lastMoved, services, consent, usedToday, today, now: new Date().toISOString(), dayOf: (iso) => isoDateAt(new Date(iso)) }),
    canClose: !tx.actor.via && (!tx.actor.userId || (tx.actor.role !== undefined && roleAtLeast(tx.actor.role, "bookkeeper"))),
  };
}

/** What Today shows from Effluent: the reminders and open incidents (decision 1095). Empty for a farm with no systems. */
export async function effluentToday(tx: OrgTx, farmIdInput: unknown) {
  const setup = await effluentSetup(tx, farmIdInput);
  if (!setup.systems.some((system) => system.change !== "withdrawn" && !system.data.retired) && !setup.ponds.length) return { hasEffluent: false, reminders: [], outOfUse: [], openIncidents: [] };
  const care = await effluentCare(tx, farmIdInput);
  return {
    hasEffluent: true,
    reminders: care.reminders,
    outOfUse: care.systems.filter((system) => !system.available && !system.data.retired && system.change !== "withdrawn").map((system) => ({ id: system.recordId, name: system.data.name, because: system.outOfUseBecause })),
    openIncidents: care.incidents.filter((incident) => incident.state === "open" || incident.state === "actions").map((incident) => ({ id: incident.recordId, title: incident.data.title, tellCouncil: Boolean(incident.tellCouncil) })),
  };
}

/** Effluent's dates for the farm calendar (decision 1097): servicing, Effluent WoF and the consent's expiry. Incident actions are Safety's actions, so they're already in Safety's dates. */
export async function effluentDue(tx: OrgTx, input: { from: string; to: string; farmId?: string | null }) {
  await requireFarming(tx);
  const farms = input.farmId ? [requireId(input.farmId, "Farm")] : (await tx.query<{ id: string }>("select id::text from farms where is_active order by farms.id")).rows.map((row) => row.id);
  const items: Array<{ date: string; title: string; kind: string; farmId: string }> = [];
  for (const farmId of farms) {
    if (!(await canSeeFarm(tx, farmId))) {
      if (input.farmId) throw new NotFoundError("Farm not found.");
      continue;
    }
    const setup = await effluentSetup(tx, farmId);
    const services = (await currentRecords<ServiceData>(tx, "effluent_service", { farmId })).filter((record) => record.farmId === farmId);
    for (const item of effluentDates({ systems: setup.systems, services, consent: activeConsent(setup.consents), from: input.from, to: input.to })) items.push({ ...item, farmId });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
