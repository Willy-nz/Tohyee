import { afterAll, beforeAll, expect, it } from "vitest";
import * as stripeRoute from "@/app/api/bank-feeds/stripe/route";
import * as printRoute from "@/app/api/documents/print/route";
import * as payNowRoute from "@/app/api/invoices/[invoiceId]/pay-now/route";
import * as paymentsRoute from "@/app/api/invoices/[invoiceId]/payments/route";
import * as voidRoute from "@/app/api/invoices/[invoiceId]/void/route";
import * as onlinePaymentsRoute from "@/app/api/online-payments/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { setStripeFetchForTests, type StripeBalanceTransaction, type StripeCheckoutSession } from "@/lib/bank/stripe/client";
import { connectStripe, linkStripeBalance, syncStripe, unlinkStripeBalance } from "@/lib/bank/stripe/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { prepareDocumentEmail } from "@/lib/email/documents";
import { listPayments, recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  checkOnlinePayments,
  dismissOnlinePaymentNotice,
  enableOnlinePayments,
  ensurePaymentLink,
  exactRate,
  getInvoicePayNow,
  getOnlinePaymentStatus,
} from "@/lib/payments/stripe";
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

const KEY = "rk_live_abcdefghijklmnop1234";
const noContext = undefined as unknown;
/** A NZ time as Unix seconds (October is NZDT, UTC+13). */
const nz = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 13, minute) / 1000;

type Link = { id: string; url: string; active: boolean; form: URLSearchParams; headers: Record<string, string> };

/** A pretend Stripe: payment links, their checkout sessions, the balance and balance transactions. */
const stripe = {
  links: [] as Link[],
  sessions: new Map<string, StripeCheckoutSession[]>(),
  transactions: [] as StripeBalanceTransaction[],
  idempotency: new Map<string, string>(),
  deactivated: [] as string[],
  unreachable: false,
};

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (headers.Authorization !== `Bearer ${KEY}`) return Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
  if (stripe.unreachable) throw new Error("connect ECONNREFUSED");
  if (url.pathname === "/v1/balance") return Response.json({ available: [{ amount: 0, currency: "nzd" }], pending: [{ amount: 0, currency: "nzd" }] });
  if (url.pathname === "/v1/payment_links" && init?.method === "POST") {
    const idem = headers["Idempotency-Key"];
    const earlier = idem ? stripe.idempotency.get(idem) : undefined;
    const existing = stripe.links.find((link) => link.id === earlier);
    if (existing) return Response.json({ id: existing.id, url: existing.url, active: existing.active });
    const id = `plink_${stripe.links.length + 1}`;
    const link = { id, url: `https://buy.stripe.com/test_${stripe.links.length + 1}`, active: true, form: new URLSearchParams(String(init.body)), headers };
    stripe.links.push(link);
    if (idem) stripe.idempotency.set(idem, id);
    return Response.json({ id, url: link.url, active: true });
  }
  const linkMatch = /^\/v1\/payment_links\/(plink_\d+)$/.exec(url.pathname);
  if (linkMatch && init?.method === "POST") {
    const link = stripe.links.find((entry) => entry.id === linkMatch[1]);
    if (!link) return Response.json({ error: { message: "No such payment link" } }, { status: 404 });
    link.active = new URLSearchParams(String(init.body)).get("active") !== "false";
    stripe.deactivated.push(link.id);
    return Response.json({ id: link.id, url: link.url, active: link.active });
  }
  if (url.pathname === "/v1/checkout/sessions") {
    const sessions = (stripe.sessions.get(url.searchParams.get("payment_link") ?? "") ?? []).filter((session) => session.status === url.searchParams.get("status"));
    return Response.json({ object: "list", data: sessions, has_more: false });
  }
  if (url.pathname === "/v1/balance_transactions") {
    const since = Number(url.searchParams.get("created[gte]"));
    const data = stripe.transactions.filter((item) => item.created >= since).sort((left, right) => right.created - left.created);
    return Response.json({ object: "list", data, has_more: false });
  }
  return Response.json({ error: { message: "not found" } }, { status: 404 });
}

/** A paid checkout session on a link, with its payment, charge and balance transaction (PN3). */
function paidSession(
  linkId: string,
  fields: { id: string; amount: number; currency?: string; created: number; settled?: { amount: number; currency: string; rate?: number }; paymentStatus?: string },
): StripeCheckoutSession {
  const settled = fields.settled ?? { amount: fields.amount, currency: fields.currency ?? "nzd" };
  const session: StripeCheckoutSession = {
    id: fields.id,
    status: "complete",
    payment_status: fields.paymentStatus ?? "paid",
    amount_total: fields.amount,
    currency: fields.currency ?? "nzd",
    created: fields.created - 60,
    payment_link: linkId,
    payment_intent: {
      id: `pi_${fields.id}`,
      latest_charge: {
        id: `ch_${fields.id}`,
        created: fields.created,
        balance_transaction: {
          id: `txn_${fields.id}`,
          amount: settled.amount,
          currency: settled.currency,
          created: fields.created,
          exchange_rate: settled.rate ?? null,
          type: "charge",
        },
      },
    },
  };
  stripe.sessions.set(linkId, [...(stripe.sessions.get(linkId) ?? []), session]);
  return session;
}

/**
 * Examples PN1-PN12 in docs/ACCOUNTING-EXAMPLES.md ("Online invoice payments
 * with Stripe"). The ST setup: 1050 Stripe linked to Stripe's NZD balance,
 * Kobe Ltd with INV-0010 for 115.00. A pretend Stripe answers; the examples
 * run in order on one organisation.
 */
describeWithDatabase("online invoice payments with Stripe (PN1-PN12)", () => {
  const org = "pay-now-co";
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let viewer: SessionUser;
  const cookies = new Map<string, string>();
  let kobeId = "";
  let stripeAccountId = "";
  const invoices: Record<string, string> = {};

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actor = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const check = async () => checkOnlinePayments(await organisation(), actor(mere));
  const ensure = async (invoiceId: string) => ensurePaymentLink(await organisation(), actor(mere), invoiceId);
  const linkFor = (url: string | null) => stripe.links.find((link) => link.url === url)!;

  async function invoice(name: string, unitPrice: string, extra: Record<string, unknown> = {}, contactId = kobeId) {
    const draft = (
      await as(jess, (tx) =>
        createInvoice(
          tx,
          {
            idempotencyKey: key("inv"),
            contactId,
            invoiceDate: "2026-09-25",
            dueDate: "2026-10-20",
            amountsMode: "exclusive",
            lines: [{ description: "Consulting", quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }],
            ...extra,
          },
          { foreignCurrency: true },
        ),
      )
    ).invoice;
    const approved = (await as(jess, (tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
    invoices[name] = approved.id;
    return approved;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setStripeFetchForTests(fakeFetch);
    server = await startTestServer();
    jess = await createTestUser("pn-jess@example.com", { displayName: "Jess" });
    mere = await createTestUser("pn-mere@example.com", { displayName: "Mere" });
    viewer = await createTestUser("pn-viewer@example.com");
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, viewer.id]);
    for (const user of [jess, mere, viewer]) cookies.set(user.email, await sessionCookieFor(user));
    await as(jess, (tx) => updateOrganisationSettings(tx, { displayName: "Aroha Ltd" }));
    stripeAccountId = (await as(jess, (tx) => createBankAccount(tx, { code: "1050", name: "Stripe", accountType: "bank" }))).id;
    kobeId = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact.id;
  });

  afterAll(async () => {
    setStripeFetchForTests(null);
    await server?.teardown();
  });

  it("PN1: an admin turns Pay now on, once Stripe is connected", async () => {
    await expect(as(jess, (tx) => enableOnlinePayments(tx))).rejects.toThrow("Connect Stripe first (Bank accounts, Stripe).");
    await connectStripe(await organisation(), actor(jess), { apiKey: KEY });
    await as(jess, (tx) => linkStripeBalance(tx, stripeAccountId, { currency: "NZD", startDate: "2026-09-25" }));
    const put = (user: SessionUser, enabled: boolean) =>
      onlinePaymentsRoute.PUT(apiRequest("/api/online-payments", { method: "PUT", cookie: cookies.get(user.email), body: { organisationId: org, enabled } }), noContext);
    expect((await put(mere, true)).status).toBe(403);
    const on = await put(jess, true);
    expect(on.status).toBe(200);
    expect(((await on.json()) as { payments: { enabled: boolean } }).payments).toMatchObject({ enabled: true, stripeConnected: true });
    const seen = await onlinePaymentsRoute.GET(apiRequest(`/api/online-payments?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), noContext);
    expect(((await seen.json()) as { payments: { enabled: boolean } }).payments.enabled).toBe(true);
    const history = await as(jess, (tx) => tx.query<{ actor_email: string }>("select actor_email from audit_events where event_type = 'online_payments.enabled'"));
    expect(history.rows.map((row) => row.actor_email)).toEqual([jess.email]);
  });

  it("PN2: emailing or printing INV-0010 makes one link for NZD 115.00; drafts and viewers make none", async () => {
    const inv = await invoice("INV-0010", "100.00");
    expect(inv).toMatchObject({ invoiceNumber: "INV-0001", total: "115.00" });
    // A viewer printing it doesn't make a link.
    const print = (user: SessionUser) =>
      printRoute.GET(apiRequest(`/api/documents/print?organisationId=${org}&kind=invoice&id=${inv.id}`, { cookie: cookies.get(user.email) }), noContext);
    const viewed = (await (await print(viewer)).json()) as { document: { payNowUrl: string | null } };
    expect([viewed.document.payNowUrl, stripe.links.length]).toEqual([null, 0]);
    // A bookkeeper printing it does.
    const printed = (await (await print(mere)).json()) as { document: { payNowUrl: string | null } };
    expect(printed.document.payNowUrl).toBe("https://buy.stripe.com/test_1");
    const form = stripe.links[0].form;
    expect(Object.fromEntries(form)).toMatchObject({
      "line_items[0][price_data][currency]": "nzd",
      "line_items[0][price_data][unit_amount]": "11500",
      "line_items[0][price_data][product_data][name]": "Invoice INV-0001",
      "line_items[0][quantity]": "1",
      "restrictions[completed_sessions][limit]": "1",
      "metadata[tohyee_invoice_id]": inv.id,
      "payment_intent_data[description]": "Payment for INV-0001",
      inactive_message: "This invoice has been paid or has changed. Use the latest link from Aroha Ltd.",
    });
    expect(stripe.links[0].headers["Stripe-Version"]).toBe("2025-07-30.basil");
    // Emailing it uses the same link, and says "Pay now".
    const prepared = await as(mere, (tx) => prepareDocumentEmail(tx, { kind: "invoice", id: inv.id }));
    expect(prepared.body).toContain("Pay now by card: https://buy.stripe.com/test_1");
    expect(await ensure(inv.id)).toBe("https://buy.stripe.com/test_1");
    expect(stripe.links).toHaveLength(1);
    // A draft gets no link.
    const draft = (
      await as(jess, (tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: kobeId,
          invoiceDate: "2026-09-25",
          dueDate: "2026-10-20",
          amountsMode: "exclusive",
          lines: [{ description: "Draft", quantity: "1", unitPrice: "1.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).invoice;
    expect(await ensure(draft.id)).toBeNull();
    expect((await as(viewer, (tx) => getInvoicePayNow(tx, draft.id))).reason).toBe("Approve the invoice first.");
    expect(await as(jess, (tx) => tx.query("select 1 from ledger_journals where origin is distinct from 'invoice'")).then((result) => result.rowCount)).toBe(0);
  });

  it("PN3: a paid session becomes a payment of 115.00 on 1 Oct into 1050; the link is switched off; checking again adds nothing", async () => {
    const link = stripe.links[0];
    paidSession(link.id, { id: "cs_1", amount: 11500, created: nz(1, 10, 15) });
    const result = await check();
    expect(result).toMatchObject({ status: "ok", recorded: 1, notices: 0, linksClosed: 1, error: null });
    const id = invoices["INV-0010"];
    expect(await as(viewer, (tx) => getInvoice(tx, id))).toMatchObject({ paidStatus: "paid", amountDue: "0.00" });
    const [payment] = await as(viewer, (tx) => listPayments(tx, id));
    expect(payment).toMatchObject({ paymentDate: "2026-10-01", amount: "115.00", bankAccountCode: "1050", reference: "Stripe pi_cs_1" });
    const journal = await as(viewer, (tx) => getJournal(tx, payment.journalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1050", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(stripe.deactivated).toEqual([link.id]);
    expect(await check()).toMatchObject({ recorded: 0, linksClosed: 0 });
    expect(await as(viewer, (tx) => listPayments(tx, id))).toHaveLength(1);
    const payNow = await as(viewer, (tx) => getInvoicePayNow(tx, id));
    expect([payNow.link, payNow.payments.map((entry) => [entry.status, entry.amount, entry.paidDate])]).toEqual([null, [["recorded", "115.00", "2026-10-01"]]]);
    const history = await as(viewer, (tx) => tx.query<{ event_type: string }>("select event_type from audit_events where entity_type = 'sales_invoice' and entity_id = $1 order by id", [id]));
    expect(history.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining(["invoice.payment_link_created", "invoice.paid_online", "invoice.payment_link_closed"]));
  });

  it("PN4: the feed's +115.00 line matches the payment, and the fee comes in as its own line", async () => {
    stripe.transactions = [
      {
        id: "txn_cs_1",
        amount: 11500,
        fee: 341,
        fee_details: [{ type: "stripe_fee", amount: 341, currency: "nzd" }],
        currency: "nzd",
        created: nz(1, 10, 15),
        type: "charge",
        description: "Payment for INV-0001",
      },
    ];
    expect(await syncStripe(await organisation(), actor(mere))).toMatchObject({ status: "ok", added: 2 });
    const lines = (await as(viewer, (tx) => listStatementLines(tx, stripeAccountId, { status: "all" }))).lines;
    const charge = lines.find((line) => line.amount === "115.00")!;
    expect(lines.find((line) => line.amount === "-3.41")?.description).toBe("Stripe fees");
    const suggestions = await as(mere, (tx) => suggestionsForLine(tx, charge.id));
    const match = suggestions.matches[0];
    expect(match).toMatchObject({ amount: "115.00" });
    const reconciled = await as(mere, (tx) => reconcileStatementLine(tx, charge.id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [match.journalLineId] }));
    expect(reconciled.line.status).toBe("reconciled");
  });

  it("PN5: after a part payment by hand, the 230.00 link is switched off and the next one is for 130.00", async () => {
    const inv = await invoice("INV-0011", "200.00");
    const first = await ensure(inv.id);
    expect(linkFor(first).form.get("line_items[0][price_data][unit_amount]")).toBe("23000");
    const paid = await paymentsRoute.POST(
      apiRequest(`/api/invoices/${inv.id}/payments`, {
        method: "POST",
        cookie: cookies.get(mere.email),
        body: { organisationId: org, idempotencyKey: key("pay"), paymentDate: "2026-10-02", amount: "100.00", bankAccountCode: "1000" },
      }),
      params({ invoiceId: inv.id }),
    );
    expect(paid.status).toBe(201);
    expect(linkFor(first).active).toBe(false);
    const second = await ensure(inv.id);
    expect(second).not.toBe(first);
    expect(linkFor(second).form.get("line_items[0][price_data][unit_amount]")).toBe("13000");
    expect((await as(viewer, (tx) => getInvoicePayNow(tx, inv.id))).link).toMatchObject({ url: second, amount: "130.00" });
  });

  it("PN6: paid by hand and by card: the card payment is an overpayment, and the invoice says so", async () => {
    const inv = await invoice("INV-0012", "100.00");
    const url = await ensure(inv.id);
    await as(mere, (tx) => recordPayment(tx, inv.id, { idempotencyKey: key("pay"), paymentDate: "2026-10-03", amount: "115.00", bankAccountCode: "1000" }));
    paidSession(linkFor(url).id, { id: "cs_6", amount: 11500, created: nz(3, 9, 5) });
    expect(await check()).toMatchObject({ recorded: 1 });
    const payments = await as(viewer, (tx) => listPayments(tx, inv.id));
    expect(payments.map((payment) => [payment.amount, payment.invoiceAmount, payment.overpaymentAmount, payment.bankAccountCode])).toEqual([
      ["115.00", "115.00", "0.00", "1000"],
      ["115.00", "0.00", "115.00", "1050"],
    ]);
    const payNow = await as(viewer, (tx) => getInvoicePayNow(tx, inv.id));
    expect(payNow.payments[0].notice).toBe("Paid twice: 115.00 is credit on Kobe Ltd's account, to apply to another invoice or refund.");
  });

  it("PN7: a USD 50.00 invoice paid by card lands as NZD 85.00: the payment is at Stripe's rate, with the gain on 7020", async () => {
    const acme = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    const inv = await invoice("INV-0020", "50.00", { amountsMode: "no_tax", lines: [{ description: "Design", quantity: "1", unitPrice: "50.00", accountCode: "4000" }], exchangeRate: "1.65" }, acme.id);
    expect(inv).toMatchObject({ currencyCode: "USD", total: "50.00", baseTotal: "82.50" });
    const url = await ensure(inv.id);
    expect(Object.fromEntries(linkFor(url).form)).toMatchObject({ "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": "5000" });
    paidSession(linkFor(url).id, { id: "cs_7", amount: 5000, currency: "usd", created: nz(4, 11), settled: { amount: 8500, currency: "nzd", rate: 1.7 } });
    expect(await check()).toMatchObject({ recorded: 1 });
    const [payment] = await as(viewer, (tx) => listPayments(tx, inv.id));
    expect([payment.amount, payment.bankAccountCode, payment.paymentDate]).toEqual(["50.00", "1050", "2026-10-04"]);
    const journal = await as(viewer, (tx) => getJournal(tx, payment.journalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1050", "85.00", "0.00"],
      ["1100", "0.00", "82.50"],
      ["7020", "0.00", "2.50"],
    ]);
    // A rate that doesn't divide evenly still gives Stripe's amount to the cent.
    const rate = exactRate("33.33", "56.67", 2);
    expect((Number(rate) * 33.33).toFixed(2)).toBe("56.67");
    expect(rate.split(".")[1].length).toBeLessThanOrEqual(8);
  });

  it("PN8, PN9: a refund or dispute in Stripe comes in through the feed only; the invoice isn't changed", async () => {
    stripe.transactions.push(
      { id: "txn_refund", amount: -11500, fee: 0, currency: "nzd", created: nz(3, 12), type: "refund" },
      { id: "txn_dispute", amount: -8500, fee: 2500, currency: "nzd", created: nz(6, 9), type: "adjustment", reporting_category: "dispute" },
    );
    await syncStripe(await organisation(), actor(mere));
    expect(await check()).toMatchObject({ recorded: 0 });
    expect(await as(viewer, (tx) => getInvoice(tx, invoices["INV-0010"]))).toMatchObject({ paidStatus: "paid" });
    expect((await as(viewer, (tx) => listPayments(tx, invoices["INV-0010"]))).map((payment) => payment.status)).toEqual(["active"]);
  });

  it("PN10: voiding switches the link off; a payment that still arrives is a notice; no balance link waits as a notice until linked", async () => {
    const inv = await invoice("INV-0013", "100.00");
    const url = await ensure(inv.id);
    const voided = await voidRoute.POST(
      apiRequest(`/api/invoices/${inv.id}/void`, {
        method: "POST",
        cookie: cookies.get(mere.email),
        body: { organisationId: org, idempotencyKey: key("void"), voidDate: "2026-10-05" },
      }),
      params({ invoiceId: inv.id }),
    );
    expect(voided.status).toBe(201);
    expect(linkFor(url).active).toBe(false);
    paidSession(linkFor(url).id, { id: "cs_10", amount: 11500, created: nz(5, 8) });
    expect(await check()).toMatchObject({ recorded: 0, notices: 1 });
    const status = await as(viewer, (tx) => getOnlinePaymentStatus(tx));
    expect(status.notices.map((notice) => notice.notice)).toEqual([
      "A Stripe payment of NZD 115.00 arrived for INV-0005, which is voided. Refund it in Stripe, or record it as a payment or overpayment by hand.",
    ]);
    expect(await as(viewer, (tx) => listPayments(tx, inv.id))).toEqual([]);
    expect((await as(mere, (tx) => dismissOnlinePaymentNotice(tx, status.notices[0].id))).notices).toEqual([]);

    // With no bank account linked to the NZD balance, the payment waits as a notice and is recorded once one is.
    const waiting = await invoice("INV-0014", "100.00");
    const waitingUrl = await ensure(waiting.id);
    await as(jess, (tx) => unlinkStripeBalance(tx, stripeAccountId));
    paidSession(linkFor(waitingUrl).id, { id: "cs_14", amount: 11500, created: nz(5, 9) });
    expect(await check()).toMatchObject({ recorded: 0, notices: 1 });
    expect((await as(viewer, (tx) => getOnlinePaymentStatus(tx))).notices.map((notice) => [notice.notice, notice.waitingForLink])).toEqual([
      ["A Stripe payment for INV-0006 (NZD 115.00) arrived, but no bank account is linked to Stripe's NZD balance.", true],
    ]);
    await as(jess, (tx) => linkStripeBalance(tx, stripeAccountId, { currency: "NZD", startDate: "2026-09-25" }));
    expect(await check()).toMatchObject({ recorded: 1 });
    expect((await as(viewer, (tx) => getOnlinePaymentStatus(tx))).notices).toEqual([]);
    expect((await as(viewer, (tx) => listPayments(tx, waiting.id))).map((payment) => [payment.amount, payment.paymentDate])).toEqual([["115.00", "2026-10-05"]]);
  });

  it("PN12: viewers see Pay now; bookkeepers leave it off on an invoice, which closes its link at the next check", async () => {
    const inv = await invoice("INV-0015", "100.00");
    const url = await ensure(inv.id);
    const get = await payNowRoute.GET(apiRequest(`/api/invoices/${inv.id}/pay-now?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), params({ invoiceId: inv.id }));
    expect(((await get.json()) as { payNow: { link: { url: string } } }).payNow.link.url).toBe(url);
    const put = (user: SessionUser, payNow: boolean) =>
      payNowRoute.PUT(apiRequest(`/api/invoices/${inv.id}/pay-now`, { method: "PUT", cookie: cookies.get(user.email), body: { organisationId: org, payNow } }), params({ invoiceId: inv.id }));
    expect((await put(viewer, false)).status).toBe(403);
    const off = (await (await put(mere, false)).json()) as { payNow: { offered: boolean; reason: string } };
    expect([off.payNow.offered, off.payNow.reason]).toEqual([false, "Pay now is left off on this invoice."]);
    expect(await ensure(inv.id)).toBeNull();
    expect(await check()).toMatchObject({ linksClosed: 1 });
    expect(linkFor(url).active).toBe(false);
  });

  it("PN11: turning Pay now off, or disconnecting Stripe, switches every open link off first; recorded payments stay", async () => {
    const inv = await invoice("INV-0016", "100.00");
    const url = await ensure(inv.id);
    const off = await onlinePaymentsRoute.PUT(
      apiRequest("/api/online-payments", { method: "PUT", cookie: cookies.get(jess.email), body: { organisationId: org, enabled: false } }),
      noContext,
    );
    expect(((await off.json()) as { linksNotSwitchedOff: string[] }).linksNotSwitchedOff).toEqual([]);
    expect(linkFor(url).active).toBe(false);
    expect(await ensure(inv.id)).toBeNull();
    expect(await as(viewer, (tx) => listPayments(tx, invoices["INV-0010"]))).toHaveLength(1);

    // On again, with a link open; Stripe can't be reached when disconnecting, so the link is listed for the dashboard.
    await as(jess, (tx) => enableOnlinePayments(tx));
    const again = await ensure(inv.id);
    stripe.unreachable = true;
    const disconnected = await stripeRoute.DELETE(apiRequest(`/api/bank-feeds/stripe?organisationId=${org}`, { method: "DELETE", cookie: cookies.get(jess.email) }), noContext);
    stripe.unreachable = false;
    expect(((await disconnected.json()) as { linksNotSwitchedOff: string[] }).linksNotSwitchedOff).toEqual([again]);
    expect((await as(viewer, (tx) => getInvoicePayNow(tx, inv.id))).link).toBeNull();
  });
});
