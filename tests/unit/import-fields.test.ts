import { describe, expect, it } from "vitest";
import { applyMapping, autoMap, findHeaderRow, headingsOf, missingRequired, normaliseHeading } from "@/lib/import/fields";
import { accountType, itemType, money } from "@/lib/import/values";

/** Column matching for imports (examples IM2-IM5, IM16): pure, no database. */
describe("import column matching", () => {
  it("compares headings ignoring case, spaces, * and punctuation", () => {
    expect(normaliseHeading("*ContactName")).toBe(normaliseHeading("Contact name"));
    expect(normaliseHeading("Debit - Year to date")).toBe("debityeartodate");
  });

  it("IM4: another system's contact export maps name, email and the address parts", () => {
    const headings = ["*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POCity", "POPostalCode", "SAAddressLine1", "TaxNumber"];
    const columns = autoMap("contacts", headings, "other_system");
    expect(columns).toEqual({
      name: ["*ContactName"],
      email: ["EmailAddress"],
      postalAddress: ["POAddressLine1", "POAddressLine2", "POCity", "POPostalCode"],
      deliveryAddress: ["SAAddressLine1"],
      gstNumber: ["TaxNumber"],
    });
    const records = applyMapping(
      [headings, ["Kobe Ltd", "a@kobe.co.nz", "1 Queen Street", "", "Auckland", "1010", "", "123456789"], ["", "", "", "", "", "", "", ""]],
      0,
      columns,
    );
    expect(records).toEqual([
      {
        row: 2,
        values: {
          name: "Kobe Ltd",
          email: "a@kobe.co.nz",
          postalAddress: "1 Queen Street\nAuckland\n1010",
          deliveryAddress: "",
          gstNumber: "123456789",
        },
      },
    ]);
  });

  it("IM16: Tohyee's own export headings map back to the same fields", () => {
    expect(autoMap("accounts", ["Code", "Name", "Type", "GST code", "Description"], "tohyee")).toEqual({
      code: ["Code"],
      name: ["Name"],
      type: ["Type"],
      gstCode: ["GST code"],
      description: ["Description"],
    });
    expect(autoMap("contacts", ["Name", "Customer (yes/no)", "Supplier (yes/no)", "Billing (postal) address"], "tohyee")).toEqual({
      name: ["Name"],
      isCustomer: ["Customer (yes/no)"],
      isSupplier: ["Supplier (yes/no)"],
      postalAddress: ["Billing (postal) address"],
    });
  });

  it("finds the headings under a report's title rows, and names blank or repeated ones", () => {
    const rows = [["Trial Balance"], ["Tui Traders Ltd"], ["As at 31 March 2026"], [], ["Account Code", "Account", "Debit", "Credit"], ["1000", "Bank", "10.00", ""]];
    expect(findHeaderRow("trial_balance", rows)).toBe(4);
    expect(headingsOf([["Amount", "", "Amount"]], 0)).toEqual(["Amount", "Column 2", "Amount (2)"]);
    expect(missingRequired("open_invoices", { number: ["No"], contact: ["Customer"] }).map((field) => field.key)).toEqual(["date", "dueDate", "amount"]);
  });

  it("IM2: account types and item types from either system's names", () => {
    expect(accountType("Overhead")).toBe("expense");
    expect(accountType("Current Asset")).toBe("current_asset");
    expect(accountType("current_liability")).toBe("current_liability");
    expect(accountType("Sales")).toBe("revenue");
    expect(() => accountType("Wibble")).toThrow('Type "Wibble" isn\'t one Tohyee knows.');
    expect(itemType("Stock (tracked)")).toBe("stock");
    expect(itemType("Non-stock")).toBe("non_stock");
  });

  it("reads amounts, including Excel's binary fractions", () => {
    expect(money("1,725.00", "Debit")).toBe("1725.00");
    expect(money("(460.00)", "Debit")).toBe("-460.00");
    expect(money("1725.0999999999999", "Debit")).toBe("1725.10");
    expect(money("", "Debit")).toBeNull();
    expect(() => money("1.005", "Debit")).toThrow("Debit: \"1.005\" has more than 2 decimal places.");
  });
});
