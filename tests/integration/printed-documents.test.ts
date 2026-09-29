import { afterAll, beforeAll, expect, it } from "vitest";
import * as printRoute from "@/app/api/documents/print/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { printedDocument } from "@/lib/documents/print";
import { recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, voidInvoice } from "@/lib/invoices/service";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { acceptQuote, createQuote, finaliseQuote } from "@/lib/quotes/service";
import { createTaxCode } from "@/lib/tax/codes";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples PD1-PD8 in docs/ACCOUNTING-EXAMPLES.md ("Printed invoices, credit notes and quotes"). */
describeWithDatabase("printed documents", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("print-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("print-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `print-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const settings = await as((tx) =>
      updateOrganisationSettings(tx, {
        displayName: "Glimmers",
        postalAddress: "PO Box 5, Dunedin",
        gstNumber: "123-456-789",
        paymentDetails: "Pay into 12-3456-7890123-00 with your invoice number",
      }),
    );
    expect(settings.gstNumber).toBe("123456789");
    const customer = async (name: string, postalAddress?: string) =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true, postalAddress }))).contact;
    const kobe = await customer("Kobe Cafe", "12 George St, Dunedin 9016");
    const paw = await customer("Paw Walkers");
    const lines = [
      { description: "Paw print pendant", quantity: "2", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" },
      { description: "Engraving", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" },
    ];
    const quote = (
      await as((tx) =>
        createQuote(tx, { idempotencyKey: key("q"), contactId: kobe.id, quoteDate: "2026-07-15", expiryDate: "2026-08-14", terms: "Valid for 30 days.", amountsMode: "exclusive", lines }),
      )
    ).quote;
    await as((tx) => finaliseQuote(tx, quote.id, { idempotencyKey: key("f") }));
    const { invoice: draftInvoice } = await as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("a"), invoiceDate: "2026-07-20", dueDate: "2026-08-20" }));
    const invoice = (await as((tx) => approveInvoice(tx, draftInvoice.id, { idempotencyKey: key("ap") }))).invoice;
    const newInvoice = async (contactId: string, amountsMode: string, amount: string, approve = true) => {
      const draft = (
        await as((tx) =>
          createInvoice(tx, {
            idempotencyKey: key("i"),
            contactId,
            invoiceDate: "2026-07-21",
            dueDate: "2026-08-20",
            amountsMode,
            lines: [{ description: "Keepsake", quantity: "1", unitPrice: amount, accountCode: "4000", taxCode: amountsMode === "no_tax" ? null : "GST" }],
          }),
        )
      ).invoice;
      return approve ? (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("ap") }))).invoice : draft;
    };
    const print = (kind: string, id: string) => as((tx) => printedDocument(tx, kind, id));
    return { org, as, kobe, paw, quote, invoice, newInvoice, print };
  }

  it("PD1 and PD2: an approved invoice is a tax invoice with everything the rules ask for", async () => {
    const w = await setup();
    const doc = await w.print("invoice", w.invoice.id);
    expect(doc).toMatchObject({
      labels: { title: "Tax invoice", isTaxDocument: true, gstLine: true, includesGstStatement: false, buyerAddressRequired: false, warnings: [] },
      organisation: { name: "Glimmers", postalAddress: "PO Box 5, Dunedin", gstNumber: "123456789" },
      customer: { name: "Kobe Cafe", billingAddress: "12 George St, Dunedin 9016" },
      number: "INV-0001",
      date: "2026-07-20",
      dueDate: "2026-08-20",
      subtotal: "275.00",
      taxTotal: "41.25",
      total: "316.25",
      amountPaid: "0.00",
      amountDue: "316.25",
      paymentDetails: "Pay into 12-3456-7890123-00 with your invoice number",
    });
    expect(doc.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineAmount, l.taxAmount])).toEqual([
      ["Paw print pendant", "2", "120", "240.00", "36.00"],
      ["Engraving", "1", "35", "35.00", "5.25"],
    ]);
    await w.as((tx) => recordPayment(tx, w.invoice.id, { idempotencyKey: key("pay"), paymentDate: "2026-07-25", amount: "100.00", bankAccountCode: "1000" }));
    const paid = await w.print("invoice", w.invoice.id);
    expect([paid.amountPaid, paid.amountDue]).toEqual(["100.00", "216.25"]);
  });

  it("PD3 and PD4: over $1,000 the buyer's address is required", async () => {
    const w = await setup();
    const kobe = await w.print("invoice", (await w.newInvoice(w.kobe.id, "inclusive", "1150.00")).id);
    expect(kobe.labels).toMatchObject({ title: "Tax invoice", gstLine: false, includesGstStatement: true, buyerAddressRequired: true, warnings: [] });
    expect([kobe.total, kobe.taxTotal]).toEqual(["1150.00", "150.00"]);
    const paw = await w.print("invoice", (await w.newInvoice(w.paw.id, "inclusive", "1150.00")).id);
    expect(paw.labels.warnings).toEqual([
      "This invoice is over $1,000, so a tax invoice must identify the customer by more than their name. Tohyee prints the billing address, and this customer has none: add one to the contact, then print it again.",
    ]);
    const exactly = await w.print("invoice", (await w.newInvoice(w.paw.id, "inclusive", "1000.00")).id);
    expect([exactly.total, exactly.taxTotal, exactly.labels.buyerAddressRequired, exactly.labels.warnings]).toEqual(["1000.00", "130.43", false, []]);
  });

  it("PD5: drafts and voided invoices", async () => {
    const w = await setup();
    const draft = await w.print("invoice", (await w.newInvoice(w.kobe.id, "exclusive", "50.00", false)).id);
    expect([draft.labels.title, draft.number, draft.organisation.gstNumber, draft.paymentDetails, draft.amountDue]).toEqual([
      "Draft invoice",
      null,
      null,
      null,
      null,
    ]);
    const approved = await w.newInvoice(w.kobe.id, "exclusive", "50.00");
    await w.as((tx) => voidInvoice(tx, approved.id, { idempotencyKey: key("v"), voidDate: "2026-07-22" }));
    const voided = await w.print("invoice", approved.id);
    expect([voided.labels.title, voided.paymentDetails]).toEqual(["Voided invoice", null]);
  });

  it("PD6: without a GST number, or with no tax, it prints Invoice", async () => {
    const w = await setup();
    const noTax = await w.print("invoice", (await w.newInvoice(w.kobe.id, "no_tax", "80.00")).id);
    expect([noTax.labels.title, noTax.labels.warnings, noTax.organisation.gstNumber]).toEqual(["Invoice", [], null]);
    await w.as((tx) => updateOrganisationSettings(tx, { gstNumber: null }));
    const unregistered = await w.print("invoice", w.invoice.id);
    expect([unregistered.labels.title, unregistered.organisation.gstNumber]).toEqual(["Invoice", null]);
    expect(unregistered.labels.warnings[0]).toMatch(/no GST number in Settings/);
    await expect(w.as((tx) => updateOrganisationSettings(tx, { gstNumber: "12-34" }))).rejects.toThrow("8 or 9 digits");
  });

  it("PD7: a credit note", async () => {
    const w = await setup();
    const draft = (
      await w.as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: w.kobe.id,
          creditNoteDate: "2026-07-25",
          amountsMode: "exclusive",
          lines: [{ description: "Engraving refund", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).creditNote;
    const approved = (await w.as((tx) => approveCreditNote(tx, draft.id, { idempotencyKey: key("ap") }))).creditNote;
    const doc = await w.print("credit_note", approved.id);
    expect([doc.labels.title, doc.number, doc.organisation.gstNumber, doc.subtotal, doc.taxTotal, doc.total, doc.dueDate, doc.paymentDetails]).toEqual([
      "Credit note",
      "CN-0001",
      "123456789",
      "35.00",
      "5.25",
      "40.25",
      null,
      null,
    ]);
  });

  it("PD8: a quote, printed by a viewer, posts nothing", async () => {
    const w = await setup();
    const journalsBefore = (await w.as((tx) => tx.query("select count(*)::int as n from ledger_journals"))).rows[0];
    const cookie = await sessionCookieFor(viewer);
    const response = await printRoute.GET(
      apiRequest(`/api/documents/print?organisationId=${w.org}&kind=quote&id=${w.quote.id}`, { cookie }),
      noContext,
    );
    expect(response.status).toBe(200);
    const { document } = (await response.json()) as { document: Awaited<ReturnType<typeof printedDocument>> };
    expect([document.labels.title, document.number, document.expiryDate, document.terms, document.taxTotal, document.total, document.organisation.gstNumber, document.paymentDetails]).toEqual([
      "Quote",
      "QU-0001",
      "2026-08-14",
      "Valid for 30 days.",
      "41.25",
      "316.25",
      null,
      null,
    ]);
    const journalsAfter = (await w.as((tx) => tx.query("select count(*)::int as n from ledger_journals"))).rows[0];
    expect(journalsAfter).toEqual(journalsBefore);
  });
});
