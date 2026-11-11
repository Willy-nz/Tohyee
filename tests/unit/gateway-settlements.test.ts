import { describe, expect, it } from "vitest";
import { dec } from "@/lib/money/decimal";
import { gatewayWords, plausibleFee, settlementChoices } from "@/lib/sales-platforms/gateway-settlements";

/** GS1-GS3 in docs/ACCOUNTING-EXAMPLES.md (not yet reviewed). Made-up amounts. */
describe("gateway settlements", () => {
  it("GS1: a gateway is named by its id or the first word of its title", () => {
    expect(gatewayWords({ method: "afterpay", title: "Afterpay (New)" })).toEqual(["afterpay"]);
    expect(gatewayWords({ method: "paypal_express", title: null })).toEqual(["paypal"]);
    // Too short to tell apart from ordinary words: not used.
    expect(gatewayWords({ method: "zip", title: "Zip" })).toEqual([]);
  });

  it("GS3: a fee is more than nothing and at most 10% plus 1.00", () => {
    expect(plausibleFee(dec("46.00"), dec("42.94"))).toBe(true);
    expect(plausibleFee(dec("46.00"), dec("46.00"))).toBe(false);
    expect(plausibleFee(dec("46.00"), dec("40.40"))).toBe(true);
    expect(plausibleFee(dec("46.00"), dec("40.39"))).toBe(false);
    expect(plausibleFee(dec("46.00"), dec("47.00"))).toBe(false);
  });

  it("GS2: single payments first; pairs only when none fits on its own", () => {
    const payments = [
      { paymentId: "1", orderName: "#1", date: "2026-10-02", amount: "46.00" },
      { paymentId: "2", orderName: "#2", date: "2026-10-03", amount: "23.00" },
      { paymentId: "3", orderName: "#3", date: "2026-10-03", amount: "10.00" },
    ];
    expect(settlementChoices(dec("42.94"), payments)).toEqual([{ payments: [payments[0]], settled: "46.00", fee: "3.06" }]);
    expect(settlementChoices(dec("64.56"), payments)).toEqual([{ payments: [payments[0], payments[1]], settled: "69.00", fee: "4.44" }]);
    expect(settlementChoices(dec("200.00"), payments)).toEqual([]);
  });
});
