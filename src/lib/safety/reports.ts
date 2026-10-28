import type { OrgTx } from "@/lib/db/org-transaction";
import { parseIsoDate, parseOptionalIsoDate, todayIsoDate } from "@/lib/dates";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm } from "@/lib/farming/access";
import { describeFiles, fileRefs, type SafetyFile } from "@/lib/safety/files";
import { appendEntry, canSeeRestricted, currentRecord, currentRecords, requireSafetyRecorder, requireSafetyReporter } from "@/lib/safety/records";
import {
  type ActionData,
  actionState,
  type CurrentRecord,
  mayBeNotifiable,
  NOTIFIABLE_QUESTIONS,
  type NotifiableAnswers,
  REPORT_TYPES,
  type ReportData,
  type ReportDetailsData,
  reportState,
  type ReportState,
  type ReportType,
  type SafetyChange,
  SEVERITIES,
  type Severity,
} from "@/lib/safety/shared";
import { optionalString, requireId, requireString } from "@/lib/validation";

/*
 * Hazards spotted, near misses and incidents, their restricted details,
 * and corrective actions through to a checked close (#446, decisions
 * 942-947; William's review: "photo -> location -> what happened ->
 * immediate action -> responsible person"). All safety records: versions,
 * dated by the database, nothing deleted.
 *
 * - Injury and medical details are a separate, restricted record
 *   (decision 936), so the report itself can be shown to the farm team.
 * - Answers to WorkSafe's notifiable-event questions show a prompt to tell
 *   WorkSafe; Tohyee never does it itself (decision 943).
 * - Marking an action done, checking it, and closing a report are a
 *   person's: refused through an AI key or farm app (decision 946).
 */

function point(input: unknown) {
  if (input == null) return null;
  if (!Array.isArray(input) || input.length !== 2 || !input.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 180) || Math.abs(input[1] as number) > 90) {
    throw new ValidationError("The place on the map isn't a longitude and latitude.");
  }
  return [input[0], input[1]] as [number, number];
}

async function paddocksOnFarm(tx: OrgTx, farmId: string, input: unknown): Promise<string[]> {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 200) throw new ValidationError("Choose up to 200 paddocks.");
  const ids = [...new Set(input.map((value) => requireId(value, "Paddock")))];
  if (!ids.length) return [];
  const found = await tx.query("select 1 from paddocks where farm_id = $1 and id = any($2::bigint[])", [farmId, ids]);
  if (found.rowCount !== ids.length) throw new ValidationError("One of those paddocks isn't on this farm.");
  return ids.sort((a, b) => Number(a) - Number(b));
}

function notifiable(input: unknown): NotifiableAnswers {
  const answers: NotifiableAnswers = {};
  if (input == null) return answers;
  if (typeof input !== "object") throw new ValidationError("Answer the WorkSafe questions with yes or no.");
  for (const question of NOTIFIABLE_QUESTIONS) {
    const value = (input as Record<string, unknown>)[question.key];
    if (value === true || value === false) answers[question.key] = value;
  }
  return answers;
}

function notAutomatic(tx: OrgTx, what: string) {
  if (tx.actor.via) throw new ForbiddenError(`${what} is for a person in Tohyee, not an AI or app: someone has to check it themselves.`);
}

export type ReportInput = Record<string, unknown>;

async function reportData(tx: OrgTx, farmId: string, input: ReportInput, previous: ReportData | null): Promise<ReportData> {
  const type = (input.type ?? previous?.type) as ReportType;
  if (!REPORT_TYPES.includes(type)) throw new ValidationError("Choose hazard spotted, near miss or incident.");
  const severity = (input.severity ?? previous?.severity ?? "minor") as Severity;
  if (!SEVERITIES.includes(severity)) throw new ValidationError("Choose how bad: minor, moderate or serious.");
  const time = optionalString(input.time, "Time", { maxLength: 5 });
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ValidationError("Enter the time like 14:30.");
  const data: ReportData = {
    type,
    title: requireString(input.title, "What it was, in a few words", { maxLength: 150 }),
    whatHappened: optionalString(input.whatHappened, "What happened", { maxLength: 4000 }),
    where: optionalString(input.where, "Where", { maxLength: 300 }),
    paddockIds: await paddocksOnFarm(tx, farmId, input.paddockIds),
    point: point(input.point),
    time,
    immediateAction: optionalString(input.immediateAction, "What was done straight away", { maxLength: 2000 }),
    severity,
    injured: input.injured === true,
    notifiable: notifiable(input.notifiable),
    workSafeNotified: previous?.workSafeNotified ?? null,
    closed: previous?.closed ?? null,
    files: await fileRefs(tx, input.files, farmId, false),
  };
  return data;
}

function fieldsFrom(previous: ReportData, input: ReportInput): ReportInput {
  const merged: ReportInput = { ...previous };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value;
  return merged;
}

export type ReportView = CurrentRecord<ReportData> & {
  state: ReportState;
  mayBeNotifiable: boolean;
  actions: Array<CurrentRecord<ActionData>>;
  /** The restricted details, when the person may see them. */
  details: CurrentRecord<ReportDetailsData> | null;
  /** Restricted details exist but this person may not see them. */
  detailsHidden: boolean;
  files: SafetyFile[];
};

/** A farm's reports, newest first, each with its actions and (if allowed) restricted details. */
export async function listReports(tx: OrgTx, farmIdInput: unknown, options: { includeWithdrawn?: boolean } = {}): Promise<ReportView[]> {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const reports = await currentRecords<ReportData>(tx, "report", { farmId, includeWithdrawn: options.includeWithdrawn });
  const actions = await currentRecords<ActionData>(tx, "action", { farmId, includeWithdrawn: true });
  const details = await currentRecords<ReportDetailsData>(tx, "report_details", { farmId });
  const hidden = await tx.query<{ report_id: string }>(
    "select distinct body::jsonb->>'reportId' as report_id from safety_entries where kind = 'report_details' and farm_id = $1",
    [farmId],
  );
  const hiddenIds = new Set(hidden.rows.map((row) => row.report_id));
  const views: ReportView[] = [];
  for (const report of reports.reverse()) {
    const own = actions.filter((action) => action.data.reportId === report.recordId);
    const detail = details.find((entry) => entry.data.reportId === report.recordId && entry.change !== "withdrawn") ?? null;
    views.push({
      ...report,
      state: reportState(report, own),
      mayBeNotifiable: mayBeNotifiable(report.data.notifiable),
      actions: own,
      details: detail,
      detailsHidden: !detail && hiddenIds.has(report.recordId),
      files: await describeFiles(tx, [...report.data.files, ...(detail?.data.files ?? [])]),
    });
  }
  return views;
}

/**
 * Records a report. With `details` (who was hurt, the injury, treatment),
 * those are saved as a separate restricted record at the same time.
 */
export async function addReport(tx: OrgTx, input: ReportInput & { farmId?: unknown; happenedOn?: unknown; details?: unknown; action?: unknown; operationId?: unknown }, members: ReadonlyMap<string, string> = new Map()) {
  // Farm staff report on their farms too (decision 960).
  requireSafetyReporter(tx);
  const farmId = requireId(input.farmId, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const happenedOn = parseIsoDate(input.happenedOn ?? todayIsoDate(), "When it happened");
  if (happenedOn > todayIsoDate()) throw new ValidationError("When it happened can't be after today.");
  const data = await reportData(tx, farmId, input, null);
  const report = await appendEntry<ReportData>(tx, { kind: "report", change: "created", farmId, happenedOn, data: { ...data }, operationId: input.operationId });
  let details = null;
  if (input.details && typeof input.details === "object" && report.version === 1) {
    const already = await tx.query("select 1 from safety_entries where kind = 'report_details' and body::jsonb->>'reportId' = $1", [report.recordId]);
    if (!already.rowCount) details = await saveDetails(tx, report.recordId, farmId, happenedOn, input.details as Record<string, unknown>, null);
  }
  // The responsible person and what they'll do, from the same report (William's flow), once.
  let action = null;
  if (input.action && typeof input.action === "object" && (input.action as { title?: unknown }).title) {
    const already = await tx.query("select 1 from safety_entries where kind = 'action' and version = 1 and body::jsonb->>'reportId' = $1", [report.recordId]);
    if (!already.rowCount) action = await addAction(tx, { ...(input.action as Record<string, unknown>), reportId: report.recordId }, members);
  }
  return { report, details, action, mayBeNotifiable: mayBeNotifiable(data.notifiable) };
}

async function saveDetails(tx: OrgTx, reportId: string, farmId: string, happenedOn: string | null, input: Record<string, unknown>, current: CurrentRecord<ReportDetailsData> | null, change: SafetyChange = "created", expectedVersion?: unknown) {
  const data: ReportDetailsData = {
    reportId,
    injuredPerson: optionalString(input.injuredPerson, "Who was hurt", { maxLength: 150 }),
    injury: optionalString(input.injury, "Injury or illness", { maxLength: 2000 }),
    treatment: optionalString(input.treatment, "Treatment", { maxLength: 2000 }),
    notes: optionalString(input.notes, "Notes", { maxLength: 4000 }),
    files: await fileRefs(tx, input.files, farmId, true),
  };
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (why) data.why = why;
  if (!data.injuredPerson && !data.injury && !data.treatment && !data.notes && !data.files.length && !current) return null;
  return appendEntry<ReportDetailsData>(tx, { kind: "report_details", recordId: current?.recordId, expectedVersion, change: current ? change : "created", farmId, happenedOn, data: { ...data } });
}

/** Adds or changes a report's restricted details (only someone who may see them, or their author). */
export async function saveReportDetails(tx: OrgTx, reportIdInput: unknown, input: Record<string, unknown> & { expectedVersion?: unknown; change?: unknown }) {
  requireSafetyRecorder(tx);
  const report = await currentRecord<ReportData>(tx, "report", reportIdInput);
  const existing = await tx.query<{ record_id: string }>("select record_id::text from safety_entries where kind = 'report_details' and version = 1 and body::jsonb->>'reportId' = $1", [report.recordId]);
  let current: CurrentRecord<ReportDetailsData> | null = null;
  if (existing.rows[0]) {
    const found = await currentRecord<ReportDetailsData>(tx, "report_details", existing.rows[0].record_id);
    current = { ...found, firstEnteredAt: found.enteredAt, firstEnteredByEmail: found.enteredByEmail };
  }
  const change = input.change === "corrected" ? "corrected" : "updated";
  return saveDetails(tx, report.recordId, report.farmId!, report.happenedOn, input, current, change, input.expectedVersion);
}

const REPORT_STEPS = ["update", "correct", "withdraw", "worksafe", "close"] as const;

/**
 * A new version of a report: `step` is "update" (more details), "correct"
 * (with what was wrong), "withdraw" (entered by mistake, with why),
 * "worksafe" (a person records that they told WorkSafe: date, phone or
 * online, reference) or "close" (with why; only once every action is
 * checked and closed, and never by an AI or app).
 */
export async function changeReport(tx: OrgTx, recordId: unknown, input: ReportInput & { step?: unknown; expectedVersion?: unknown; operationId?: unknown }) {
  requireSafetyRecorder(tx);
  const current = await currentRecord<ReportData>(tx, "report", recordId);
  const step = input.step as (typeof REPORT_STEPS)[number];
  if (!REPORT_STEPS.includes(step)) throw new ValidationError("Choose what to do with the report.");
  const farmId = current.farmId!;
  let data: ReportData;
  let change: SafetyChange = "updated";
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (step === "worksafe") {
    const how = input.how === "online" ? "online" : input.how === "phone" ? "phone" : null;
    if (!how) throw new ValidationError("Say whether WorkSafe was told by phone or online.");
    const on = parseIsoDate(input.on, "When WorkSafe was told");
    if (on > todayIsoDate()) throw new ValidationError("That date is after today.");
    data = { ...current.data, workSafeNotified: { on, how, reference: optionalString(input.reference, "WorkSafe's reference", { maxLength: 100 }) } };
  } else if (step === "close") {
    notAutomatic(tx, "Closing a report");
    if (!why) throw new ValidationError("Say why it's closed, e.g. what was put right.");
    const actions = await currentRecords<ActionData>(tx, "action", { farmId });
    const open = actions.filter((action) => action.data.reportId === current.recordId && !action.data.verified);
    if (open.length) throw new ValidationError(`${open.length} action${open.length === 1 ? " is" : "s are"} still to be checked and closed first.`);
    data = { ...current.data, closed: { why } };
  } else {
    data = await reportData(tx, farmId, fieldsFrom(current.data, input), current.data);
    if (step === "correct") change = "corrected";
    if (step === "withdraw") change = "withdrawn";
  }
  delete data.why;
  if (why && step !== "close") data.why = why;
  const happenedOn = step === "correct" && input.happenedOn ? parseIsoDate(input.happenedOn, "When it happened") : current.happenedOn;
  return appendEntry<ReportData>(tx, { kind: "report", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId, happenedOn, data: { ...data }, operationId: input.operationId });
}

// Corrective actions -------------------------------------------------------------------------------

async function assignee(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>): Promise<{ assignedToUserId: string | null; assignedToName: string | null }> {
  const userId = typeof input.assignedToUserId === "string" && input.assignedToUserId ? input.assignedToUserId.toLowerCase() : null;
  if (userId && !members.has(userId)) throw new ValidationError("That person isn't a member of this organisation.");
  const name = optionalString(input.assignedToName, "Who it's for", { maxLength: 150 });
  if (!userId && !name) throw new ValidationError("Say who's responsible.");
  return { assignedToUserId: userId, assignedToName: userId ? null : name };
}

/**
 * Adds a corrective action, for a report or a hazard on the same farm.
 * `members` is the organisation's members (id -> name), from the core
 * database, for choosing who's responsible.
 */
export async function addAction(tx: OrgTx, input: Record<string, unknown>, members: ReadonlyMap<string, string>, options: { checkId?: string; effluentIncidentId?: string } = {}) {
  // A failed pre-start check makes its own action, whoever did the check (decision 955); so does an
  // effluent incident's reporter, for its actions (#487, decision 1094).
  if (!options.checkId && !options.effluentIncidentId) requireSafetyRecorder(tx);
  let farmId: string;
  let reportId: string | null = null;
  let hazardId: string | null = null;
  if (input.reportId) {
    const report = await currentRecord<ReportData>(tx, "report", input.reportId);
    if (report.change === "withdrawn" || report.data.closed) throw new ValidationError("That report is closed or withdrawn.");
    farmId = report.farmId!;
    reportId = report.recordId;
  } else if (input.hazardId) {
    const hazard = await currentRecord(tx, "hazard", input.hazardId);
    farmId = hazard.farmId!;
    hazardId = hazard.recordId;
  } else {
    farmId = requireId(input.farmId, "Farm");
  }
  const data: ActionData = {
    reportId,
    hazardId,
    title: requireString(input.title, "What needs doing", { maxLength: 200 }),
    ...(await assignee(tx, input, members)),
    due: parseOptionalIsoDate(input.due || null, "Due by"),
    done: null,
    verified: null,
  };
  // A failed pre-start check's action names the check (decision 955).
  if (options.checkId) data.checkId = options.checkId;
  if (options.effluentIncidentId) data.effluentIncidentId = options.effluentIncidentId;
  return appendEntry<ActionData>(tx, { kind: "action", change: "created", farmId, data: { ...data }, operationId: input.operationId });
}

const ACTION_STEPS = ["update", "done", "verify", "reopen", "withdraw"] as const;

/**
 * A new version of an action: "update" (who, when, what), "done" (by a
 * person, with what was done and any photos), "verify" (someone checks it
 * and closes it, bookkeeper or above, never an AI or app; the history shows
 * who did each, decision 946), "reopen" (the check
 * found it not right, with why) or "withdraw" (entered by mistake).
 */
export async function changeAction(tx: OrgTx, recordId: unknown, input: Record<string, unknown>, members: ReadonlyMap<string, string>) {
  const current = await currentRecord<ActionData>(tx, "action", recordId);
  const step = input.step as (typeof ACTION_STEPS)[number];
  // Farm staff may mark their own actions done; everything else is for bookkeepers and above (decision 960).
  if (step === "done" && current.data.assignedToUserId && current.data.assignedToUserId === tx.actor.userId) requireSafetyReporter(tx);
  else requireSafetyRecorder(tx);
  if (!ACTION_STEPS.includes(step)) throw new ValidationError("Choose what to do with the action.");
  if (current.data.verified && step !== "reopen") throw new ValidationError("This action is checked and closed. Reopen it to change it.");
  let data: ActionData = { ...current.data };
  delete data.why;
  let change: SafetyChange = "updated";
  const why = optionalString(input.why, "Why", { maxLength: 1000 });
  if (step === "update") {
    data = { ...data, title: input.title === undefined ? data.title : requireString(input.title, "What needs doing", { maxLength: 200 }), due: input.due === undefined ? data.due : parseOptionalIsoDate(input.due || null, "Due by") };
    if (input.assignedToUserId !== undefined || input.assignedToName !== undefined) Object.assign(data, await assignee(tx, input, members));
  } else if (step === "done") {
    notAutomatic(tx, "Marking an action done");
    if (data.done) throw new ValidationError("It's already marked done.");
    data.done = { note: requireString(input.note, "What was done", { maxLength: 2000 }), files: await fileRefs(tx, input.files, current.farmId, false) };
  } else if (step === "verify") {
    notAutomatic(tx, "Checking an action");
    if (!data.done) throw new ValidationError("Mark it done before it's checked.");
    data.verified = { note: optionalString(input.note, "What was checked", { maxLength: 2000 }) };
  } else if (step === "reopen") {
    notAutomatic(tx, "Reopening an action");
    if (!why) throw new ValidationError("Say why it's reopened.");
    data.done = null;
    data.verified = null;
  } else {
    change = "withdrawn";
    if (!why) throw new ValidationError("Say why it's withdrawn.");
  }
  if (why) data.why = why;
  return appendEntry<ActionData>(tx, { kind: "action", recordId: current.recordId, expectedVersion: input.expectedVersion, change, farmId: current.farmId, data: { ...data }, operationId: input.operationId });
}

/** Open actions for the person (assigned to them) or, for everyone, on their farms: for Today and the calendar. */
export async function openActions(tx: OrgTx, options: { mine?: boolean } = {}) {
  const today = todayIsoDate();
  const actions = await currentRecords<ActionData>(tx, "action");
  return actions
    .filter((action) => {
      const state = actionState(action, today);
      return (state === "open" || state === "overdue" || state === "done") && (!options.mine || action.data.assignedToUserId === tx.actor.userId);
    })
    .map((action) => ({ ...action, state: actionState(action, today) }));
}

/**
 * A farm's actions that aren't on a report (on a hazard, from a failed
 * pre-start check, or on their own) and aren't yet checked and closed, so
 * they can be seen and marked done (decision 979). Newest first.
 */
export async function farmActionsWithoutReport(tx: OrgTx, farmIdInput: unknown) {
  const farmId = requireId(farmIdInput, "Farm");
  if (!(await canSeeFarm(tx, farmId))) throw new NotFoundError("Farm not found.");
  const today = todayIsoDate();
  return (await currentRecords<ActionData>(tx, "action", { farmId }))
    .filter((action) => action.farmId === farmId && !action.data.reportId && action.change !== "withdrawn" && !action.data.verified)
    .map((action) => ({ ...action, state: actionState(action, today) }))
    .reverse();
}

/** Whether this person may see restricted details (for the screens). */
export { canSeeRestricted };
