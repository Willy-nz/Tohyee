/*
 * Effluent's reminders (#487, decisions 1095-1097), worked out from the
 * records each time and never stored: shift the pods or irrigator, read the
 * pond, the checks, servicing, the Effluent WoF and the consent's expiry.
 * They show on Today and Effluent's overview; the dated ones go on the farm
 * calendar. Pure and browser-safe.
 */

export const SERVICE_KINDS = ["service", "wof", "repair"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = { service: "Service", wof: "Effluent Warrant of Fitness", repair: "Repair" };

export type ServiceData = {
  systemId: string;
  kind: ServiceKind;
  doneOn: string;
  /** Who did it, as typed (a contractor, the WoF assessor). */
  by: string | null;
  notes: string | null;
  /** The next one, if the person or assessor set it. */
  nextDue: string | null;
  files: Array<{ id: string; name: string; sha256: string }>;
  why?: string | null;
};

export type ReminderKind = "shift" | "pond" | "check" | "service" | "wof" | "consent";
export type Reminder = {
  key: string;
  kind: ReminderKind;
  /** "due" is now or overdue; "soon" is coming up. */
  when: "due" | "soon";
  text: string;
  /** For the calendar: the date it's due (shifts and pond readings are today). */
  date: string;
  systemId?: string | null;
  pondId?: string | null;
};

export const SOON_DAYS = { service: 14, wof: 30, consent: 90 } as const;

/** Months after a date (the 31st becomes the month's last day). */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

type SystemLike = { recordId: string; firstEnteredAt?: string; data: { name: string; type: string; checkEvery: "day" | "week"; serviceEveryMonths: number | null; wofDue: string | null; retired: boolean }; change: string; lastCheckedAt: string | null; available: boolean };
type PondLike = { recordId: string; data: { name: string }; readToday: boolean };
type MovedLike = { systemId: string; systemName: string; shiftDue: string | null; running: boolean };
type ServiceLike = { change: string; data: ServiceData };
type ConsentLike = { data: { title: string; consentNumber: string | null; expiresOn: string | null } } | null;

/** When each system's next service and Effluent WoF are due: from the last one recorded, else from the setup. */
export function serviceDue(system: SystemLike, services: readonly ServiceLike[]): { service: string | null; wof: string | null; lastService: string | null; lastWof: string | null } {
  const own = services.filter((each) => each.change !== "withdrawn" && each.data.systemId === system.recordId).sort((a, b) => a.data.doneOn.localeCompare(b.data.doneOn));
  const lastService = own.filter((each) => each.data.kind === "service").at(-1) ?? null;
  const lastWof = own.filter((each) => each.data.kind === "wof").at(-1) ?? null;
  const service = lastService ? (lastService.data.nextDue ?? (system.data.serviceEveryMonths ? addMonths(lastService.data.doneOn, system.data.serviceEveryMonths) : null)) : null;
  const wof = lastWof ? (lastWof.data.nextDue ?? null) : system.data.wofDue;
  return { service, wof, lastService: lastService?.data.doneOn ?? null, lastWof: lastWof?.data.doneOn ?? null };
}

/**
 * What's due for a farm's effluent today and soon (decision 1095), most
 * urgent first. `today` is the farm's date, `now` the time (for shifts).
 * `usedToday` names systems running or run today, for daily checks.
 */
export function effluentReminders(input: { systems: readonly SystemLike[]; ponds: readonly PondLike[]; lastMoved: readonly MovedLike[]; services: readonly ServiceLike[]; consent: ConsentLike; usedToday: ReadonlySet<string>; today: string; now: string; dayOf: (iso: string) => string }): Reminder[] {
  const { today, now } = input;
  const reminders: Reminder[] = [];
  for (const moved of input.lastMoved) {
    if (moved.running && moved.shiftDue && moved.shiftDue <= now) reminders.push({ key: `shift-${moved.systemId}`, kind: "shift", when: "due", text: `Shift ${moved.systemName}`, date: today, systemId: moved.systemId });
  }
  for (const pond of input.ponds) if (!pond.readToday) reminders.push({ key: `pond-${pond.recordId}`, kind: "pond", when: "due", text: `Read ${pond.data.name}`, date: today, pondId: pond.recordId });
  for (const system of input.systems) {
    if (system.change === "withdrawn" || system.data.retired) continue;
    const last = system.lastCheckedAt ? input.dayOf(system.lastCheckedAt) : null;
    if (system.data.checkEvery === "week") {
      if (!last || last <= addDaysIso(today, -7)) reminders.push({ key: `check-${system.recordId}`, kind: "check", when: "due", text: `Weekly check: ${system.data.name}`, date: today, systemId: system.recordId });
    } else if (input.usedToday.has(system.recordId) && last !== today) {
      reminders.push({ key: `check-${system.recordId}`, kind: "check", when: "due", text: `Pre-start check: ${system.data.name}`, date: today, systemId: system.recordId });
    }
    const due = serviceDue(system, input.services);
    if (due.service) {
      if (due.service <= today) reminders.push({ key: `service-${system.recordId}`, kind: "service", when: "due", text: `Service ${system.data.name} (was due ${due.service})`, date: due.service, systemId: system.recordId });
      else if (due.service <= addDaysIso(today, SOON_DAYS.service)) reminders.push({ key: `service-${system.recordId}`, kind: "service", when: "soon", text: `Service ${system.data.name}`, date: due.service, systemId: system.recordId });
    }
    if (due.wof) {
      if (due.wof <= today) reminders.push({ key: `wof-${system.recordId}`, kind: "wof", when: "due", text: `Effluent WoF for ${system.data.name} (was due ${due.wof})`, date: due.wof, systemId: system.recordId });
      else if (due.wof <= addDaysIso(today, SOON_DAYS.wof)) reminders.push({ key: `wof-${system.recordId}`, kind: "wof", when: "soon", text: `Effluent WoF for ${system.data.name}`, date: due.wof, systemId: system.recordId });
    }
  }
  const expires = input.consent?.data.expiresOn;
  if (expires && expires <= addDaysIso(today, SOON_DAYS.consent)) {
    const name = input.consent!.data.consentNumber ?? input.consent!.data.title;
    reminders.push({ key: "consent", kind: "consent", when: expires <= today ? "due" : "soon", text: expires < today ? `Consent ${name} expired ${expires}` : `Consent ${name} expires ${expires}`, date: expires });
  }
  const order: ReminderKind[] = ["shift", "check", "pond", "service", "wof", "consent"];
  return reminders.sort((a, b) => Number(a.when === "soon") - Number(b.when === "soon") || order.indexOf(a.kind) - order.indexOf(b.kind) || a.date.localeCompare(b.date));
}

/**
 * The dated items for the farm calendar in a range (decision 1097):
 * servicing, Effluent WoF and the consent's expiry, wherever they fall
 * (not just soon).
 */
export function effluentDates(input: { systems: readonly SystemLike[]; services: readonly ServiceLike[]; consent: ConsentLike; from: string; to: string }): Array<{ date: string; title: string; kind: "service" | "wof" | "consent" }> {
  const items: Array<{ date: string; title: string; kind: "service" | "wof" | "consent" }> = [];
  const within = (date: string | null): date is string => date !== null && date >= input.from && date <= input.to;
  for (const system of input.systems) {
    if (system.change === "withdrawn" || system.data.retired) continue;
    const due = serviceDue(system, input.services);
    if (within(due.service)) items.push({ date: due.service, title: `Service ${system.data.name}`, kind: "service" });
    if (within(due.wof)) items.push({ date: due.wof, title: `Effluent WoF: ${system.data.name}`, kind: "wof" });
  }
  const expires = input.consent?.data.expiresOn ?? null;
  if (within(expires)) items.push({ date: expires, title: `Effluent consent ${input.consent!.data.consentNumber ?? input.consent!.data.title} expires`, kind: "consent" });
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
