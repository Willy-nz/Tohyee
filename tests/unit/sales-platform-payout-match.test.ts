import { describe, expect, it } from "vitest";
import {
  guidePayoutLine,
  inTimingWindow,
  mentionsId,
  type PayoutCandidate,
  type PayoutConnection,
  settlementRows,
  summariseSettlement,
} from "@/lib/sales-platforms/payout-match";

/** Examples SPR1-SPR10 in docs/ACCOUNTING-EXAMPLES.md (made-up store, made-up numbers). */

const BANK = "11";
const shop: PayoutConnection = {
  connectionId: "1",
  platformLabel: "Shopify",
  names: ["shopify"],
  postingOn: true,
  payoutAccountId: BANK,
  payoutAccountCode: "1000",
  clearingAccountCode: "1010",
  clearingAccountName: "Money held by Shopify",
  startDate: "2026-10-01",
  missing: [],
  readsPayouts: true,
};

function payout(id: string, net: string, issuedOn: string, overrides: Partial<PayoutCandidate> = {}): PayoutCandidate {
  return {
    connectionId: "1",
    platformLabel: "Shopify",
    externalId: id,
    issuedOn,
    status: "PAID",
    direction: "DEPOSIT",
    net,
    currency: "NZD",
    settlement: null,
    posted: { journalLineId: `jl-${id}`, journalId: `j-${id}`, reconciledLineId: null, reconciledLineDate: null },
    refusal: null,
    ordersNotInBooks: [],
    ...overrides,
  };
}

const line = (amount: string, date: string, text: string, accountId = BANK) => ({ id: "500", accountId, date, amount, text });

describe("SPR1: a payout's settlement", () => {
  it("net fees, a refund and an adjustment add up to the net", () => {
    const settlement = summariseSettlement(
      [
        { type: "CHARGE", amount: "46.00", fee: "1.38", net: "44.62", orderName: "#1001" },
        { type: "CHARGE", amount: "28.90", fee: "1.14", net: "27.76", orderName: "#1002" },
        { type: "REFUND", amount: "-23.00", fee: "0.00", net: "-23.00", orderName: "#1001" },
      ],
      "49.38",
    );
    expect(settlement).toEqual({
      grossSales: "74.90",
      refunds: "-23.00",
      fees: "-2.52",
      adjustments: "0.00",
      chargebacks: "0.00",
      reserves: "0.00",
      other: "0.00",
      net: "49.38",
      transactionCount: 3,
      addsUp: true,
      orderNames: ["#1001", "#1002"],
    });
    expect(settlementRows(settlement)).toEqual([
      { label: "Gross sales", amount: "74.90" },
      { label: "Refunds", amount: "-23.00" },
      { label: "Fees", amount: "-2.52" },
      { label: "Net payout", amount: "49.38" },
    ]);
  });

  it("a chargeback and its fee", () => {
    const settlement = summariseSettlement(
      [
        { type: "CHARGE", amount: "69.00", fee: "2.07", net: "66.93", orderName: "#1005" },
        { type: "DISPUTE_WITHDRAWAL", amount: "-28.90", fee: "0.00", net: "-28.90", orderName: "#1002" },
        { type: "CHARGEBACK_FEE", amount: "-25.00", fee: "0.00", net: "-25.00", orderName: "#1002" },
      ],
      "13.03",
    );
    expect(settlement).toMatchObject({ grossSales: "69.00", fees: "-27.07", chargebacks: "-28.90", net: "13.03", addsUp: true, orderNames: ["#1005"] });
  });

  it("parts that don't add up are flagged, not forced", () => {
    expect(summariseSettlement([{ type: "CHARGE", amount: "10.00", fee: "0.50", net: "9.50", orderName: null }], "9.00").addsUp).toBe(false);
  });
});

describe("SPR2-SPR10: what a bank line is", () => {
  it("SPR2: the payout number on the line matches it, whatever else is near", () => {
    const guidance = guidePayoutLine(line("49.38", "2026-10-08", "SHOPIFY 70001"), [shop], [payout("70001", "49.38", "2026-10-07"), payout("70009", "49.38", "2026-10-06")]);
    expect(guidance).toMatchObject({ status: "matched", evidence: "payout_id", action: { kind: "match", journalLineIds: ["jl-70001"] } });
  });

  it("SPR2: the payout number with a different amount isn't matched", () => {
    const guidance = guidePayoutLine(line("50.00", "2026-10-08", "SHOPIFY 70001"), [shop], [payout("70001", "49.38", "2026-10-07")]);
    expect(guidance).toMatchObject({ status: "unmatched", action: null });
    expect(guidance!.reason).toContain("0.62 different");
  });

  it("the number has to be a word of its own", () => {
    expect(mentionsId("SHOPIFY 700012", "70001")).toBe(false);
    expect(mentionsId("PAYOUT-70001/NZ", "70001")).toBe(true);
  });

  it("SPR3: the platform's name, the amount and a date in the window", () => {
    const guidance = guidePayoutLine(line("49.38", "2026-10-09", "Shopify Payments NZ"), [shop], [payout("70001", "49.38", "2026-10-07")]);
    expect(guidance).toMatchObject({ status: "matched", evidence: "platform_amount_date" });
  });

  it("SPR4: timing: up to 10 days after the payout, or a day before", () => {
    expect(inTimingWindow("2026-10-07", "2026-10-17")).toBe(true);
    expect(inTimingWindow("2026-10-07", "2026-10-18")).toBe(false);
    expect(inTimingWindow("2026-10-07", "2026-10-06")).toBe(true);
    expect(inTimingWindow("2026-10-07", "2026-10-05")).toBe(false);
    const late = guidePayoutLine(line("49.38", "2026-10-20", "SHOPIFY"), [shop], [payout("70001", "49.38", "2026-10-07")]);
    expect(late).toMatchObject({ status: "unmatched", action: null });
  });

  it("SPR5: only the amount and date fit (the line doesn't name Shopify): offered for a person to check", () => {
    const guidance = guidePayoutLine(line("49.38", "2026-10-08", "DEPOSIT"), [shop], [payout("70001", "49.38", "2026-10-07")]);
    expect(guidance).toMatchObject({ status: "needs_choice", evidence: "amount_date" });
  });

  it("SPR5: two payouts of the same amount: no pick", () => {
    const guidance = guidePayoutLine(line("30.00", "2026-10-10", "SHOPIFY"), [shop], [payout("70011", "30.00", "2026-10-07"), payout("70012", "30.00", "2026-10-08")]);
    expect(guidance).toMatchObject({ status: "needs_choice", action: null });
    expect(guidance!.payouts.map((entry) => entry.externalId)).toEqual(["70011", "70012"]);
    // Multiple deposits: once one is matched, the other deposit is the other payout.
    const after = guidePayoutLine(
      line("30.00", "2026-10-10", "SHOPIFY"),
      [shop],
      [payout("70011", "30.00", "2026-10-07", { posted: { journalLineId: "jl-70011", journalId: "j", reconciledLineId: "499", reconciledLineDate: "2026-10-09" } }), payout("70012", "30.00", "2026-10-08")],
    );
    expect(after).toMatchObject({ status: "matched", action: { journalLineIds: ["jl-70012"] } });
  });

  it("SPR6: a duplicate import: the payout's already matched to another line", () => {
    const matched = payout("70001", "49.38", "2026-10-07", { posted: { journalLineId: "jl", journalId: "j", reconciledLineId: "499", reconciledLineDate: "2026-10-08" } });
    for (const text of ["SHOPIFY", "SHOPIFY 70001"]) {
      const guidance = guidePayoutLine(line("49.38", "2026-10-08", text), [shop], [matched]);
      expect(guidance).toMatchObject({ status: "already_matched", action: null });
      expect(guidance!.reason).toContain("duplicate");
    }
  });

  it("SPR7: two payouts in one deposit", () => {
    const guidance = guidePayoutLine(line("66.71", "2026-10-15", "SHOPIFY"), [shop], [payout("70001", "49.38", "2026-10-07"), payout("70002", "17.33", "2026-10-14"), payout("70003", "13.03", "2026-10-13")]);
    expect(guidance).toMatchObject({ status: "combined", action: { kind: "match", journalLineIds: ["jl-70001", "jl-70002"] } });
    // Without the platform's name, a combination isn't guessed (the line isn't treated as a payout at all).
    expect(guidePayoutLine(line("66.71", "2026-10-15", "DEPOSIT"), [shop], [payout("70001", "49.38", "2026-10-07"), payout("70002", "17.33", "2026-10-14")])).toBeNull();
    // Two sets that add up: a person chooses.
    const two = guidePayoutLine(line("30.00", "2026-10-15", "SHOPIFY"), [shop], [payout("1", "10.00", "2026-10-10"), payout("2", "20.00", "2026-10-11"), payout("3", "15.00", "2026-10-12"), payout("4", "15.00", "2026-10-13")]);
    expect(two).toMatchObject({ status: "needs_choice", action: null });
  });

  it("a payout not posted yet, or refused, isn't matched; the reason is the sync's", () => {
    const refused = payout("70003", "13.03", "2026-10-21", { posted: null, refusal: "Payout 70003 has a chargeback. Choose a chargebacks account in the Shopify settings." });
    expect(guidePayoutLine(line("13.03", "2026-10-22", "SHOPIFY"), [shop], [refused])).toMatchObject({ status: "payout_not_posted", action: null });
    expect(guidePayoutLine(line("13.03", "2026-10-22", "SHOPIFY"), [shop], [refused])!.reason).toContain("chargebacks account");
    const inTransit = payout("70004", "76.23", "2026-11-04", { posted: null, status: "IN_TRANSIT" });
    expect(guidePayoutLine(line("76.23", "2026-11-05", "SHOPIFY 70004"), [shop], [inTransit])!.reason).toContain("in transit");
  });

  it("SPR8: missing posting setup", () => {
    const off = { ...shop, postingOn: false };
    expect(guidePayoutLine(line("49.38", "2026-10-08", "SHOPIFY"), [off], [])).toMatchObject({ status: "missing_posting_setup", action: null });
    // Shopify named, but payouts are set to arrive in another account.
    expect(guidePayoutLine(line("49.38", "2026-10-08", "SHOPIFY", "12"), [shop], [payout("70001", "49.38", "2026-10-07")])).toMatchObject({ status: "missing_posting_setup" });
  });

  it("SPR9: missing settlement data: before the start date, or payouts can't be read", () => {
    const early = guidePayoutLine(line("80.00", "2026-09-20", "SHOPIFY"), [shop], []);
    expect(early).toMatchObject({ status: "missing_settlement_data", action: null });
    const noScopes = guidePayoutLine(line("80.00", "2026-10-20", "SHOPIFY"), [{ ...shop, readsPayouts: false }], []);
    // The net out of the clearing account, for a person to review; the fees stay there.
    expect(noScopes).toMatchObject({ status: "missing_settlement_data", action: { kind: "transfer", otherAccountCode: "1010" } });
    expect(noScopes!.reason).toContain("fees stay there");
  });

  it("SPR10: genuinely unmatched stays unresolved", () => {
    expect(guidePayoutLine(line("80.00", "2026-10-20", "SHOPIFY"), [shop], [payout("70001", "49.38", "2026-10-15")])).toMatchObject({ status: "unmatched", action: null });
  });

  it("lines that aren't payouts get nothing", () => {
    // Another account, no platform named.
    expect(guidePayoutLine(line("49.38", "2026-10-08", "KOBE CAFE", "12"), [shop], [payout("70001", "49.38", "2026-10-07")])).toBeNull();
    // A customer paying into the account payouts arrive in.
    expect(guidePayoutLine(line("20.00", "2026-10-08", "KOBE CAFE"), [shop], [payout("70001", "49.38", "2026-10-07")])).toBeNull();
    // The Shopify subscription going out.
    expect(guidePayoutLine(line("-39.00", "2026-10-08", "SHOPIFY* SUBSCRIPTION"), [shop], [])).toBeNull();
    // No store pays out at all.
    expect(guidePayoutLine(line("49.38", "2026-10-08", "SHOPIFY"), [], [])).toBeNull();
  });

  it("no suggestion carries a tax code (SPR10: payouts have no GST)", () => {
    const guidance = guidePayoutLine(line("49.38", "2026-10-08", "SHOPIFY"), [shop], [payout("70001", "49.38", "2026-10-07")]);
    expect(JSON.stringify(guidance!.action)).not.toMatch(/tax/i);
  });
});
