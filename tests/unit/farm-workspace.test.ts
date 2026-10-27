import { describe, expect, it } from "vitest";
import { FARM_TABS } from "@/components/farm-workspace";
import { addDays } from "@/lib/farming/farm-words";
import { launcherUrl } from "@/lib/farming/launchers";
import { COVER_AGE_BANDS, GRAZED_BANDS, paddockBand } from "@/lib/farming/map-colours";

/** The farmer's workspace (#447, decisions 907-910). */
describe("farm workspace tabs", () => {
  it("are Today, Map, Log, Safety and More, in that order", () => {
    expect(FARM_TABS.map((tab) => [tab.label, tab.href])).toEqual([
      ["Today", "/operations/farm"],
      ["Map", "/operations/farm/map"],
      ["Log", "/operations/farm/log"],
      ["Safety", "/operations/farm/safety"],
      ["More", "/operations/farm/more"],
    ]);
  });
});

describe("map colours are facts, not judgements (decision 907)", () => {
  const today = "2026-10-27";
  const grazed = (lastGrazedOn: string | null, inNow = false) => paddockBand({ inNow, lastGrazedOn, coverOn: null }, "grazed", today).key;
  it("bands days since grazed", () => {
    expect(grazed(null, true)).toBe("in");
    expect(grazed("2026-10-27")).toBe("0-7");
    expect(grazed("2026-10-20")).toBe("0-7");
    expect(grazed("2026-10-19")).toBe("8-14");
    expect(grazed("2026-10-13")).toBe("8-14");
    expect(grazed("2026-10-12")).toBe("15-21");
    expect(grazed("2026-09-27")).toBe("22-30");
    expect(grazed("2026-09-26")).toBe("31+");
    expect(grazed(null)).toBe("none");
  });
  it("bands the cover reading's age", () => {
    const age = (coverOn: string | null) => paddockBand({ inNow: true, lastGrazedOn: null, coverOn }, "cover_age", today).key;
    expect([age("2026-10-24"), age("2026-10-13"), age("2026-09-27"), age("2026-09-26"), age(null)]).toEqual(["0-7", "8-14", "15-30", "31+", "none"]);
  });
  it("uses the theme's colours and plain words", () => {
    for (const band of [...GRAZED_BANDS, ...COVER_AGE_BANDS]) {
      expect(band.colour).toMatch(/^var\(--/);
      expect(band.label).not.toMatch(/\b(good|bad|high|low|overdue|due|poor|ready)\b/i);
    }
  });
});

describe("app tile addresses (decision 908)", () => {
  it("are https (http only on this computer), with no keys or passwords", () => {
    expect(launcherUrl("https://plate.example.nz/walk")).toBe("https://plate.example.nz/walk");
    expect(launcherUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(() => launcherUrl("http://plate.example.nz")).toThrow("https://");
    expect(() => launcherUrl("javascript:alert(1)")).toThrow();
    expect(() => launcherUrl("https://me:secret@plate.example.nz")).toThrow("passwords");
    expect(() => launcherUrl("https://plate.example.nz/?key=tohyee_app_abc")).toThrow("keys");
  });
  it("adds days to a date", () => {
    expect(addDays("2026-10-27", 6)).toBe("2026-11-02");
  });
});
