import { describe, expect, it } from "vitest";
import { answerFromEntries, HISTORY_PAGE_SIZE, offlineHistoryNote, type PackEntry } from "@/lib/offline/pack-inventory";

/*
 * Farm histories answered from the device (#479, decisions 1054-1055):
 * dates, paddock, page size and cursor are honoured as the server would,
 * paging ends, and a summary for an earlier day than the one kept is never
 * shown as that day's. Made-up data only.
 */

const PATH = "/api/farming/farms/f1/grazings";

/** 60 grazings, one a day from 1 September 2026 back, two paddocks; ids go up with the date. */
function grazings(count = 60) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 1) - index * 86_400_000).toISOString().slice(0, 10);
    return { id: String(1000 - index), paddockId: index % 2 ? "p2" : "p1", inOn: date, mob: "Milkers" };
  });
}

function pack(rows = grazings()): PackEntry[] {
  return [
    { path: PATH, query: { open: "1" }, body: { grazings: [{ id: "7", inOn: "2026-10-27", outOn: null }], next: null } },
    { path: PATH, query: {}, body: { grazings: rows, next: null, offline: { heldFrom: "2025-10-28", complete: true, count: rows.length } } },
  ];
}

type Page = { grazings: Array<{ id: string; inOn: string; paddockId: string }>; next: string | null; offline: unknown };
const ask = (query: Record<string, string | number | null>, entries = pack()) => answerFromEntries(entries, PATH, { organisationId: "org-1", ...query }) as Page | undefined;

describe("a downloaded history, paged on the device", () => {
  it("pages newest first, with no row twice, until a last page that ends", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = ask({ cursor })!;
      expect(page.grazings.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE);
      seen.push(...page.grazings.map((row) => row.id));
      cursor = page.next;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(60);
    expect(seen).toEqual(grazings().map((row) => row.id));
  });

  it("honours From and To, and a paddock", () => {
    const page = ask({ from: "2026-08-20", to: "2026-08-25", paddockId: "p1" })!;
    expect(page.grazings.map((row) => row.inOn)).toEqual(["2026-08-24", "2026-08-22", "2026-08-20"]);
    expect(page.next).toBeNull();
  });

  it("gives nothing (and no next page) for dates with no records", () => {
    expect(ask({ from: "2026-10-20", to: "2026-10-28" })).toMatchObject({ grazings: [], next: null });
  });

  it("never repeats the first page for a later dated cursor (the review's case)", () => {
    const one: PackEntry[] = [{ path: PATH, query: { from: "2025-10-28", limit: "1000" }, body: { grazings: [{ id: "1", inOn: "2026-10-01", paddockId: "p1" }], next: "2026-10-01_1" } }];
    expect(ask({ from: "2026-10-20", to: "2026-10-28", cursor: "2026-10-01_1" }, one)).toMatchObject({ grazings: [], next: null });
    expect(ask({ cursor: "2026-10-01_1" }, one)).toMatchObject({ grazings: [], next: null });
  });

  it("ends at a cursor past what's on the device, and refuses a cursor that isn't one", () => {
    expect(ask({ cursor: "2020-01-01_5" })).toMatchObject({ grazings: [], next: null });
    expect(ask({ cursor: "not-a-cursor" })).toBeUndefined();
  });

  it("uses the page size asked for (the Log's last 50)", () => {
    const page = ask({ limit: 50 })!;
    expect(page.grazings).toHaveLength(50);
    expect(page.next).toBe(`${page.grazings[49].inOn}_${page.grazings[49].id}`);
  });

  it("keeps mobs still in apart from the history", () => {
    expect(ask({ open: 1 })!.grazings.map((row) => row.id)).toEqual(["7"]);
  });

  it("says what's on the device, and when it isn't everything", () => {
    expect(ask({})!.offline).toEqual({ heldFrom: "2025-10-28", complete: true, count: 60 });
    expect(offlineHistoryNote({ heldFrom: "2025-10-28", complete: true, count: 60 })).toBe("From this device: records from 28 October 2025 on. Older ones need a connection.");
    expect(offlineHistoryNote({ heldFrom: "2025-10-28", complete: false, count: 20000 })).toBe("From this device: only the newest 20,000 records since 28 October 2025 are kept here. The rest need a connection.");
    expect(offlineHistoryNote(null)).toBeNull();
  });
});

describe("a summary for a day", () => {
  const entries: PackEntry[] = [{ path: "/api/farming/farms/f1/pasture", query: { onDate: "2026-10-28" }, body: { summary: { averageCover: 2400 } } }];

  it("is the last known one for the day kept or later, and never given for an earlier day", () => {
    expect(answerFromEntries(entries, "/api/farming/farms/f1/pasture", { onDate: "2026-10-29" })).toEqual({ summary: { averageCover: 2400 } });
    expect(answerFromEntries(entries, "/api/farming/farms/f1/pasture", { onDate: "2026-10-28" })).toEqual({ summary: { averageCover: 2400 } });
    expect(answerFromEntries(entries, "/api/farming/farms/f1/pasture", { onDate: "2026-09-01" })).toBeUndefined();
  });
});
