/*
 * Farm safety: types, labels and fixed wording shared by the server and the
 * screens (#446). Browser-safe: no server imports.
 *
 * Tohyee keeps safety records. It doesn't decide what the law needs, and
 * nothing here says a farm complies with it (decision 937). Wording drawn
 * from WorkSafe's guidance names its source and date; the points marked
 * "not yet reviewed by Jess" are listed in docs/FARM-SAFETY.md.
 */

export const SAFETY_KINDS = [
  "hazard",
  "emergency_info",
  "report",
  "report_details",
  "action",
  "induction",
  "induction_signoff",
  "visit",
  "equipment",
  "checklist",
  "check",
  "equipment_release",
  "training",
  "chemical",
] as const;
export type SafetyKind = (typeof SAFETY_KINDS)[number];

export const KIND_LABELS: Record<SafetyKind, string> = {
  hazard: "Hazard",
  emergency_info: "Emergency details",
  report: "Report",
  report_details: "Restricted details",
  action: "Action",
  induction: "Induction",
  induction_signoff: "Induction sign-off",
  visit: "Sign in on site",
  equipment: "Equipment",
  checklist: "Checklist",
  check: "Pre-start check",
  equipment_release: "Equipment released",
  training: "Training",
  chemical: "Chemical",
};

export const SAFETY_CHANGES = ["created", "updated", "corrected", "withdrawn"] as const;
export type SafetyChange = (typeof SAFETY_CHANGES)[number];
export const CHANGE_LABELS: Record<SafetyChange, string> = {
  created: "Added",
  updated: "Changed",
  corrected: "Corrected",
  withdrawn: "Withdrawn (entered by mistake)",
};

/** A photo or document a record names; the hash is in the record's own version (decision 945). */
export type SafetyFileRef = { id: string; name: string; sha256: string };

/** One version of a safety record, as the screens get it. */
export type SafetyVersion<T> = {
  seq: string;
  kind: SafetyKind;
  recordId: string;
  version: number;
  change: SafetyChange;
  changeLabel: string;
  farmId: string | null;
  /** When it happened, as the person said. */
  happenedOn: string | null;
  /** When it was entered: set by the database, never by the person (decision 932). */
  enteredAt: string;
  enteredByEmail: string;
  enteredByName?: string;
  via: string | null;
  hash: string;
  data: T;
};

export type CurrentRecord<T> = SafetyVersion<T> & { firstEnteredAt: string; firstEnteredByEmail: string; firstEnteredByName?: string };

/** Entered more than a day after the date it happened: both dates show (decision 932). */
export function enteredLate(happenedOn: string | null, enteredAt: string, timeZone = "Pacific/Auckland"): boolean {
  if (!happenedOn) return false;
  const entered = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(enteredAt));
  return entered > happenedOn;
}

// Hazards --------------------------------------------------------------------------------------

export const HAZARD_LEVELS = ["low", "medium", "high"] as const;
export type HazardLevel = (typeof HAZARD_LEVELS)[number];
export const HAZARD_LEVEL_LABELS: Record<HazardLevel, string> = { low: "Low", medium: "Medium", high: "High" };

export type Position = [number, number];
export type ZoneGeometry = { type: "Polygon"; coordinates: Position[][] };

export type HazardData = {
  title: string;
  description: string | null;
  level: HazardLevel;
  /** What's done about it (WorkSafe: eliminate, isolate or minimise). */
  controls: string | null;
  /** A place people mustn't go (shown in red on the map). */
  noGo: boolean;
  paddockIds: string[];
  /** Longitude, latitude. */
  point: Position | null;
  zone: ZoneGeometry | null;
  /** When it should next be looked at. */
  reviewDue: string | null;
  /** Gone from the farm (e.g. the hole filled in). */
  removed: boolean;
  /** Set on the version that says someone looked at it and it still stands. */
  reviewed?: boolean;
  /** Why it was corrected, withdrawn, removed or reviewed. */
  why?: string | null;
};

export type HazardState = "active" | "removed" | "withdrawn";

export function hazardState(record: Pick<SafetyVersion<HazardData>, "change" | "data">): HazardState {
  if (record.change === "withdrawn") return "withdrawn";
  return record.data.removed ? "removed" : "active";
}

export function reviewOverdue(data: Pick<HazardData, "reviewDue" | "removed">, today: string): boolean {
  return !data.removed && data.reviewDue !== null && data.reviewDue < today;
}

// Emergency details ------------------------------------------------------------------------------

export type EmergencyContact = { name: string; role: string | null; phone: string };
export type EmergencyEquipment = { what: string; where: string };

export type EmergencyData = {
  /** Where the farm is, for the 111 call. */
  address: string | null;
  /** Which gate or road end emergency services use. */
  entrance: string | null;
  assemblyPoint: string | null;
  contacts: EmergencyContact[];
  firstAiders: string[];
  equipment: EmergencyEquipment[];
  /** What to do where there's no phone coverage (WorkSafe's contractors guidance asks for a backup plan). */
  noCoveragePlan: string | null;
  medicalCentre: string | null;
  notes: string | null;
  why?: string | null;
};

export const EMPTY_EMERGENCY: EmergencyData = {
  address: null,
  entrance: null,
  assemblyPoint: null,
  contacts: [],
  firstAiders: [],
  equipment: [],
  noCoveragePlan: null,
  medicalCentre: null,
  notes: null,
};

/**
 * Numbers shown on every farm's emergency details, from WorkSafe's "Notify
 * WorkSafe" page (read 27 October 2026): 111 in an emergency; WorkSafe on
 * 0800 030 040, any time, for a death or anything needing attention now.
 */
export const FIXED_NUMBERS = [
  { name: "Emergency (ambulance, fire, police)", phone: "111" },
  { name: "WorkSafe (24 hours)", phone: "0800 030 040" },
] as const;

export const WORKSAFE_NOTIFY_URL = "https://worksafe.govt.nz/notify-worksafe/";

/** Restricted access for the overview: what the person may do. */
export type SafetyAccess = { canRecord: boolean; canSeeRestricted: boolean; isOwner: boolean };

// Describing any record (history, the WorkSafe pack) -------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  title: "What",
  name: "Name",
  description: "Details",
  level: "How serious",
  controls: "What's done about it",
  noGo: "No-go zone",
  paddockIds: "Paddocks",
  point: "Place on the map",
  zone: "Zone on the map",
  reviewDue: "Review by",
  removed: "Removed from the farm",
  reviewed: "Reviewed: still stands",
  why: "Why",
  address: "Address",
  entrance: "Entrance for emergency services",
  assemblyPoint: "Assembly point",
  contacts: "Contacts",
  firstAiders: "First aiders",
  equipment: "Emergency equipment",
  noCoveragePlan: "Where there's no phone coverage",
  medicalCentre: "Nearest medical centre",
  notes: "Notes",
  type: "Type",
  whatHappened: "What happened",
  where: "Where",
  time: "Time",
  immediateAction: "What was done straight away",
  severity: "How bad",
  injured: "Someone hurt or made ill",
  notifiable: "May need notifying",
  workSafeNotified: "WorkSafe told",
  closed: "Closed",
  reportId: "Report",
  hazardId: "Hazard",
  injuredPerson: "Who",
  injury: "Injury or illness",
  treatment: "Treatment",
  assignedToUserId: "Assigned to (member)",
  assignedToName: "Assigned to",
  due: "Due",
  done: "Done",
  verified: "Checked and closed",
};

/** A short name for a record, for lists and the pack. */
export function recordTitle(kind: SafetyKind, data: Record<string, unknown>): string {
  for (const key of ["title", "name", "what"]) {
    if (typeof data[key] === "string" && data[key]) return data[key] as string;
  }
  return KIND_LABELS[kind];
}

function valueText(key: string, value: unknown, paddockNames: ReadonlyMap<string, string>): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : null;
  if (key === "paddockIds" && Array.isArray(value)) return value.length ? value.map((id) => paddockNames.get(String(id)) ?? `Paddock ${id}`).join(", ") : null;
  if (key === "point" && Array.isArray(value)) return `${Number(value[1]).toFixed(6)}, ${Number(value[0]).toFixed(6)} (latitude, longitude)`;
  if (key === "zone") return "Drawn on the map";
  if (key === "level" && typeof value === "string") return HAZARD_LEVEL_LABELS[value as HazardLevel] ?? value;
  if (key === "type" && typeof value === "string") return REPORT_TYPE_LABELS[value as ReportType] ?? value;
  if (key === "severity" && typeof value === "string") return SEVERITY_LABELS[value as Severity] ?? value;
  if (key === "notifiable" && value && typeof value === "object") {
    const yes = NOTIFIABLE_QUESTIONS.filter((question) => (value as Record<string, unknown>)[question.key] === true).map((question) => question.key);
    return yes.length ? `Yes: ${yes.join(", ")}` : null;
  }
  if (key === "workSafeNotified" && value && typeof value === "object") {
    const notice = value as WorkSafeNotice;
    return `${notice.on}, by ${notice.how}${notice.reference ? `, reference ${notice.reference}` : ""}`;
  }
  if ((key === "closed" || key === "verified") && value && typeof value === "object") return (value as { why?: string; note?: string | null }).why ?? (value as { note?: string | null }).note ?? "Yes";
  if (key === "done" && value && typeof value === "object") return (value as { note: string }).note;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value
      .map((item) => (item && typeof item === "object" ? Object.values(item as Record<string, unknown>).filter((part) => part !== null && part !== "").join(", ") : String(item)))
      .join("; ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Each filled-in field of a record, labelled, in a fixed order. */
export function recordFields(data: Record<string, unknown>, paddockNames: ReadonlyMap<string, string> = new Map()): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  const order = Object.keys(FIELD_LABELS);
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  for (const [key, value] of Object.entries(data).sort(([a], [b]) => rank(a) - rank(b))) {
    if (key === "files") continue;
    const text = valueText(key, value, paddockNames);
    if (text !== null) fields.push([FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (first) => first.toUpperCase()), text]);
  }
  return fields;
}

// Reports: hazards spotted, near misses and incidents ----------------------------------------------

export const REPORT_TYPES = ["hazard", "near_miss", "incident"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_TYPE_LABELS: Record<ReportType, string> = { hazard: "Hazard spotted", near_miss: "Near miss", incident: "Incident" };

export const SEVERITIES = ["minor", "moderate", "serious"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_LABELS: Record<Severity, string> = { minor: "Minor", moderate: "Moderate", serious: "Serious" };

/**
 * The questions that prompt "this may need to be notified", in WorkSafe's
 * words from its quick guide "What events need to be notified?" (March
 * 2024). A yes shows the prompt; Tohyee never notifies anyone itself
 * (decision 943). Not yet reviewed by Jess.
 */
export const NOTIFIABLE_QUESTIONS = [
  { key: "death", text: "Did someone die?" },
  { key: "hospital", text: "Was someone admitted to hospital for immediate treatment (as an inpatient, not just seen and sent home)?" },
  {
    key: "seriousInjury",
    text: "Was there a serious injury or illness: an amputation, serious head injury, serious eye injury, serious burn, skin torn away, spinal injury, loss of a bodily function, a serious cut, a serious infection, or medical treatment needed within 48 hours of being exposed to a substance?",
  },
  {
    key: "dangerousIncident",
    text: "Even if nobody was hurt, was someone put in serious, immediate danger by something unplanned or out of control: a spill or leak, fire or explosion, an electric shock, something falling from height, or a collapse?",
  },
] as const;
export type NotifiableKey = (typeof NOTIFIABLE_QUESTIONS)[number]["key"];
export type NotifiableAnswers = Partial<Record<NotifiableKey, boolean>>;

export function mayBeNotifiable(answers: NotifiableAnswers | null | undefined): boolean {
  return Boolean(answers && Object.values(answers).some(Boolean));
}

export type WorkSafeNotice = { on: string; how: "phone" | "online"; reference: string | null };

export type ReportData = {
  type: ReportType;
  title: string;
  whatHappened: string | null;
  where: string | null;
  paddockIds: string[];
  point: Position | null;
  /** HH:MM, as the person says. */
  time: string | null;
  immediateAction: string | null;
  severity: Severity;
  /** Someone hurt or made ill: their details go in restricted details. */
  injured: boolean;
  notifiable: NotifiableAnswers;
  /** Recorded by a person after they told WorkSafe (Tohyee doesn't). */
  workSafeNotified: WorkSafeNotice | null;
  /** Closed by a person, with why; only once every action is verified. */
  closed: { why: string } | null;
  files: SafetyFileRef[];
  why?: string | null;
};

export type ReportDetailsData = {
  reportId: string;
  injuredPerson: string | null;
  injury: string | null;
  treatment: string | null;
  notes: string | null;
  files: SafetyFileRef[];
  why?: string | null;
};

export type ActionData = {
  /** What it's for: a report or a hazard (by record id), or neither. */
  reportId: string | null;
  hazardId: string | null;
  title: string;
  assignedToUserId: string | null;
  /** A name, for someone without a login. */
  assignedToName: string | null;
  due: string | null;
  done: { note: string; files: SafetyFileRef[] } | null;
  verified: { note: string | null } | null;
  why?: string | null;
};

export type ActionState = "open" | "overdue" | "done" | "verified" | "withdrawn";

export function actionState(record: Pick<SafetyVersion<ActionData>, "change" | "data">, today: string): ActionState {
  if (record.change === "withdrawn") return "withdrawn";
  if (record.data.verified) return "verified";
  if (record.data.done) return "done";
  return record.data.due && record.data.due < today ? "overdue" : "open";
}

export const ACTION_STATE_LABELS: Record<ActionState, string> = { open: "Open", overdue: "Overdue", done: "Done, to check", verified: "Checked and closed", withdrawn: "Withdrawn" };

export type ReportState = "open" | "actions" | "closed" | "withdrawn";
export const REPORT_STATE_LABELS: Record<ReportState, string> = { open: "Open", actions: "Actions open", closed: "Closed", withdrawn: "Withdrawn" };

export function reportState(record: Pick<SafetyVersion<ReportData>, "change" | "data">, actions: ReadonlyArray<Pick<SafetyVersion<ActionData>, "change" | "data">>): ReportState {
  if (record.change === "withdrawn") return "withdrawn";
  if (record.data.closed) return "closed";
  return actions.some((action) => action.change !== "withdrawn" && !action.data.verified) ? "actions" : "open";
}
