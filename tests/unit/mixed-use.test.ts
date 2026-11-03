import { describe, expect, it } from "vitest";
import { claimsGst, decisionRefusal, decisionsFor, lineParts, personGstRefusal, refundLeft, refundRefusal } from "@/lib/bank/mixed-use-rules";
import { reviewBatchActions } from "@/lib/bank/mixed-use";

describe("Mixed-use account rules (#545)", () => {
  it("MU7: money out is business, split or private; money in only a refund or private", () => {
    expect(decisionsFor("-46.00")).toEqual(["business", "split", "private"]);
    expect(decisionsFor("500.00")).toEqual(["refund", "private"]);
    expect(decisionRefusal("business", "500.00")).toMatch(/only be a refund/);
    expect(decisionRefusal("refund", "-46.00")).toMatch(/Money out/);
    expect(decisionRefusal("private", "500.00")).toBeNull();
  });

  it("MU2-MU4: the business and private parts", () => {
    expect(lineParts("business", "-46.00", null)).toEqual({ business: "46.00", private: "0.00" });
    expect(lineParts("private", "-120.00", null)).toEqual({ business: "0.00", private: "120.00" });
    expect(lineParts("split", "-230.00", "80.50")).toEqual({ business: "80.50", private: "149.50" });
    expect(() => lineParts("split", "-230.00", "230.00")).toThrow(/less than the line/);
    expect(() => lineParts("split", "-230.00", "0")).toThrow(/more than 0.00/);
    expect(lineParts("refund", "230.00", "80.50")).toEqual({ business: "80.50", private: "149.50" });
    expect(() => lineParts("refund", "20.00", "23.00")).toThrow(/can't be more than the line/);
  });

  it("MU5: a person claims GST only with the receipt; out of scope and not registered need none", () => {
    expect(claimsGst([null, "out_of_scope"])).toBe(false);
    expect(claimsGst(["standard"])).toBe(true);
    expect(personGstRefusal("registered", true, false)).toMatch(/receipt or tax invoice/);
    expect(personGstRefusal("unconfirmed", true, false)).toMatch(/receipt/);
    expect(personGstRefusal("registered", true, true)).toBeNull();
    expect(personGstRefusal("registered", false, false)).toBeNull();
    expect(personGstRefusal("not_registered", true, false)).toBeNull();
  });

  it("MU8: a refund uses the original's accounts and tax codes, up to what's left", () => {
    const original = [{ accountCode: "6120", taxCode: "GST", amount: "46.00" }];
    expect(refundRefusal(original, [], [{ accountCode: "6120", taxCode: "GST", amount: "23.00" }])).toBeNull();
    expect(refundRefusal(original, [], [{ accountCode: "6120", taxCode: null, amount: "23.00" }])).toMatch(/wasn't on it/);
    expect(refundRefusal(original, [{ accountCode: "6120", taxCode: "GST", amount: "23.00" }], [{ accountCode: "6120", taxCode: "GST", amount: "23.01" }])).toMatch(/23.00/);
    expect(refundLeft("46.00", ["23.00", "23.00"])).toBe("0.00");
  });

  it("MU14: batch actions get the batch key per line; a bad or repeated one is refused on its own", () => {
    const actions = reviewBatchActions([{ lineId: "5", decision: "private" }, { lineId: "5", decision: "private" }, { lineId: "6", decision: "maybe" }], "k-12345678", true);
    expect(actions[0]).toMatchObject({ action: "private", targetId: "5", idempotencyKey: "k-12345678:5", payload: { byAi: true } });
    expect(actions[1].refused).toMatch(/already in this call/);
    expect(actions[2].refused).toMatch(/decision/);
  });
});
