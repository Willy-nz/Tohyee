import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction, getBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill, getBill, voidBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { listRecodes, recodeLine } from "@/lib/ledger/recode";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { profitAndLoss } from "@/lib/reports/financial";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/** Recoding a posted line (RCD1-RCD6, #258/#259; not yet reviewed). Each test gets its own organisation. */
describeWithDatabase("recoding posted lines", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("recode-owner@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `recode-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const contact = async (name: string, extra: Record<string, unknown>): Promise<Contact> => (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const supplier = await contact("Lawyers Ltd", { isSupplier: true });
    const customer = await contact("Kobe Ltd", { isCustomer: true });
    const bill = async (lines: unknown[], billDate = "2026-05-10") => {
      const draft = await as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId: supplier.id, billDate, dueDate: "2026-07-20", supplierInvoiceNumber: key("S"), amountsMode: "exclusive", lines }),
      );
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }))).bill;
    };
    const recode = (fields: Record<string, unknown>) => as((tx) => recodeLine(tx, { idempotencyKey: key("rc"), documentType: undefined, documentId: undefined, lineOrder: 1, reason: "Coded wrongly", ...fields }));
    const journal = async (journalId: string) => {
      const found = await as((tx) => getJournal(tx, journalId));
      return { postingDate: found.postingDate, origin: found.origin, lines: found.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]) };
    };
    return { as, supplier, customer, bill, recode, journal };
  }

  it("RCD1: a bill line moves to another account on the bill's date; payables and GST don't move", async () => {
    const w = await setup();
    const bill = await w.bill([{ description: "Advice", quantity: "1", unitPrice: "500.00", accountCode: "6010", taxCode: "GST" }]);
    const result = await w.recode({ documentType: "bill", documentId: bill.id, accountCode: "6100", reason: "It was the lawyer's invoice" });
    expect(result.recode).toMatchObject({ fromAccountCode: "6010", toAccountCode: "6100", amount: "500.00", lineOrder: 1 });
    expect(await w.journal(result.recode.journalId)).toEqual({
      postingDate: "2026-05-10",
      origin: "recode",
      lines: [
        ["6100", "500.00", "0.00"],
        ["6010", "0.00", "500.00"],
      ],
    });
    expect((await w.as((tx) => getBill(tx, bill.id))).lines[0].accountCode).toBe("6100");
    const pl = await w.as((tx) => profitAndLoss(tx, { from: "2026-05-01", to: "2026-05-31" }));
    const lines = pl.expenses.sections.flatMap((section) => section.lines.map((line) => [line.code, line.amount]));
    expect(lines).toEqual([["6100", "500.00"]]);
    // Retrying gives the same recode; it's listed on the bill.
    const again = await w.as((tx) => listRecodes(tx, { documentType: "bill", documentId: bill.id }));
    expect(again.map((entry) => entry.reason)).toEqual(["It was the lawyer's invoice"]);
  });

  it("RCD2: an invoice's income line", async () => {
    const w = await setup();
    const draft = await w.as((tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId: w.customer.id, invoiceDate: "2026-05-12", dueDate: "2026-06-20", amountsMode: "exclusive", lines: [{ description: "Consulting", quantity: "1", unitPrice: "1000.00", accountCode: "4000", taxCode: "GST" }] }),
    );
    const invoice = (await w.as((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("a") }))).invoice;
    const result = await w.recode({ documentType: "invoice", documentId: invoice.id, accountCode: "4100" });
    expect((await w.journal(result.recode.journalId)).lines).toEqual([
      ["4100", "0.00", "1000.00"],
      ["4000", "1000.00", "0.00"],
    ]);
    expect((await w.as((tx) => getInvoice(tx, invoice.id))).lines[0].accountCode).toBe("4100");
  });

  it("RCD3: refused on or before the lock date", async () => {
    const w = await setup();
    const bill = await w.bill([{ description: "Advice", quantity: "1", unitPrice: "500.00", accountCode: "6010", taxCode: "GST" }]);
    await w.as((tx) => updatePeriodControls(tx, { lockDate: "2026-05-31", reason: "May closed" }));
    await expect(w.recode({ documentType: "bill", documentId: bill.id, accountCode: "6100" })).rejects.toThrow(/lock/i);
    expect((await w.as((tx) => getBill(tx, bill.id))).lines[0].accountCode).toBe("6010");
  });

  it("RCD4: spend and receive money lines; the bank side doesn't change", async () => {
    const w = await setup();
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const spend = await w.as((tx) =>
      createBankTransaction(tx, { idempotencyKey: key("spend"), kind: "spend", accountId: bank.id, contactId: w.supplier.id, date: "2026-06-03", amountsMode: "exclusive", lines: [{ description: "Fees", accountCode: "6020", taxCode: "GST", amount: "80.00" }] }),
    );
    const spent = await w.recode({ documentType: "bank_transaction", documentId: spend.bankTransaction.id, accountCode: "6130" });
    expect((await w.journal(spent.recode.journalId)).lines).toEqual([
      ["6130", "80.00", "0.00"],
      ["6020", "0.00", "80.00"],
    ]);
    const receive = await w.as((tx) =>
      createBankTransaction(tx, { idempotencyKey: key("rcv"), kind: "receive", accountId: bank.id, contactId: w.customer.id, date: "2026-06-04", amountsMode: "exclusive", lines: [{ description: "Interest", accountCode: "4100", taxCode: "NONE", amount: "12.00" }] }),
    );
    const received = await w.recode({ documentType: "bank_transaction", documentId: receive.bankTransaction.id, accountCode: "4200" });
    expect((await w.journal(received.recode.journalId)).lines).toEqual([
      ["4200", "0.00", "12.00"],
      ["4100", "12.00", "0.00"],
    ]);
    expect((await w.as((tx) => getBankTransaction(tx, receive.bankTransaction.id))).lines[0].accountCode).toBe("4200");
  });

  it("RCD5: tracking only; a required category can't be left off", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!;
    const valueId = async (name: string) => {
      const setup = await w.as((tx) => createTrackingValue(tx, { categoryId: department.id, name }));
      return setup.categories.find((category) => category.id === department.id)!.values.find((value) => value.name === name)!.id;
    };
    const retail = await valueId("Retail");
    const wholesale = await valueId("Wholesale");
    const bill = await w.bill([{ description: "Advice", quantity: "1", unitPrice: "200.00", accountCode: "6010", taxCode: "GST", tracking: { [department.id]: retail } }]);
    const result = await w.recode({ documentType: "bill", documentId: bill.id, tracking: { [department.id]: wholesale } });
    const found = await w.as((tx) => getJournal(tx, result.recode.journalId));
    expect(found.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.tracking])).toEqual([
      ["6010", "200.00", "0.00", { [department.id]: wholesale }],
      ["6010", "0.00", "200.00", { [department.id]: retail }],
    ]);
    expect((await w.as((tx) => getBill(tx, bill.id))).lines[0].tracking).toEqual({ [department.id]: wholesale });
  });

  it("RCD6: refusals", async () => {
    const w = await setup();
    const bill = await w.bill([{ description: "Advice", quantity: "1", unitPrice: "500.00", accountCode: "6010", taxCode: "GST" }]);
    const to = (accountCode: string) => w.recode({ documentType: "bill", documentId: bill.id, accountCode });
    for (const control of ["1000", "1100", "2000", "2100", "1400"]) await expect(to(control)).rejects.toThrow(/control account/);
    await expect(to("1620")).rejects.toThrow(/fixed asset register/);
    await expect(to("6010")).rejects.toThrow(/Nothing would change/);
    await expect(w.recode({ documentType: "bill", documentId: bill.id, accountCode: "6100", reason: "" })).rejects.toThrow(/reason/i);
    await expect(w.recode({ documentType: "bill", documentId: bill.id, lineOrder: 2, accountCode: "6100" })).rejects.toThrow(/no line 2/);

    const stock = (
      await w.as((tx) =>
        createItem(tx, { idempotencyKey: key("item"), code: "WIDGET", name: "Widget", itemType: "stock", purchaseAccountCode: "1400", purchaseTaxCode: "GST", incomeAccountCode: "4000", salesTaxCode: "GST", salePrice: "12.00", purchasePrice: "5.00" }),
      )
    ).item;
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const stocked = await w.bill([{ itemId: stock.id, quantity: "2", unitPrice: "5.00" }], "2026-06-01");
    await expect(w.recode({ documentType: "bill", documentId: stocked.id, accountCode: "6100" })).rejects.toThrow(/stock item/);

    const voided = await w.bill([{ description: "Advice", quantity: "1", unitPrice: "50.00", accountCode: "6010", taxCode: "GST" }], "2026-06-02");
    await w.as((tx) => voidBill(tx, voided.id, { idempotencyKey: key("v"), voidDate: "2026-06-02" }));
    await expect(w.recode({ documentType: "bill", documentId: voided.id, accountCode: "6100" })).rejects.toThrow(/voided/);

    // The database still refuses any other change to an approved line.
    await expect(w.as((tx) => tx.query("update bill_lines set description = 'Changed' where bill_id = $1", [bill.id]))).rejects.toThrow(/can't be changed/);
    await expect(
      w.as(async (tx) => {
        await tx.query("select set_config('tohyee.recoding', 'on', true)");
        await tx.query("update bill_lines set description = 'Changed' where bill_id = $1", [bill.id]);
      }),
    ).rejects.toThrow(/can't be changed/);
  });
});
