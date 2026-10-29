import { describe, expect, it } from "vitest";
import { accuracyQuality, accuracyText, canAsk, fixAge, GPS_START, type GpsEvent, gpsMessage, gpsReducer, type GpsState, restoreSteps } from "@/lib/location/gps";

/*
 * Use my location on the farm's maps (#498 item 6, decisions 1115-1118):
 * not asked, allowed, blocked, unavailable and timed out; a block is never
 * asked again by itself; the steps to allow it again for each browser.
 */

const run = (events: GpsEvent[], from: GpsState = GPS_START) => events.reduce(gpsReducer, from);
const fix = { lon: 170.5, lat: -45.87, accuracy: 8, at: 1_000_000 };

describe("GPS state", () => {
  it("starts not asked, asks on a tap and is allowed with a position", () => {
    expect(GPS_START).toEqual({ status: "not_asked" });
    expect(run([{ type: "ask" }])).toEqual({ status: "asking", fix: null });
    expect(run([{ type: "ask" }, { type: "fix", fix }])).toEqual({ status: "granted", fix });
  });

  it("turns the browser's errors into blocked, unavailable and timed out", () => {
    expect(run([{ type: "ask" }, { type: "error", code: 1, at: 5 }])).toEqual({ status: "denied", checkedAt: 5 });
    expect(run([{ type: "ask" }, { type: "error", code: 2 }])).toEqual({ status: "unavailable", reason: "no_fix" });
    expect(run([{ type: "ask" }, { type: "error", code: 3 }])).toEqual({ status: "timed_out" });
  });

  it("shows a block from the Permissions API before anything is tapped", () => {
    expect(run([{ type: "permission", state: "denied", at: 9 }])).toEqual({ status: "denied", checkedAt: 9 });
    expect(run([{ type: "permission", state: "granted" }])).toEqual({ status: "granted", fix: null });
  });

  it("doesn't ask again while blocked: the browser would say no without asking", () => {
    const blocked = run([{ type: "permission", state: "denied" }]);
    expect(canAsk(blocked)).toBe(false);
    expect(gpsReducer(blocked, { type: "ask" })).toBe(blocked);
  });

  it("comes back after the person allows it again (Check again)", () => {
    const blocked = run([{ type: "error", code: 1 }]);
    expect(gpsReducer(blocked, { type: "permission", state: "granted" })).toEqual({ status: "granted", fix: null });
    // Reset to "ask": back to not asked, so the next tap asks.
    expect(gpsReducer(blocked, { type: "permission", state: "prompt" })).toEqual({ status: "not_asked" });
    // Still blocked: stays blocked, with when it was checked.
    expect(gpsReducer(blocked, { type: "permission", state: "denied", at: 42 })).toEqual({ status: "denied", checkedAt: 42 });
  });

  it("keeps the last position while finding a new one, and can try again after a timeout", () => {
    const found = run([{ type: "ask" }, { type: "fix", fix }]);
    expect(gpsReducer(found, { type: "ask" })).toEqual({ status: "asking", fix });
    const timedOut = run([{ type: "ask" }, { type: "error", code: 3 }]);
    expect(canAsk(timedOut)).toBe(true);
    expect(gpsReducer(timedOut, { type: "ask" }).status).toBe("asking");
  });

  it("can't ask on a browser without location, or a plain-http address", () => {
    for (const reason of ["no_api", "insecure"] as const) {
      const state = run([{ type: "unsupported", reason }]);
      expect(state).toEqual({ status: "unavailable", reason });
      expect(canAsk(state)).toBe(false);
      expect(gpsReducer(state, { type: "ask" })).toBe(state);
      expect(gpsReducer(state, { type: "permission", state: "granted" })).toBe(state);
    }
  });

  it("says the map works without it, and what centring on yourself means", () => {
    expect(gpsMessage(GPS_START, 0)).toMatch(/map works without it/);
    expect(gpsMessage({ status: "denied", checkedAt: null }, 0)).toMatch(/blocked.*map still works/);
    expect(gpsMessage({ status: "granted", fix }, fix.at + 1000)).toBe("You're the blue dot, ±8 m, found just now.");
    expect(gpsMessage({ status: "granted", fix: { ...fix, accuracy: 120 } }, fix.at)).toMatch(/±120 m.*rough/);
    expect(gpsMessage({ status: "timed_out" }, 0)).toMatch(/15 seconds/);
  });

  it("never calls an old position live", () => {
    expect(fixAge(1000, 1000 + 59_000)).toBe("just now");
    expect(fixAge(1000, 1000 + 5 * 60_000)).toBe("5 min ago");
    expect(fixAge(0, 2 * 60 * 60_000)).toMatch(/^at /);
  });

  it("rounds accuracy and grades it like tractor mode", () => {
    expect(accuracyText(3.4)).toBe("±3 m");
    expect(accuracyText(0.2)).toBe("±1 m");
    expect(accuracyText(23)).toBe("±25 m");
    expect(accuracyText(2400)).toBe("±2.4 km");
    expect(accuracyText(null)).toBe("accuracy not known");
    expect([accuracyQuality(5), accuracyQuality(20), accuracyQuality(80), accuracyQuality(null)]).toEqual(["good", "fair", "poor", "unknown"]);
  });
});

describe("allowing the location again", () => {
  it("gives each browser its own steps, ending with Check again", () => {
    const cases: Array<[Parameters<typeof restoreSteps>[0], RegExp]> = [
      [{ os: "ios", browser: "safari" }, /Safari Websites/],
      [{ os: "ios", browser: "chrome" }, /Chrome › Location/],
      [{ os: "android", browser: "chrome" }, /left of the address bar › Permissions/],
      [{ os: "android", browser: "firefox" }, /padlock/],
      [{ os: "android", browser: "samsung" }, /Site permissions › Location/],
      [{ os: "android", browser: "edge" }, /Site permissions/],
      [{ os: "windows", browser: "firefox" }, /clear Blocked/],
      [{ os: "mac", browser: "safari" }, /Safari › Settings/],
      [{ os: "windows", browser: "chrome" }, /Site settings/],
      [{ os: "other", browser: "other" }, /settings for this site/],
    ];
    for (const [info, expected] of cases) {
      const steps = restoreSteps(info);
      expect(steps.join(" ")).toMatch(expected);
      expect(steps.at(-1)).toMatch(/Check again/);
    }
  });

  it("reminds phones that their own Location must be on", () => {
    expect(restoreSteps({ os: "android", browser: "chrome" }).join(" ")).toMatch(/phone's Location is on/);
    expect(restoreSteps({ os: "ios", browser: "safari" }).join(" ")).toMatch(/Location Services is on/);
    expect(restoreSteps({ os: "windows", browser: "edge" }).join(" ")).not.toMatch(/phone/);
  });

  it("points an installed Home Screen app at the phone's settings", () => {
    expect(restoreSteps({ os: "android", browser: "chrome" }, true)[0]).toMatch(/Long-press the Tohyee icon/);
    expect(restoreSteps({ os: "ios", browser: "chrome" }, true).join(" ")).toMatch(/Safari Websites/);
  });
});
