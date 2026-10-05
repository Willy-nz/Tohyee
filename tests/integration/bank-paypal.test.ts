import { afterAll, beforeAll, expect, it } from "vitest";
import * as paypalRoute from "@/app/api/bank-feeds/paypal/route";
import * as syncRoute from "@/app/api/bank-feeds/paypal/sync/route";
import * as linkRoute from "@/app/api/bank-accounts/[accountId]/paypal/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { setPayPalFetchForTests, type PayPalTransaction } from "@/lib/bank/paypal/client";
import { connectPayPal, disconnectPayPal, getPayPalStatus, linkPayPalBalance, syncDuePayPal, syncPayPal } from "@/lib/bank/paypal/service";
import { suggestionsForLine } from "@/lib/bank/reconcile";
import { linkStripeBalance } from "@/lib/bank/stripe/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { dec, sum, toFixedString } from "@/lib/money/decimal";
import { getOrganisation } from "@/lib/organisations/registry";
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

/** The examples run to 9 Oct 2026; syncs look up to this moment. */
const LATER = new Date("2026-10-10T00:00:00Z");
const CLIENT_ID = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFgHiJkLmNoPqRsTuVwXyZ0123456789abcd";

function tx(
  id: string,
  code: string,
  date: string,
  amount: string,
  fields: { currency?: string; fee?: string; status?: string; subject?: string; invoice?: string; payer?: string } = {},
): PayPalTransaction {
  const currency = fields.currency ?? "NZD";
  return {
    transaction_info: {
      transaction_id: id,
      transaction_event_code: code,
      transaction_initiation_date: date,
      transaction_amount: { currency_code: currency, value: amount },
      ...(fields.fee ? { fee_amount: { currency_code: currency, value: fields.fee } } : {}),
      transaction_status: fields.status ?? "S",
      ...(fields.subject ? { transaction_subject: fields.subject } : {}),
      ...(fields.invoice ? { invoice_id: fields.invoice } : {}),
    },
    ...(fields.payer ? { payer_info: { payer_name: { alternate_full_name: fields.payer } } } : {}),
  };
}

const PP3 = tx("1AB", "T0006", "2026-10-01T10:15:00+1300", "115.00", { fee: "-4.12", invoice: "INV-0011", payer: "Kobe Ltd" });
const PP4 = tx("2CD", "T1107", "2026-10-03T09:00:00+1300", "-115.00", { fee: "3.82" });
const PP5_USD = tx("3EF", "T0200", "2026-10-04T08:00:00+1300", "-200.00", { currency: "USD" });
const PP5_NZD = tx("3EG", "T0200", "2026-10-04T08:00:00+1300", "320.00");
const PP6 = tx("4GH", "T1201", "2026-10-06T11:00:00+1300", "-60.00");
const PP6_FEE = tx("4GI", "T0106", "2026-10-06T11:00:00+1300", "-20.00");
const PP7 = tx("5IJ", "T0400", "2026-10-08T15:00:00+1300", "-100.00");

/** A pretend PayPal: a token for the right credentials, balances, and transactions paged two at a time. */
const paypal = {
  transactions: [] as PayPalTransaction[],
  balances: [
    { currency: "NZD", total_balance: { currency_code: "NZD", value: "0.00" }, available_balance: { currency_code: "NZD", value: "0.00" } },
    { currency: "USD", total_balance: { currency_code: "USD", value: "0.00" }, available_balance: { currency_code: "USD", value: "0.00" } },
  ] as Array<Record<string, unknown>>,
  requests: [] as URL[],
  searchStatus: 200,
};

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  paypal.requests.push(url);
  const auth = String((init?.headers as Record<string, string>).Authorization);
  if (url.pathname === "/v1/oauth2/token") {
    const [id, secret] = Buffer.from(auth.replace("Basic ", ""), "base64").toString().split(":");
    if (secret !== SECRET && secret !== `${SECRET}2`) return Response.json({ error: "invalid_client", error_description: "Client Authentication failed" }, { status: 401 });
    return Response.json({ access_token: `token-for-${id}`, token_type: "Bearer", expires_in: 32400 });
  }
  if (!auth.startsWith("Bearer token-for-")) return Response.json({ message: "no" }, { status: 401 });
  if (url.pathname === "/v1/reporting/balances") return Response.json({ balances: paypal.balances });
  if (url.pathname === "/v1/reporting/transactions") {
    if (paypal.searchStatus !== 200) return Response.json({ name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions." }, { status: paypal.searchStatus });
    const start = Date.parse(url.searchParams.get("start_date")!);
    const end = Date.parse(url.searchParams.get("end_date")!);
    const currency = url.searchParams.get("transaction_currency");
    const matching = paypal.transactions.filter((item) => {
      const at = Date.parse(String(item.transaction_info.transaction_initiation_date).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
      return at >= start && at <= end && item.transaction_info.transaction_amount?.currency_code === currency;
    });
    const page = Number(url.searchParams.get("page"));
    return Response.json({ transaction_details: matching.slice((page - 1) * 2, page * 2), page, total_pages: Math.max(1, Math.ceil(matching.length / 2)) });
  }
  return Response.json({ message: "not found" }, { status: 404 });
}

/**
 * Examples PP1-PP10 in docs/ACCOUNTING-EXAMPLES.md ("PayPal as a bank
 * feed"). Base currency NZD, 1060 PayPal (NZD), 1070 PayPal USD (USD), and
 * Kobe Ltd's INV-0011 for 115.00. A pretend PayPal answers; the examples run
 * in order, as they build on each other.
 */
describeWithDatabase("PayPal as a bank feed (PP1-PP10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  const org = "paypal-co";
  let nzdId = "";
  let usdId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actorOf = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const lines = async (accountId = nzdId) =>
    (await as(viewer, (t) => listStatementLines(t, accountId, { status: "all" }))).lines.sort((a, b) => a.externalId!.localeCompare(b.externalId!));
  const line = async (externalId: string, accountId = nzdId) => (await lines(accountId)).find((entry) => entry.externalId === externalId);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setPayPalFetchForTests(fakeFetch);
    server = await startTestServer();
    owner = await createTestUser("owner@example.com");
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
    ownerCookie = await sessionCookieFor(owner);
    bookkeeperCookie = await sessionCookieFor(bookkeeper);
    viewerCookie = await sessionCookieFor(viewer);
    await createTestOrganisation(owner, org);
    for (const [user, role] of [
      [bookkeeper, "bookkeeper"],
      [viewer, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    nzdId = (await as(owner, (t) => createBankAccount(t, { code: "1060", name: "PayPal", accountType: "bank" }))).id;
    usdId = (await as(owner, (t) => createBankAccount(t, { code: "1070", name: "PayPal USD", accountType: "bank", currencyCode: "USD" }))).id;
    await as(bookkeeper, async (t) => {
      const kobe = (await createContact(t, { idempotencyKey: key("contact"), name: "Kobe Ltd", isCustomer: true })).contact;
      const drafted = await createInvoice(t, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-09-25",
        dueDate: "2026-10-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
      });
      await approveInvoice(t, drafted.invoice.id, { idempotencyKey: key("approve") });
    });
  });

  afterAll(async () => {
    setPayPalFetchForTests(null);
    await server?.teardown();
  });

  it("PP1: the live app's client ID and secret are checked with PayPal; the secret is stored encrypted and never shown", async () => {
    const post = (cookie: string, clientSecret: string) =>
      paypalRoute.POST(apiRequest("/api/bank-feeds/paypal", { method: "POST", cookie, body: { organisationId: org, clientId: CLIENT_ID, clientSecret } }), params({}));
    expect((await post(bookkeeperCookie, SECRET)).status).toBe(403);
    const wrong = await post(ownerCookie, "WrongSecretWrongSecretWrong123");
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain("Use the live app's client ID and secret (not sandbox).");
    const response = await post(ownerCookie, SECRET);
    expect(response.status).toBe(201);
    const { paypal: status } = (await response.json()) as { paypal: Record<string, unknown> };
    expect(status).toMatchObject({ connected: true, clientId: CLIENT_ID, syncEveryHours: 6 });
    expect((status.balances as Array<{ currency: string; total: string }>).map((balance) => [balance.currency, balance.total])).toEqual([
      ["NZD", "0.00"],
      ["USD", "0.00"],
    ]);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    const stored = await as(owner, (t) => t.query<{ client_secret_ciphertext: string }>("select client_secret_ciphertext from paypal_connections"));
    expect(stored.rows[0].client_secret_ciphertext).not.toContain(SECRET);
  });

  it("PP2: each PayPal currency links to a bank account in that currency; one feed per account", async () => {
    await expect(as(owner, (t) => linkPayPalBalance(t, usdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow(
      "PayPal's balance is in NZD; 1070 is in USD.",
    );
    const link = (cookie: string, accountId: string, currency: string) =>
      linkRoute.POST(
        apiRequest(`/api/bank-accounts/${accountId}/paypal`, { method: "POST", cookie, body: { organisationId: org, currency, startDate: "2026-10-01" } }),
        params({ accountId }),
      );
    expect((await link(bookkeeperCookie, nzdId, "NZD")).status).toBe(403);
    expect((await link(ownerCookie, nzdId, "NZD")).status).toBe(201);
    expect((await link(ownerCookie, usdId, "USD")).status).toBe(201);
    await expect(as(owner, (t) => linkStripeBalance(t, nzdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow();
  });

  it("PP3: a completed payment comes in with its fee; it can be matched to the invoice", async () => {
    paypal.transactions = [PP3];
    const synced = await syncRoute.POST(apiRequest("/api/bank-feeds/paypal/sync", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }), params({}));
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { result: unknown }).result).toMatchObject({ status: "ok", added: 2 });
    expect((await lines()).map((entry) => [entry.date, entry.amount, entry.description, entry.payee, entry.reference, entry.externalId])).toEqual([
      ["2026-10-01", "115.00", "Payment", "Kobe Ltd", "INV-0011", "paypal:1AB"],
      ["2026-10-01", "-4.12", "PayPal fees", null, null, "paypal:1AB:fee"],
    ]);
    const suggestions = await as(viewer, async (t) => suggestionsForLine(t, (await line("paypal:1AB"))!.id));
    expect(suggestions.documents).toEqual([expect.objectContaining({ kind: "invoice", amountDue: "115.00", contactName: "Kobe Ltd" })]);
    expect(await syncPayPal(await organisation(), actorOf(bookkeeper), LATER)).toMatchObject({ added: 0, duplicates: 2 });
    // Every request covers at most 31 days.
    for (const url of paypal.requests.filter((entry) => entry.pathname === "/v1/reporting/transactions")) {
      expect(Date.parse(url.searchParams.get("end_date")!) - Date.parse(url.searchParams.get("start_date")!)).toBeLessThanOrEqual(31 * 86_400_000);
      expect(url.searchParams.get("fields")).toBe("all");
    }
  });

  it("PP4-PP7: refunds, conversions, chargebacks and withdrawals come in as PayPal reports them", async () => {
    paypal.transactions = [PP3, PP4, PP5_USD, PP5_NZD, PP6, PP6_FEE, PP7];
    expect(await syncPayPal(await organisation(), actorOf(bookkeeper), LATER)).toMatchObject({ status: "ok", added: 7 });
    expect((await lines()).map((entry) => [entry.date, entry.amount, entry.description])).toEqual([
      ["2026-10-01", "115.00", "Payment"],
      ["2026-10-01", "-4.12", "PayPal fees"],
      ["2026-10-03", "-115.00", "Refund"],
      ["2026-10-03", "3.82", "PayPal fees"],
      ["2026-10-04", "320.00", "Currency conversion"],
      ["2026-10-06", "-60.00", "Chargeback"],
      ["2026-10-06", "-20.00", "Chargeback fee"],
      ["2026-10-08", "-100.00", "Withdrawal to bank"],
    ]);
    expect((await lines(usdId)).map((entry) => [entry.date, entry.amount, entry.description, entry.currencyCode])).toEqual([
      ["2026-10-04", "-200.00", "Currency conversion", "USD"],
    ]);
    // Reconciling the two legs as one transfer with both amounts is the FXB transfer (bank-foreign.test.ts).
  });

  it("PP8: pending and denied payments wait; a completed one comes in on its own date", async () => {
    const pending = tx("6KL", "T0006", "2026-10-09T10:00:00+1300", "50.00", { status: "P" });
    const denied = tx("6KM", "T0006", "2026-10-09T10:00:00+1300", "70.00", { status: "D" });
    paypal.transactions = [PP3, PP4, PP5_NZD, PP6, PP6_FEE, PP7, pending, denied];
    expect(await syncPayPal(await organisation(), actorOf(bookkeeper), LATER)).toMatchObject({ added: 0 });
    paypal.transactions = [...paypal.transactions.filter((item) => item !== pending), tx("6KL", "T0006", "2026-10-09T10:00:00+1300", "50.00")];
    expect(await syncPayPal(await organisation(), actorOf(bookkeeper), LATER)).toMatchObject({ added: 1 });
    expect(await line("paypal:6KL")).toMatchObject({ date: "2026-10-09", amount: "50.00" });
    expect(await line("paypal:6KM")).toBeUndefined();
  });

  it("PP9: the lines add up to the change in PayPal's balance, which is the statement balance", async () => {
    const before = (await lines()).filter((entry) => entry.externalId !== "paypal:6KL");
    expect(toFixedString(sum(before.map((entry) => dec(entry.amount))), 2)).toBe("139.70");
    paypal.balances = [{ currency: "NZD", total_balance: { currency_code: "NZD", value: "189.70" }, available_balance: { currency_code: "NZD", value: "189.70" } }];
    await syncPayPal(await organisation(), actorOf(bookkeeper), LATER);
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).statementBalance).toBe("189.70");
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).paypal).toMatchObject({ active: true, lastSyncStatus: "ok" });
  });

  it("an app without Transaction Search fails the sync with the reason; the schedule syncs when due", async () => {
    paypal.searchStatus = 403;
    const failed = await syncPayPal(await organisation(), actorOf(bookkeeper), LATER);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Turn on Transaction Search for the app");
    expect(await as(viewer, (t) => getPayPalStatus(t))).toMatchObject({ lastSyncStatus: "failed" });
    paypal.searchStatus = 200;
    const asked = paypal.requests.length;
    await syncDuePayPal();
    expect(paypal.requests.length).toBe(asked);
    await as(owner, (t) => t.query("update paypal_connections set last_synced_at = now() - interval '7 hours' where status = 'active'"));
    await syncDuePayPal();
    expect(paypal.requests.length).toBeGreaterThan(asked);
  });

  it("PP10: disconnecting deletes the secret; reconnecting and relinking adds no line twice", async () => {
    const before = (await lines()).length;
    expect((await paypalRoute.DELETE(apiRequest(`/api/bank-feeds/paypal?organisationId=${org}`, { method: "DELETE", cookie: viewerCookie }), params({}))).status).toBe(403);
    await as(owner, (t) => disconnectPayPal(t));
    const stored = await as(owner, (t) => t.query<{ client_secret_ciphertext: string | null }>("select client_secret_ciphertext from paypal_connections"));
    expect(stored.rows.every((row) => row.client_secret_ciphertext === null)).toBe(true);
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).paypal).toBeNull();
    await connectPayPal(await organisation(), actorOf(owner), { clientId: CLIENT_ID, clientSecret: `${SECRET}2` });
    await as(owner, (t) => linkPayPalBalance(t, nzdId, { currency: "NZD", startDate: "2026-10-01" }));
    expect(await syncPayPal(await organisation(), actorOf(bookkeeper), LATER)).toMatchObject({ status: "ok", added: 0 });
    expect(await lines()).toHaveLength(before);
  });
});
