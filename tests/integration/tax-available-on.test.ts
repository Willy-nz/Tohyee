import { afterAll, beforeAll, expect, it } from "vitest";
import * as taxCodeRoute from "@/app/api/tax/codes/[taxCodeId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankRule } from "@/lib/bank/rules";
import { createBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { createCreditNote } from "@/lib/credit-notes/service";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createExpenseClaim } from "@/lib/expense-claims/service";
import { approveInvoice, createInvoice, getInvoice, updateInvoice, voidInvoice } from "@/lib/invoices/service";
import { createItem, updateItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createQuote } from "@/lib/quotes/service";
import { createRepeatingBill } from "@/lib/repeating/bills";
import { createRepeatingInvoice, getRepeatingInvoice, runRepeatingInvoices } from "@/lib/repeating/service";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTaxCode, listTaxCodes, type TaxCode, updateTaxCode } from "@/lib/tax/codes";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/**
 * Examples TAO1-TAO12 in docs/ACCOUNTING-EXAMPLES.md (a tax code's
 * "Available on", not yet approved by Jess), following NetSuite's tax code
 * field: Sales, Purchases or Both. The editors' pickers and starting codes
 * are `codesForSide` (tests/unit/tax-available-on.test.ts, TAO6); here the
 * server refuses a code on the wrong side, defaults and settings must match,
 * and changing a code never touches saved documents. 1000 is the bank, 1100
 * accounts receivable, 2000 accounts payable, 2100 GST, 4000 Sales, 6010 an
 * expense account.
 */
describeWithDatabase("a tax code's Available on", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  const ORG = "tao-co";
  const people: Record<string, Contact> = {};
  let supplierInvoice = 0;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const sale = (unitPrice: string, taxCode: string, description = "Dog walking") => ({ description, quantity: "1", unitPrice, accountCode: "4000", taxCode });
  const cost = (unitPrice: string, taxCode: string, description = "Supplies") => ({ description, quantity: "1", unitPrice, accountCode: "6010", taxCode });
  const refusal = (code: string, only: "sales" | "purchases", side: "sales" | "purchases", label = "Line 1") =>
    `${label}: tax code ${code} is available on ${only} only, so it can't be used on ${side}. Choose a tax code available on ${side}.`;
  const invoice = (lines: Array<Record<string, unknown>>, invoiceDate = "2026-07-01", org = ORG) =>
    inOrganisation(org, { userId: owner.id, email: owner.email }, (tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId: people["Kobe Ltd"].id, invoiceDate, dueDate: "2026-07-20", amountsMode: "exclusive", lines }),
    );
  const bill = (lines: Array<Record<string, unknown>>, billDate = "2026-07-01", org = ORG) =>
    inOrganisation(org, { userId: owner.id, email: owner.email }, (tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: people["Kauri Supplies"].id,
        billDate,
        dueDate: "2026-07-20",
        supplierInvoiceNumber: `SI-${++supplierInvoice}`,
        amountsMode: "exclusive",
        lines,
      }),
    );
  const code = async (name: string) => (await run((tx) => listTaxCodes(tx))).find((entry) => entry.code === name) as TaxCode;
  const setAvailableOn = async (name: string, availableOn: string) => run(async (tx) => updateTaxCode(tx, (await listTaxCodes(tx)).find((entry) => entry.code === name)!.id, { availableOn }));
  const money = (kind: "spend" | "receive", taxCode: string, contact: string) =>
    run(async (tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key(kind),
        kind,
        accountId: (await listBankAccounts(tx)).find((account) => account.code === "1000")!.id,
        contactId: people[contact].id,
        date: "2026-07-05",
        amountsMode: "inclusive",
        lines: [{ description: kind === "spend" ? "Stationery" : "Dog walking", accountCode: kind === "spend" ? "6010" : "4000", taxCode, amount: "115.00" }],
      }),
    );

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("tao-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("tao-bookkeeper@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, bookkeeper.id]);
    const contact = async (name: string, fields: Record<string, unknown>) => {
      people[name] = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, ...fields }))).contact;
    };
    await contact("Kobe Ltd", { isCustomer: true });
    await contact("Kauri Supplies", { isSupplier: true });
    await contact("Cloud Apps Inc", { isSupplier: true, billingCountry: "US", defaultPurchaseTaxCode: "NONE" });
    await run(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "PUR", label: "GST on purchases", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01", availableOn: "purchases" });
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "SAL", label: "GST on sales", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01", availableOn: "sales" });
    });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("TAO1: after migration 0050 every existing code, the starting NZ codes and a code added without a choice are Both", async () => {
    const migration = tenantMigrations.find((entry) => entry.version === "0050")!;
    expect(migration.name).toBe("tax_code_available_on");
    const codes = await run((tx) => listTaxCodes(tx));
    for (const name of ["GST", "ZERO", "EXEMPT", "NONE"]) {
      expect(codes.find((entry) => entry.code === name)!.availableOn).toBe("both");
    }
    // A code inserted as before the migration (no column given) is Both.
    await run((tx) =>
      tx.query(
        "insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from) values ('test', 'tao1-old', 'x', 'OLDSTYLE', 'Old style', 'exempt', 0, '2010-10-01')",
      ),
    );
    expect((await code("OLDSTYLE")).availableOn).toBe("both");
    const added = await run((tx) => createTaxCode(tx, { idempotencyKey: key("tax"), code: "PLAIN", label: "Plain", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" }));
    expect(added.taxCode.availableOn).toBe("both");
    // A GST-coded invoice and bill work as before.
    expect((await invoice([sale("100.00", "GST")])).invoice).toMatchObject({ taxTotal: "15.00", total: "115.00" });
    expect((await bill([cost("200.00", "GST")])).bill).toMatchObject({ taxTotal: "30.00", total: "230.00" });
  });

  it("TAO2: a purchases-only code is refused on an invoice and accepted on a bill", async () => {
    await expect(invoice([sale("100.00", "PUR")])).rejects.toThrow(refusal("PUR", "purchases", "sales"));
    const { bill: draft } = await bill([cost("200.00", "PUR")]);
    expect(draft).toMatchObject({ taxTotal: "30.00", total: "230.00" });
    // Test bills share a supplier and total, so approving goes past the duplicate warning (DU2).
    const approved = (await run((tx) => approveBill(tx, draft.id, { idempotencyKey: key("approve"), approveDespiteWarnings: true }))).bill;
    const journal = await run((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount])).toEqual([
      ["6010", "200.00", "0.00"],
      ["2100", "30.00", "0.00"],
      ["2000", "0.00", "230.00"],
    ]);
  });

  it("TAO3: each sales and purchase document takes only codes available on its side", async () => {
    const kauri = people["Kauri Supplies"].id;
    const kobe = people["Kobe Ltd"].id;
    const purchases = refusal("SAL", "sales", "purchases");
    const sales = refusal("PUR", "purchases", "sales");
    await expect(bill([cost("200.00", "SAL")])).rejects.toThrow(purchases);
    await expect(
      run((tx) =>
        createSupplierCreditNote(tx, { idempotencyKey: key("scn"), contactId: kauri, creditNoteDate: "2026-07-10", supplierCreditNoteNumber: "CR-1", amountsMode: "exclusive", lines: [cost("10.00", "SAL")] }),
      ),
    ).rejects.toThrow(purchases);
    await expect(
      run((tx) =>
        createPurchaseOrder(tx, { idempotencyKey: key("po"), contactId: kauri, orderDate: "2026-07-10", deliveryAddress: "12 Stuart St, Dunedin", amountsMode: "exclusive", lines: [cost("600.00", "SAL")] }),
      ),
    ).rejects.toThrow(purchases);
    await expect(
      run((tx) =>
        createRepeatingBill(tx, {
          idempotencyKey: key("rb"),
          contactId: kauri,
          supplierInvoiceNumber: "K-{month}",
          amountsMode: "exclusive",
          lines: [cost("50.00", "SAL")],
          period: "month",
          every: 1,
          startDate: "2026-08-01",
          dueRule: "days_after",
          dueDays: 20,
          saveAs: "draft",
        }),
      ),
    ).rejects.toThrow(purchases);
    await expect(
      run((tx) =>
        createExpenseClaim(tx, {
          idempotencyKey: key("claim"),
          description: "Market trip",
          receipts: [{ receiptDate: "2026-07-03", supplierName: "Paper Plus", description: "Paper", accountCode: "6010", taxCode: "SAL", amount: "23.00" }],
        }),
      ),
    ).rejects.toThrow(refusal("SAL", "sales", "purchases", "Receipt 1"));
    await expect(
      run((tx) => createCreditNote(tx, { idempotencyKey: key("cn"), contactId: kobe, creditNoteDate: "2026-07-10", amountsMode: "exclusive", lines: [sale("50.00", "PUR")] })),
    ).rejects.toThrow(sales);
    await expect(
      run((tx) => createQuote(tx, { idempotencyKey: key("quote"), contactId: kobe, quoteDate: "2026-07-10", amountsMode: "exclusive", lines: [sale("300.00", "PUR")] })),
    ).rejects.toThrow(sales);
    await expect(
      run((tx) =>
        createRepeatingInvoice(tx, {
          idempotencyKey: key("ri"),
          contactId: kobe,
          amountsMode: "exclusive",
          lines: [sale("100.00", "PUR")],
          period: "month",
          every: 1,
          startDate: "2026-08-01",
          dueRule: "days_after",
          dueDays: 20,
          saveAs: "draft",
        }),
      ),
    ).rejects.toThrow(sales);
    // The sales-only code on an invoice, and the purchases-only one on a supplier credit note, are fine.
    expect((await invoice([sale("100.00", "SAL")])).invoice).toMatchObject({ taxTotal: "15.00", total: "115.00" });
    const credit = await run((tx) =>
      createSupplierCreditNote(tx, { idempotencyKey: key("scn"), contactId: kauri, creditNoteDate: "2026-07-10", supplierCreditNoteNumber: "CR-2", amountsMode: "exclusive", lines: [cost("10.00", "PUR")] }),
    );
    expect(credit.creditNote).toMatchObject({ taxTotal: "1.50", total: "11.50" });
  });

  it("TAO4: spend money is purchases and receive money sales", async () => {
    await expect(money("spend", "SAL", "Kauri Supplies")).rejects.toThrow(refusal("SAL", "sales", "purchases"));
    await expect(money("receive", "PUR", "Kobe Ltd")).rejects.toThrow(refusal("PUR", "purchases", "sales"));
    const received = await money("receive", "SAL", "Kobe Ltd");
    expect(received.bankTransaction).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
    const spent = await money("spend", "PUR", "Kauri Supplies");
    expect(spent.bankTransaction).toMatchObject({ subtotal: "100.00", taxTotal: "15.00", total: "115.00" });
  });

  it("TAO5: Available on is chosen when a code is added and changed by an admin, audited; a bookkeeper can't change it", async () => {
    const created = await run((tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'tax.code_created' and details->>'code' = 'PUR'"),
    );
    expect(created.rows[0].details).toMatchObject({ availableOn: "purchases" });
    await expect(
      run((tx) => createTaxCode(tx, { idempotencyKey: key("tax"), code: "ODD", label: "Odd", category: "exempt", rate: "0", effectiveFrom: "2010-10-01", availableOn: "sometimes" })),
    ).rejects.toThrow("availableOn");
    const exempt = await code("EXEMPT");
    const patch = async (user: SessionUser, availableOn: string) =>
      taxCodeRoute.PATCH(
        apiRequest(`/api/tax/codes/${exempt.id}`, { method: "PATCH", cookie: await sessionCookieFor(user), body: { organisationId: ORG, availableOn } }),
        params({ taxCodeId: exempt.id }),
      );
    expect((await patch(bookkeeper, "sales")).status).toBe(403);
    const response = await patch(owner, "sales");
    expect(response.status).toBe(200);
    expect((await response.json()).taxCode.availableOn).toBe("sales");
    const history = await run((tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'tax.code_updated' and entity_id = $1", [exempt.id]),
    );
    expect(history.rows[0].details).toEqual({ code: "EXEMPT", changes: { availableOn: { from: "both", to: "sales" } } });
    expect((await patch(owner, "both")).status).toBe(200);
  });

  it("TAO7: contact defaults, the tax code for exports and items' codes must be available on their side; the database checks it too", async () => {
    await expect(run((tx) => updateContact(tx, people["Kobe Ltd"].id, { defaultSalesTaxCode: "PUR" }))).rejects.toThrow(
      "Tax code PUR is available on purchases only, so it can't be a contact's default sales tax code. Choose a code available on sales.",
    );
    await expect(run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "SAL" }))).rejects.toThrow(
      "Tax code SAL is available on sales only, so it can't be a contact's default purchase tax code. Choose a code available on purchases.",
    );
    await expect(
      run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Wrong Side Ltd", isCustomer: true, defaultSalesTaxCode: "PUR" })),
    ).rejects.toThrow("can't be a contact's default sales tax code");
    expect((await run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "PUR" }))).defaultPurchaseTaxCode).toBe("PUR");
    await run((tx) => createTaxCode(tx, { idempotencyKey: key("tax"), code: "ZPUR", label: "Zero-rated purchases", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01", availableOn: "purchases" }));
    await expect(run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "ZPUR" }))).rejects.toThrow(
      "ZPUR is available on purchases only, so it can't be the tax code for exports. Choose a zero-rated code available on sales.",
    );
    await expect(
      run((tx) => createItem(tx, { idempotencyKey: key("item"), code: "TOUR", name: "Tour", itemType: "non_stock", salesTaxCode: "PUR" })),
    ).rejects.toThrow("Tax code PUR is available on purchases only, so it can't be an item's sales tax code. Choose a code available on sales.");
    const item = (await run((tx) => createItem(tx, { idempotencyKey: key("item"), code: "TOUR", name: "Tour", itemType: "non_stock", salesTaxCode: "SAL", purchaseTaxCode: "PUR" }))).item;
    expect([item.salesTaxCode, item.purchaseTaxCode]).toEqual(["SAL", "PUR"]);
    await expect(run((tx) => updateItem(tx, item.id, { purchaseTaxCode: "SAL" }))).rejects.toThrow("can't be an item's purchase tax code");
    // The database refuses them too.
    await expect(run((tx) => tx.query("update organisation_settings set export_tax_code_id = (select id from tax_codes where code = 'ZPUR')"))).rejects.toThrow(
      "The tax code for exports must be available on sales",
    );
    await expect(
      run((tx) => tx.query("update contacts set default_sales_tax_code_id = (select id from tax_codes where code = 'PUR') where id = $1", [people["Kobe Ltd"].id])),
    ).rejects.toThrow("A contact's default sales tax code must be available on sales");
    await expect(run((tx) => tx.query("update items set sales_tax_code_id = (select id from tax_codes where code = 'PUR') where id = $1", [item.id]))).rejects.toThrow(
      "An item's sales tax code must be available on sales",
    );
  });

  it("TAO8: a bank rule's code suits the side it codes: money in sales, money out purchases, either way both", async () => {
    const rule = (direction: string, taxCode: string) =>
      run((tx) =>
        createBankRule(tx, { name: `Rule ${direction} ${taxCode}`, matchText: "PAW", direction, contactId: people["Kobe Ltd"].id, targetAccountCode: "4000", taxCode, amountsMode: "inclusive" }),
      );
    await expect(rule("out", "SAL")).rejects.toThrow("Tax code SAL is available on sales only, so it can't be used on a rule for money out (spend money is purchases).");
    await expect(rule("any", "SAL")).rejects.toThrow("so it can't be used on a rule for money in or out (that needs a code available on both).");
    expect((await rule("in", "SAL")).lines[0].taxCode).toBe("SAL");
    expect((await rule("any", "GST")).lines[0].taxCode).toBe("GST");
    await expect(
      run((tx) =>
        tx.query(
          "update bank_rules set direction = 'out' where id in (select rule_id from bank_rule_lines where tax_code_id = (select id from tax_codes where code = 'SAL'))",
        ),
      ),
    ).rejects.toThrow("A bank rule's tax code must be available on the side it codes");
  });

  it("TAO9: a draft with a code no longer available on its side can't be saved or approved; approved documents are untouched", async () => {
    const { invoice: draft } = await invoice([sale("100.00", "GST")], "2026-07-08");
    const { invoice: other } = await invoice([sale("200.00", "GST")], "2026-07-08");
    const approved = (await run((tx) => approveInvoice(tx, other.id, { idempotencyKey: key("approve") }))).invoice;
    expect(approved).toMatchObject({ status: "approved", taxTotal: "30.00", total: "230.00" });
    // GST is used for sales only by the "any" bank rule (TAO8); it goes first.
    await run((tx) =>
      tx.query("delete from bank_rules where id in (select rule_id from bank_rule_lines where tax_code_id = (select id from tax_codes where code = 'GST'))"),
    );
    expect((await setAvailableOn("GST", "purchases")).availableOn).toBe("purchases");
    const refused = refusal("GST", "purchases", "sales");
    await expect(run((tx) => updateInvoice(tx, draft.id, { reference: "Saved again" }))).rejects.toThrow(refused);
    await expect(run((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).rejects.toThrow(refused);
    const kept = await run((tx) => getInvoice(tx, approved.id));
    expect(kept).toMatchObject({ status: "approved", taxTotal: "30.00", total: "230.00" });
    expect(kept.lines[0].taxCode).toBe("GST");
    // An approved invoice can still be voided: saved documents aren't checked again.
    const voided = (await run((tx) => voidInvoice(tx, approved.id, { idempotencyKey: key("void"), voidDate: "2026-07-09" }))).invoice;
    expect(voided.status).toBe("voided");
    expect((await setAvailableOn("GST", "both")).availableOn).toBe("both");
    const ok = (await run((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
    expect(ok).toMatchObject({ status: "approved", taxTotal: "15.00", total: "115.00" });
  });

  it("TAO10: changing Available on is refused while a contact default, the export code, an item or a bank rule uses it on the side it would lose", async () => {
    await expect(setAvailableOn("ZERO", "purchases")).rejects.toThrow(
      "Tax code ZERO can't be made available on purchases only while it's used for sales: the tax code for exports (Settings › Exports). Change those first.",
    );
    await expect(setAvailableOn("NONE", "sales")).rejects.toThrow(
      "Tax code NONE can't be made available on sales only while it's used for purchases: Cloud Apps Inc's default purchase tax code. Change those first.",
    );
    await expect(setAvailableOn("PUR", "sales")).rejects.toThrow(
      "Tax code PUR can't be made available on sales only while it's used for purchases: Kauri Supplies' default purchase tax code; item TOUR's purchase tax code. Change those first.",
    );
    await expect(setAvailableOn("SAL", "purchases")).rejects.toThrow(`item TOUR's sales tax code; bank rule "Rule in SAL"`);
    // The side the code keeps is fine: ZERO can be sales only while it's the tax code for exports.
    expect((await setAvailableOn("ZERO", "sales")).availableOn).toBe("sales");
    expect((await setAvailableOn("ZERO", "both")).availableOn).toBe("both");
    // The database refuses it too.
    await expect(run((tx) => tx.query("update tax_codes set available_on = 'sales' where code = 'NONE'"))).rejects.toThrow(
      "Tax code NONE is used for purchases, so it can't be made available on sales only",
    );
  });

  it("TAO11: a repeating invoice whose code is no longer available on sales makes nothing and keeps the reason", async () => {
    await run((tx) => createTaxCode(tx, { idempotencyKey: key("tax"), code: "SVC", label: "Services", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01" }));
    const template = (
      await run((tx) =>
        createRepeatingInvoice(tx, {
          idempotencyKey: key("ri"),
          contactId: people["Kobe Ltd"].id,
          amountsMode: "exclusive",
          lines: [sale("100.00", "SVC", "Monthly walks")],
          period: "month",
          every: 1,
          startDate: "2026-08-01",
          dueRule: "days_after",
          dueDays: 20,
          saveAs: "draft",
        }),
      )
    ).repeatingInvoice;
    await setAvailableOn("SVC", "purchases");
    const refusedRun = await run((tx) => runRepeatingInvoices(tx, { today: "2026-08-01", repeatingInvoiceId: template.id }));
    expect(refusedRun).toMatchObject({ made: 0, failed: 1 });
    expect((await run((tx) => getRepeatingInvoice(tx, template.id))).lastError).toBe(`2026-08-01: ${refusal("SVC", "purchases", "sales")}`);
    await setAvailableOn("SVC", "both");
    const madeRun = await run((tx) => runRepeatingInvoices(tx, { today: "2026-08-01", repeatingInvoiceId: template.id }));
    expect(madeRun).toMatchObject({ made: 1, failed: 0 });
    const made = await run((tx) => tx.query<{ invoice_id: string }>("select invoice_id from repeating_invoice_runs where repeating_invoice_id = $1", [template.id]));
    expect(await run((tx) => getInvoice(tx, made.rows[0].invoice_id))).toMatchObject({ taxTotal: "15.00", total: "115.00" });
  });

  it("TAO12: the GST return is unchanged: sales-only and purchases-only codes count like any standard-rated code", async () => {
    const org = "tao-gst";
    await createTestOrganisation(owner, org);
    const inOrg = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await inOrg(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "PUR", label: "GST on purchases", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01", availableOn: "purchases" });
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "SAL", label: "GST on sales", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01", availableOn: "sales" });
      people["Kobe Ltd"] = (await createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true })).contact;
      people["Kauri Supplies"] = (await createContact(tx, { idempotencyKey: key("c"), name: "Kauri Supplies", isSupplier: true })).contact;
    });
    const sold = await invoice([sale("100.00", "SAL")], "2026-07-02", org);
    await inOrg((tx) => approveInvoice(tx, sold.invoice.id, { idempotencyKey: key("approve") }));
    const bought = await bill([cost("200.00", "PUR")], "2026-07-03", org);
    await inOrg((tx) => approveBill(tx, bought.bill.id, { idempotencyKey: key("approve"), approveDespiteWarnings: true }));
    const july = await inOrg((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }));
    expect(july.boxes).toMatchObject({ box5: "115.00", box6: "0.00", box7: "115.00", box8: "15.00", box11: "230.00", box12: "30.00" });
  });
});
