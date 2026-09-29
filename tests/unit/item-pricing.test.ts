import { describe, expect, it } from "vitest";
import { baseQuantity, type ItemForLines, levelPrice, lineDefaults, unitPriceFor } from "@/lib/items/pricing";

/** Examples IT4-IT6 in docs/ACCOUNTING-EXAMPLES.md ("Products and services"), the pure maths. */
describe("item prices and units (IT4-IT6)", () => {
  const wholesale = { id: "1", markupPercent: "-10" };
  const tradePlus = { id: "2", markupPercent: "5" };

  it("IT4: a level's price is the base sale price adjusted by its percent, rounded once to cents", () => {
    expect(levelPrice("12", wholesale, null, 2)).toBe("10.80");
    expect(levelPrice("12", tradePlus, null, 2)).toBe("12.60");
    // 9.99 x 0.9 = 8.991 -> 8.99; 9.99 x 1.05 = 10.4895 -> 10.49.
    expect(levelPrice("9.99", wholesale, null, 2)).toBe("8.99");
    expect(levelPrice("9.99", tradePlus, null, 2)).toBe("10.49");
    // Half away from zero: 0.05 x 0.9 = 0.045 -> 0.05; 3.3333 x 0.85 = 2.833305 -> 2.83.
    expect(levelPrice("0.05", wholesale, null, 2)).toBe("0.05");
    expect(levelPrice("3.3333", { markupPercent: "-15" }, null, 2)).toBe("2.83");
    // A price set for the level wins, as typed.
    expect(levelPrice("12", wholesale, "10", 2)).toBe("10");
    // No level: the base price as it is; no base price and no override: nothing.
    expect(levelPrice("12.5", null, null, 2)).toBe("12.5");
    expect(levelPrice(null, wholesale, null, 2)).toBeNull();
  });

  it("IT5: base quantities are exact; a unit's price is the base price times its size", () => {
    expect(baseQuantity("2", "12")).toBe("24");
    expect(baseQuantity("3", "2.5")).toBe("7.5");
    expect(baseQuantity("0.3333", "3")).toBe("0.9999");
    expect(baseQuantity("5", null)).toBe("5");
    expect(unitPriceFor("3.5", "12")).toBe("42");
    expect(unitPriceFor("1.2345", "2.5")).toBe("3.0863");
    expect(unitPriceFor("3.5", null)).toBe("3.5");
  });

  const widget: ItemForLines = {
    id: "10",
    code: "WIDGET",
    name: "Widget",
    description: null,
    itemType: "stock",
    salePrice: "12",
    purchasePrice: "5",
    incomeAccountCode: "4000",
    purchaseAccountCode: "1400",
    salesTaxCode: "GST",
    purchaseTaxCode: "GST",
    levelPrices: [{ priceLevelId: "1", price: "10" }],
    suppliers: [
      { contactId: "7", price: "4.8" },
      { contactId: "8", price: null },
    ],
  };

  it("IT2, IT4: a sales line takes the name, income account, sales tax code and the level's price", () => {
    expect(lineDefaults(widget, { side: "sale", scale: 2, unitFactor: null })).toEqual({
      description: "Widget",
      unitPrice: "12",
      accountCode: "4000",
      taxCode: "GST",
    });
    expect(lineDefaults(widget, { side: "sale", scale: 2, unitFactor: null, priceLevel: wholesale }).unitPrice).toBe("10");
    expect(lineDefaults(widget, { side: "sale", scale: 2, unitFactor: null, priceLevel: tradePlus }).unitPrice).toBe("12.6");
  });

  it("IT6: a purchase line takes the supplier's price, else the item's purchase price", () => {
    expect(lineDefaults(widget, { side: "purchase", scale: 2, unitFactor: null, supplierId: "7" })).toEqual({
      description: "Widget",
      unitPrice: "4.8",
      accountCode: "1400",
      taxCode: "GST",
    });
    expect(lineDefaults(widget, { side: "purchase", scale: 2, unitFactor: null, supplierId: "8" }).unitPrice).toBe("5");
    expect(lineDefaults(widget, { side: "purchase", scale: 2, unitFactor: null, supplierId: "9" }).unitPrice).toBe("5");
    expect(lineDefaults(widget, { side: "purchase", scale: 2, unitFactor: "12", supplierId: "7" }).unitPrice).toBe("57.6");
  });
});
