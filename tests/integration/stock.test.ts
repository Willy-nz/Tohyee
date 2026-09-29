import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote, voidCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { postMovement } from "@/lib/inventory/movements";
import { approveInvoice, createInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { addItemUnit, createItem, type Item } from "@/lib/items/service";
import { getJournal, postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { inventoryValuation, trialBalance } from "@/lib/reports/financial";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { dec, sub, toFixedString } from "@/lib/money/decimal";
import { createTaxCode } from "@/lib/tax/codes";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/** Examples ST1-ST12 in docs/ACCOUNTING-EXAMPLES.md ("Stock tracking"). Each test gets its own organisation. */
describeWithDatabase("stock tracking", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("stock-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { locations?: boolean; negative?: boolean } = {}) {
    organisations += 1;
    const org = `stock-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const loc: Record<string, string> = {};
    let locationCategory = "";
    if (options.locations) {
      await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
      locationCategory = (await as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "location")!.id;
      for (const name of ["Dunedin", "Auckland"]) {
        const setup = await as((tx) => createTrackingValue(tx, { categoryId: locationCategory, name }));
        loc[name] = setup.categories.find((c) => c.id === locationCategory)!.values.find((v) => v.name === name)!.id;
      }
    } else {
      await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    }
    if (options.negative) await as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: true }));
    const at = (name?: string) => (name ? { [locationCategory]: loc[name] } : {});
    const contact = async (name: string, extra: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const item = async (fields: Record<string, unknown>): Promise<Item> =>
      (await as((tx) => createItem(tx, { idempotencyKey: key("item"), incomeAccountCode: "4000", salesTaxCode: "GST", purchaseAccountCode: "1400", purchaseTaxCode: "GST", ...fields }))).item;
    const widget = await item({ code: "WIDGET", name: "Widget", itemType: "stock", salePrice: "12.00", purchasePrice: "5.00" });
    const stockLine = (itemId: string, quantity: string, unitPrice: string, where?: string, extra: Record<string, unknown> = {}) => ({
      itemId,
      quantity,
      unitPrice,
      tracking: at(where),
      ...extra,
    });
    const bill = async (lines: unknown[], billDate = "2026-06-01") => {
      const draft = await as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId: paw.id, billDate, dueDate: "2026-07-20", supplierInvoiceNumber: key("S"), amountsMode: "exclusive", lines }),
      );
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }))).bill;
    };
    const draftInvoice = async (lines: unknown[], invoiceDate = "2026-06-10") =>
      (await as((tx) => createInvoice(tx, { idempotencyKey: key("inv"), contactId: kobe.id, invoiceDate, dueDate: "2026-07-20", amountsMode: "exclusive", lines }))).invoice;
    const invoice = async (lines: unknown[], invoiceDate = "2026-06-10") => {
      const draft = await draftInvoice(lines, invoiceDate);
      return (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice;
    };
    const journal = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    const stock = async () => {
      const report = await as((tx) => inventoryValuation(tx));
      return Object.fromEntries(report.items.map((row) => [`${row.itemCode}${row.locationName ? `@${row.locationName}` : ""}`, [row.quantity, row.value]]));
    };
    /** Stock always equals account 1400 to the cent, on the stock report and the trial balance. */
    const assertTies = async () => {
      const report = await as((tx) => inventoryValuation(tx));
      const tb = await as((tx) => trialBalance(tx, { asAt: "2026-12-31" }));
      const row = tb.rows.find((entry) => entry.code === "1400");
      const ledger = row ? toFixedString(sub(dec(row.debit), dec(row.credit)), 2) : "0.00";
      expect(report.inventoryAccountBalance).toBe(report.totalValue);
      expect(ledger).toBe(report.totalValue);
    };
    return { org, as, loc, at, paw, kobe, item, widget, stockLine, bill, draftInvoice, invoice, journal, stock, assertTies };
  }

  it("ST1, ST2, ST4: buying and selling stock post to 1400 and 5000; voiding puts it back exactly", async () => {
    const w = await setup({ locations: true });
    const bought = await w.bill([w.stockLine(w.widget.id, "10", "5.00", "Dunedin")]);
    expect(await w.journal(bought.approvalJournalId!)).toEqual([
      ["1400", "50.00", "0.00"],
      ["2100", "7.50", "0.00"],
      ["2000", "0.00", "57.50"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["10", "50.00"] });

    const sold = await w.invoice([w.stockLine(w.widget.id, "4", "12.00", "Dunedin")]);
    const journal = await w.as((tx) => getJournal(tx, sold.approvalJournalId!));
    expect(journal.postingDate).toBe("2026-06-10");
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1100", "55.20", "0.00"],
      ["4000", "0.00", "48.00"],
      ["2100", "0.00", "7.20"],
      ["5000", "20.00", "0.00"],
      ["1400", "0.00", "20.00"],
    ]);
    // Cost of sales is tagged like the line; inventory isn't.
    expect(journal.lines[3].tracking).toEqual(w.at("Dunedin"));
    expect(journal.lines[4].tracking).toEqual({});
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["6", "30.00"] });
    await w.assertTies();

    // ST4: void on a later date.
    const voided = (await w.as((tx) => voidInvoice(tx, sold.id, { idempotencyKey: key("v"), voidDate: "2026-06-12" }))).invoice;
    const reversal = await w.as((tx) => getJournal(tx, voided.voidJournalId!));
    expect(reversal.postingDate).toBe("2026-06-12");
    expect(reversal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1100", "0.00", "55.20"],
      ["4000", "48.00", "0.00"],
      ["2100", "7.20", "0.00"],
      ["5000", "0.00", "20.00"],
      ["1400", "20.00", "0.00"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["10", "50.00"] });
    await w.assertTies();
    // The bill's stock has moved since (the invoice and its void), so voiding the bill is refused.
    await expect(w.as((tx) => voidBill(tx, bought.id, { idempotencyKey: key("v"), voidDate: "2026-06-12" }))).rejects.toThrow("has moved since");
  });

  it("ST1: stock lines go to 1400 and only stock goes there", async () => {
    const w = await setup();
    const service = await w.item({ code: "ENGRAVE", name: "Engraving", itemType: "service", salePrice: "25", purchaseAccountCode: "6070" });
    await expect(w.bill([w.stockLine(w.widget.id, "1", "5", undefined, { accountCode: "5100", description: "Widget", taxCode: "GST" })])).rejects.toThrow(
      "is a stock item, so it goes to the inventory account",
    );
    await expect(w.bill([{ description: "Shelf", quantity: "1", unitPrice: "10", accountCode: "1400", taxCode: "GST" }])).rejects.toThrow(
      "which only stock items go to",
    );
    await expect(w.bill([{ itemId: service.id, quantity: "1", unitPrice: "10", accountCode: "1400", taxCode: "GST" }])).rejects.toThrow("which only stock items go to");
    await expect(
      w.as((tx) =>
        postJournal(tx, {
          idempotencyKey: key("j"),
          postingDate: "2026-06-01",
          reference: "X",
          lines: [
            { accountCode: "1400", debitAmount: "5" },
            { accountCode: "3000", creditAmount: "5" },
          ],
        }),
      ),
    ).rejects.toThrow("only moves with stock");
    // A bill that's voided while nothing else has moved puts the stock back out exactly.
    const bought = await w.bill([w.stockLine(w.widget.id, "3", "3.33")]);
    await w.as((tx) => voidBill(tx, bought.id, { idempotencyKey: key("v"), voidDate: "2026-06-02" }));
    expect(await w.stock()).toEqual({});
    await w.assertTies();
  });

  it("ST3: weighted average is per location; stock lines need a location once locations exist", async () => {
    const w = await setup({ locations: true });
    await w.bill([w.stockLine(w.widget.id, "10", "5.00", "Dunedin"), w.stockLine(w.widget.id, "10", "7.00", "Auckland")]);
    const sold = await w.invoice([w.stockLine(w.widget.id, "1", "12.00", "Auckland")]);
    expect((await w.journal(sold.approvalJournalId!)).slice(3)).toEqual([
      ["5000", "7.00", "0.00"],
      ["1400", "0.00", "7.00"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["9", "63.00"], "WIDGET@Dunedin": ["10", "50.00"] });
    const noPlace = await w.draftInvoice([w.stockLine(w.widget.id, "1", "12.00")]);
    await expect(w.as((tx) => approveInvoice(tx, noPlace.id, { idempotencyKey: key("a") }))).rejects.toThrow("needs a Location");
    expect((await w.as((tx) => getInvoice(tx, noPlace.id))).status).toBe("draft");
    await w.assertTies();
  });

  it("ST5: a credit note restocks at the original sale's cost; supplier returns at the average", async () => {
    const w = await setup({ locations: true });
    await w.bill([w.stockLine(w.widget.id, "10", "5.00", "Dunedin")]);
    const sold = await w.invoice([w.stockLine(w.widget.id, "4", "12.00", "Dunedin")]);
    await w.bill([w.stockLine(w.widget.id, "6", "8.00", "Dunedin")], "2026-06-11");
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["12", "78.00"] });

    const lines = [w.stockLine(w.widget.id, "1", "12.00", "Dunedin")];
    const missing = await w.as((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: w.kobe.id, creditNoteDate: "2026-06-15", amountsMode: "exclusive", lines }),
    );
    await expect(w.as((tx) => approveCreditNote(tx, missing.creditNote.id, { idempotencyKey: key("a") }))).rejects.toThrow("needs the invoice it was sold on");
    const draft = await w.as((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: w.kobe.id, creditNoteDate: "2026-06-15", amountsMode: "exclusive", lines, returnInvoiceId: sold.id }),
    );
    const credit = (await w.as((tx) => approveCreditNote(tx, draft.creditNote.id, { idempotencyKey: key("a") }))).creditNote;
    expect(credit.returnInvoiceId).toBe(sold.id);
    expect(await w.journal(credit.approvalJournalId!)).toEqual([
      ["4000", "12.00", "0.00"],
      ["2100", "1.80", "0.00"],
      ["1100", "0.00", "13.80"],
      ["1400", "5.00", "0.00"],
      ["5000", "0.00", "5.00"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["13", "83.00"] });
    // Returning more than was sold is refused (W9).
    const tooMany = await w.as((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: w.kobe.id,
        creditNoteDate: "2026-06-15",
        amountsMode: "exclusive",
        lines: [w.stockLine(w.widget.id, "4", "12.00", "Dunedin")],
        returnInvoiceId: sold.id,
      }),
    );
    await expect(w.as((tx) => approveCreditNote(tx, tooMany.creditNote.id, { idempotencyKey: key("a") }))).rejects.toThrow("3 of WIDGET at Dunedin can still be returned");
    // The invoice can't be voided while stock from it has been returned.
    await expect(w.as((tx) => voidInvoice(tx, sold.id, { idempotencyKey: key("v"), voidDate: "2026-06-15" }))).rejects.toThrow("Void that credit note first");
    // Voiding the credit note takes the returned unit back out at exactly 5.00.
    await w.as((tx) => voidCreditNote(tx, credit.id, { idempotencyKey: key("v"), voidDate: "2026-06-15" }));
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["12", "78.00"] });

    // Supplier credit note: 2 back to Paw at the average (78.00 / 12 = 6.50), credited at 8.00 each.
    const scn = await w.as((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: w.paw.id,
        creditNoteDate: "2026-06-16",
        supplierCreditNoteNumber: "CR-1",
        amountsMode: "exclusive",
        lines: [w.stockLine(w.widget.id, "2", "8.00", "Dunedin")],
      }),
    );
    const returned = (await w.as((tx) => approveSupplierCreditNote(tx, scn.creditNote.id, { idempotencyKey: key("a") }))).creditNote;
    expect(await w.journal(returned.approvalJournalId!)).toEqual([
      ["2000", "18.40", "0.00"],
      ["1400", "0.00", "16.00"],
      ["2100", "0.00", "2.40"],
      // Credited 8.00 each for units carried at 6.50: 3.00 less cost of sales, and 1400 moves by 13.00 in all.
      ["1400", "3.00", "0.00"],
      ["5000", "0.00", "3.00"],
    ]);
    expect(await w.stock()).toEqual({ "WIDGET@Dunedin": ["10", "65.00"] });
    await w.assertTies();
  });

  it("ST6: services and non-stock items never touch 1400 or 5000", async () => {
    const w = await setup();
    const service = await w.item({ code: "ENGRAVE", name: "Engraving", itemType: "service", salePrice: "25", purchaseAccountCode: "6070" });
    const box = await w.item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", salePrice: "4", purchasePrice: "2", purchaseAccountCode: "5100" });
    const sold = await w.invoice([{ itemId: service.id, quantity: "1" }, { itemId: box.id, quantity: "2" }]);
    expect((await w.journal(sold.approvalJournalId!)).map((line) => line[0])).toEqual(["1100", "4000", "2100"]);
    const bought = await w.bill([{ itemId: box.id, quantity: "10" }]);
    expect((await w.journal(bought.approvalJournalId!)).map((line) => line[0])).toEqual(["5100", "2100", "2000"]);
    expect(await w.stock()).toEqual({});
  });

  it("ST7: units: selling 2 Box of 12 takes 24 each out of stock", async () => {
    const w = await setup();
    const box = (await w.as((tx) => addItemUnit(tx, w.widget.id, { name: "Box of 12", factor: "12" }))).units[0];
    await w.bill([w.stockLine(w.widget.id, "30", "5.00")]);
    const sold = await w.invoice([{ itemId: w.widget.id, unitId: box.id, quantity: "2" }]);
    expect(sold.lines[0]).toMatchObject({ baseQuantity: "24", lineAmount: "288.00" });
    expect((await w.journal(sold.approvalJournalId!)).slice(3)).toEqual([
      ["5000", "120.00", "0.00"],
      ["1400", "0.00", "120.00"],
    ]);
    expect(await w.stock()).toEqual({ WIDGET: ["6", "30.00"] });
    await w.assertTies();
  });

  it("ST8: a kit's income goes to its account and its parts leave stock", async () => {
    const w = await setup();
    const candle = await w.item({ code: "CANDLE", name: "Candle", itemType: "stock", salePrice: "6", purchasePrice: "2" });
    const kit = await w.item({
      code: "GIFT-SET",
      name: "Gift set",
      itemType: "kit",
      salePrice: "30.00",
      incomeAccountCode: "4100",
      components: [
        { itemId: w.widget.id, quantity: "1" },
        { itemId: candle.id, quantity: "2" },
      ],
    });
    await w.bill([w.stockLine(w.widget.id, "5", "5.00"), w.stockLine(candle.id, "10", "2.00")]);
    const sold = await w.invoice([{ itemId: kit.id, quantity: "1" }]);
    expect(await w.journal(sold.approvalJournalId!)).toEqual([
      ["1100", "34.50", "0.00"],
      ["4100", "0.00", "30.00"],
      ["2100", "0.00", "4.50"],
      ["5000", "9.00", "0.00"],
      ["1400", "0.00", "9.00"],
    ]);
    expect(await w.stock()).toEqual({ CANDLE: ["8", "16.00"], WIDGET: ["4", "20.00"] });
    await w.assertTies();
  });

  it("ST9: with negative stock off, selling more than is on hand is refused", async () => {
    const w = await setup();
    await w.bill([w.stockLine(w.widget.id, "2", "5.00")]);
    const draft = await w.draftInvoice([w.stockLine(w.widget.id, "3", "12.00")]);
    await expect(w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).rejects.toThrow("Stock can't go negative");
    const after = await w.as((tx) => getInvoice(tx, draft.id));
    expect(after).toMatchObject({ status: "draft", invoiceNumber: null });
    // The database refuses it too.
    await expect(w.as((tx) => tx.query("update inventory_item_balances set on_hand_quantity = -1, carrying_value = -5"))).rejects.toThrow(
      "Stock can't go negative",
    );
  });

  it("ST10, ST12: negative stock on: sell below zero, then a bill tops up cost of sales; can't turn it off while below zero", async () => {
    const w = await setup({ negative: true });
    await w.bill([w.stockLine(w.widget.id, "2", "5.00")]);
    const sold = await w.invoice([w.stockLine(w.widget.id, "3", "12.00")]);
    expect((await w.journal(sold.approvalJournalId!)).slice(3)).toEqual([
      ["5000", "15.00", "0.00"],
      ["1400", "0.00", "15.00"],
    ]);
    expect(await w.stock()).toEqual({ WIDGET: ["-1", "-5.00"] });
    await w.assertTies();

    await expect(w.as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: false }))).rejects.toThrow("below zero (WIDGET)");
    await expect(w.as((tx) => tx.query("update organisation_settings set allow_negative_stock = false"))).rejects.toThrow("can't be turned off");

    const topUp = await w.bill([w.stockLine(w.widget.id, "4", "6.00")], "2026-06-20");
    const journal = await w.as((tx) => getJournal(tx, topUp.approvalJournalId!));
    expect(journal.postingDate).toBe("2026-06-20");
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1400", "24.00", "0.00"],
      ["2100", "3.60", "0.00"],
      ["2000", "0.00", "27.60"],
      ["5000", "1.00", "0.00"],
      ["1400", "0.00", "1.00"],
    ]);
    expect(await w.stock()).toEqual({ WIDGET: ["3", "18.00"] });
    await w.assertTies();
    await w.as((tx) => updateOrganisationSettings(tx, { allowNegativeStock: false }));
  });

  it("ST11: no cost history: costed at the item's purchase price, else refused", async () => {
    const w = await setup({ negative: true });
    const sold = await w.invoice([w.stockLine(w.widget.id, "2", "12.00")]);
    // WIDGET's purchase price is 5.00; ST11's 4.00 is the same rule.
    expect((await w.journal(sold.approvalJournalId!)).slice(3)).toEqual([
      ["5000", "10.00", "0.00"],
      ["1400", "0.00", "10.00"],
    ]);
    const plain = await w.item({ code: "CHARM", name: "Charm", itemType: "stock", salePrice: "9" });
    const draft = await w.draftInvoice([w.stockLine(plain.id, "1", "9.00")]);
    await expect(w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).rejects.toThrow("no cost to use for it");
    const four = await w.item({ code: "CHARM4", name: "Charm 4", itemType: "stock", salePrice: "9", purchasePrice: "4.00" });
    const sold4 = await w.invoice([w.stockLine(four.id, "2", "9.00")]);
    expect((await w.journal(sold4.approvalJournalId!)).slice(3)).toEqual([
      ["5000", "8.00", "0.00"],
      ["1400", "0.00", "8.00"],
    ]);
    expect(await w.stock()).toEqual({ CHARM4: ["-2", "-8.00"], WIDGET: ["-2", "-10.00"] });
    await w.assertTies();
  });

  it("stock equals account 1400 to the cent across a mixed scenario, with direct stock movements and backdating refused", async () => {
    const w = await setup({ locations: true });
    await w.bill([w.stockLine(w.widget.id, "3", "3.33", "Dunedin"), w.stockLine(w.widget.id, "7", "4.1234", "Auckland")]);
    await w.invoice([w.stockLine(w.widget.id, "1", "12", "Dunedin"), w.stockLine(w.widget.id, "2", "12", "Auckland")]);
    await w.as((tx) =>
      postMovement(tx, {
        idempotencyKey: key("m"),
        movementType: "adjustment",
        movementDate: "2026-06-12",
        itemCode: "widget",
        quantityDelta: "-1",
        reference: "Stocktake",
        inventoryAccountCode: "1400",
        offsetAccountCode: "5000",
        locationValueId: w.loc.Auckland,
      }),
    );
    await w.as((tx) =>
      postMovement(tx, {
        idempotencyKey: key("m"),
        movementType: "landed_cost",
        movementDate: "2026-06-12",
        itemCode: "WIDGET",
        amount: "3.10",
        reference: "Freight",
        inventoryAccountCode: "1400",
        offsetAccountCode: "2000",
        locationValueId: w.loc.Dunedin,
      }),
    );
    await w.invoice([w.stockLine(w.widget.id, "2", "12", "Dunedin")], "2026-06-13");
    expect(await w.stock()).toEqual({ "WIDGET@Auckland": ["4", "16.49"] });
    await w.assertTies();
    // Backdating stays refused.
    const early = await w.draftInvoice([w.stockLine(w.widget.id, "1", "12", "Auckland")], "2026-06-05");
    await expect(w.as((tx) => approveInvoice(tx, early.id, { idempotencyKey: key("a") }))).rejects.toThrow("Backdated stock movements aren't supported yet");
    // Stock movements to another account are refused.
    await expect(
      w.as((tx) =>
        postMovement(tx, {
          idempotencyKey: key("m"),
          movementType: "receipt",
          movementDate: "2026-06-20",
          itemCode: "WIDGET",
          quantity: "1",
          unitCost: "5",
          reference: "X",
          inventoryAccountCode: "1200",
          offsetAccountCode: "2000",
          locationValueId: w.loc.Auckland,
        }),
      ),
    ).rejects.toThrow("Stock is kept in the inventory account (1400)");
  });
});
