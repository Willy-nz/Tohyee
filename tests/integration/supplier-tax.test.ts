import { afterAll, beforeAll, expect, it } from "vitest";
import * as contactsRoute from "@/app/api/contacts/[contactId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction } from "@/lib/bank/transactions";
import { approveBill, createBill, getBill, updateBill } from "@/lib/bills/service";
import { type Contact, createContact, getContact, updateContact } from "@/lib/contacts/service";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { getJournal } from "@/lib/ledger/journals";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createRepeatingBill } from "@/lib/repeating/bills";
import { createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { listTaxCodes, createTaxCode } from "@/lib/tax/codes";
import { contactSalesTaxCodeFor } from "@/lib/tax/contact-tax";
import { contactPurchaseTaxCode } from "@/lib/tax/purchase-defaults";
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
 * Examples EX16-EX25 in docs/ACCOUNTING-EXAMPLES.md (a supplier's default
 * purchase tax code, not yet approved by Jess), following Xero's contact
 * "Purchase defaults" tax rate. The editors' starting code for a new line is
 * `contactPurchaseTaxCode` (tests/unit/supplier-tax.test.ts); here it's
 * worked out from the saved contact and tax codes, and every document saves
 * the code on its lines. 1000 is the bank, 2000 accounts payable, 2100 GST,
 * 6010 an expense account.
 */
describeWithDatabase("a supplier's default purchase tax code", () => {
  let server: TestServer;
  let owner: SessionUser;
  const ORG = "stx-co";
  const people: Record<string, Contact> = {};
  let invoiceNumber = 0;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const line = (unitPrice: string, taxCode: string, description = "Subscription") => ({ description, quantity: "1", unitPrice, accountCode: "6010", taxCode });
  /** The code the purchase editors start a new line with; null is the usual default. */
  const startingCode = (name: string) =>
    run(async (tx) => contactPurchaseTaxCode(await getContact(tx, people[name].id), await listTaxCodes(tx)));
  const draftBill = (name: string, lines: Array<Record<string, unknown>>) =>
    run((tx) =>
      createBill(tx, {
        idempotencyKey: key("bill"),
        contactId: people[name].id,
        billDate: "2026-07-01",
        dueDate: "2026-07-20",
        supplierInvoiceNumber: `SI-${++invoiceNumber}`,
        amountsMode: "exclusive",
        lines,
      }),
    );
  const approve = async (billId: string) => (await run((tx) => approveBill(tx, billId, { idempotencyKey: key("approve") }))).bill;
  const contact = async (name: string, fields: Record<string, unknown> = {}) => {
    people[name] = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, isSupplier: true, ...fields }))).contact;
    return people[name];
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("stx-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await contact("Cloud Apps Inc", { billingCountry: "US", defaultPurchaseTaxCode: "none" });
    await contact("Kauri Supplies");
    await contact("Rata Rentals", { isCustomer: true, defaultSalesTaxCode: "EXEMPT", defaultPurchaseTaxCode: "GST" });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EX16: after migration 0049 contacts have no default purchase tax code; Foreign trade stays off for new organisations", async () => {
    const migration = tenantMigrations.find((entry) => entry.version === "0049")!;
    expect(migration.name).toBe("contact_purchase_tax_code");
    expect(people["Kauri Supplies"].defaultPurchaseTaxCode).toBeNull();
    expect(people["Cloud Apps Inc"].defaultPurchaseTaxCode).toBe("NONE");
    const old = await run(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        "insert into contacts (command_source, idempotency_key, request_hash, name, is_supplier) values ('test', 'ex16-old', 'x', 'Old Supplier', true) returning id",
      );
      return getContact(tx, inserted.rows[0].id);
    });
    expect(old).toMatchObject({ defaultPurchaseTaxCode: null, defaultSalesTaxCode: null });
    expect(await run((tx) => getOrganisationSettings(tx))).toMatchObject({ foreignTrade: false });
    // Creating a contact with a default is in its history.
    const created = await run((tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'contact.created' and entity_id = $1", [
        people["Cloud Apps Inc"].id,
      ]),
    );
    expect(created.rows[0].details).toMatchObject({ defaultPurchaseTaxCode: "NONE" });
  });

  it("EX17: an overseas subscription supplier with default NONE: the bill line starts NONE and has no GST", async () => {
    expect(await startingCode("Cloud Apps Inc")).toBe("NONE");
    const { bill } = await draftBill("Cloud Apps Inc", [line("50.00", "NONE")]);
    expect(bill).toMatchObject({ taxTotal: "0.00", total: "50.00" });
    const approved = await approve(bill.id);
    const journal = await run((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount])).toEqual([
      ["6010", "50.00", "0.00"],
      ["2000", "0.00", "50.00"],
    ]);
  });

  it("EX18: a supplier without a default keeps the usual default (GST)", async () => {
    expect(await startingCode("Kauri Supplies")).toBeNull();
    const { bill } = await draftBill("Kauri Supplies", [line("200.00", "GST", "Timber")]);
    expect(bill).toMatchObject({ taxTotal: "30.00", total: "230.00" });
  });

  it("EX20: a line changed by hand saves as chosen", async () => {
    const { bill } = await draftBill("Cloud Apps Inc", [line("100.00", "GST", "Local support, GST charged")]);
    expect(bill).toMatchObject({ taxTotal: "15.00", total: "115.00" });
    expect(bill.lines[0].taxCode).toBe("GST");
  });

  it("EX21: changing the contact's default (audited) leaves saved bills alone; only new lines start differently", async () => {
    const { bill } = await draftBill("Cloud Apps Inc", [line("50.00", "NONE")]);
    await run((tx) => updateContact(tx, people["Cloud Apps Inc"].id, { defaultPurchaseTaxCode: "GST" }));
    const history = await run((tx) =>
      tx.query<{ details: { changes: Record<string, unknown> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id desc limit 1",
        [people["Cloud Apps Inc"].id],
      ),
    );
    expect(history.rows[0].details.changes.defaultPurchaseTaxCode).toEqual({ from: "NONE", to: "GST" });
    expect(await startingCode("Cloud Apps Inc")).toBe("GST");
    expect((await run((tx) => getBill(tx, bill.id))).lines[0].taxCode).toBe("NONE");
    await run((tx) => updateBill(tx, bill.id, { supplierInvoiceNumber: `SI-${++invoiceNumber}` }));
    const approved = await approve(bill.id);
    expect(approved).toMatchObject({ taxTotal: "0.00", total: "50.00" });
    expect(approved.lines[0].taxCode).toBe("NONE");
    // Over HTTP, cleared then set back to NONE.
    for (const [sent, expected] of [
      ["", null],
      ["none", "NONE"],
    ] as const) {
      const response = await contactsRoute.PATCH(
        apiRequest(`/api/contacts/${people["Cloud Apps Inc"].id}`, {
          method: "PATCH",
          cookie: await sessionCookieFor(owner),
          body: { organisationId: ORG, defaultPurchaseTaxCode: sent },
        }),
        params({ contactId: people["Cloud Apps Inc"].id }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).contact.defaultPurchaseTaxCode).toBe(expected);
    }
  });

  it("EX22: an inactive code is refused; any active code will do, and the sales and purchase defaults are separate", async () => {
    await run(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "OLD", label: "Old", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01" });
      await tx.query("update tax_codes set is_active = false where code = 'OLD'");
    });
    await expect(run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "OLD" }))).rejects.toThrow(
      "Tax code OLD is inactive, so it can't be a contact's default purchase tax code.",
    );
    await expect(
      run((tx) => createContact(tx, { idempotencyKey: key("contact"), name: "Old Code Ltd", isSupplier: true, defaultPurchaseTaxCode: "OLD" })),
    ).rejects.toThrow("Tax code OLD is inactive, so it can't be a contact's default purchase tax code.");
    await expect(run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "NOPE" }))).rejects.toThrow("There's no tax code NOPE.");
    // Tax codes aren't split into sales and purchase codes: ZERO (e.g. land bought zero-rated) is accepted.
    expect((await run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "ZERO" }))).defaultPurchaseTaxCode).toBe("ZERO");
    await run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: null }));
    // A code that became inactive after it was set can be kept, but isn't used for new lines.
    await run(async (tx) => {
      await tx.query("update tax_codes set is_active = true where code = 'OLD'");
      await updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "OLD" });
      await tx.query("update tax_codes set is_active = false where code = 'OLD'");
    });
    expect((await run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "OLD", name: "Kauri Supplies Ltd" }))).defaultPurchaseTaxCode).toBe(
      "OLD",
    );
    expect(await startingCode("Kauri Supplies")).toBeNull();
    await run((tx) => updateContact(tx, people["Kauri Supplies"].id, { defaultPurchaseTaxCode: "" }));
    // Rata Rentals: sales lines start EXEMPT (its sales default), purchase lines GST (its purchase default).
    expect(await run((tx) => contactSalesTaxCodeFor(tx, people["Rata Rentals"].id))).toBe("EXEMPT");
    expect(await startingCode("Rata Rentals")).toBe("GST");
    // Cloud Apps' purchase default doesn't touch its sales lines.
    expect(await run((tx) => contactSalesTaxCodeFor(tx, people["Cloud Apps Inc"].id))).toBeNull();
  });

  it("EX23: spend money with the contact starts with its default; it posts with no GST", async () => {
    const bank = (await run((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const { bankTransaction } = await run((tx) =>
      createBankTransaction(tx, {
        idempotencyKey: key("spend"),
        kind: "spend",
        accountId: bank.id,
        contactId: people["Cloud Apps Inc"].id,
        date: "2026-07-05",
        amountsMode: "inclusive",
        lines: [{ description: "Monthly subscription", accountCode: "6010", taxCode: "NONE", amount: "50.00" }],
      }),
    );
    expect(bankTransaction).toMatchObject({ taxTotal: "0.00", total: "50.00" });
    const journal = await run((tx) => getJournal(tx, bankTransaction.journalId));
    expect(journal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount])).toEqual([
      ["6010", "50.00", "0.00"],
      ["1000", "0.00", "50.00"],
    ]);
  });

  it("EX24: supplier credit notes, purchase orders and repeating bills save the supplier's NONE", async () => {
    const cloud = people["Cloud Apps Inc"].id;
    const credit = await run((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: cloud,
        creditNoteDate: "2026-07-10",
        supplierCreditNoteNumber: "CR-1",
        amountsMode: "exclusive",
        lines: [line("10.00", "NONE", "Refund for downtime")],
      }),
    );
    expect(credit.creditNote).toMatchObject({ taxTotal: "0.00", total: "10.00" });
    const order = await run((tx) =>
      createPurchaseOrder(tx, {
        idempotencyKey: key("po"),
        contactId: cloud,
        orderDate: "2026-07-10",
        deliveryAddress: "12 Stuart St, Dunedin 9016",
        amountsMode: "exclusive",
        lines: [line("600.00", "NONE", "Annual plan")],
      }),
    );
    expect(order.purchaseOrder).toMatchObject({ taxTotal: "0.00", total: "600.00" });
    const template = await run((tx) =>
      createRepeatingBill(tx, {
        idempotencyKey: key("rb"),
        contactId: cloud,
        supplierInvoiceNumber: "CLOUD-{month}",
        amountsMode: "exclusive",
        lines: [line("50.00", "NONE")],
        period: "month",
        every: 1,
        startDate: "2026-08-01",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "draft",
      }),
    );
    expect(template.repeatingBill.lines[0].taxCode).toBe("NONE");
  });
});
