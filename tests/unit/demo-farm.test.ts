import { describe, expect, it } from "vitest";
import { buildTime } from "@/lib/demo/build-time";
import { assertDemoAllows, demoRefuses } from "@/lib/demo/guard";
import { dayOf, demoMonths, demoStart, gstDueDate, gstPeriods, milkSolidsFor, moneyBetween, seasonEnd, seededRandom, seedFor } from "@/lib/demo/plan";
import { demoFarmEnabled } from "@/lib/demo/switch";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/** The demo farm's dates, figures and refusals (#437, decisions 855-869). */
describe("the demo farm's plan", () => {
  it("starts on 1 June at least twelve months back: 12 to 23 months of books", () => {
    expect(demoStart("2026-10-24")).toBe("2025-06-01");
    expect(demoStart("2026-06-01")).toBe("2025-06-01");
    expect(demoStart("2026-05-31")).toBe("2024-06-01");
    expect(demoStart("2027-02-29".replace("29", "28"))).toBe("2025-06-01");
    expect(demoMonths("2025-06-01", "2026-10-24")).toHaveLength(17);
    expect(demoMonths("2025-06-01", "2026-10-24").at(-1)).toBe("2026-10");
  });

  it("gives the same farm for the same day, and keeps money exact", () => {
    const a = seededRandom(seedFor("2026-10-24"));
    const b = seededRandom(seedFor("2026-10-24"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const random = seededRandom(7);
    for (let n = 0; n < 200; n += 1) {
      const value = moneyBetween(random, 12.5, 99.99);
      expect(value).toMatch(/^\d+\.\d{2}$/);
      expect(Number(value)).toBeGreaterThanOrEqual(12.5);
      expect(Number(value)).toBeLessThanOrEqual(99.99);
    }
  });

  it("milks August to May, about 110,000 kg MS a season", () => {
    const random = seededRandom(1);
    const season = demoMonths("2025-06-01", "2026-05-31").map((month) => milkSolidsFor(month, random));
    expect(season.slice(0, 2)).toEqual([0, 0]);
    const total = season.reduce((sum, kg) => sum + kg, 0);
    expect(total).toBeGreaterThan(104_000);
    expect(total).toBeLessThan(116_000);
  });

  it("files two-monthly GST periods ending in odd months, due on IRD's dates", () => {
    expect(gstPeriods("2025-06-01", "2026-10-24")).toEqual([
      ["2025-06-01", "2025-07-31"],
      ["2025-08-01", "2025-09-30"],
      ["2025-10-01", "2025-11-30"],
      ["2025-12-01", "2026-01-31"],
      ["2026-02-01", "2026-03-31"],
      ["2026-04-01", "2026-05-31"],
      ["2026-06-01", "2026-07-31"],
      ["2026-08-01", "2026-09-30"],
    ]);
    expect(gstDueDate("2025-07-31")).toBe("2025-08-28");
    expect(gstDueDate("2025-11-30")).toBe("2026-01-15");
    expect(gstDueDate("2026-03-31")).toBe("2026-05-07");
    expect(seasonEnd("2026-05-31")).toBe("2026-05-31");
    expect(seasonEnd("2026-06-01")).toBe("2027-05-31");
    expect(dayOf("2026-02", 30)).toBe("2026-02-28");
  });
});

describe("what the demo farm refuses", () => {
  it("refuses changes that reach outside Tohyee, and allows reading them", () => {
    for (const path of [
      "/api/email/settings",
      "/api/email/google/connect",
      "/api/email/documents",
      "/api/bank-feeds/akahu/settings",
      "/api/bank-accounts/12/feed/sync",
      "/api/bank-accounts/12/stripe",
      "/api/bills/inbox/mailboxes",
      "/api/crm/mail/connect",
      "/api/crm/emails",
      "/api/payroll/pay-runs/abc/payday-filing",
      "/api/payroll/pay-runs/abc/payslips",
      "/api/my-mail/mailboxes/3",
      "/api/farming/mail",
      "/api/sales-platforms/connections",
      "/api/organisations/demo-farm-1/members",
      // Inviting, resending and cancelling (#441) stay refused too.
      "/api/organisations/demo-farm-1/members/00000000-0000-4000-8000-000000000001/invitation",
      "/api/organisations/demo-farm-1/analytics/report-emails",
      "/api/analytics/google/load",
    ]) {
      expect(demoRefuses("POST", path), path).toBe(true);
      expect(demoRefuses("GET", path), path).toBe(false);
    }
    // Ordinary work in the demo farm goes ahead.
    for (const path of ["/api/invoices", "/api/bank-accounts/12/imports", "/api/crm/emails/draft", "/api/farming/farms/1/pasture/readings", "/api/analytics/books", "/api/email/templates"]) {
      expect(demoRefuses("POST", path), path).toBe(false);
    }
  });

  it("passes real organisations straight through, and holds the demo farm back while it's made", () => {
    const record = (demo: OrganisationRecord["demo"]) => ({ demo }) as OrganisationRecord;
    const post = new Request("http://tohyee.test/api/email/settings", { method: "PUT" });
    expect(() => assertDemoAllows(post, record(null))).not.toThrow();
    expect(() => assertDemoAllows(post, record({ userId: "u", status: "ready" }))).toThrow(/demo farm/);
    expect(() => assertDemoAllows(new Request("http://tohyee.test/api/invoices"), record({ userId: "u", status: "building" }))).toThrow(/still being made/);
  });

  it("is on unless the server turns it off", () => {
    const before = process.env.TOHYEE_DEMO_FARM;
    try {
      delete process.env.TOHYEE_DEMO_FARM;
      expect(demoFarmEnabled()).toBe(true);
      process.env.TOHYEE_DEMO_FARM = "off";
      expect(demoFarmEnabled()).toBe(false);
      process.env.TOHYEE_DEMO_FARM = "on";
      expect(demoFarmEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.TOHYEE_DEMO_FARM;
      else process.env.TOHYEE_DEMO_FARM = before;
    }
  });

  it("says how long it took to make in words", () => {
    expect(buildTime(null)).toBeNull();
    expect(buildTime(21.5)).toBe("22 seconds");
    expect(buildTime(1)).toBe("1 second");
    expect(buildTime(60)).toBe("1 minute");
    expect(buildTime(100)).toBe("1 minute 40 seconds");
  });
});
