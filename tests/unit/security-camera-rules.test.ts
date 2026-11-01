import { describe, expect, it } from "vitest";
import { accessFor, cameraHealth, eventTiming, expires, isTimeZone, localTimeToInstant, retentionCutoff } from "@/lib/security-cameras/shared";

/* Camera clock, health, retention and access rules (#508, decisions 1218-1222). Made-up cameras. */

describe("camera clock", () => {
  it("reads the camera's wall-clock time in its time zone, daylight saving included", () => {
    // NZST (+12) in winter, NZDT (+13) in summer.
    expect(localTimeToInstant("2026-07-01T09:00:00", "Pacific/Auckland")?.toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(localTimeToInstant("2026-12-01T09:00:00", "Pacific/Auckland")?.toISOString()).toBe("2026-11-30T20:00:00.000Z");
    expect(localTimeToInstant("2026-12-01T09:00:00", "UTC")?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    // 2:30 on 5 April 2026 happens twice in Auckland: the first (still NZDT, +13).
    expect(localTimeToInstant("2026-04-05T02:30:00", "Pacific/Auckland")?.toISOString()).toBe("2026-04-04T13:30:00.000Z");
    expect(localTimeToInstant("not a time", "UTC")).toBeNull();
  });

  it("knows real time zones", () => {
    expect(isTimeZone("Pacific/Auckland")).toBe(true);
    expect(isTimeZone("Pacific/Nowhere")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });

  it("keeps both times and trusts the camera unless it's in the future", () => {
    const received = new Date("2026-11-01T10:00:00Z");
    expect(eventTiming(new Date("2026-11-01T09:59:30Z"), received)).toEqual({ occurredAt: new Date("2026-11-01T09:59:30Z"), clockNote: "ok" });
    // A few minutes ahead is clock drift; more is a wrong clock, so Tohyee's time is used.
    expect(eventTiming(new Date("2026-11-01T10:05:00Z"), received).clockNote).toBe("ok");
    expect(eventTiming(new Date("2026-11-01T11:00:00Z"), received)).toEqual({ occurredAt: received, clockNote: "camera_ahead" });
    // A backlog after the camera was offline keeps the camera's time and says so.
    expect(eventTiming(new Date("2026-10-31T10:00:00Z"), received)).toEqual({ occurredAt: new Date("2026-10-31T10:00:00Z"), clockNote: "arrived_late" });
    expect(eventTiming(null, received)).toEqual({ occurredAt: received, clockNote: "no_time" });
  });
});

describe("camera health", () => {
  const now = new Date("2026-11-05T10:00:00+13:00"); // a Thursday
  const camera = { name: "Camera 2", isActive: true, quietAlertHours: 24 };
  it("is the time of the last upload", () => {
    expect(cameraHealth({ ...camera, lastUploadAt: null }, now, "Pacific/Auckland")).toEqual({ state: "never", text: "Nothing from Camera 2 yet." });
    expect(cameraHealth({ ...camera, lastUploadAt: "2026-11-03T08:00:00+13:00" }, now, "Pacific/Auckland")).toEqual({ state: "quiet", text: "No uploads from Camera 2 since Tuesday." });
    expect(cameraHealth({ ...camera, lastUploadAt: "2026-10-20T08:00:00+13:00" }, now, "Pacific/Auckland").text).toBe("No uploads from Camera 2 since 20 Oct.");
    expect(cameraHealth({ ...camera, lastUploadAt: "2026-11-05T07:00:00+13:00" }, now, "Pacific/Auckland")).toEqual({ state: "ok", text: "Last upload 3 hours ago" });
    expect(cameraHealth({ ...camera, quietAlertHours: 2, lastUploadAt: "2026-11-05T07:00:00+13:00" }, now, "Pacific/Auckland")).toEqual({ state: "quiet", text: "No uploads from Camera 2 for 3 hours." });
    expect(cameraHealth({ ...camera, lastUploadAt: "2026-11-05T09:58:00+13:00" }, now, "Pacific/Auckland").text).toBe("Last upload 2 minutes ago");
    expect(cameraHealth({ ...camera, isActive: false, lastUploadAt: null }, now).state).toBe("archived");
  });
});

describe("retention", () => {
  const now = new Date("2026-11-30T00:00:00Z");
  it("goes by when Tohyee got the file, and never removes kept events", () => {
    expect(retentionCutoff(now, 30).toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(expires({ kept: false, receivedAt: "2026-10-30T23:59:59Z" }, 30, now)).toBe(true);
    expect(expires({ kept: false, receivedAt: "2026-10-31T00:00:00Z" }, 30, now)).toBe(false);
    expect(expires({ kept: true, receivedAt: "2020-01-01T00:00:00Z" }, 30, now)).toBe(false);
  });
});

describe("access", () => {
  it("gives owners and admins everything and others only what they're given", () => {
    expect(accessFor("owner", null)).toEqual({ view: true, download: true, delete: true, configure: true });
    expect(accessFor("admin", null).configure).toBe(true);
    expect(accessFor("bookkeeper", null)).toEqual({ view: false, download: false, delete: false, configure: false });
    expect(accessFor("farm_worker", "view")).toEqual({ view: true, download: false, delete: false, configure: false });
    expect(accessFor("viewer", "download")).toEqual({ view: true, download: true, delete: false, configure: false });
    expect(accessFor("bookkeeper", "delete")).toEqual({ view: true, download: true, delete: true, configure: false });
  });
});
