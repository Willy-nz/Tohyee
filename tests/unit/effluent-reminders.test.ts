import { describe, expect, it } from "vitest";
import { addMonths, effluentDates, effluentReminders, serviceDue } from "@/lib/effluent/reminders";

const system = (over: Record<string, unknown> = {}) => ({ recordId: "s1", change: "created", lastCheckedAt: null as string | null, available: true, data: { name: "Irrigator", type: "travelling_irrigator", checkEvery: "day" as "day" | "week", serviceEveryMonths: 6 as number | null, wofDue: null as string | null, retired: false }, ...over });
const service = (kind: "service" | "wof", doneOn: string, nextDue: string | null = null) => ({ change: "created", data: { systemId: "s1", kind, doneOn, by: "x", notes: null, nextDue, files: [] } });

/** Effluent's reminders (#487, decisions 1095-1097). */
describe("effluent reminders", () => {
  it("adds months, keeping month ends", () => {
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
  });

  it("next service from the last one and the interval, or its own next date; the WoF from the last WoF, else the setup", () => {
    expect(serviceDue(system(), [])).toEqual({ service: null, wof: null, lastService: null, lastWof: null });
    expect(serviceDue(system(), [service("service", "2026-05-01")]).service).toBe("2026-11-01");
    expect(serviceDue(system(), [service("service", "2026-05-01", "2026-09-01")]).service).toBe("2026-09-01");
    expect(serviceDue(system({ data: { ...system().data, wofDue: "2026-12-01" } }), []).wof).toBe("2026-12-01");
    expect(serviceDue(system({ data: { ...system().data, wofDue: "2026-12-01" } }), [service("wof", "2026-10-01", "2027-10-01")]).wof).toBe("2027-10-01");
  });

  it("orders what's due first, then soon; daily checks only when used today; weekly after seven days", () => {
    const base = { ponds: [{ recordId: "p1", data: { name: "Pond" }, readToday: false }], lastMoved: [{ systemId: "s1", systemName: "Irrigator", shiftDue: "2026-10-29T01:00:00Z", running: true }], services: [service("service", "2026-04-20")], consent: { data: { title: "Permit", consentNumber: "RM1", expiresOn: "2027-01-10" } }, today: "2026-10-29", now: "2026-10-29T02:00:00Z", dayOf: (iso: string) => iso.slice(0, 10) };
    const list = effluentReminders({ ...base, systems: [system(), system({ recordId: "s2", lastCheckedAt: "2026-10-21T00:00:00Z", data: { ...system().data, name: "Pods", checkEvery: "week", serviceEveryMonths: null } })], usedToday: new Set(["s1"]) });
    expect(list.map((reminder) => [reminder.kind, reminder.when, reminder.text])).toEqual([
      ["shift", "due", "Shift Irrigator"],
      ["check", "due", "Pre-start check: Irrigator"],
      ["check", "due", "Weekly check: Pods"],
      ["pond", "due", "Read Pond"],
      ["service", "due", "Service Irrigator (was due 2026-10-20)"],
      ["consent", "soon", "Consent RM1 expires 2027-01-10"],
    ]);
    const quiet = effluentReminders({ ...base, ponds: [], lastMoved: [], services: [], consent: null, systems: [system({ lastCheckedAt: "2026-10-23T00:00:00Z", data: { ...system().data, checkEvery: "week" } })], usedToday: new Set() });
    expect(quiet).toEqual([]);
  });

  it("calendar dates fall where they're due, in the range asked", () => {
    const items = effluentDates({ systems: [system({ data: { ...system().data, wofDue: "2027-03-01" } })], services: [service("service", "2026-06-01")], consent: { data: { title: "Permit", consentNumber: null, expiresOn: "2040-06-30" } }, from: "2026-10-01", to: "2027-06-30" });
    expect(items).toEqual([
      { date: "2026-12-01", title: "Service Irrigator", kind: "service" },
      { date: "2027-03-01", title: "Effluent WoF: Irrigator", kind: "wof" },
    ]);
  });
});
