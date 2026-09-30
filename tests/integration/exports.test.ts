import { afterAll, beforeAll, expect, it } from "vitest";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact, getContact, listContacts, updateContact } from "@/lib/contacts/service";
import { createCreditNote } from "@/lib/credit-notes/service";
import { createOpportunity, makeInvoiceFromOpportunity, updateOpportunity } from "@/lib/crm/service";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { applyMapping, autoMap, findHeaderRow } from "@/lib/import/fields";
import { exportCsv, importMasterRecords } from "@/lib/import/service";
import { parseDelimited } from "@/lib/bank/formats/table";
import { approveInvoice, createInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import { createQuote } from "@/lib/quotes/service";
import { createRepeatingInvoice } from "@/lib/repeating/service";
import { calculateGstReturn } from "@/lib/reports/gst-return";
import { contactSalesTaxCodeFor } from "@/lib/tax/contact-tax";
import { createTaxCode } from "@/lib/tax/codes";
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
 * Examples EX1-EX15 in docs/ACCOUNTING-EXAMPLES.md (exports and the tax code
 * for overseas customers, not yet approved by Jess), following NetSuite's
 * Foreign Trade box and Tax Code for Exports, and IRD's IR375: exports are
 * zero-rated, not exempt, and the invoice's currency doesn't decide it. The
 * editors' starting code for a new line is `contactSalesTaxCode`
 * (tests/unit/exports.test.ts); here it's checked through the server's copy
 * (`contactSalesTaxCodeFor`, used for CRM invoices) and every document saves
 * the code on its lines. 1100 is accounts receivable, 2100 GST, 4000 Sales.
 */
describeWithDatabase("exports and the tax code for overseas customers", () => {
  let server: TestServer;
  let owner: SessionUser;
  const ORG = "ex-co";
  const people: Record<string, Contact> = {};

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const line = (unitPrice: string, taxCode: string, description = "Goods") => ({ description, quantity: "1", unitPrice, accountCode: "4000", taxCode });
  const draftInvoice = (contactId: string, invoiceDate: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    run((tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId, invoiceDate, dueDate: "2026-08-20", amountsMode: "exclusive", lines, ...extra }, { foreignCurrency: true }),
    );
  const approve = async (invoiceId: string) => (await run((tx) => approveInvoice(tx, invoiceId, { idempotencyKey: key("approve") }))).invoice;
  const startingCode = (name: string) => run((tx) => contactSalesTaxCodeFor(tx, people[name].id));
  const contact = async (name: string, fields: Record<string, unknown> = {}) => {
    people[name] = (await run((tx) => createContact(tx, { idempotencyKey: key("contact"), name, isCustomer: true, ...fields }))).contact;
    return people[name];
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("ex-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await contact("Kobe Ltd");
    await contact("Wombat Pty Ltd", { billingCountry: "AU" });
    await contact("Paws LLC", { billingCountry: "US" });
    await contact("Tui Traders", { currencyCode: "USD" });
    await contact("Kiwi Gifts Ltd", { deliveryCountry: "AU" });
    await contact("Sydney Visitors", { billingCountry: "AU", deliveryCountry: "NZ" });
    await contact("Harbour Tours", { billingCountry: "AU", defaultSalesTaxCode: "GST" });
    await contact("Rata Rentals", { defaultSalesTaxCode: "exempt" });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EX1: contacts are in New Zealand and Foreign trade is off with ZERO for exports, after migration 0048 and for new organisations", async () => {
    expect(people["Kobe Ltd"]).toMatchObject({ billingCountry: "NZ", deliveryCountry: null, defaultSalesTaxCode: null });
    expect(people["Wombat Pty Ltd"]).toMatchObject({ billingCountry: "AU", deliveryCountry: null });
    expect(people["Rata Rentals"]).toMatchObject({ billingCountry: "NZ", defaultSalesTaxCode: "EXEMPT" });
    // A new organisation (provisioned after the migration).
    expect(await run((tx) => getOrganisationSettings(tx))).toMatchObject({ foreignTrade: false, exportTaxCode: "ZERO" });
    // An existing organisation: a contact row as it was before 0048, and the migration's own update.
    const migration = tenantMigrations.find((entry) => entry.version === "0048")!;
    expect(migration.name).toBe("exports_tax_code");
    const update = migration.sql.slice(migration.sql.indexOf("update organisation_settings"), migration.sql.indexOf(";", migration.sql.indexOf("update organisation_settings")) + 1);
    const old = await run(async (tx) => {
      await tx.query("update organisation_settings set export_tax_code_id = null");
      await tx.query(update);
      const inserted = await tx.query<{ id: string }>(
        "insert into contacts (command_source, idempotency_key, request_hash, name, is_customer) values ('test', 'ex1-old', 'x', 'Old Customer', true) returning id",
      );
      return getContact(tx, inserted.rows[0].id);
    });
    expect(old).toMatchObject({ billingCountry: "NZ", deliveryCountry: null, defaultSalesTaxCode: null });
    expect(await run((tx) => getOrganisationSettings(tx))).toMatchObject({ foreignTrade: false, exportTaxCode: "ZERO" });
  });

  it("EX3: with Foreign trade off an overseas customer starts with the usual default", async () => {
    expect(await startingCode("Wombat Pty Ltd")).toBeNull();
    expect(await startingCode("Kobe Ltd")).toBeNull();
  });

  it("EX4: turning Foreign trade on (audited) makes an overseas customer's lines start with ZERO; the invoice has no GST", async () => {
    await run((tx) => updateOrganisationSettings(tx, { foreignTrade: true }));
    const audit = await run((tx) =>
      tx.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where event_type = 'organisation.settings_updated' order by id desc limit 1",
      ),
    );
    expect(audit.rows[0].details).toMatchObject({ foreignTrade: true });
    expect(await startingCode("Wombat Pty Ltd")).toBe("ZERO");
    const draft = await draftInvoice(people["Wombat Pty Ltd"].id, "2026-07-01", [line("500.00", "ZERO")]);
    const approved = await approve(draft.invoice.id);
    expect(approved).toMatchObject({ taxTotal: "0.00", total: "500.00" });
    const journal = await run((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((entry) => [entry.accountCode, entry.debitAmount, entry.creditAmount])).toEqual([
      ["1100", "500.00", "0.00"],
      ["4000", "0.00", "500.00"],
    ]);
  });

  it("EX2: a New Zealand customer keeps the usual GST", async () => {
    expect(await startingCode("Kobe Ltd")).toBeNull();
    const approved = await approve((await draftInvoice(people["Kobe Ltd"].id, "2026-07-02", [line("100.00", "GST")])).invoice.id);
    expect(approved).toMatchObject({ taxTotal: "15.00", total: "115.00" });
  });

  it("EX5: a contact's own default sales tax code comes first; an inactive one is refused", async () => {
    expect(await startingCode("Harbour Tours")).toBe("GST");
    expect(await startingCode("Rata Rentals")).toBe("EXEMPT");
    await run(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "OLD", label: "Old", category: "standard", rate: "0.15", effectiveFrom: "2010-10-01" });
      await tx.query("update tax_codes set is_active = false where code = 'OLD'");
    });
    await expect(run((tx) => updateContact(tx, people["Kobe Ltd"].id, { defaultSalesTaxCode: "OLD" }))).rejects.toThrow(
      "Tax code OLD is inactive, so it can't be a contact's default sales tax code.",
    );
    await expect(run((tx) => updateContact(tx, people["Kobe Ltd"].id, { defaultSalesTaxCode: "NOPE" }))).rejects.toThrow("There's no tax code NOPE.");
    // Clearing it, and the change is in the contact's history.
    const cleared = await run((tx) => updateContact(tx, people["Rata Rentals"].id, { defaultSalesTaxCode: "" }));
    expect(cleared.defaultSalesTaxCode).toBeNull();
    const restored = await run((tx) => updateContact(tx, people["Rata Rentals"].id, { defaultSalesTaxCode: "EXEMPT" }));
    expect(restored.defaultSalesTaxCode).toBe("EXEMPT");
    const history = await run((tx) =>
      tx.query<{ details: { changes: Record<string, unknown> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id",
        [people["Rata Rentals"].id],
      ),
    );
    expect(history.rows.map((row) => row.details.changes.defaultSalesTaxCode)).toEqual([
      { from: "EXEMPT", to: null },
      { from: null, to: "EXEMPT" },
    ]);
  });

  it("EX6: the delivery country beats the billing country", async () => {
    expect(await startingCode("Kiwi Gifts Ltd")).toBe("ZERO");
    expect(await startingCode("Sydney Visitors")).toBeNull();
  });

  it("EX7: a line changed by hand to GST saves as chosen (the warning never blocks)", async () => {
    const draft = await draftInvoice(people["Wombat Pty Ltd"].id, "2026-07-03", [line("200.00", "GST", "Consulting in Auckland")]);
    expect(draft.invoice).toMatchObject({ taxTotal: "30.00", total: "230.00" });
    expect(draft.invoice.lines[0].taxCode).toBe("GST");
  });

  it("EX8: saved documents don't change when the settings or the contact change", async () => {
    const draft = await draftInvoice(people["Wombat Pty Ltd"].id, "2026-07-04", [line("500.00", "ZERO")]);
    await run((tx) => updateOrganisationSettings(tx, { foreignTrade: false }));
    await run((tx) => updateContact(tx, people["Wombat Pty Ltd"].id, { billingCountry: "NZ" }));
    expect((await run((tx) => getInvoice(tx, draft.invoice.id))).lines[0].taxCode).toBe("ZERO");
    // Saving the draft again (e.g. a new reference) keeps its lines' codes.
    await run((tx) => updateInvoice(tx, draft.invoice.id, { reference: "PO 77" }));
    const approved = await approve(draft.invoice.id);
    expect(approved).toMatchObject({ reference: "PO 77", taxTotal: "0.00", total: "500.00" });
    expect(approved.lines[0].taxCode).toBe("ZERO");
    // Only new lines start differently.
    expect(await startingCode("Wombat Pty Ltd")).toBeNull();
    await run((tx) => updateContact(tx, people["Wombat Pty Ltd"].id, { billingCountry: "AU" }));
    await run((tx) => updateOrganisationSettings(tx, { foreignTrade: true }));
    expect(await startingCode("Wombat Pty Ltd")).toBe("ZERO");
  });

  it("EX9: a USD invoice to a New Zealand customer stays standard-rated", async () => {
    expect(await startingCode("Tui Traders")).toBeNull();
    const draft = await draftInvoice(people["Tui Traders"].id, "2026-07-05", [line("1000.00", "GST")], { exchangeRate: "1.60" });
    expect(draft.invoice).toMatchObject({ currencyCode: "USD", taxTotal: "150.00", total: "1150.00", baseTaxTotal: "240.00", baseTotal: "1840.00" });
  });

  it("EX10: an NZD invoice to a US customer is zero-rated", async () => {
    expect(await startingCode("Paws LLC")).toBe("ZERO");
    const draft = await draftInvoice(people["Paws LLC"].id, "2026-07-06", [line("800.00", "ZERO")]);
    expect(draft.invoice).toMatchObject({ currencyCode: "NZD", taxTotal: "0.00", total: "800.00" });
  });

  it("EX11: exports are in Box 5 and Box 6 of the GST return; exempt sales are in no box", async () => {
    const org = "ex-gst";
    await createTestOrganisation(owner, org);
    const inOrg = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await inOrg((tx) => updateOrganisationSettings(tx, { foreignTrade: true }));
    const customer = async (name: string, fields: Record<string, unknown> = {}) =>
      (await inOrg((tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true, ...fields }))).contact;
    const sale = async (contactId: string, invoiceDate: string, unitPrice: string, taxCode: string) => {
      const draft = await inOrg((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId, invoiceDate, dueDate: "2026-08-20", amountsMode: "exclusive", lines: [line(unitPrice, taxCode)] }),
      );
      return (await inOrg((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    };
    await sale((await customer("Kobe Ltd")).id, "2026-07-02", "100.00", "GST");
    await sale((await customer("Wombat Pty Ltd", { billingCountry: "AU" })).id, "2026-07-03", "500.00", "ZERO");
    await sale((await customer("Paws LLC", { billingCountry: "US" })).id, "2026-07-04", "800.00", "ZERO");
    await sale((await customer("Rata Rentals", { defaultSalesTaxCode: "EXEMPT" })).id, "2026-07-05", "400.00", "EXEMPT");
    const july = await inOrg((tx) => calculateGstReturn(tx, { periodStart: "2026-07-01", periodEnd: "2026-07-31" }));
    expect(july.boxes).toMatchObject({ box5: "1415.00", box6: "1300.00", box7: "115.00", box8: "15.00" });
  });

  it("EX13: the tax code for exports must be an active zero-rated code (audited); the database checks it too", async () => {
    const refusedBecause = "The tax code for exports must be zero-rated (like ZERO): exports are zero-rated, not exempt, so they count in Box 5 and Box 6 of the GST return.";
    await expect(run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "EXEMPT" }))).rejects.toThrow(`${refusedBecause} EXEMPT is exempt.`);
    await expect(run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "GST" }))).rejects.toThrow(`${refusedBecause} GST is standard-rated.`);
    await expect(run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "NONE" }))).rejects.toThrow(`${refusedBecause} NONE is no GST (out of scope).`);
    await run(async (tx) => {
      await createTaxCode(tx, { idempotencyKey: key("tax"), code: "ZOLD", label: "Old zero", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" });
      await tx.query("update tax_codes set is_active = false where code = 'ZOLD'");
    });
    await expect(run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "ZOLD" }))).rejects.toThrow("ZOLD is inactive");
    await expect(
      run((tx) => tx.query("update organisation_settings set export_tax_code_id = (select id from tax_codes where code = 'EXEMPT')")),
    ).rejects.toThrow("The tax code for exports must be zero-rated");
    await run((tx) => createTaxCode(tx, { idempotencyKey: key("tax"), code: "EXPORT", label: "Exports", category: "zero_rated", rate: "0", effectiveFrom: "2010-10-01" }));
    // Over HTTP, as an admin: accepted and audited.
    const response = await settingsRoute.PATCH(
      apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: await sessionCookieFor(owner), body: { exportTaxCode: "export" } }),
      params({ organisationId: ORG }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).settings).toMatchObject({ foreignTrade: true, exportTaxCode: "EXPORT" });
    const audit = await run((tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'organisation.settings_updated' order by id desc limit 1"),
    );
    expect(audit.rows[0].details).toMatchObject({ exportTaxCode: "EXPORT" });
    expect(await startingCode("Wombat Pty Ltd")).toBe("EXPORT");
    await run((tx) => updateOrganisationSettings(tx, { exportTaxCode: "ZERO" }));
  });

  it("EX14: countries by code or name; the contacts import and export carry them", async () => {
    await expect(run((tx) => updateContact(tx, people["Kobe Ltd"].id, { billingCountry: "XX" }))).rejects.toThrow(
      'Billing country "XX" isn\'t a country.',
    );
    await expect(run((tx) => updateContact(tx, people["Kobe Ltd"].id, { deliveryCountry: 5 }))).rejects.toThrow("Delivery country must be a country code");
    expect((await run((tx) => updateContact(tx, people["Kobe Ltd"].id, { billingCountry: "Australia" }))).billingCountry).toBe("AU");
    expect((await run((tx) => updateContact(tx, people["Kobe Ltd"].id, { billingCountry: "au" }))).billingCountry).toBe("AU");
    expect((await run((tx) => updateContact(tx, people["Kobe Ltd"].id, { billingCountry: "" }))).billingCountry).toBe("NZ");

    const text = "Name,Country,Delivery country\nBilby Traders,Australia,\nEagle Inc,US,\nHuia Ltd,,\nKakapo Co,,AU";
    const rows = parseDelimited(text);
    const headerRow = findHeaderRow("contacts", rows);
    const records = applyMapping(rows, headerRow, autoMap("contacts", rows[headerRow], "tohyee"));
    const result = await run((tx) => importMasterRecords(tx, { kind: "contacts", records, idempotencyKey: key("import"), commit: true }));
    expect(result.problems).toEqual([]);
    const byName = new Map((await run((tx) => listContacts(tx))).map((entry) => [entry.name, entry]));
    expect(["Bilby Traders", "Eagle Inc", "Huia Ltd", "Kakapo Co"].map((name) => [byName.get(name)?.billingCountry, byName.get(name)?.deliveryCountry])).toEqual([
      ["AU", null],
      ["US", null],
      ["NZ", null],
      ["NZ", "AU"],
    ]);
    const exported = await run((tx) => exportCsv(tx, "contacts"));
    expect(exported.csv.split("\r\n")[0]).toMatch(/,Country,Delivery country$/);
    expect(exported.csv).toMatch(/\r\nKakapo Co,.*,NZ,AU(\r\n|$)/);
  });

  it("EX15: CRM invoices use the same starting code; credit notes, quotes and repeating invoices save ZERO for an export", async () => {
    await run((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const wonInvoice = async (name: string) => {
      const deal = await run((tx) => createOpportunity(tx, { name: `Deal with ${name}`, contactId: people[name].id, amount: "100.00" }));
      await run((tx) => updateOpportunity(tx, deal.id, { stage: "won" }));
      return (await run((tx) => makeInvoiceFromOpportunity(tx, deal.id))).invoice;
    };
    expect((await wonInvoice("Wombat Pty Ltd")).lines.map((entry) => entry.taxCode)).toEqual(["ZERO"]);
    expect((await wonInvoice("Harbour Tours")).lines.map((entry) => entry.taxCode)).toEqual(["GST"]);
    expect((await wonInvoice("Kobe Ltd")).lines.map((entry) => entry.taxCode)).toEqual(["GST"]);

    const wombat = people["Wombat Pty Ltd"].id;
    const credit = await run((tx) =>
      createCreditNote(tx, { idempotencyKey: key("cn"), contactId: wombat, creditNoteDate: "2026-07-10", amountsMode: "exclusive", lines: [line("50.00", "ZERO")] }),
    );
    expect(credit.creditNote).toMatchObject({ taxTotal: "0.00", total: "50.00" });
    const quote = await run((tx) =>
      createQuote(tx, { idempotencyKey: key("quote"), contactId: wombat, quoteDate: "2026-07-10", amountsMode: "exclusive", lines: [line("300.00", "ZERO")] }),
    );
    expect(quote.quote).toMatchObject({ taxTotal: "0.00", total: "300.00" });
    const template = await run((tx) =>
      createRepeatingInvoice(tx, {
        idempotencyKey: key("ri"),
        contactId: wombat,
        amountsMode: "exclusive",
        lines: [line("100.00", "ZERO")],
        period: "month",
        every: 1,
        startDate: "2026-08-01",
        dueRule: "days_after",
        dueDays: 20,
        saveAs: "draft",
      }),
    );
    expect(template.repeatingInvoice.lines[0].taxCode).toBe("ZERO");
  });
});
