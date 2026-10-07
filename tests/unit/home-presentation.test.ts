import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { bankAccountsForHome, HOME_BANK_ACCOUNT_LIMIT, NeedsAttention, NextGstTile } from "@/components/home/home";
import type { BankAccount } from "@/lib/bank/accounts";
import type { HomeSummary } from "@/lib/reports/home";

vi.mock("next/link", () => ({ default: "a" }));

const summary: HomeSummary = {
  today: "2026-10-08", currencyCode: "NZD", cashInBank: "4500.00",
  owedToYou: { total: "295.00", count: 2, overdueTotal: "230.00", overdueCount: 1 },
  billsToPay: { total: "250.00", count: 2, overdueTotal: "135.00", overdueCount: 1 },
  billsDueThisWeek: 2, nextGstReturn: { status: "none_filed" }, profitByMonth: [], recentActivity: [],
  toDo: { paydayFilingsDue: 1, accountsToReconcile: 5, feedsToReconnect: 1, draftsToApprove: 2 },
};

function gst(nextGstReturn: HomeSummary["nextGstReturn"]) {
  return renderToStaticMarkup(createElement(NextGstTile, { summary: { ...summary, nextGstReturn } }));
}

describe("Home presentation preserves financial meaning", () => {
  it("does not display a zero estimate when GST is unavailable", () => {
    for (const state of [
      { status: "none_filed" } as const,
      { status: "error", periodStart: "2026-10-01", periodEnd: "2026-11-30", message: "Check the tax rate." } as const,
    ]) {
      const html = gst(state);
      expect(html).toContain("Unavailable");
      expect(html).not.toContain("0.00");
      expect(html).not.toContain("Payable");
    }
  });

  it("shows an estimate, direction, both period dates and configured basis", () => {
    const html = gst({ status: "ready", periodStart: "2026-10-01", periodEnd: "2026-11-30", basis: "payments", box15: "-15.00" });
    expect(html).toContain("Estimate · Refundable");
    expect(html).toContain("15.00");
    expect(html).not.toContain("-15.00");
    expect(html).toContain("1 Oct 2026");
    expect(html).toContain("30 Nov 2026");
    expect(html).toContain("Payments");
  });

  it("shows each action once and limits the initial list to five", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttention, { summary }));
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("To do");
    expect(html.match(/5 bank lines to reconcile/g)).toHaveLength(1);
    expect(html).toContain("8 Oct 2026 – 14 Oct 2026");
    expect(html).toContain("View all");
    expect(html).not.toContain("2 drafts to approve");
    expect(html.indexOf("overdue invoice")).toBeLessThan(html.indexOf("bank lines to reconcile"));
  });

  it("uses the up-to-date empty state when there are no actions", () => {
    const html = renderToStaticMarkup(createElement(NeedsAttention, { summary: {
      ...summary, owedToYou: { ...summary.owedToYou, overdueCount: 0 }, billsDueThisWeek: 0,
      toDo: { paydayFilingsDue: 0, accountsToReconcile: 0, feedsToReconnect: 0, draftsToApprove: 0 },
    } }));
    expect(html).toContain("You&#x27;re up to date.");
    expect(html).not.toContain("View all");
  });
  it("says there's nothing to pay when the estimate is zero, not Payable", () => {
    const html = gst({ status: "ready", periodStart: "2026-10-01", periodEnd: "2026-11-30", basis: "invoice", box15: "0.00" });
    expect(html).toContain("Estimate · Nothing to pay so far");
    expect(html).not.toContain("Payable");
    expect(html).not.toContain("Refundable");
  });

  it("lists at most five active bank accounts on Home, failed feeds first", () => {
    const account = (n: number, failed = false, isActive = true) =>
      ({
        id: `a${n}`, code: String(1000 + n), name: `Account ${n}`, isActive,
        feed: { active: failed, lastSyncStatus: failed ? "failed" : null },
        simplefin: null, stripe: null, paypal: null, wise: null,
      }) as unknown as BankAccount;
    const accounts = [...Array.from({ length: 100 }, (_, i) => account(i)), account(200, true), account(300, false, false)];
    const { shown, total } = bankAccountsForHome(accounts);
    expect(HOME_BANK_ACCOUNT_LIMIT).toBe(5);
    expect(total).toBe(101);
    expect(shown.map((entry) => entry.name)).toEqual(["Account 200", "Account 0", "Account 1", "Account 2", "Account 3"]);
  });
});
