import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { allocateLandedCost, splitByWeight } from "@/lib/inventory/landed-cost";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { createItem, type Item } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { inventoryValuation, trialBalance } from "@/lib/reports/financial";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Landed cost across a bill (LDC1-LDC5, #259; not yet reviewed). Each test gets its own organisation. */
describeWithDatabase("landed cost across a bill", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("landed-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `landed-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const contact = async (name: string, extra: Record<string, unknown>): Promise<Contact> => (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const item = async (code: string): Promise<Item> =>
      (
        await as((tx) =>
          createItem(tx, { idempotencyKey: key("item"), code, name: code, itemType: "stock", incomeAccountCode: "4000", salesTaxCode: "GST", purchaseAccountCode: "1400", purchaseTaxCode: "GST", salePrice: "30.00", purchasePrice: "10.00" }),
        )
      ).item;
    const anvil = await item("ANVIL");
    const bolt = await item("BOLT");
    const draft = await as((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: paw.id,
        billDate: "2026-06-01",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: "PAW-1",
        amountsMode: "exclusive",
        lines: [
          { itemId: anvil.id, quantity: "10", unitPrice: "20.00" },
          { itemId: bolt.id, quantity: "30", unitPrice: "10.00" },
        ],
      }),
    );
    const bill = (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }))).bill;
    const sell = async (itemId: string, quantity: string) => {
      const invoice = await as((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId: kobe.id, invoiceDate: "2026-06-10", dueDate: "2026-07-20", amountsMode: "exclusive", lines: [{ itemId, quantity, unitPrice: "30.00" }] }),
      );
      await as((tx) => approveInvoice(tx, invoice.invoice.id, { idempotencyKey: key("a") }));
    };
    const allocate = (fields: Record<string, unknown>) =>
      as((tx) => allocateLandedCost(tx, { idempotencyKey: key("lc"), billId: bill.id, amount: undefined, offsetAccountCode: "5100", allocationDate: "2026-06-15", ...fields }));
    const stock = async () => Object.fromEntries((await as((tx) => inventoryValuation(tx))).items.map((row) => [row.itemCode, [row.quantity, row.value]]));
    const journal = async (journalId: string) => (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const ties = async () => {
      const report = await as((tx) => inventoryValuation(tx));
      const tb = await as((tx) => trialBalance(tx, { asAt: "2026-12-31" }));
      const row = tb.rows.find((entry) => entry.code === "1400")!;
      expect(toFixedString(sub(dec(row.debit), dec(row.credit)), 2)).toBe(report.totalValue);
    };
    return { as, bill, sell, allocate, stock, journal, ties };
  }

  it("LDC1: by value, all on hand: Dr 1400, Cr 5100; average cost goes up", async () => {
    const w = await setup();
    const result = await w.allocate({ amount: "50.00" });
    expect(result.allocation.method).toBe("value");
    expect(result.allocation.lines.map((line) => [line.itemCode, line.share, line.toStock, line.toCostOfSales])).toEqual([
      ["ANVIL", "20.00", "20.00", "0.00"],
      ["BOLT", "30.00", "30.00", "0.00"],
    ]);
    expect(result.allocation.costOfSalesJournalId).toBeNull();
    expect(await w.stock()).toEqual({ ANVIL: ["10", "220.00"], BOLT: ["30", "330.00"] });
    await w.ties();
    // The same request again changes nothing.
    const again = await w.as((tx) => allocateLandedCost(tx, { idempotencyKey: "same-key-1", billId: w.bill.id, amount: "1.00", offsetAccountCode: "5100", allocationDate: "2026-06-15" }));
    const repeat = await w.as((tx) => allocateLandedCost(tx, { idempotencyKey: "same-key-1", billId: w.bill.id, amount: "1.00", offsetAccountCode: "5100", allocationDate: "2026-06-15" }));
    expect(repeat.created).toBe(false);
    expect(repeat.allocation.id).toBe(again.allocation.id);
  });

  it("LDC2: by quantity", async () => {
    const w = await setup();
    const result = await w.allocate({ amount: "50.00", method: "quantity" });
    expect(result.allocation.lines.map((line) => [line.itemCode, line.share])).toEqual([
      ["ANVIL", "12.50"],
      ["BOLT", "37.50"],
    ]);
  });

  it("LDC3: the share for stock already sold goes to cost of sales", async () => {
    const w = await setup();
    await w.sell((await w.as((tx) => tx.query<{ id: string }>("select id::text from items where code = 'BOLT'"))).rows[0].id, "12");
    const result = await w.allocate({ amount: "50.00" });
    expect(result.allocation.lines.map((line) => [line.itemCode, line.share, line.toStock, line.toCostOfSales])).toEqual([
      ["ANVIL", "20.00", "20.00", "0.00"],
      ["BOLT", "30.00", "18.00", "12.00"],
    ]);
    expect(await w.journal(result.allocation.costOfSalesJournalId!)).toEqual([
      ["5000", "12.00", "0.00"],
      ["5100", "0.00", "12.00"],
    ]);
    expect(await w.stock()).toEqual({ ANVIL: ["10", "220.00"], BOLT: ["18", "198.00"] });
    await w.ties();
  });

  it("LDC4: shares add up to the cent, the leftover to the largest (first of equals)", () => {
    const parts = splitByWeight(dec("100.00"), [dec("10"), dec("10"), dec("10")], 2).map((part) => toFixedString(part, 2));
    expect(parts).toEqual(["33.34", "33.33", "33.33"]);
    expect(splitByWeight(dec("0.05"), [dec("1"), dec("3")], 2).map((part) => toFixedString(part, 2))).toEqual(["0.01", "0.04"]);
  });

  it("LDC6: stock received in a locked period: the cost posts on an open date; the locked period isn't touched", async () => {
    const w = await setup();
    await w.sell((await w.as((tx) => tx.query<{ id: string }>("select id::text from items where code = 'BOLT'"))).rows[0].id, "12");
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-06-30", reason: "June closed" }));
    await expect(w.allocate({ amount: "50.00", allocationDate: "2026-06-20" })).rejects.toThrow(/lock/i);
    const result = await w.allocate({ amount: "50.00", allocationDate: "2026-07-01" });
    expect(result.allocation.lines.map((line) => [line.itemCode, line.toStock, line.toCostOfSales])).toEqual([
      ["ANVIL", "20.00", "0.00"],
      ["BOLT", "18.00", "12.00"],
    ]);
    const cogs = await w.as((tx) => getJournal(tx, result.allocation.costOfSalesJournalId!));
    expect(cogs.postingDate).toBe("2026-07-01");
    const dates = await w.as((tx) =>
      tx.query<{ posting_date: string }>("select distinct posting_date::text from ledger_journals where posting_date <= '2026-06-30' and created_at > now() - interval '1 minute' and origin = 'inventory' and reference like 'Landed cost%'"),
    );
    expect(dates.rows).toEqual([]);
  });

  it("LDC5: refused for a draft bill, a bank or system account, or a backdated date", async () => {
    const w = await setup();
    await expect(w.allocate({ amount: "50.00", offsetAccountCode: "1000" })).rejects.toThrow(/coded to on its bill/);
    await expect(w.allocate({ amount: "50.00", offsetAccountCode: "2000" })).rejects.toThrow(/coded to on its bill/);
    await expect(w.allocate({ amount: "50.00", allocationDate: "2026-05-01" })).rejects.toThrow(/Backdated stock movements/);
    const draft = await w.as(async (tx) => {
      const contact = (await tx.query<{ id: string }>("select id::text from contacts where name = 'Paw Supplies'")).rows[0].id;
      return createBill(tx, { idempotencyKey: key("bill"), contactId: contact, billDate: "2026-06-01", dueDate: "2026-07-20", supplierInvoiceNumber: "PAW-2", amountsMode: "exclusive", lines: [{ description: "Rope", quantity: "1", unitPrice: "5.00", accountCode: "6070", taxCode: "GST" }] });
    });
    await expect(w.as((tx) => allocateLandedCost(tx, { idempotencyKey: key("lc"), billId: draft.bill.id, amount: "5.00", offsetAccountCode: "5100" }))).rejects.toThrow(/approved bill/);
  });
});
