/*
 * Safety on a farm phone (#446, layout follow-up; decisions 976-989): a
 * small overview and focused screens, each with its own address so a link
 * (from Today, a paddock, a machine's QR code) opens the exact record on
 * the right farm and the browser's Back returns to where the person was.
 * Pure functions, shared by the screens and their tests.
 */

import { formatDate } from "@/lib/format";

export const SAFETY_SCREENS = ["emergency", "report", "equipment", "people", "hazards", "reports", "chemicals", "records", "needs"] as const;
export type SafetyScreen = (typeof SAFETY_SCREENS)[number];

export const SAFETY_SCREEN_TITLES: Record<SafetyScreen, string> = {
  emergency: "Emergency details",
  report: "Report something",
  equipment: "Equipment and pre-start checks",
  people: "People and inductions",
  hazards: "Hazards and map",
  reports: "Reports and actions",
  chemicals: "Chemicals and fuel",
  records: "Records and settings",
  needs: "Needs doing",
};

/** Where a Safety link goes: a screen, the farm, and one record on it. */
export type SafetyLink = {
  screen: SafetyScreen | null;
  farmId: string | null;
  /** The record to open: a hazard, report, action, machine, induction, training record or visit. */
  hazard: string | null;
  report: string | null;
  action: string | null;
  equipment: string | null;
  induction: string | null;
  training: string | null;
  visit: string | null;
};

const RECORD_KEYS = ["hazard", "report", "action", "equipment", "induction", "training", "visit"] as const;
type RecordKey = (typeof RECORD_KEYS)[number];

/** Farms have whole-number ids and safety records UUIDs; anything else in an address is ignored. */
const ID = /^(?:[1-9]\d{0,17}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function id(value: string | null | undefined): string | null {
  return value && ID.test(value) ? value : null;
}

export function emptyLink(): SafetyLink {
  return { screen: null, farmId: null, hazard: null, report: null, action: null, equipment: null, induction: null, training: null, visit: null };
}

/**
 * Reads a Safety address. `?equipment=` alone (a machine's QR code, decision
 * 955) opens that machine's check; an unknown screen opens the overview.
 */
export function readSafetyLink(params: { get(name: string): string | null }): SafetyLink {
  const link = emptyLink();
  const view = params.get("view");
  link.farmId = id(params.get("farm"));
  for (const key of RECORD_KEYS) link[key] = id(params.get(key));
  link.screen = (SAFETY_SCREENS as readonly string[]).includes(view ?? "") ? (view as SafetyScreen) : null;
  if (!link.screen && link.equipment) link.screen = "equipment";
  return link;
}

/** The address of a Safety screen (the farmer's workspace), optionally for one farm and one record. */
export function safetyHref(target: Partial<SafetyLink> = {}): string {
  const query = new URLSearchParams();
  if (target.farmId) query.set("farm", target.farmId);
  if (target.screen) query.set("view", target.screen);
  for (const key of RECORD_KEYS) {
    const value = target[key];
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return `/operations/farm/safety${text ? `?${text}` : ""}`;
}

/**
 * The record a link asks for, but only on the farm it was made for: after
 * switching farms, another farm's record isn't looked for (decision 984).
 */
export function linkedRecord(link: SafetyLink, key: RecordKey, farmId: string): string | null {
  if (link.farmId && link.farmId !== farmId) return null;
  return link[key];
}

/** The element a screen scrolls to for its linked record, e.g. `safety-hazard-12`. */
export function recordAnchor(key: RecordKey, recordId: string): string {
  return `safety-${key}-${recordId}`;
}

/** The first linked record on a link, as an element to scroll to. */
export function linkAnchor(link: SafetyLink, farmId: string): string | null {
  // An action inside a report scrolls to the action, not the report.
  for (const key of ["action", "hazard", "report", "equipment", "induction", "training", "visit"] as const) {
    const value = linkedRecord(link, key, farmId);
    if (value) return recordAnchor(key, value);
  }
  return null;
}

// Needs doing -----------------------------------------------------------------------------------------

type ActionRef = { id: string; title: string; due?: string | null; state?: string; reportId?: string | null; hazardId?: string | null };

/** What Today's safety data gives (src/lib/safety/today.ts), as the screens see it. */
export type SafetyTodayData = {
  myActions: ActionRef[];
  overdueActions: ActionRef[];
  actionsToCheck: ActionRef[];
  outOfUse: Array<{ id: string; name: string }>;
  toSign: Array<{ id: string; title: string; reason: string }>;
  training: Array<{ id: string; who: string; what: string; expiresOn: string | null; state: string }>;
  selfDeclaredOnSite: Array<{ id: string; name: string; company: string | null }>;
  reviewsDue: Array<{ id: string; title: string; reviewDue: string | null }>;
  importantHazards: Array<{ id: string; title: string; noGo: boolean }>;
  notCheckedToday: Array<{ id: string; name: string }>;
};

export type NeedsDoingTone = "red" | "amber" | "blue" | "neutral";

export type NeedsDoingItem = {
  key: string;
  /** A word for the badge, never colour alone (decision 986). */
  badge: string;
  tone: NeedsDoingTone;
  text: string;
  /** Extra detail, e.g. the due date. */
  note: string | null;
  href: string;
};

function actionHref(action: ActionRef, farmId: string): string {
  return safetyHref({ farmId, screen: "reports", report: action.reportId ?? null, action: action.id });
}

/**
 * The person's safety jobs on one farm, most urgent first (decision 979):
 * machines out of use, their own overdue actions, inductions to sign, their
 * other actions, then (for those who keep the registers) others' overdue
 * actions, actions to check, training, hazard reviews and self-declared
 * visitors. Each opens its exact record on that farm. Built from Today's
 * data, not a to-do list of its own.
 */
export function needsDoing(today: SafetyTodayData, farmId: string): NeedsDoingItem[] {
  const items: NeedsDoingItem[] = [];
  const mine = new Set(today.myActions.map((action) => action.id));
  for (const item of today.outOfUse) items.push({ key: `u${item.id}`, badge: "Out of use", tone: "red", text: `${item.name}: don't use it`, note: null, href: safetyHref({ farmId, screen: "equipment", equipment: item.id }) });
  for (const action of today.myActions.filter((each) => each.state === "overdue")) items.push({ key: `a${action.id}`, badge: "Overdue", tone: "red", text: action.title, note: action.due ? `was due ${formatDate(action.due)}` : null, href: actionHref(action, farmId) });
  for (const induction of today.toSign) items.push({ key: `s${induction.id}`, badge: "Sign", tone: "amber", text: induction.title, note: induction.reason, href: safetyHref({ farmId, screen: "people", induction: induction.id }) });
  for (const action of today.myActions.filter((each) => each.state !== "overdue")) items.push({ key: `a${action.id}`, badge: "Yours", tone: "blue", text: action.title, note: action.due ? `by ${formatDate(action.due)}` : null, href: actionHref(action, farmId) });
  for (const action of today.overdueActions.filter((each) => !mine.has(each.id))) items.push({ key: `o${action.id}`, badge: "Overdue", tone: "red", text: action.title, note: action.due ? `was due ${formatDate(action.due)}` : null, href: actionHref(action, farmId) });
  for (const action of today.actionsToCheck) items.push({ key: `c${action.id}`, badge: "To check", tone: "amber", text: action.title, note: "marked done", href: actionHref(action, farmId) });
  for (const record of [...today.training].sort((a, b) => Number(b.state === "expired") - Number(a.state === "expired"))) {
    items.push({ key: `t${record.id}`, badge: record.state === "expired" ? "Expired" : "Renew", tone: record.state === "expired" ? "red" : "amber", text: `${record.who}: ${record.what}`, note: record.expiresOn ? `expires ${formatDate(record.expiresOn)}` : null, href: safetyHref({ farmId, screen: "people", training: record.id }) });
  }
  for (const hazard of today.reviewsDue) items.push({ key: `r${hazard.id}`, badge: "Review", tone: "amber", text: hazard.title, note: hazard.reviewDue ? `review was due ${formatDate(hazard.reviewDue)}` : null, href: safetyHref({ farmId, screen: "hazards", hazard: hazard.id }) });
  for (const visit of today.selfDeclaredOnSite) items.push({ key: `v${visit.id}`, badge: "On site", tone: "neutral", text: `${visit.name}${visit.company ? ` (${visit.company})` : ""}`, note: "signed in through the sign-in link", href: safetyHref({ farmId, screen: "people", visit: visit.id }) });
  return items;
}

/** How many to show before "View all" (decision 979). */
export const NEEDS_DOING_SHOWN = 5;

// Report drafts kept while moving between screens -------------------------------------------------------

/**
 * Where a half-filled form is kept while the person moves around Safety
 * (decision 985): this tab only, per person, organisation and farm, so it
 * never moves to another farm.
 */
export function formMemoryKey(parts: { userId: string; organisationId: string; farmId: string; form: string }): string {
  return `tohyee.safety.form.${parts.userId}.${parts.organisationId}.${parts.farmId}.${parts.form}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A small store for half-filled forms. Every call says truthfully whether the browser kept it. */
export function createFormMemory(storage: () => StorageLike | null) {
  const safe = () => {
    try {
      return storage();
    } catch {
      return null;
    }
  };
  return {
    read<T>(key: string): T | null {
      try {
        const raw = safe()?.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },
    /** True only when the browser stored it and reads it back the same. */
    write(key: string, value: unknown): boolean {
      const store = safe();
      if (!store) return false;
      try {
        const text = JSON.stringify(value);
        store.setItem(key, text);
        return store.getItem(key) === text;
      } catch {
        return false;
      }
    },
    clear(key: string): void {
      try {
        safe()?.removeItem(key);
      } catch {
        // Nothing to do: it wasn't kept.
      }
    },
  };
}

// WorkSafe's questions -------------------------------------------------------------------------------

/** How many of WorkSafe's questions are still unanswered (an unanswered question is never a No, decision 982). */
export function unansweredQuestions(keys: readonly string[], answers: Partial<Record<string, boolean>>): number {
  return keys.filter((key) => answers[key] !== true && answers[key] !== false).length;
}

/** A queued item as the safety screens read it (the device's list of work, src/lib/offline/queue.ts). */
type QueuedLike = { kind: string; farmId: string | null; status: string; operationId: string; meta: Record<string, unknown> };

export type CheckOnDevice = { operationId: string; criticalFaults: string[]; status: string };

/**
 * One machine's pre-start checks recorded on this device and not yet with
 * Tohyee (decision 1047): those that failed a critical check (don't use it)
 * and those waiting to send. Without these, a check saved with no signal
 * left the machine looking unchecked.
 */
export function checksOnDevice(items: readonly QueuedLike[], farmId: string, equipmentId: string): { faults: CheckOnDevice[]; waiting: CheckOnDevice[] } {
  const mine = items
    .filter((item) => item.kind === "safety.check" && item.farmId === farmId && item.status !== "synced" && item.meta.equipmentId === equipmentId)
    .map((item) => ({ operationId: item.operationId, status: item.status, criticalFaults: Array.isArray(item.meta.criticalFaults) ? (item.meta.criticalFaults as unknown[]).map(String) : [] }));
  return { faults: mine.filter((check) => check.criticalFaults.length > 0), waiting: mine.filter((check) => check.criticalFaults.length === 0) };
}

/**
 * The farm's pre-start checks this device has sent (kept in its list for the
 * day): when the number goes up, the equipment screen reads the machines
 * again, so a check sent when the signal came back shows (decision 1047).
 */
export function sentChecks(items: readonly QueuedLike[], farmId: string): number {
  return items.filter((item) => item.kind === "safety.check" && item.farmId === farmId && item.status === "synced").length;
}
