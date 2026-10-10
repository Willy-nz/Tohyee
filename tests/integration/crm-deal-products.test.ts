import { afterAll, beforeAll, expect, it } from "vitest";
import * as quoteRoute from "@/app/api/crm/opportunities/[opportunityId]/quote/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { dealQuotes, makeQuoteFromDeal, setDealLines } from "@/lib/crm/deal-lines";
import { createOpportunity, getOpportunity, updateOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, getInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { acceptQuote, acceptQuoteAsSalesOrder, finaliseQuote, getQuote } from "@/lib/quotes/service";
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

const ORG = "crm-deal-products";

/** Examples DS7-DS9 (approved by Jess 10 Oct 2026), decision 502: deal products, quotes and winning the deal. */
describeWithDatabase("CRM deal products and quotes (DS7-DS9)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let contactId = "";
  let keyringId = "";

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const asRep = <T>(work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) =>
    inOrganisation(ORG, { userId: rep.id, email: rep.email }, async (tx) => work(tx, await crmScope(tx, "sales_rep", rep.id)));
  const deal = (name: string) => as((tx) => createOpportunity(tx, { name, contactId, ownerUserId: rep.id, amount: "0.00", closeDate: "2026-12-31", stage: "proposal" }));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep')", [ORG, rep.id]);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    contactId = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
    keyringId = (
      await as((tx) => createItem(tx, { idempotencyKey: key("i"), code: "KEYRING", name: "Paw print keyring", itemType: "service", salePrice: "25.00", incomeAccountCode: "4000", salesTaxCode: "GST" }))
    ).item.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("DS7: a deal's products set its amount (excl. GST), which then can't be typed; Make quote copies them", async () => {
    const clinic = await deal("Clinic keyrings");
    const set = await asRep((tx, scope) =>
      setDealLines(tx, clinic.id, { lines: [{ itemId: keyringId, quantity: "20", discountPercent: "10" }, { description: "Setup", quantity: "1", unitPrice: "50.00" }] }, scope),
    );
    expect(set.lines.map((line) => [line.description, line.unitPrice, line.discountPercent, line.lineAmount])).toEqual([
      ["Paw print keyring", "25", "10.00", "450.00"],
      ["Setup", "50", "0.00", "50.00"],
    ]);
    expect(set.opportunity.amount).toBe("500.00");
    await expect(as((tx) => updateOpportunity(tx, clinic.id, { amount: "600.00" }))).rejects.toThrow(/comes from its products/);

    // A sales rep can't make a quote: it's in the books (decision 491).
    const repTry = await quoteRoute.POST(
      apiRequest(`/api/crm/opportunities/${clinic.id}/quote`, { method: "POST", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, idempotencyKey: key("q") } }),
      params({ opportunityId: clinic.id }),
    );
    expect(repTry.status).toBe(403);
    const quoteKey = key("q");
    const made = await as((tx) => makeQuoteFromDeal(tx, clinic.id, { idempotencyKey: quoteKey, quoteDate: "2026-10-12" }));
    expect(made.quote).toMatchObject({ status: "draft", amountsMode: "exclusive", subtotal: "500.00", taxTotal: "75.00", total: "575.00", expiryDate: "2026-11-11" });
    expect(made.quote.lines.map((line) => [line.description, line.discountPercent, line.accountCode, line.taxCode, line.itemId])).toEqual([
      ["Paw print keyring", "10.00", "4000", "GST", keyringId],
      ["Setup", "0.00", "4000", "GST", null],
    ]);
    // A retry with the same key is the same quote.
    expect((await as((tx) => makeQuoteFromDeal(tx, clinic.id, { idempotencyKey: quoteKey }))).quote.id).toBe(made.quote.id);
    expect((await as((tx) => dealQuotes(tx, clinic.id))).length).toBe(1);
  });

  it("DS8-DS9: a new revision declines the finalised quote; accepting the new one wins the deal and links its invoice", async () => {
    const clinic = await deal("Clinic keyrings 2");
    await as((tx) => setDealLines(tx, clinic.id, { lines: [{ itemId: keyringId, quantity: "20", discountPercent: "10" }, { description: "Setup", quantity: "1", unitPrice: "50.00" }] }));
    const first = await as((tx) => makeQuoteFromDeal(tx, clinic.id, { idempotencyKey: key("q"), quoteDate: "2026-10-12" }));
    const finalised = await as((tx) => finaliseQuote(tx, first.quote.id, { idempotencyKey: key("f") }));
    // The keyrings go up to 25.
    const changed = await as((tx) =>
      setDealLines(tx, clinic.id, { lines: [{ itemId: keyringId, quantity: "25", discountPercent: "10" }, { description: "Setup", quantity: "1", unitPrice: "50.00" }] }),
    );
    expect(changed.opportunity.amount).toBe("612.50");
    const second = await as((tx) => makeQuoteFromDeal(tx, clinic.id, { idempotencyKey: key("q"), quoteDate: "2026-10-15" }));
    expect(second.replaced).toBe(finalised.quote.quoteNumber);
    expect((await as((tx) => getQuote(tx, first.quote.id))).status).toBe("declined");
    expect(second.quote).toMatchObject({ subtotal: "612.50", taxTotal: "91.88", total: "704.38" });

    await as((tx) => finaliseQuote(tx, second.quote.id, { idempotencyKey: key("f") }));
    const accepted = await as((tx) => acceptQuote(tx, second.quote.id, { idempotencyKey: key("a"), invoiceDate: "2026-10-20", dueDate: "2026-11-20" }));
    const won = await as((tx) => getOpportunity(tx, clinic.id));
    expect(won).toMatchObject({ stageType: "won", invoiceId: accepted.invoice.id, amount: "612.50" });
    const invoice = await as((tx) => getInvoice(tx, accepted.invoice.id));
    expect(invoice.lines.map((line) => [line.discountPercent, line.lineAmount])).toEqual([
      ["10.00", "562.50"],
      ["0.00", "50.00"],
    ]);
    const approved = (await as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("ap") }))).invoice;
    expect((await as((tx) => getJournal(tx, approved.approvalJournalId!))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1100", "704.38", "0.00"],
      ["4000", "0.00", "612.50"],
      ["2100", "0.00", "91.88"],
    ]);
    // Closed now: no more products or quotes.
    await expect(as((tx) => setDealLines(tx, clinic.id, { lines: [] }))).rejects.toThrow(/closed/);
    await expect(as((tx) => makeQuoteFromDeal(tx, clinic.id, { idempotencyKey: key("q") }))).rejects.toThrow(/open deal/);
  });

  it("a deal without products quotes its amount as one line; accepting as a sales order links the order", async () => {
    const simple = await as((tx) => createOpportunity(tx, { name: "Collars", contactId, ownerUserId: rep.id, amount: "200.00", closeDate: "2026-12-31", stage: "proposal" }));
    const made = await as((tx) => makeQuoteFromDeal(tx, simple.id, { idempotencyKey: key("q"), quoteDate: "2026-10-12" }));
    expect(made.quote.lines.map((line) => [line.description, line.lineAmount])).toEqual([["Collars", "200.00"]]);
    // A new revision of a draft just replaces it.
    const again = await as((tx) => makeQuoteFromDeal(tx, simple.id, { idempotencyKey: key("q"), quoteDate: "2026-10-13" }));
    expect(again.replaced).toBeNull();
    expect((await as((tx) => dealQuotes(tx, simple.id))).map((quote) => quote.id)).toEqual([again.quote.id]);
    await as((tx) => finaliseQuote(tx, again.quote.id, { idempotencyKey: key("f") }));
    const order = await as((tx) => acceptQuoteAsSalesOrder(tx, again.quote.id, { idempotencyKey: key("a"), orderDate: "2026-10-20" }));
    expect(await as((tx) => getOpportunity(tx, simple.id))).toMatchObject({ stageType: "won", salesOrderId: order.salesOrder.id });
  });

  it("checks lines: a price or an item's, more than nothing, and a discount from 0 to 100", async () => {
    const d = await deal("Checks");
    await expect(as((tx) => setDealLines(tx, d.id, { lines: [{ description: "No price", quantity: "1" }] }))).rejects.toThrow(/needs a unit price/);
    await expect(as((tx) => setDealLines(tx, d.id, { lines: [{ description: "X", quantity: "0", unitPrice: "5" }] }))).rejects.toThrow(/must not be zero|more than 0/);
    await expect(as((tx) => setDealLines(tx, d.id, { lines: [{ description: "X", quantity: "1", unitPrice: "5", discountPercent: "150" }] }))).rejects.toThrow(/0 to 100/);
    // Removing every line lets the amount be typed again.
    await as((tx) => setDealLines(tx, d.id, { lines: [{ description: "X", quantity: "1", unitPrice: "5" }] }));
    await as((tx) => setDealLines(tx, d.id, { lines: [] }));
    expect((await as((tx) => updateOpportunity(tx, d.id, { amount: "80.00" }))).amount).toBe("80.00");
  });
});
