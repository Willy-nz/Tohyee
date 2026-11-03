import { describe, expect, it } from "vitest";
import { aiGstRefusal } from "@/lib/ai/gst-evidence";
import { type PostingRules, gstWaitReason, planOrder } from "@/lib/sales-platforms/orders";
import { stepGaps, storeGstSetup, suggestTaxCodes, type PostingDraft } from "@/lib/sales-platforms/setup";
import { NZ_DEFAULT_TAX_CODES } from "@/lib/tax/default-codes";
import { gstRegistrationSummary, gstStatusOn, isGstRegisteredOn, type GstRegistration } from "@/lib/tax/registration";
import { gstChoiceValue, initialRegistrationChoice, registrationChanges, registrationPatch } from "@/lib/tax/registration-choice";
import { shopifyOrderFromGraphql } from "@/lib/sales-platforms/shopify";
import { order1001, orderNode } from "../helpers/fake-shopify-orders";

/**
 * Issue #546, examples GSR1-GSR10 in docs/ACCOUNTING-EXAMPLES.md ("GST
 * registration a person has confirmed"): Kowhai Crafts registered,
 * not registered, unconfirmed, and registered from 1 Nov 2026.
 */
const reg = (overrides: Partial<GstRegistration> = {}): GstRegistration => ({
  registered: true,
  from: null,
  until: null,
  organisationName: "Kowhai Crafts",
  confirmed: true,
  ...overrides,
});
const REGISTERED = reg();
const NOT_REGISTERED = reg({ registered: false });
const UNCONFIRMED = reg({ confirmed: false });
const FROM_NOV = reg({ from: "2026-11-01" });

describe("GST status on a date (GSR1-GSR4)", () => {
  it("is registered only when confirmed and inside the dates", () => {
    expect(gstStatusOn(REGISTERED, "2026-10-15")).toBe("registered");
    expect(gstStatusOn(NOT_REGISTERED, "2026-10-15")).toBe("not_registered");
    expect(gstStatusOn(reg({ registered: false, confirmed: false }), "2026-10-15")).toBe("not_registered");
    expect(gstStatusOn(UNCONFIRMED, "2026-10-15")).toBe("unconfirmed");
    expect(gstStatusOn(FROM_NOV, "2026-10-31")).toBe("not_registered");
    expect(gstStatusOn(FROM_NOV, "2026-11-01")).toBe("registered");
    expect(gstStatusOn(reg({ until: "2027-03-31" }), "2027-04-01")).toBe("not_registered");
    // Older callers that don't say whether it's confirmed count as confirmed.
    expect(gstStatusOn({ registered: true, from: null, until: null }, "2026-10-15")).toBe("registered");
  });

  it("isGstRegisteredOn is the yes/no helper for automatic posting", () => {
    expect(isGstRegisteredOn(REGISTERED, "2026-10-15")).toBe(true);
    expect(isGstRegisteredOn(UNCONFIRMED, "2026-10-15")).toBe(false);
    expect(isGstRegisteredOn(NOT_REGISTERED, "2026-10-15")).toBe(false);
    expect(isGstRegisteredOn(FROM_NOV, "2026-10-31")).toBe(false);
    expect(isGstRegisteredOn(FROM_NOV, "2026-11-01")).toBe(true);
  });
});

const RULES: PostingRules = {
  baseCurrency: "NZD",
  gstRegistered: true,
  foreignTrade: false,
  exportTaxCode: null,
  untaxedTaxCode: "ZERO",
  taxCodes: [{ rate: "0.15", code: "GST", codeRate: "0.15" }],
  salesAccountCode: "4000",
  shippingAccountCode: "4000",
};
const order = (processedAt: string) => shopifyOrderFromGraphql({ ...orderNode(order1001({ processedAt })), refunds: [] });

describe("Shopify and WooCommerce orders (GSR3, GSR6)", () => {
  it("GSR3: while unconfirmed, a new order waits with one plain reason", () => {
    expect(gstWaitReason({ ...RULES, gstRegistration: UNCONFIRMED }, "2026-10-02")).toBe(
      "Kowhai Crafts's GST registration hasn't been confirmed yet, so Tohyee won't decide its GST on its own. Confirm it in Settings › Organisation (GST).",
    );
    expect(gstWaitReason({ ...RULES, gstRegistration: REGISTERED }, "2026-10-02")).toBeNull();
    expect(gstWaitReason({ ...RULES, gstRegistration: NOT_REGISTERED }, "2026-10-02")).toBeNull();
    // Not registered on that date (even unconfirmed): it comes in at the full amount instead of waiting.
    expect(gstWaitReason({ ...RULES, gstRegistration: reg({ from: "2026-11-01", confirmed: false }) }, "2026-10-02")).toBeNull();
  });

  it("GSR6: registered from 1 Nov 2026, a 46.00 order on 31 Oct is 46.00 sales and one on 1 Nov is 40.00 + 6.00 GST", () => {
    const rules = { ...RULES, gstRegistration: FROM_NOV };
    // 31 Oct 2026 11:00 NZDT and 1 Nov 2026 11:00 NZDT.
    const before = planOrder(order("2026-10-30T22:00:00Z"), rules, new Map(), false);
    expect(before).toMatchObject({ ok: true, amountsMode: "no_tax", total: "46.00", lines: [{ taxCode: null, unitPrice: "23.00" }] });
    const after = planOrder(order("2026-10-31T22:00:00Z"), rules, new Map(), false);
    expect(after).toMatchObject({ ok: true, amountsMode: "inclusive", total: "46.00", lines: [{ taxCode: "GST", unitPrice: "23.00" }] });
  });
});

const taxCodes = NZ_DEFAULT_TAX_CODES.map((code) => ({ ...code, isActive: true, availableOn: "both" }));
const draft = { startDate: "2026-10-01", salesAccountCode: "4000", separateShipping: false, shippingAccountCode: "", clearingAccountCode: "1010", payoutAccountCode: "1000", feesAccountCode: "6020", chargebacksAccountCode: "", reserveAccountCode: "", untaxedTaxCode: "", guestContactId: "", taxCodes: [], paymentMethods: [] } as PostingDraft;

describe("the guided store setup (GSR3, GSR6, GSR7)", () => {
  it("asks GST questions and suggests 15% → GST only for a confirmed registration from the start date on", () => {
    expect(storeGstSetup(REGISTERED, "2026-10-01", "2026-11-03")).toBe("registered");
    expect(storeGstSetup(UNCONFIRMED, "2026-10-01", "2026-11-03")).toBe("unconfirmed");
    expect(storeGstSetup(NOT_REGISTERED, "2026-10-01", "2026-11-03")).toBe("not_registered");
    // Registered from 1 Nov: a store starting 1 Oct still meets GST from 1 Nov.
    expect(storeGstSetup(FROM_NOV, "2026-10-01", "2026-11-03")).toBe("registered");
    // Registration ended 31 Mar 2027: a store starting after it never does.
    expect(storeGstSetup(reg({ until: "2027-03-31" }), "2027-04-01", "2027-04-01")).toBe("not_registered");
    // No start date yet: from today.
    expect(storeGstSetup(FROM_NOV, "", "2026-11-03")).toBe("registered");
    expect(storeGstSetup(null, "2026-10-01", "2026-11-03")).toBe("unconfirmed");

    expect(suggestTaxCodes(taxCodes, true)).toEqual({ untaxed: "ZERO", rates: [{ rate: "15", taxCode: "GST" }] });
    expect(suggestTaxCodes(taxCodes, false)).toEqual({ untaxed: null, rates: [] });
  });

  it("GSR7: a non-registered organisation isn't asked for a tax code for untaxed sales", () => {
    expect(stepGaps("accounts", draft, { platform: "shopify", gstRegistered: false })).toEqual([]);
    expect(stepGaps("accounts", draft, { platform: "shopify", gstRegistered: true })).toEqual(["Choose the tax code for untaxed sales."]);
  });
});

describe("AI bank coding (GSR10)", () => {
  it("needs evidence for GST treatment when registered, and chooses none while unconfirmed", () => {
    expect(aiGstRefusal("registered", undefined, ["standard"], "Kowhai Crafts")).toMatch(/gstEvidence.*leave the line unreconciled/);
    expect(aiGstRefusal("registered", undefined, [null], "Kowhai Crafts")).toMatch(/gstEvidence/);
    expect(aiGstRefusal("registered", "tax_document", ["standard"], "Kowhai Crafts")).toBeNull();
    expect(aiGstRefusal("registered", "no_gst_supply", [null, "out_of_scope"], "Kowhai Crafts")).toBeNull();
    expect(aiGstRefusal("registered", "no_gst_supply", ["standard"], "Kowhai Crafts")).toMatch(/no tax code/);
    expect(aiGstRefusal("registered", "merchant_name", ["standard"], "Kowhai Crafts")).toMatch(/must be one of/);
    expect(aiGstRefusal("unconfirmed", "tax_document", ["standard"], "Kowhai Crafts")).toMatch(/hasn't been confirmed.*review/);
    expect(aiGstRefusal("unconfirmed", "tax_document", [null], "Kowhai Crafts")).toMatch(/hasn't been confirmed/);
    expect(aiGstRefusal("unconfirmed", "no_gst_supply", [null], "Kowhai Crafts")).toBeNull();
    // Not registered: no evidence needed; the posting itself refuses GST codes (NR2).
    expect(aiGstRefusal("not_registered", undefined, [null], "Kowhai Crafts")).toBeNull();
  });
});

const saved = { gstRegistered: true, gstRegisteredFrom: null, gstRegisteredUntil: null, gstRegistrationConfirmedAt: null };

describe("Settings and the new-organisation form (GSR1, GSR2, GSR4, GSR5, GSR8)", () => {
  it("GSR4: nothing is chosen while unconfirmed, and saving without a choice sends nothing about GST", () => {
    expect(initialRegistrationChoice(saved)).toBe("");
    expect(registrationPatch(saved, { choice: "", from: "", until: "" }, false)).toEqual({});
    expect(initialRegistrationChoice({ ...saved, gstRegistrationConfirmedAt: "2026-11-03T00:00:00Z" })).toBe("registered");
    expect(initialRegistrationChoice({ ...saved, gstRegistered: false, gstRegistrationConfirmedAt: "2026-11-03T00:00:00Z" })).toBe("not_registered");
  });

  it("GSR5: choosing an answer confirms it; an unchanged confirmed answer isn't confirmed again", () => {
    expect(registrationPatch(saved, { choice: "registered", from: "", until: "" }, false)).toEqual({
      gstRegistered: true,
      gstRegisteredFrom: null,
      gstRegisteredUntil: null,
      gstRegistrationConfirmed: true,
    });
    const confirmed = { ...saved, gstRegistrationConfirmedAt: "2026-11-03T00:00:00Z" };
    expect(registrationPatch(confirmed, { choice: "registered", from: "", until: "" }, false)).toEqual({ gstRegistered: true, gstRegisteredFrom: null, gstRegisteredUntil: null });
  });

  it("GSR8: a change sends the acknowledgement only once ticked", () => {
    const confirmed = { ...saved, gstRegistrationConfirmedAt: "2026-11-03T00:00:00Z" };
    const form = { choice: "registered" as const, from: "2026-09-01", until: "" };
    expect(registrationChanges(confirmed, form)).toBe(true);
    expect(registrationChanges(confirmed, { choice: "registered", from: "", until: "" })).toBe(false);
    expect(registrationPatch(confirmed, form, false)).not.toHaveProperty("acknowledgeAffectedPeriods");
    expect(registrationPatch(confirmed, form, true)).toMatchObject({ gstRegisteredFrom: "2026-09-01", gstRegistrationConfirmed: true, acknowledgeAffectedPeriods: true });
    // Not registered sends no dates.
    expect(registrationPatch(confirmed, { choice: "not_registered", from: "2026-09-01", until: "" }, false)).toMatchObject({ gstRegistered: false, gstRegisteredFrom: null });
  });

  it("GSR1-GSR2: the new-organisation answer", () => {
    expect(gstChoiceValue("registered")).toBe(true);
    expect(gstChoiceValue("not_registered")).toBe(false);
    expect(gstChoiceValue("unsure")).toBe("unsure");
    expect(gstChoiceValue("")).toBe("unsure");
  });
});

describe("one answer for Settings, MCP and posting (GSR9)", () => {
  const settings = {
    displayName: "Kowhai Crafts",
    gstRegistered: true,
    gstRegisteredFrom: "2026-11-01",
    gstRegisteredUntil: null,
    gstRegistrationConfirmedAt: "2026-11-03T00:00:00Z",
    gstRegistrationConfirmedBy: "jess@example.com",
  };
  it("reports today's status, the dates and who confirmed it", () => {
    expect(gstRegistrationSummary(settings, "2026-10-31")).toMatchObject({ statusToday: "not_registered", confirmed: true, from: "2026-11-01" });
    expect(gstRegistrationSummary(settings, "2026-11-03")).toMatchObject({ statusToday: "registered", confirmedBy: "jess@example.com" });
    expect(gstRegistrationSummary({ ...settings, gstRegisteredFrom: null, gstRegistrationConfirmedAt: null, gstRegistrationConfirmedBy: null }, "2026-11-03")).toMatchObject({
      statusToday: "unconfirmed",
      confirmed: false,
      note: expect.stringMatching(/Don't choose GST codes/),
    });
    expect(gstRegistrationSummary({ ...settings, gstRegistered: false, gstRegisteredFrom: null, gstRegistrationConfirmedAt: null, gstRegistrationConfirmedBy: null }, "2026-11-03")).toMatchObject({
      statusToday: "not_registered",
      confirmed: false,
    });
  });
});
