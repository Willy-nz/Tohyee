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
