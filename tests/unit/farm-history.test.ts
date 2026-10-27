import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, historyConditions, parseHistoryQuery, toPage } from "@/lib/farming/history";
import { coverText, daysAgo, daysBetween, mobText, shortDate } from "@/lib/farming/farm-words";
import { resolveSelectedFarm } from "@/lib/client/farm-selection";

/** Farm histories a page at a time, and plain words (#447, decisions 900, 901 and 903). */
describe("history pages", () => {
  it("reads the page size, dates and cursor, with limits", () => {
    expect(parseHistoryQuery({})).toEqual({ from: null, to: null, limit: 25, after: null });
    expect(parseHistoryQuery({ limit: "100", from: "2026-10-01", to: "2026-10-27", cursor: "2026-10-20_42" })).toEqual({ from: "2026-10-01", to: "2026-10-27", limit: 100, after: { date: "2026-10-20", id: "42" } });
    expect(() => parseHistoryQuery({ limit: "1001" })).toThrow("from 1 to 1,000");
    expect(() => parseHistoryQuery({ limit: "0" })).toThrow();
    expect(() => parseHistoryQuery({ from: "2026-10-27", to: "2026-10-01" })).toThrow("can't be before");
    expect(() => decodeCursor("2026-10-20;drop table")).toThrow("isn't valid");
    expect(decodeCursor(encodeCursor({ date: "2026-01-02", id: "7" }))).toEqual({ date: "2026-01-02", id: "7" });
  });

  it("numbers the conditions after the ones already there", () => {
    const query = parseHistoryQuery({ from: "2026-10-01", to: "2026-10-27", cursor: "2026-10-20_42" });
    expect(historyConditions(query, "r.measured_on", "r.id", 3)).toEqual({
      sql: "r.measured_on >= $3::date and r.measured_on <= $4::date and (r.measured_on, r.id) < ($5::date, $6::bigint)",
      params: ["2026-10-01", "2026-10-27", "2026-10-20", "42"],
    });
    expect(historyConditions(parseHistoryQuery({}), "g.in_on", "g.id", 2)).toEqual({ sql: "true", params: [] });
  });

  it("ends a page with the cursor of its last row only when there's more", () => {
    const rows = [5, 4, 3].map((n) => ({ id: String(n), date: `2026-10-0${n}` }));
    expect(toPage(rows, 3, (row) => row)).toEqual({ rows, next: null });
    expect(toPage(rows, 2, (row) => row)).toEqual({ rows: rows.slice(0, 2), next: "2026-10-04_4" });
  });
});

describe("plain farm words", () => {
  it("says dates, ages, covers and mobs shortly, without judging", () => {
    expect(shortDate("2026-10-24", "2026-10-27")).toBe("24 Oct");
    expect(shortDate("2025-12-24", "2026-10-27")).toBe("24 Dec 2025");
    expect(daysBetween("2026-10-20", "2026-10-27")).toBe(7);
    expect([daysAgo("2026-10-27", "2026-10-27"), daysAgo("2026-10-26", "2026-10-27"), daysAgo("2026-10-12", "2026-10-27")]).toEqual(["today", "yesterday", "15 days ago"]);
    expect(coverText(3057)).toBe("3,057 kg DM/ha");
    expect(mobText("Milkers", 300)).toBe("Milkers (300)");
    expect(mobText("Dry cows", null)).toBe("Dry cows");
  });
});

describe("opening a farm page", () => {
  const farms = [
    { id: "1", isActive: true },
    { id: "2", isActive: true },
    { id: "3", isActive: false },
  ];
  it("opens the farm last used when nothing is chosen in the tab, never an archived or unknown one", () => {
    expect(resolveSelectedFarm(farms, null, "2")).toEqual(farms[1]);
    expect(resolveSelectedFarm(farms, null, "3")).toBeNull();
    expect(resolveSelectedFarm(farms, null, "99")).toBeNull();
    expect(resolveSelectedFarm(farms, null, null)).toBeNull();
  });
  it("keeps this tab's choice, and a stale choice is never swapped for the last farm", () => {
    expect(resolveSelectedFarm(farms, "1", "2")).toEqual(farms[0]);
    expect(resolveSelectedFarm(farms, "3", "2")).toBeNull();
  });
});
