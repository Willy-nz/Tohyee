import { afterAll, beforeAll, expect, it } from "vitest";
import * as quotesRoute from "@/app/api/quotes/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { archiveContact, type Contact, createContact } from "@/lib/contacts/service";
import { getCustomerSetup } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, deleteInvoice, getInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import {
  acceptQuote,
  copyQuote,
  createQuote,
  declineQuote,
  deleteQuote,
  finaliseQuote,
  getQuote,
  listQuotes,
  quoteForInvoice,
  updateQuote,
} from "@/lib/quotes/service";
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

/** Examples QT1-QT8 in docs/ACCOUNTING-EXAMPLES.md ("Quotes"). Each test gets its own organisation. */
describeWithDatabase("quotes", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("quotes-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("quotes-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `quotes-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    const terms = (await as((tx) => getCustomerSetup(tx))).paymentTerms;
    const twentieth = terms.find((t) => t.name === "20th of the following month")!.id;
    const customer = async (name: string, extra: Record<string, unknown> = {}): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true, ...extra }))).contact;
    const kobe = await customer("Kobe Cafe", { paymentTermId: twentieth, postalAddress: "12 George St, Dunedin 9016" });
    const lines = [
      { description: "Paw print pendant", quantity: "2", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" },
      { description: "Engraving", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" },
    ];
    const draft = async (extra: Record<string, unknown> = {}) =>
      (
        await as((tx) =>
          createQuote(tx, {
            idempotencyKey: key("quote"),
            contactId: kobe.id,
            quoteDate: "2026-07-15",
            expiryDate: "2026-08-14",
            terms: "Valid for 30 days.",
            amountsMode: "exclusive",
            lines,
            ...extra,
          }),
        )
      ).quote;
    const finalise = async (id: string) => (await as((tx) => finaliseQuote(tx, id, { idempotencyKey: key("fin") }))).quote;
    return { org, as, kobe, customer, draft, finalise, lines };
  }

  it("QT1: a draft quote works out like an invoice and posts nothing", async () => {
    const w = await setup();
    const quote = await w.draft();
    expect([quote.status, quote.quoteNumber, quote.subtotal, quote.taxTotal, quote.total]).toEqual(["draft", null, "275.00", "41.25", "316.25"]);
    expect(quote.lines.map((l) => [l.lineAmount, l.taxAmount])).toEqual([["240.00", "36.00"], ["35.00", "5.25"]]);
    const journals = await w.as((tx) => tx.query("select 1 from ledger_journals"));
    expect(journals.rowCount).toBe(0);
    const edited = await w.as((tx) => updateQuote(tx, quote.id, { reference: "Kobe order" }));
    expect(edited.reference).toBe("Kobe order");
  });

  it("QT2: finalising numbers QU-0001 with no gaps and locks the quote", async () => {
    const w = await setup();
    const quote = await w.finalise((await w.draft()).id);
    expect([quote.status, quote.quoteNumber]).toEqual(["finalised", "QU-0001"]);
    await expect(w.as((tx) => updateQuote(tx, quote.id, { reference: "x" }))).rejects.toThrow("finalised, so it can't be edited");
    await expect(w.as((tx) => deleteQuote(tx, quote.id))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update quote_lines set description = 'x' where quote_id = $1", [quote.id]))).rejects.toThrow(
      "Lines of a finalised quote can't be changed",
    );
    await expect(w.as((tx) => tx.query("update quotes set total = 1 where id = $1", [quote.id]))).rejects.toThrow("can't be changed");
    // A refused finalise rolls the counter back.
    const rata = await w.customer("Rata Ltd");
    const second = await w.draft({ contactId: rata.id });
    await w.as((tx) => archiveContact(tx, rata.id));
    await expect(w.finalise(second.id)).rejects.toThrow("Rata Ltd is archived");
    expect((await w.as((tx) => getQuote(tx, second.id))).status).toBe("draft");
    expect((await w.finalise((await w.draft()).id)).quoteNumber).toBe("QU-0002");
  });

  it("QT3: accepting makes a draft invoice with the quote's lines, linked both ways", async () => {
    const w = await setup();
    const quote = await w.finalise((await w.draft()).id);
    const acceptKey = key("accept");
    const accepted = await w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: acceptKey, invoiceDate: "2026-07-20" }));
    const invoice = accepted.invoice;
    expect([invoice.status, invoice.contactId, invoice.invoiceDate, invoice.dueDate, invoice.reference, invoice.total]).toEqual([
      "draft",
      w.kobe.id,
      "2026-07-20",
      "2026-08-20",
      "QU-0001",
      "316.25",
    ]);
    expect(invoice.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineAmount])).toEqual(
      quote.lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineAmount]),
    );
    expect([accepted.quote.status, accepted.quote.invoiceId]).toEqual(["accepted", invoice.id]);
    expect(await w.as((tx) => quoteForInvoice(tx, invoice.id))).toEqual({ id: quote.id, quoteNumber: "QU-0001" });
    const again = await w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: acceptKey, invoiceDate: "2026-07-20" }));
    expect([again.created, again.invoice.id]).toEqual([false, invoice.id]);
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).invoice;
    expect(approved.invoiceNumber).toBe("INV-0001");
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([
      ["1100", "316.25", "0.00"],
      ["4000", "0.00", "275.00"],
      ["2100", "0.00", "41.25"],
    ]);
  });

  it("QT4: declining closes a quote; accepted and declined quotes can't change again", async () => {
    const w = await setup();
    const first = await w.finalise((await w.draft()).id);
    const second = await w.finalise((await w.draft()).id);
    await w.as((tx) => acceptQuote(tx, first.id, { idempotencyKey: key("accept"), invoiceDate: "2026-07-20" }));
    const declined = (await w.as((tx) => declineQuote(tx, second.id, { idempotencyKey: key("decline") }))).quote;
    expect(declined.status).toBe("declined");
    await expect(w.as((tx) => acceptQuote(tx, second.id, { idempotencyKey: key("accept"), invoiceDate: "2026-07-20" }))).rejects.toThrow(
      "already declined",
    );
    await expect(w.as((tx) => declineQuote(tx, first.id, { idempotencyKey: key("decline") }))).rejects.toThrow("already accepted");
  });

  it("QT5: expired quotes are listed by their expiry date", async () => {
    const w = await setup();
    const past = await w.finalise((await w.draft({ quoteDate: "2026-01-05", expiryDate: "2026-01-31" })).id);
    const open = await w.finalise((await w.draft({ quoteDate: "2026-01-05", expiryDate: null })).id);
    const draft = await w.draft({ quoteDate: "2026-01-05", expiryDate: "2026-01-31" });
    expect(past.expired).toBe(true);
    expect(open.expired).toBe(false);
    expect(draft.expired).toBe(false);
    const expired = await w.as((tx) => listQuotes(tx, { status: "expired" }));
    expect(expired.quotes.map((q) => q.id)).toEqual([past.id]);
    const finalised = await w.as((tx) => listQuotes(tx, { status: "finalised" }));
    expect(finalised.quotes.map((q) => q.id)).toEqual([open.id]);
    // An expired quote can still be accepted, as in Xero.
    const accepted = await w.as((tx) => acceptQuote(tx, past.id, { idempotencyKey: key("accept"), invoiceDate: "2026-02-05", dueDate: "2026-02-20" }));
    expect(accepted.quote.expired).toBe(false);
  });

  it("QT6: copying makes a new draft with the same lines and expiry period", async () => {
    const w = await setup();
    const original = await w.finalise((await w.draft()).id);
    const copy = (await w.as((tx) => copyQuote(tx, original.id, { idempotencyKey: key("copy"), quoteDate: "2026-09-01" }))).quote;
    expect([copy.status, copy.quoteNumber, copy.quoteDate, copy.expiryDate, copy.total, copy.copiedFromQuoteId, copy.terms]).toEqual([
      "draft",
      null,
      "2026-09-01",
      "2026-10-01",
      "316.25",
      original.id,
      "Valid for 30 days.",
    ]);
    expect(copy.lines.map((l) => l.description)).toEqual(["Paw print pendant", "Engraving"]);
    // A copy is checked like a new quote: an archived customer is refused.
    await w.as((tx) => archiveContact(tx, w.kobe.id));
    await expect(w.as((tx) => copyQuote(tx, original.id, { idempotencyKey: key("copy"), quoteDate: "2026-09-02" }))).rejects.toThrow(
      "Kobe Cafe is archived",
    );
  });

  it("QT7: the invoice an accepted quote made can't be deleted", async () => {
    const w = await setup();
    const quote = await w.finalise((await w.draft()).id);
    const { invoice } = await w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("accept"), invoiceDate: "2026-07-20" }));
    await expect(w.as((tx) => deleteInvoice(tx, invoice.id))).rejects.toThrow("made by accepting quote QU-0001");
    expect((await w.as((tx) => getInvoice(tx, invoice.id))).status).toBe("draft");
  });

  it("QT8: refusals, and a viewer can see quotes but not save them", async () => {
    const w = await setup();
    const draft = await w.draft();
    await expect(w.as((tx) => acceptQuote(tx, draft.id, { idempotencyKey: key("a"), invoiceDate: "2026-07-20" }))).rejects.toThrow("Finalise this quote");
    await expect(w.as((tx) => declineQuote(tx, draft.id, { idempotencyKey: key("d") }))).rejects.toThrow("still a draft");
    await w.finalise(draft.id);
    await expect(w.finalise(draft.id)).rejects.toThrow("already finalised");
    await expect(w.draft({ lines: [] })).rejects.toThrow("A quote needs at least one line.");
    await expect(w.draft({ expiryDate: "2026-07-01" })).rejects.toThrow("expiry date can't be before");

    const cookie = await sessionCookieFor(viewer);
    const list = await quotesRoute.GET(apiRequest(`/api/quotes?organisationId=${w.org}`, { cookie }), noContext);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { quotes: unknown[] }).quotes).toHaveLength(1);
    const post = await quotesRoute.POST(
      apiRequest("/api/quotes", {
        method: "POST",
        cookie,
        body: { organisationId: w.org, idempotencyKey: key("q"), contactId: w.kobe.id, quoteDate: "2026-07-15", amountsMode: "exclusive", lines: w.lines },
      }),
      noContext,
    );
    expect(post.status).toBe(403);
  });
});
