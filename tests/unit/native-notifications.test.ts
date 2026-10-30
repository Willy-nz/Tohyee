import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SCHEDULED, morningOf, notificationId, planNotifications, refreshDeviceReminders, setRemindersOn, tappedPath } from "@/lib/native/notifications";
import type { DeviceReminder } from "@/lib/native/reminders-shared";

/*
 * Reminders as notifications in the Android app (#502, decisions
 * 1146-1148): what's scheduled from the server's reminders, when, and
 * that a refresh replaces what Tohyee scheduled, only when turned on.
 */

const base = { organisationId: "org-1", farmId: "f1", path: "/operations/farm/effluent?farm=f1", body: "Home farm" };
const reminder = (over: Partial<DeviceReminder> & Pick<DeviceReminder, "key" | "kind" | "title">): DeviceReminder => ({ ...base, at: null, date: null, ...over });

// Wednesday 30 October 2026, 10:00 on the phone's clock.
const now = new Date(2026, 9, 30, 10, 0, 0);

describe("planNotifications", () => {
  it("schedules a shift at its time, and a dated reminder at 7 am that day", () => {
    const shift = new Date(2026, 9, 30, 12, 30).toISOString();
    const planned = planNotifications([reminder({ key: "shift-1", kind: "shift", title: "Shift Irrigator", at: shift }), reminder({ key: "action-1", kind: "action", title: "Safety action due: Fix the gate", date: "2026-11-02" })], now);
    expect(planned.map((entry) => [entry.title, entry.at])).toEqual([
      ["Shift Irrigator", shift],
      ["Safety action due: Fix the gate", morningOf("2026-11-02").toISOString()],
    ]);
    expect(planned[0]).toMatchObject({ path: base.path, organisationId: "org-1", key: "org-1:shift-1" });
    expect(new Date(planned[1].at).getHours()).toBe(7);
  });

  it("leaves out what's already due (it's on Today) and what's more than two weeks away", () => {
    const planned = planNotifications(
      [
        reminder({ key: "shift-late", kind: "shift", title: "Late shift", at: new Date(2026, 9, 30, 9, 0).toISOString() }),
        reminder({ key: "today", kind: "action", title: "Due today", date: "2026-10-30" }),
        reminder({ key: "far", kind: "service", title: "Service", date: "2026-12-25" }),
      ],
      now,
    );
    expect(planned).toEqual([]);
  });

  it("repeats a pond reading each morning for a week from its date", () => {
    const planned = planNotifications([reminder({ key: "pond-1", kind: "pond", title: "Read Pond", date: "2026-10-30", daily: true })], now);
    // Today's 7 am has gone: tomorrow and the five days after.
    expect(planned.map((entry) => new Date(entry.at).getDate())).toEqual([31, 1, 2, 3, 4, 5]);
    expect(new Set(planned.map((entry) => entry.id)).size).toBe(6);
  });

  it("keeps ids stable across refreshes and different for different times or organisations", () => {
    const at = "2026-11-02T18:00:00.000Z";
    expect(notificationId("org-1:action-1", at)).toBe(notificationId("org-1:action-1", at));
    expect(notificationId("org-1:action-1", at)).not.toBe(notificationId("org-2:action-1", at));
    expect(notificationId("org-1:action-1", at)).toBeGreaterThan(0);
    expect(notificationId("org-1:action-1", at)).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it("keeps the nearest when there are too many", () => {
    const many = Array.from({ length: 100 }, (_, index) => reminder({ key: `shift-${index}`, kind: "shift", title: `Shift ${index}`, at: new Date(now.getTime() + (index + 1) * 3_600_000).toISOString() }));
    const planned = planNotifications(many, now);
    expect(planned).toHaveLength(MAX_SCHEDULED);
    expect(planned[0].title).toBe("Shift 0");
    expect(planned.at(-1)!.title).toBe(`Shift ${MAX_SCHEDULED - 1}`);
  });
});

describe("tapping a reminder", () => {
  it("opens a Tohyee page, never another site", () => {
    expect(tappedPath({ tohyee: true, path: "/operations/farm/safety?farm=f1", organisationId: "org-1" })).toEqual({ path: "/operations/farm/safety?farm=f1", organisationId: "org-1" });
    expect(tappedPath({ tohyee: true, path: "//evil.example/x" })).toBeNull();
    expect(tappedPath({ tohyee: true, path: "https://evil.example/x" })).toBeNull();
    expect(tappedPath({ path: "/operations" })).toBeNull();
    expect(tappedPath(null)).toBeNull();
  });
});

describe("refreshing the phone's reminders", () => {
  type Call = { method: string; options: Record<string, unknown> };
  let calls: Call[];
  let display: string;
  let pending: Array<{ id: number; extra?: { tohyee?: boolean } }>;
  const store = new Map<string, string>();
  const original = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    calls = [];
    display = "granted";
    pending = [{ id: 11, extra: { tohyee: true } }, { id: 99, extra: null as never }];
    store.clear();
    const record = (method: string, answer: (options: Record<string, unknown>) => unknown = () => ({})) => async (options: Record<string, unknown>) => {
      calls.push({ method, options });
      return answer(options);
    };
    const plugin = {
      checkPermissions: record("checkPermissions", () => ({ display })),
      getPending: record("getPending", () => ({ notifications: pending })),
      cancel: record("cancel"),
      createChannel: record("createChannel"),
      schedule: record("schedule", (options) => ({ notifications: (options.notifications as unknown[]).map(() => ({})) })),
    };
    (globalThis as { window?: unknown }).window = {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { LocalNotifications: plugin }, PluginHeaders: [{ name: "LocalNotifications" }] },
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  const answers = (byOrganisation: Record<string, unknown>) =>
    (async (url: string) => {
      const organisationId = new URL(url, "https://tohyee.example.nz").searchParams.get("organisationId")!;
      const body = byOrganisation[organisationId];
      if (body === "offline") throw new TypeError("Failed to fetch");
      if (typeof body === "number") return new Response("{}", { status: body });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

  const shiftIn = (hours: number) => reminder({ key: "shift-1", kind: "shift", title: "Shift Irrigator", at: new Date(Date.now() + hours * 3_600_000).toISOString() });

  it("does nothing but clear Tohyee's own when reminders are off", async () => {
    expect(await refreshDeviceReminders(["org-1"], answers({ "org-1": { reminders: [shiftIn(2)] } }))).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["getPending", "cancel"]);
    expect(calls[1].options).toEqual({ notifications: [{ id: 11 }] });
  });

  it("replaces Tohyee's scheduled reminders with every organisation's, inexact, on its own channel", async () => {
    setRemindersOn(true);
    const count = await refreshDeviceReminders(["org-1", "org-2", "org-3"], answers({ "org-1": { reminders: [shiftIn(2)] }, "org-2": 403, "org-3": { reminders: [{ ...shiftIn(3), organisationId: "org-3", key: "shift-9" }] } }));
    expect(count).toBe(2);
    expect(calls.map((call) => call.method)).toEqual(["getPending", "cancel", "checkPermissions", "createChannel", "schedule"]);
    const scheduled = calls.at(-1)!.options.notifications as Array<Record<string, unknown>>;
    expect(scheduled.map((entry) => entry.title)).toEqual(["Shift Irrigator", "Shift Irrigator"]);
    expect(scheduled[0]).toMatchObject({ channelId: "tohyee-reminders", isExactNotification: false, extra: { tohyee: true, organisationId: "org-1" } });
  });

  it("keeps what's scheduled when Tohyee can't be reached", async () => {
    setRemindersOn(true);
    expect(await refreshDeviceReminders(["org-1", "org-2"], answers({ "org-1": { reminders: [shiftIn(2)] }, "org-2": "offline" }))).toBeNull();
    expect(await refreshDeviceReminders(["org-1"], answers({ "org-1": 500 }))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("schedules nothing while notifications aren't allowed", async () => {
    setRemindersOn(true);
    display = "denied";
    expect(await refreshDeviceReminders(["org-1"], answers({ "org-1": { reminders: [shiftIn(2)] } }))).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["getPending", "cancel", "checkPermissions"]);
  });
});
