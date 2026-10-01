import type { Role } from "@/lib/auth/roles";
import type { Task, TimelineEntry } from "@/lib/crm/service";
import {
  canEditLayoutField,
  customIdOf,
  isReadOnlyOnLayout,
  isRequiredOnLayout,
  type LayoutRecord,
  layoutFieldLabel,
  type PageLayout,
  standardField,
  type StandardField,
} from "@/lib/crm/record-types/layout";
import type { CustomField } from "@/lib/custom-fields/values";

/**
 * The CRM record page's arithmetic (CRT7, CRT11), browser-safe: the Details
 * tab's sections from a record type's page layout, and the Activity panel's
 * "Upcoming & overdue" and past activity by month, after Salesforce's
 * Lightning record page (its activity timeline groups past activity by
 * month, newest first, under "Upcoming & Overdue").
 */

export type DetailField = {
  key: string;
  label: string;
  required: boolean;
  readOnly: boolean;
  /** Whether this person can change it inline here (CRT6, CRT7). */
  editable: boolean;
  standard: StandardField | null;
  custom: CustomField | null;
};

export type DetailSection = { name: string; fields: DetailField[] };

/**
 * The layout's sections with the fields this record shows: standard fields,
 * and custom fields that apply to it (`visible`: a prospect only gets fields
 * turned on for prospects, CRMF8). Empty sections are left out.
 */
export function detailSections(record: LayoutRecord, layout: PageLayout, visible: readonly CustomField[], role: Role): DetailSection[] {
  const sections: DetailSection[] = [];
  for (const section of layout.sections) {
    const fields: DetailField[] = [];
    for (const field of section.fields) {
      const id = customIdOf(field.key);
      const custom = id === null ? null : (visible.find((entry) => entry.id === id) ?? null);
      if (id !== null && !custom) continue;
      const standard = id === null ? (standardField(record, field.key) ?? null) : null;
      if (id === null && !standard) continue;
      fields.push({
        key: field.key,
        label: layoutFieldLabel(record, field.key, visible),
        required: isRequiredOnLayout(record, field),
        readOnly: isReadOnlyOnLayout(record, field),
        editable: canEditLayoutField(record, field, role),
        standard,
        custom,
      });
    }
    if (fields.length > 0) sections.push({ name: section.name, fields });
  }
  return sections;
}

export type UpcomingItem = {
  key: string;
  kind: "task" | "activity" | "meeting";
  /** A task's due date (YYYY-MM-DD) or when an activity or meeting is planned (ISO). */
  when: string | null;
  title: string;
  detail: string | null;
  overdue: boolean;
  task: Task | null;
};

/**
 * Open tasks and planned activities and meetings: overdue tasks first
 * (oldest first), then what's coming up soonest first, then tasks with no
 * due date.
 */
export function upcomingAndOverdue(tasks: readonly Task[], timeline: readonly TimelineEntry[], today: string, nowIso: string): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  for (const task of tasks) {
    if (task.status === "done") continue;
    items.push({
      key: `task-${task.id}`,
      kind: "task",
      when: task.dueDate,
      title: task.title,
      detail: [task.personName, task.opportunityName].filter(Boolean).join(" · ") || null,
      overdue: task.dueDate !== null && task.dueDate < today,
      task,
    });
  }
  timeline.forEach((entry, index) => {
    if ((entry.kind === "activity" || entry.kind === "meeting") && entry.at > nowIso) {
      items.push({ key: `${entry.kind}-${entry.at}-${index}`, kind: entry.kind, when: entry.at, title: entry.title, detail: entry.detail, overdue: false, task: null });
    }
  });
  const rank = (item: UpcomingItem) => (item.overdue ? 0 : item.when === null ? 2 : 1);
  // A due date sorts as the start of that day, before anything planned later that day.
  const sortKey = (item: UpcomingItem) => (item.when === null ? "" : item.when.length === 10 ? `${item.when}T00:00:00` : item.when);
  return items.sort((a, b) => rank(a) - rank(b) || (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0) || a.key.localeCompare(b.key));
}

export type PastMonth = { month: string; label: string; entries: TimelineEntry[] };

const MONTH_PARTS = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit" });
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The New Zealand month of a moment, like "2026-09". */
export function nzMonth(iso: string): string {
  const parts = MONTH_PARTS.formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === "year")!.value;
  const month = parts.find((part) => part.type === "month")!.value;
  return `${year}-${month}`;
}

export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/**
 * Past activity grouped by New Zealand month, newest first: the timeline
 * up to now, with tasks only once they're done (open ones are under
 * "Upcoming & overdue").
 */
export function pastByMonth(tasks: readonly Task[], timeline: readonly TimelineEntry[], nowIso: string): PastMonth[] {
  const entries: TimelineEntry[] = timeline.filter((entry) => entry.kind !== "task" && entry.at <= nowIso);
  for (const task of tasks) {
    if (task.status !== "done" || !task.completedAt) continue;
    entries.push({
      kind: "task",
      at: new Date(task.completedAt).toISOString(),
      title: `Task done: ${task.title}`,
      detail: [task.personName, task.opportunityName].filter(Boolean).join(" · ") || null,
      amount: null,
      href: null,
      by: task.createdByEmail,
    });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const months: PastMonth[] = [];
  for (const entry of entries) {
    const month = nzMonth(entry.at);
    const last = months.at(-1);
    if (last && last.month === month) last.entries.push(entry);
    else months.push({ month, label: monthLabel(month), entries: [entry] });
  }
  return months;
}
