import { describe, expect, it } from "vitest";
import { applyMovement, type Balance, type CostingInput } from "@/lib/inventory/costing";

/** Applies movements in order, returning each result. Money in cents (NZD). */
function run(movements: CostingInput[], start: Balance = { quantity: "0", value: "0" }) {
  let balance = start;
  return movements.map((movement) => {
    const result = applyMovement(balance, movement, 2);
    balance = { quantity: result.quantityAfter, value: result.valueAfter };
    return result;
  });
}

describe("weighted average costing (worked examples)", () => {
  it("W1: receive 3 @ $3.33, sell 1 -> cost of sale $3.33, 2 left worth $6.66", () => {
    const [, sale] = run([
      { type: "receipt", quantity: "3", unitCost: "3.33" },
      { type: "issue", quantity: "1" },
    ]);
    expect(sale.valueDelta).toBe("-3.33");
    expect(sale.quantityAfter).toBe("2");
    expect(sale.valueAfter).toBe("6.66");
  });

  it("W2: receive 999 @ $2.57, sell 1 -> cost of sale $2.57 (not $257)", () => {
    const [receipt, sale] = run([
      { type: "receipt", quantity: "999", unitCost: "2.57" },
      { type: "issue", quantity: "1" },
    ]);
    expect(receipt.valueDelta).toBe("2567.43");
    expect(sale.valueDelta).toBe("-2.57");
    expect(sale.valueAfter).toBe("2564.86");
  });

  it("W3: $10.00 for 3 units sold 1, 1, 1 -> $3.33, $3.34, $3.33 and nothing left over", () => {
    const results = run([
      { type: "receipt", quantity: "1", unitCost: "3" },
      { type: "receipt", quantity: "1", unitCost: "3" },
      { type: "receipt", quantity: "1", unitCost: "4" },
      { type: "issue", quantity: "1" },
      { type: "issue", quantity: "1" },
      { type: "issue", quantity: "1" },
    ]);
    // $6.67 left for 2 units averages $3.335, which rounds half up to $3.34.
    expect(results.slice(3).map((result) => result.valueDelta)).toEqual(["-3.33", "-3.34", "-3.33"]);
    expect(results[5].quantityAfter).toBe("0");
    expect(results[5].valueAfter).toBe("0");
  });

  it("W4: $10.00 for 3 units sold 1 then 2 -> $3.33 then the remaining $6.67", () => {
    const results = run([
      { type: "receipt", quantity: "3", unitCost: "3.333333" },
      { type: "issue", quantity: "1" },
      { type: "issue", quantity: "2" },
    ]);
    expect(results[0].valueDelta).toBe("10"); // 3 x 3.333333 = 9.999999 -> $10.00
    expect(results[1].valueDelta).toBe("-3.33");
    expect(results[2].valueDelta).toBe("-6.67");
    expect(results[2].valueAfter).toBe("0");
  });

  it("W5: weighted average across two receipts", () => {
    // 10 @ $5 + 10 @ $7 = $120 for 20 -> $6 each; sell 5 -> $30
    const results = run([
      { type: "receipt", quantity: "10", unitCost: "5" },
      { type: "receipt", quantity: "10", unitCost: "7" },
      { type: "issue", quantity: "5" },
    ]);
    expect(results[2].valueDelta).toBe("-30");
    expect(results[2].unitCost).toBe("6");
    expect(results[2].valueAfter).toBe("90");
  });

  it("W6: fractional quantities (kg) are costed exactly", () => {
    const results = run([
      { type: "receipt", quantity: "2.5", unitCost: "4" },
      { type: "issue", quantity: "0.75" },
    ]);
    expect(results[1].valueDelta).toBe("-3");
    expect(results[1].quantityAfter).toBe("1.75");
  });

  it("W7: selling more than is on hand is refused (no negative stock)", () => {
    expect(() =>
      run([
        { type: "receipt", quantity: "2", unitCost: "5" },
        { type: "issue", quantity: "3" },
      ]),
    ).toThrow(/Stock can't go negative/);
    expect(() => run([{ type: "issue", quantity: "1" }])).toThrow(/no stock on hand/);
  });

  it("W8: customer return restocks at the original sale's cost, even after the average moved", () => {
    const start = run([
      { type: "receipt", quantity: "10", unitCost: "5" },
      { type: "issue", quantity: "4" }, // $20 out at $5
      { type: "receipt", quantity: "6", unitCost: "8" }, // average now moves
    ]);
    const balance = { quantity: start[2].quantityAfter, value: start[2].valueAfter };
    const back = applyMovement(
      balance,
      {
        type: "customer_return",
        quantity: "1",
        original: { quantity: "4", value: "20", returnedQuantity: "0", returnedValue: "0" },
      },
      2,
    );
    expect(back.valueDelta).toBe("5");
  });

  it("W9: partial returns add back exactly what the sale took out", () => {
    // Sale took 3 units for $10.00. Return 1, then the other 2.
    const original = { quantity: "3", value: "10", returnedQuantity: "0", returnedValue: "0" };
    const balance = { quantity: "5", value: "20" };
    const first = applyMovement(balance, { type: "customer_return", quantity: "1", original }, 2);
    expect(first.valueDelta).toBe("3.33");
    const second = applyMovement(
      { quantity: first.quantityAfter, value: first.valueAfter },
      {
        type: "customer_return",
        quantity: "2",
        original: { ...original, returnedQuantity: "1", returnedValue: "3.33" },
      },
      2,
    );
    expect(second.valueDelta).toBe("6.67");
    expect(() =>
      applyMovement(
        { quantity: second.quantityAfter, value: second.valueAfter },
        {
          type: "customer_return",
          quantity: "1",
          original: { ...original, returnedQuantity: "3", returnedValue: "10" },
        },
        2,
      ),
    ).toThrow(/can still be returned/);
  });

  it("W10: landed cost is added to the stock on hand", () => {
    const results = run([
      { type: "receipt", quantity: "4", unitCost: "10" },
      { type: "landed_cost", amount: "6" },
      { type: "issue", quantity: "1" },
    ]);
    expect(results[1].valueAfter).toBe("46");
    expect(results[2].valueDelta).toBe("-11.5");
  });

  it("W11: stocktake adjustments: down at average, up at a given cost", () => {
    const results = run([
      { type: "receipt", quantity: "3", unitCost: "10" },
      { type: "adjustment", quantityDelta: "-1" },
      { type: "adjustment", quantityDelta: "2", unitCost: "4" },
    ]);
    expect(results[1].valueDelta).toBe("-10");
    expect(results[2].valueDelta).toBe("8");
    expect(results[2].valueAfter).toBe("28");
  });

  it("W12: refuses movements whose value rounds to zero", () => {
    expect(() => run([{ type: "receipt", quantity: "0.001", unitCost: "1" }])).toThrow(/rounds to zero/);
  });
});

describe("negative stock and receipts at a value (ST10, ST11)", () => {
  const allow = { allowNegative: true };

  it("ST10: selling below zero at the average, then a receipt fills the shortfall and tops up cost of sales", () => {
    const sale = applyMovement({ quantity: "2", value: "10" }, { type: "issue", quantity: "3" }, 2, allow);
    expect(sale).toMatchObject({ valueDelta: "-15", quantityAfter: "-1", valueAfter: "-5", costAdjustment: "0" });
    const bill = applyMovement({ quantity: "-1", value: "-5" }, { type: "receipt", quantity: "4", value: "24" }, 2, allow);
    expect(bill).toMatchObject({ valueDelta: "23", costAdjustment: "1", quantityAfter: "3", valueAfter: "18" });
    // Exactly filling the shortfall.
    expect(applyMovement({ quantity: "-1", value: "-5" }, { type: "receipt", quantity: "1", value: "6" }, 2, allow)).toMatchObject({
      valueDelta: "5",
      costAdjustment: "1",
      quantityAfter: "0",
      valueAfter: "0",
    });
    // Filling only part of it: the value moves by the issued value of the units filled.
    expect(applyMovement({ quantity: "-3", value: "-15" }, { type: "receipt", quantity: "1", value: "6" }, 2, allow)).toMatchObject({
      valueDelta: "5",
      costAdjustment: "1",
      quantityAfter: "-2",
      valueAfter: "-10",
    });
    // Without the setting it's refused (W7, ST9).
    expect(() => applyMovement({ quantity: "2", value: "10" }, { type: "issue", quantity: "3" }, 2)).toThrow(/Stock can't go negative/);
  });

  it("ST11: nothing on hand is costed at the fallback cost; with none it's refused", () => {
    expect(
      applyMovement({ quantity: "0", value: "0" }, { type: "issue", quantity: "2" }, 2, { allowNegative: true, fallbackUnitCost: "4" }),
    ).toMatchObject({ valueDelta: "-8", quantityAfter: "-2", valueAfter: "-8" });
    expect(() => applyMovement({ quantity: "0", value: "0" }, { type: "issue", quantity: "2" }, 2, { allowNegative: true, fallbackUnitCost: null })).toThrow(
      /no cost to use for it/,
    );
  });

  it("ST1, ST4: a receipt at a line's value, and an exact reversal", () => {
    const receipt = applyMovement({ quantity: "0", value: "0" }, { type: "receipt", quantity: "3", value: "10" }, 2);
    expect(receipt).toMatchObject({ valueDelta: "10", unitCost: "3.333333", quantityAfter: "3", valueAfter: "10" });
    const undo = applyMovement({ quantity: "3", value: "10" }, { type: "reversal", quantityDelta: "3", valueDelta: "10", costAdjustment: "0" }, 2);
    expect(undo).toMatchObject({ quantityAfter: "0", valueAfter: "0" });
  });
});
