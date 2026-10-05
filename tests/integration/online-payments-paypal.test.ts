import { afterAll, beforeAll, expect, it } from "vitest";
import * as paypalRoute from "@/app/api/bank-feeds/paypal/route";
import * as printRoute from "@/app/api/documents/print/route";
import * as payNowRoute from "@/app/api/invoices/[invoiceId]/pay-now/route";
import * as paymentsRoute from "@/app/api/invoices/[invoiceId]/payments/route";
import * as voidRoute from "@/app/api/invoices/[invoiceId]/void/route";
import * as onlinePaymentsRoute from "@/app/api/online-payments/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { setPayPalFetchForTests } from "@/lib/bank/paypal/client";
import { connectPayPal, linkPayPalBalance, unlinkPayPalBalance } from "@/lib/bank/paypal/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { prepareDocumentEmail } from "@/lib/email/documents";
import { listPayments, recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { getOrganisation } from "@/lib/organisations/registry";
import { checkPayPalPayments, enablePayPalPayNow, ensurePayPalInvoice, getInvoicePayPal } from "@/lib/payments/paypal";
import { getOnlinePaymentStatus } from "@/lib/payments/stripe";
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

const CLIENT_ID = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFgHiJkLmNoPqRsTuVwXyZ0123456789abcd";
const noContext = undefined as unknown;

type FakeInvoice = {
  id: string;
  number: string;
  currency: string;
  amount: string;
  status: string;
  body: Record<string, unknown>;
  sent: Record<string, unknown> | null;
  cancelled: Record<string, unknown> | null;
  transactions: Array<Record<string, unknown>>;
};

/** A pretend PayPal: a token, balances, and invoices that can be made payable, read and cancelled. */
const paypal = {
  invoices: [] as FakeInvoice[],
  unreachable: false,
  invoicingStatus: 200,
};

function invoiceJson(invoice: FakeInvoice) {
  return {
    id: invoice.id,
    status: invoice.status,
    detail: {
      invoice_number: invoice.number,
      currency_code: invoice.currency,
      metadata: invoice.status === "DRAFT" ? {} : { recipient_view_url: `https://www.paypal.com/invoice/p/#${invoice.id}` },
    },
    payments: { transactions: invoice.transactions },
  };
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const auth = String((init?.headers as Record<string, string>).Authorization);
  if (paypal.unreachable && url.pathname.startsWith("/v2/invoicing")) throw new Error("connect ECONNREFUSED");
  if (url.pathname === "/v1/oauth2/token") {
    const [id, secret] = Buffer.from(auth.replace("Basic ", ""), "base64").toString().split(":");
    if (secret !== SECRET) return Response.json({ error: "invalid_client", error_description: "Client Authentication failed" }, { status: 401 });
    return Response.json({ access_token: `token-for-${id}`, token_type: "Bearer", expires_in: 32400 });
  }
  if (!auth.startsWith("Bearer token-for-")) return Response.json({ message: "no" }, { status: 401 });
  if (url.pathname === "/v1/reporting/balances") {
    return Response.json({
      balances: ["NZD", "USD"].map((currency) => ({ currency, total_balance: { currency_code: currency, value: "0.00" } })),
    });
  }
  if (url.pathname.startsWith("/v2/invoicing") && paypal.invoicingStatus !== 200) {
    return Response.json({ name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions." }, { status: paypal.invoicingStatus });
  }
  if (url.pathname === "/v2/invoicing/invoices" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { detail: { invoice_number: string; currency_code: string }; items: Array<{ unit_amount: { value: string } }> };
    if (paypal.invoices.some((invoice) => invoice.number === body.detail.invoice_number)) {
      return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", details: [{ description: "Invoice number already exists." }] }, { status: 422 });
    }
    const invoice: FakeInvoice = {
      id: `INV2-${paypal.invoices.length + 1}`,
      number: body.detail.invoice_number,
      currency: body.detail.currency_code,
      amount: body.items[0].unit_amount.value,
      status: "DRAFT",
      body,
      sent: null,
      cancelled: null,
      transactions: [],
    };
    paypal.invoices.push(invoice);
    return Response.json(invoiceJson(invoice), { status: 201 });
  }
  const match = /^\/v2\/invoicing\/invoices\/([^/]+)(\/send|\/cancel)?$/.exec(url.pathname);
  const invoice = match ? paypal.invoices.find((entry) => entry.id === decodeURIComponent(match[1])) : undefined;
  if (match && !invoice) return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
  if (invoice && match![2] === "/send") {
    invoice.sent = JSON.parse(String(init?.body));
    invoice.status = "UNPAID";
    return Response.json({ links: [] });
  }
  if (invoice && match![2] === "/cancel") {
    invoice.cancelled = JSON.parse(String(init?.body));
    invoice.status = "CANCELLED";
    return new Response(null, { status: 204 });
  }
  if (invoice) return Response.json(invoiceJson(invoice));
  return Response.json({ message: "not found" }, { status: 404 });
}

/** The customer pays a PayPal invoice through PayPal (PPN3). */
function pay(invoice: FakeInvoice, paymentId: string, date: string, amount = invoice.amount) {
  invoice.transactions.push({ payment_id: paymentId, payment_date: date, method: "PAYPAL", type: "PAYPAL", amount: { currency_code: invoice.currency, value: amount } });
  invoice.status = "PAID";
}

/**
 * Examples PPN1-PPN10 in docs/ACCOUNTING-EXAMPLES.md ("Online invoice
 * payments with PayPal"). 1060 PayPal linked to NZD, 1070 PayPal USD linked
 * to USD; Kobe Ltd (NZD) and Acme Inc (USD). A pretend PayPal answers; the
 * examples run in order on one organisation.
 */
describeWithDatabase("online invoice payments with PayPal (PPN1-PPN10)", () => {
  const org = "paypal-pay-co";
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let viewer: SessionUser;
  const cookies = new Map<string, string>();
  let kobeId = "";
  let acmeId = "";
  let nzdId = "";
  let usdId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actor = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const check = async () => checkPayPalPayments(await organisation(), actor(mere));
  const ensure = async (invoiceId: string) => ensurePayPalInvoice(await organisation(), actor(mere), invoiceId);
  const byUrl = (url: string | null) => paypal.invoices.find((invoice) => url?.endsWith(`#${invoice.id}`))!;

  async function invoice(unitPrice: string, extra: Record<string, unknown> = {}, contactId = kobeId) {
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
    return (await as(jess, (tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setPayPalFetchForTests(fakeFetch);
    server = await startTestServer();
    jess = await createTestUser("ppn-jess@example.com", { displayName: "Jess" });
    mere = await createTestUser("ppn-mere@example.com", { displayName: "Mere" });
    viewer = await createTestUser("ppn-viewer@example.com");
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, viewer.id]);
    for (const user of [jess, mere, viewer]) cookies.set(user.email, await sessionCookieFor(user));
    nzdId = (await as(jess, (tx) => createBankAccount(tx, { code: "1060", name: "PayPal", accountType: "bank" }))).id;
    usdId = (await as(jess, (tx) => createBankAccount(tx, { code: "1070", name: "PayPal USD", accountType: "bank", currencyCode: "USD" }))).id;
    kobeId = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true }))).contact.id;
    acmeId = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact.id;
  });

  afterAll(async () => {
    setPayPalFetchForTests(null);
    await server?.teardown();
  });

  it("PPN1: an admin turns Pay with PayPal on, once PayPal is connected", async () => {
    await expect(as(jess, (tx) => enablePayPalPayNow(tx))).rejects.toThrow("Connect PayPal first (Bank accounts, PayPal).");
    await connectPayPal(await organisation(), actor(jess), { clientId: CLIENT_ID, clientSecret: SECRET });
    await as(jess, (tx) => linkPayPalBalance(tx, nzdId, { currency: "NZD", startDate: "2026-09-25" }));
    await as(jess, (tx) => linkPayPalBalance(tx, usdId, { currency: "USD", startDate: "2026-09-25" }));
    const put = (user: SessionUser) =>
      onlinePaymentsRoute.PUT(
        apiRequest("/api/online-payments", { method: "PUT", cookie: cookies.get(user.email), body: { organisationId: org, provider: "paypal", enabled: true } }),
        noContext,
      );
    expect((await put(mere)).status).toBe(403);
    const on = (await (await put(jess)).json()) as { paypal: { enabled: boolean }; payments: { enabled: boolean } };
    expect([on.paypal.enabled, on.payments.enabled]).toEqual([true, false]);
    // An app without Invoicing: emailing goes ahead without the link, and copying says why.
    const inv = await invoice("1.00");
    paypal.invoicingStatus = 403;
    await expect(ensure(inv.id)).rejects.toThrow("Give the app Invoicing in PayPal's developer dashboard.");
    paypal.invoicingStatus = 200;
  });

  it("PPN2: emailing or printing makes one PayPal invoice for NZD 115.00, payable without PayPal emailing anyone", async () => {
    const inv = await invoice("100.00");
    const print = (user: SessionUser) =>
      printRoute.GET(apiRequest(`/api/documents/print?organisationId=${org}&kind=invoice&id=${inv.id}`, { cookie: cookies.get(user.email) }), noContext);
    expect(((await (await print(viewer)).json()) as { document: { payPalUrl: string | null } }).document.payPalUrl).toBeNull();
    const printed = (await (await print(mere)).json()) as { document: { payPalUrl: string | null; payNowUrl: string | null } };
    const made = byUrl(printed.document.payPalUrl);
    expect([made.number, made.currency, made.amount, made.status, printed.document.payNowUrl]).toEqual([inv.invoiceNumber, "NZD", "115.00", "UNPAID", null]);
    expect(made.body).toMatchObject({
      items: [{ name: `Invoice ${inv.invoiceNumber}`, quantity: "1", unit_amount: { currency_code: "NZD", value: "115.00" } }],
      configuration: { allow_partial_payment: false },
    });
    expect(made.body).not.toHaveProperty("primary_recipients");
    expect(made.sent).toEqual({ send_to_recipient: false, send_to_invoicer: false });
    const prepared = await as(mere, (tx) => prepareDocumentEmail(tx, { kind: "invoice", id: inv.id }));
    expect(prepared.body).toContain(`Pay with PayPal: https://www.paypal.com/invoice/p/#${made.id}`);
    expect(await ensure(inv.id)).toBe(printed.document.payPalUrl);
    expect(paypal.invoices.filter((entry) => entry.status !== "DRAFT")).toHaveLength(1);
  });

  it("PPN3, PPN4: a PayPal payment is recorded once on its date into 1060, and the invoice is paid", async () => {
    const inv = await invoice("100.00");
    const made = byUrl(await ensure(inv.id));
    pay(made, "1AB", "2026-10-01");
    expect(await check()).toMatchObject({ status: "ok", recorded: 1, notices: 0, linksClosed: 1 });
    expect(await as(viewer, (tx) => getInvoice(tx, inv.id))).toMatchObject({ paidStatus: "paid" });
    const [payment] = await as(viewer, (tx) => listPayments(tx, inv.id));
    expect([payment.amount, payment.paymentDate, payment.bankAccountCode, payment.reference]).toEqual(["115.00", "2026-10-01", "1060", "PayPal 1AB"]);
    const journal = await as(viewer, (tx) => getJournal(tx, payment.journalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1060", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    // PayPal has finished with a paid invoice, so it isn't cancelled; Tohyee just closes its link.
    expect(made.cancelled).toBeNull();
    expect(await check()).toMatchObject({ recorded: 0, linksClosed: 0 });
    expect(await as(viewer, (tx) => listPayments(tx, inv.id))).toHaveLength(1);
    // Payments typed into PayPal by hand aren't PayPal's to report.
    const external = await invoice("10.00");
    const externalInvoice = byUrl(await ensure(external.id));
    externalInvoice.transactions.push({ payment_id: "CASH1", payment_date: "2026-10-02", method: "CASH", type: "EXTERNAL", amount: { currency_code: "NZD", value: "11.50" } });
    expect(await check()).toMatchObject({ recorded: 0 });
  });

  it("PPN5: after a part payment by hand, the PayPal invoice is cancelled and the next one is for 130.00, numbered -2", async () => {
    const inv = await invoice("200.00");
    const first = byUrl(await ensure(inv.id));
    const paid = await paymentsRoute.POST(
      apiRequest(`/api/invoices/${inv.id}/payments`, {
        method: "POST",
        cookie: cookies.get(mere.email),
        body: { organisationId: org, idempotencyKey: key("pay"), paymentDate: "2026-10-02", amount: "100.00", bankAccountCode: "1000" },
      }),
      params({ invoiceId: inv.id }),
    );
    expect(paid.status).toBe(201);
    expect([first.status, first.cancelled]).toEqual(["CANCELLED", { send_to_recipient: false, send_to_invoicer: false }]);
    const second = byUrl(await ensure(inv.id));
    expect([second.number, second.amount]).toEqual([`${inv.invoiceNumber}-2`, "130.00"]);
  });

  it("PPN6: paid by hand and through PayPal, the PayPal payment is an overpayment", async () => {
    const inv = await invoice("100.00");
    const made = byUrl(await ensure(inv.id));
    await as(mere, (tx) => recordPayment(tx, inv.id, { idempotencyKey: key("pay"), paymentDate: "2026-10-03", amount: "115.00", bankAccountCode: "1000" }));
    pay(made, "2CD", "2026-10-03");
    expect(await check()).toMatchObject({ recorded: 1 });
    const payments = await as(viewer, (tx) => listPayments(tx, inv.id));
    expect(payments.map((payment) => [payment.overpaymentAmount, payment.bankAccountCode])).toEqual([
      ["0.00", "1000"],
      ["115.00", "1060"],
    ]);
  });

  it("PPN7: a USD invoice offers PayPal only while PayPal's USD balance is linked, and is paid into 1070 in USD", async () => {
    const inv = await invoice("50.00", { amountsMode: "no_tax", lines: [{ description: "Design", quantity: "1", unitPrice: "50.00", accountCode: "4000" }], exchangeRate: "1.65" }, acmeId);
    await as(jess, (tx) => unlinkPayPalBalance(tx, usdId));
    expect(await ensure(inv.id)).toBeNull();
    expect((await as(viewer, (tx) => getInvoicePayPal(tx, inv.id))).reason).toBe("Link PayPal's USD balance to a bank account first.");
    await as(jess, (tx) => linkPayPalBalance(tx, usdId, { currency: "USD", startDate: "2026-09-25" }));
    const made = byUrl(await ensure(inv.id));
    expect([made.currency, made.amount]).toEqual(["USD", "50.00"]);
    pay(made, "3EF", "2026-10-04");
    expect(await check()).toMatchObject({ recorded: 1 });
    const [payment] = await as(viewer, (tx) => listPayments(tx, inv.id));
    expect([payment.amount, payment.currencyCode, payment.bankAccountCode]).toEqual(["50.00", "USD", "1070"]);
  });

  it("PPN8: voiding cancels the PayPal invoice; a payment that still arrives is a notice", async () => {
    const inv = await invoice("100.00");
    const made = byUrl(await ensure(inv.id));
    const voided = await voidRoute.POST(
      apiRequest(`/api/invoices/${inv.id}/void`, { method: "POST", cookie: cookies.get(mere.email), body: { organisationId: org, idempotencyKey: key("void"), voidDate: "2026-10-05" } }),
      params({ invoiceId: inv.id }),
    );
    expect(voided.status).toBe(201);
    expect(made.status).toBe("CANCELLED");
    pay(made, "4GH", "2026-10-05");
    expect(await check()).toMatchObject({ recorded: 0, notices: 1 });
    expect((await as(viewer, (tx) => getOnlinePaymentStatus(tx))).notices.map((notice) => [notice.provider, notice.notice])).toEqual([
      ["paypal", `A PayPal payment of NZD 115.00 arrived for ${inv.invoiceNumber}, which is voided. Refund it in PayPal, or record it as a payment or overpayment by hand.`],
    ]);
  });

  it("PPN10: the invoice's Leave Pay now off tick leaves PayPal off too; viewers see the PayPal link", async () => {
    const inv = await invoice("100.00");
    const url = await ensure(inv.id);
    const seen = (await (await payNowRoute.GET(apiRequest(`/api/invoices/${inv.id}/pay-now?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), params({ invoiceId: inv.id }))).json()) as {
      paypal: { link: { url: string } };
    };
    expect(seen.paypal.link.url).toBe(url);
    const off = (await (
      await payNowRoute.PUT(
        apiRequest(`/api/invoices/${inv.id}/pay-now`, { method: "PUT", cookie: cookies.get(mere.email), body: { organisationId: org, payNow: false } }),
        params({ invoiceId: inv.id }),
      )
    ).json()) as { paypal: { offered: boolean; reason: string } };
    expect([off.paypal.offered, off.paypal.reason]).toEqual([false, "Pay now is left off on this invoice."]);
    expect(await check()).toMatchObject({ linksClosed: 1 });
    expect(byUrl(url).status).toBe("CANCELLED");
  });

  it("PPN9: turning it off, or disconnecting PayPal, cancels every open PayPal invoice first", async () => {
    const inv = await invoice("100.00");
    const made = byUrl(await ensure(inv.id));
    const off = await onlinePaymentsRoute.PUT(
      apiRequest("/api/online-payments", { method: "PUT", cookie: cookies.get(jess.email), body: { organisationId: org, provider: "paypal", enabled: false } }),
      noContext,
    );
    expect(((await off.json()) as { linksNotSwitchedOff: string[] }).linksNotSwitchedOff).toEqual([]);
    expect(made.status).toBe("CANCELLED");
    expect(await ensure(inv.id)).toBeNull();
    await as(jess, (tx) => enablePayPalPayNow(tx));
    const again = await ensure(inv.id);
    paypal.unreachable = true;
    const disconnected = await paypalRoute.DELETE(apiRequest(`/api/bank-feeds/paypal?organisationId=${org}`, { method: "DELETE", cookie: cookies.get(jess.email) }), noContext);
    paypal.unreachable = false;
    expect(((await disconnected.json()) as { linksNotSwitchedOff: string[] }).linksNotSwitchedOff).toEqual([again]);
    expect((await as(viewer, (tx) => getInvoicePayPal(tx, inv.id))).link).toBeNull();
  });
});
