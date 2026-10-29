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
  // Farm dairy effluent (#487): kept in the same history (docs/FARM-EFFLUENT.md).
  "effluent_system",
  "effluent_pond",
  "effluent_block",
  "effluent_zone",
  "effluent_consent",
  "effluent_application",
  "effluent_pond_reading",
  "effluent_deferral",
  "effluent_service",
  "effluent_incident",
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
  effluent_system: "Effluent system",
  effluent_pond: "Effluent pond or sump",
  effluent_block: "Effluent block",
  effluent_zone: "No-apply zone",
  effluent_consent: "Effluent consent conditions",
  effluent_application: "Effluent applied",
  effluent_pond_reading: "Pond level",
  effluent_deferral: "Effluent not applied",
  effluent_service: "Effluent servicing",
  effluent_incident: "Effluent incident",
};

/** Effluent records (#487): kept in the safety history, but not part of the WorkSafe pack. */
export function isEffluentKind(kind: string): boolean {
  return kind.startsWith("effluent_");
}

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

/**
 * WorkSafe's current quick guide "What events need to be notified?" (March
 * 2024), linked beside the questions so their wording can be checked
 * against it (decision 964).
 */
export const WORKSAFE_NOTIFIABLE_GUIDE_URL = "https://registers.worksafe.govt.nz/dmsdocument/20210-what-events-need-to-be-notified/latest";

/**
 * When the site of a notifiable event may be disturbed before WorkSafe says
 * so: WorkSafe's quick guide (Health and Safety at Work Act 2015, s 55;
 * decision 964).
 */
export const SITE_EXCEPTIONS = [
  "to help someone who's hurt",
  "to remove someone who has died",
  "to make the site safe, or stop something else serious happening",
  "by the police, or as they direct",
  "with WorkSafe's (an inspector's) permission",
] as const;

/**
 * How long a record of a notifiable event must be kept: at least five years
 * from when WorkSafe was told (Health and Safety at Work Act 2015, s 57;
 * decision 963). Tohyee keeps everything anyway: nothing is deleted.
 */
export const NOTIFIABLE_KEEP_YEARS = 5;
export const NOTIFIABLE_KEEP_RULE =
  "Records of notifiable events must be kept for at least five years from when WorkSafe was told (Health and Safety at Work Act 2015, s 57). Tohyee doesn't delete safety records.";

/** The day five years after WorkSafe was told (29 February moves to 1 March, so it's never short). */
export function notifiableKeepUntil(toldOn: string): string {
  const [year, month, day] = toldOn.slice(0, 10).split("-").map(Number);
  const target = new Date(Date.UTC(year + NOTIFIABLE_KEEP_YEARS, month - 1, day));
  return target.toISOString().slice(0, 10);
}

/** The keeping period shown on a report that may be notifiable, and in the WorkSafe pack (decision 963). */
export function notifiableKeepText(notice: WorkSafeNotice | null, formatDay: (isoDate: string) => string = (isoDate) => isoDate): string {
  if (!notice) return "If this is a notifiable event, keep its record for at least five years from when WorkSafe is told (Health and Safety at Work Act 2015, s 57).";
  return `Keep this record until at least ${formatDay(notifiableKeepUntil(notice.on))}: five years from when WorkSafe was told (Health and Safety at Work Act 2015, s 57).`;
}

/** Restricted access for the overview: what the person may do. */
export type SafetyAccess = { canRecord: boolean; canReport: boolean; farmStaff: boolean; canSeeRestricted: boolean; isOwner: boolean };

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
  checkId: "Pre-start check",
  equipmentId: "Equipment",
  checklistId: "Checklist",
  checklistVersion: "Checklist version",
  answers: "Answers",
  hoursOrKm: "Hours or km",
  passed: "Passed",
  criticalFault: "Out of use (critical fault)",
  whatWasDone: "What was done",
  owner: "Whose",
  ownerName: "Owner",
  fixedAssetId: "Fixed asset",
  responsibleUserId: "Responsible (member)",
  releaserUserIds: "Can release (members)",
  retired: "No longer used",
  items: "Checks",
  what: "Training",
  provider: "Provider",
  expiresOn: "Expires",
  certificate: "Certificate",
  canDo: "Covers",
  confirmedByPerson: "Confirmed by them",
  person: "Person",
  unNumber: "UN number",
  maxQuantity: "Most on site",
  unit: "Unit",
  location: "Where it's kept",
  storage: "Storage",
  hazards: "Hazards",
  sdsDate: "Safety data sheet date",
  approvedHandler: "Needs an approved handler",
  hazardousWaste: "Hazardous waste",
  audiences: "For",
  sections: "Sections",
  needsResign: "Everyone signs again",
  inductionId: "Induction",
  inductionVersion: "Induction version",
  audience: "As",
  signedHow: "Signed",
  statement: "Statement",
  emergencyVersion: "Emergency details version",
  purpose: "What for",
  signedOut: "Signed out",
  leftAt: "Left at",
  injuredPerson: "Who",
  injury: "Injury or illness",
  treatment: "Treatment",
  assignedToUserId: "Assigned to (member)",
  assignedToName: "Assigned to",
  due: "Due",
  done: "Done",
  verified: "Checked and closed",
  // Effluent (#487).
  systemId: "Effluent system",
  pondId: "Pond or sump",
  blockId: "Effluent block",
  consentNumber: "Consent number",
  council: "Regional council",
  maxDepthMm: "Most depth (mm)",
  maxRateMmPerHour: "Most rate (mm/h)",
  returnPeriodDays: "Days between applications",
  startedAt: "Started",
  stoppedAt: "Stopped",
  depthEnteredMm: "Depth as entered (mm)",
  depthWorkedOut: "Depth worked out",
  ponding: "Ponding or runoff",
  weather: "Weather",
  soil: "Soil",
  levelMm: "Level (mm on the gauge)",
  capacityM3: "Holds (m³)",
  bufferM: "Buffer (m)",
  areaHa: "Area (ha)",
  incidentId: "Effluent incident",
  effluentIncidentId: "Effluent incident",
  councilTold: "Council told",
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
  if (key === "signedHow" && typeof value === "string") return SIGNED_HOW_LABELS[value as SignedHow] ?? value;
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
  if (key === "answers" && Array.isArray(value)) {
    return value.map((answer: { text?: string; result?: string; note?: string | null }) => `${answer.text}: ${answer.result === "ok" ? "OK" : answer.result === "na" ? "n/a" : `FAULT${answer.note ? ` (${answer.note})` : ""}`}`).join("; ") || null;
  }
  if (key === "items" && Array.isArray(value)) return value.map((item: { text?: string; critical?: boolean }) => `${item.text}${item.critical ? " (critical)" : ""}`).join("; ") || null;
  if (key === "sections" && Array.isArray(value)) return value.map((section: { heading?: string }) => section.heading).join("; ") || null;
  if (key === "hazards" && Array.isArray(value)) return `${value.length} shown`;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value
      .map((item) => (item && typeof item === "object" ? Object.values(item as Record<string, unknown>).filter((part) => part !== null && part !== "").join(", ") : String(item)))
      .join("; ");
  }
  if (typeof value === "object") {
    const named = value as { name?: unknown; company?: unknown };
    if (typeof named.name === "string") return typeof named.company === "string" && named.company ? `${named.name} (${named.company})` : named.name;
    return JSON.stringify(value);
  }
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
  /** For an action made by a failed pre-start check. */
  checkId?: string | null;
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

// Inductions, sign-offs and signing in on site ---------------------------------------------------------

export const AUDIENCES = ["worker", "contractor", "visitor"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const AUDIENCE_LABELS: Record<Audience, string> = { worker: "Workers", contractor: "Contractors", visitor: "Visitors" };

export type InductionSection = { heading: string; text: string };

export type InductionData = {
  title: string;
  audiences: Audience[];
  sections: InductionSection[];
  /** Set on a version that changes something people must read again (decision 949). */
  needsResign: boolean;
  why?: string | null;
};

/** Who signed: a member signing for themselves, a member recording for someone else, or someone through the farm's sign-in link. */
export type SignedHow = "self" | "recorded" | "link";
export const SIGNED_HOW_LABELS: Record<SignedHow, string> = {
  self: "signed on their own login",
  recorded: "recorded for them (not their own signature)",
  link: "self-declared, no login (the farm's sign-in link, name as typed)",
};
/** The short label for a sign-off or sign-in through the gate link (decision 965). */
export const SELF_DECLARED = "Self-declared, no login";
/** Shown with gate-link sign-offs: contractors who come often are better as Farm staff (decision 965). */
export const INVITE_CONTRACTORS = "Contractors who come regularly can be invited as Farm staff, so they sign on their own login.";

export type SafetyPerson = { userId: string | null; name: string; company: string | null; phone: string | null };

/** The words someone agrees to when they sign (decision 950). Not yet reviewed by Jess. */
export const SIGN_STATEMENT = "I have read this induction, the farm's hazards and its emergency details, and I'll ask if anything isn't clear.";
export const NOT_COMPETENCE = "Signing shows someone was told about the farm and its hazards. It doesn't show they can do a job safely: that's training and supervision.";

/**
 * The gate page's privacy notice (decision 966), covering what the Privacy
 * Commissioner's guidance says to tell people: that it's being collected,
 * why, who sees it, whether they can decline and what happens then, that
 * they can see and correct it, how long it's kept, and how to contact the
 * farm. The name and address are the organisation's, from its settings.
 */
export function sitePrivacyNotice(organisation: { name: string; postalAddress: string | null }): Array<{ label: string; text: string }> {
  const address = organisation.postalAddress?.replace(/\s*\n\s*/g, ", ").trim();
  return [
    { label: "What's collected", text: `${organisation.name} collects your name, company, phone, what you're here for, and when you sign in and out. It's kept in Tohyee, the farm's records system.` },
    { label: "Why", text: "For health and safety on the farm: to know who's on site in an emergency, and to show you were told about the farm's hazards." },
    { label: "Who sees it", text: `${organisation.name} and the people who keep its safety records. It may be given to WorkSafe, the police or emergency services if they need it.` },
    { label: "If you'd rather not", text: "Company, phone and what you're here for are optional. Your name is needed to sign in here; if you don't want to give it, don't sign in here: talk to the farm instead." },
    { label: "Seeing and correcting it", text: `You can ask ${organisation.name} to see your details and to correct them. A correction is added to the record; the earlier version stays in the history.` },
    { label: "How long it's kept", text: "Safety records are kept and not deleted, so they can be shown later (for example to WorkSafe)." },
    { label: "Contact", text: address ? `${organisation.name}, ${address}.` : `${organisation.name}: use the farm's contacts on this page.` },
  ];
}

export type SignoffData = {
  inductionId: string;
  inductionVersion: number;
  person: SafetyPerson;
  audience: Audience;
  signedHow: SignedHow;
  statement: string;
  /** The hazards shown when they signed: id and version (decision 949). */
  hazards: Array<{ id: string; version: number }>;
  emergencyVersion: number | null;
  why?: string | null;
};

export type VisitData = {
  person: SafetyPerson;
  audience: Audience;
  purpose: string | null;
  /** Set on the version that signs out; the time is that version's entry time. */
  signedOut: boolean;
  /** A missed sign-out corrected later: when they say they left (decision 951). */
  leftAt: string | null;
  signedHow: SignedHow;
  why?: string | null;
  /** Recorded on a phone with no connection (#472, decision 1014): the phone's time of the sign-in or sign-out, sent later. */
  phoneTime?: string | null;
};

// Equipment and pre-start checks ------------------------------------------------------------------------

export const EQUIPMENT_OWNERS = ["owned", "hired", "contractor"] as const;
export type EquipmentOwner = (typeof EQUIPMENT_OWNERS)[number];
export const EQUIPMENT_OWNER_LABELS: Record<EquipmentOwner, string> = { owned: "Ours", hired: "Hired", contractor: "A contractor's" };

export type EquipmentData = {
  name: string;
  /** e.g. tractor, quad bike, side-by-side, chainsaw. */
  type: string | null;
  owner: EquipmentOwner;
  ownerName: string | null;
  /** The fixed asset in the books, if it is one (not needed). */
  fixedAssetId: string | null;
  checklistId: string | null;
  /** Who's responsible for it: failed checks go to them. */
  responsibleUserId: string | null;
  /** Members who may release it after a failed check (owners and admins always may). */
  releaserUserIds: string[];
  notes: string | null;
  retired: boolean;
  why?: string | null;
};

export type ChecklistItem = { key: string; text: string; critical: boolean };
export type ChecklistData = { title: string; items: ChecklistItem[]; why?: string | null };

export type CheckAnswer = { key: string; text: string; critical: boolean; result: "ok" | "fault" | "na"; note: string | null };
export type CheckData = {
  equipmentId: string;
  checklistId: string;
  checklistVersion: number;
  /** The questions as asked, copied in: a changed checklist never rewrites an answer (decision 954). */
  answers: CheckAnswer[];
  hoursOrKm: string | null;
  passed: boolean;
  /** A failed critical item: the equipment is out of use until released. */
  criticalFault: boolean;
  files: SafetyFileRef[];
  why?: string | null;
};

export type ReleaseData = { equipmentId: string; checkId: string; whatWasDone: string; files: SafetyFileRef[]; why?: string | null };

export const LOCKOUT_NOTE = "Tohyee's \"out of use\" is a record, not a lock: tag it out on the machine too, and take the key.";

// Training and chemicals ------------------------------------------------------------------------------

export type TrainingData = {
  person: SafetyPerson;
  what: string;
  provider: string | null;
  expiresOn: string | null;
  certificate: string | null;
  /** Jobs it covers, or limits (WorkSafe: keep "which jobs each person can and can't do"). */
  canDo: string | null;
  files: SafetyFileRef[];
  /** The person confirmed it on their own login (decision 956). */
  confirmedByPerson: boolean;
  why?: string | null;
};

export type TrainingState = "current" | "expiring" | "expired" | "no_expiry" | "withdrawn";
export const TRAINING_STATE_LABELS: Record<TrainingState, string> = { current: "Current", expiring: "Expires soon", expired: "Expired", no_expiry: "No expiry", withdrawn: "Withdrawn" };
export const EXPIRING_DAYS = 60;

export function trainingState(record: Pick<SafetyVersion<TrainingData>, "change" | "data">, today: string): TrainingState {
  if (record.change === "withdrawn") return "withdrawn";
  if (!record.data.expiresOn) return "no_expiry";
  if (record.data.expiresOn < today) return "expired";
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + EXPIRING_DAYS);
  return record.data.expiresOn <= soon.toISOString().slice(0, 10) ? "expiring" : "current";
}

export type ChemicalData = {
  name: string;
  unNumber: string | null;
  /** The most likely to be on site at once (WorkSafe's inventory), a decimal string, and its unit. */
  maxQuantity: string | null;
  unit: string | null;
  location: string | null;
  storage: string | null;
  hazards: string | null;
  sds: SafetyFileRef | null;
  /** The date on the safety data sheet. */
  sdsDate: string | null;
  approvedHandler: boolean;
  hazardousWaste: string | null;
  removed: boolean;
  why?: string | null;
};

/**
 * A chemical's safety data sheet (decision 967, replacing 957's "replace
 * sheets more than five years old"): WorkSafe says a new sheet is needed
 * when the substance is supplied again after five years, or when its sheet
 * has changed. So a missing sheet is needed; one over five years old (or
 * undated) is a prompt to get the current one when it's next supplied, not
 * a sheet that has stopped counting.
 */
export type SdsState = "missing" | "check" | "ok";
export function sdsState(data: Pick<ChemicalData, "sdsDate" | "sds">, today: string): SdsState {
  if (!data.sds) return "missing";
  if (!data.sdsDate) return "check";
  const fiveYearsAgo = `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`;
  return data.sdsDate < fiveYearsAgo ? "check" : "ok";
}
export const SDS_RULE = "WorkSafe: a new safety data sheet is needed when the substance is supplied again after five years, or when its sheet has changed.";
export const SDS_CHECK = "Sheet over 5 years old or undated: ask for the current one when it's next supplied";
