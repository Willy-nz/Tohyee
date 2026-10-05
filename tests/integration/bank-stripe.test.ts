import { afterAll, beforeAll, expect, it } from "vitest";
import * as stripeRoute from "@/app/api/bank-feeds/stripe/route";
import * as syncRoute from "@/app/api/bank-feeds/stripe/sync/route";
import * as linkRoute from "@/app/api/bank-accounts/[accountId]/stripe/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { reconcileStatementLine, suggestionsForLine } from "@/lib/bank/reconcile";
import { linkSimpleFinAccount } from "@/lib/bank/simplefin/service";
import { setStripeFetchForTests, type StripeBalanceTransaction } from "@/lib/bank/stripe/client";
import { connectStripe, disconnectStripe, getStripeStatus, linkStripeBalance, linesFromStripe, syncDueStripe, syncStripe } from "@/lib/bank/stripe/service";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { add, dec, sum, toFixedString } from "@/lib/money/decimal";
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

const KEY = "rk_live_abcdefghijklmnop1234";
/** A NZ time as Unix seconds (October is NZDT, UTC+13). */
const nz = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 13, minute) / 1000;

const txn = (fields: Partial<StripeBalanceTransaction> & { id: string; amount: number; created: number }): StripeBalanceTransaction => ({
  currency: "nzd",
  fee: 0,
  fee_details: [],
  status: "available",
  type: "charge",
  description: null,
  exchange_rate: null,
  reporting_category: null,
  source: null,
  ...fields,
});

const ST3 = txn({
  id: "txn_1",
  amount: 11500,
  fee: 341,
  fee_details: [{ type: "stripe_fee", amount: 341, currency: "nzd" }],
  net: 11159,
  created: nz(1, 10, 15),
  status: "pending",
  description: "Payment for INV-0010",
});
const ST4 = txn({ id: "txn_2", amount: 8500, fee: 305, created: nz(2, 9), exchange_rate: 1.7, source: { amount: 5000, currency: "usd" } });
const ST5 = txn({ id: "txn_3", type: "refund", amount: -11500, created: nz(3, 12) });
const ST6 = txn({ id: "txn_4", type: "adjustment", reporting_category: "dispute", amount: -8500, fee: 2500, created: nz(6, 9) });
const ST7 = txn({
  id: "txn_5",
  amount: 10000,
  fee: 345,
  fee_details: [
    { type: "stripe_fee", amount: 300, currency: "nzd" },
    { type: "tax", amount: 45, currency: "nzd" },
  ],
  created: nz(7, 11),
});
const ST8 = txn({ id: "txn_6", type: "payout", amount: -5000, created: nz(8, 15), description: "STRIPE PAYOUT" });

/** A pretend Stripe: answers /balance and pages through /balance_transactions two at a time, newest first. */
const stripe = {
  transactions: [] as StripeBalanceTransaction[],
  balance: { available: [{ amount: 0, currency: "nzd" }], pending: [{ amount: 0, currency: "nzd" }] } as Record<string, Array<{ amount: number; currency: string }>>,
  requests: [] as URL[],
  status: 200,
};

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  stripe.requests.push(url);
  const auth = String((init?.headers as Record<string, string>).Authorization);
  if (auth !== `Bearer ${KEY}` && !auth.startsWith("Bearer rk_live_second")) return Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
  if (stripe.status !== 200) return Response.json({ error: { message: "The provided key does not have the required permissions" } }, { status: stripe.status });
  if (url.pathname === "/v1/balance") return Response.json(stripe.balance);
  if (url.pathname === "/v1/balance_transactions") {
    const since = Number(url.searchParams.get("created[gte]"));
    const currency = url.searchParams.get("currency");
    const matching = stripe.transactions
      .filter((item) => item.created >= since && item.currency === currency)
      .sort((left, right) => right.created - left.created);
    const after = url.searchParams.get("starting_after");
    const start = after ? matching.findIndex((item) => item.id === after) + 1 : 0;
    return Response.json({ object: "list", data: matching.slice(start, start + 2), has_more: start + 2 < matching.length });
  }
  return Response.json({ error: { message: "not found" } }, { status: 404 });
}

/**
 * Examples ST1-ST10 in docs/ACCOUNTING-EXAMPLES.md ("Stripe as a bank
 * feed"). Base currency NZD, a bank account 1050 Stripe (NZD), a USD account
 * 1020, and Kobe Ltd's INV-0010 for 115.00. A pretend Stripe answers; the
 * examples run in order, as they build on each other.
 */
describeWithDatabase("Stripe as a bank feed (ST1-ST10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  const org = "stripe-co";
  let stripeAccountId = "";
  let usdId = "";
  let nzdId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actorOf = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const lines = async () =>
    (await as(viewer, (tx) => listStatementLines(tx, stripeAccountId, { status: "all" }))).lines.sort((a, b) => a.externalId!.localeCompare(b.externalId!));
  const line = async (externalId: string) => (await lines()).find((entry) => entry.externalId === externalId);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setStripeFetchForTests(fakeFetch);
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
    stripeAccountId = (await as(owner, (tx) => createBankAccount(tx, { code: "1050", name: "Stripe", accountType: "bank" }))).id;
    usdId = (await as(owner, (tx) => createBankAccount(tx, { code: "1020", name: "USD account", accountType: "bank", currencyCode: "USD" }))).id;
    nzdId = (await as(viewer, (tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    await as(bookkeeper, async (tx) => {
      const kobe = (await createContact(tx, { idempotencyKey: key("contact"), name: "Kobe Ltd", isCustomer: true })).contact;
      const drafted = await createInvoice(tx, {
        idempotencyKey: key("invoice"),
        contactId: kobe.id,
        invoiceDate: "2026-09-25",
        dueDate: "2026-10-20",
        amountsMode: "exclusive",
        lines: [{ description: "Consulting", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
      });
      await approveInvoice(tx, drafted.invoice.id, { idempotencyKey: key("approve") });
    });
  });

  afterAll(async () => {
    setStripeFetchForTests(null);
    await server?.teardown();
  });

  it("ST1: only a restricted key is accepted; it's checked with Stripe and stored encrypted", async () => {
    const post = (cookie: string, apiKey: string) =>
      stripeRoute.POST(apiRequest("/api/bank-feeds/stripe", { method: "POST", cookie, body: { organisationId: org, apiKey } }), params({}));
    expect((await post(bookkeeperCookie, KEY)).status).toBe(403);
    const full = await post(ownerCookie, "sk_live_abcdefghijklmnop1234");
    expect(full.status).toBe(400);
    expect(JSON.stringify(await full.json())).toContain("Use a restricted key with read access only.");
    const wrong = await post(ownerCookie, "rk_live_wrongwrongwrong123");
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain("Stripe refused the key");
    const response = await post(ownerCookie, KEY);
    expect(response.status).toBe(201);
    const { stripe: status } = (await response.json()) as { stripe: Record<string, unknown> };
    expect(status).toMatchObject({ connected: true, keyHint: "rk_live_abcd…1234", liveMode: true, syncEveryHours: 6 });
    expect(status.balances).toEqual([{ currency: "NZD", available: "0.00", pending: "0.00", linkedAccountId: null }]);
    expect(JSON.stringify(status)).not.toContain(KEY);
    const stored = await as(owner, (tx) => tx.query<{ api_key_ciphertext: string }>("select api_key_ciphertext from stripe_connections"));
    expect(stored.rows[0].api_key_ciphertext).not.toContain(KEY);
    const audit = await as(viewer, (tx) => tx.query<{ actor_email: string }>("select actor_email from audit_events where event_type = 'bank_feed.stripe_connected'"));
    expect(audit.rows).toEqual([{ actor_email: owner.email }]);
  });

  it("ST2: Stripe's balance links to a bank account in its currency; admins link", async () => {
    await expect(as(owner, (tx) => linkStripeBalance(tx, usdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow(
      "Stripe's balance is in NZD; 1020 is in USD.",
    );
    const link = (cookie: string) =>
      linkRoute.POST(
        apiRequest(`/api/bank-accounts/${stripeAccountId}/stripe`, { method: "POST", cookie, body: { organisationId: org, currency: "NZD", startDate: "2026-10-01" } }),
        params({ accountId: stripeAccountId }),
      );
    expect((await link(bookkeeperCookie)).status).toBe(403);
    const response = await link(ownerCookie);
    expect(response.status).toBe(201);
    expect(((await response.json()) as { link: unknown }).link).toMatchObject({ currencyCode: "NZD", startDate: "2026-10-01", lastSyncStatus: "never" });
    // The same balance can't feed two accounts, and an account has one feed.
    await expect(as(owner, (tx) => linkStripeBalance(tx, nzdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow(
      "Stripe's NZD balance is already linked to another bank account.",
    );
    await expect(as(owner, (tx) => linkSimpleFinAccount(tx, stripeAccountId, { simplefinAccountId: "X", startDate: "2026-10-01" }))).rejects.toThrow();
  });

  it("ST3: a charge comes in at its full amount with its fee as its own line, and can be matched to the invoice", async () => {
    stripe.transactions = [ST3];
    stripe.balance = { available: [{ amount: 0, currency: "nzd" }], pending: [{ amount: 11159, currency: "nzd" }] };
    const journalsBefore = (await as(viewer, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"))).rows[0].n;
    const synced = await syncRoute.POST(apiRequest("/api/bank-feeds/stripe/sync", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }), params({}));
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { result: unknown }).result).toMatchObject({ status: "ok", added: 2 });
    expect((await lines()).map((entry) => [entry.date, entry.amount, entry.description, entry.externalId, entry.status])).toEqual([
      ["2026-10-01", "115.00", "Payment for INV-0010", "stripe:txn_1", "unreconciled"],
      ["2026-10-01", "-3.41", "Stripe fees", "stripe:txn_1:fee", "unreconciled"],
    ]);
    expect((await as(viewer, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"))).rows[0].n).toBe(journalsBefore);
    const charge = (await line("stripe:txn_1"))!;
    const suggestions = await as(viewer, (tx) => suggestionsForLine(tx, charge.id));
    expect(suggestions.documents).toEqual([expect.objectContaining({ kind: "invoice", amountDue: "115.00", contactName: "Kobe Ltd" })]);
    expect(await syncStripe(await organisation(), actorOf(bookkeeper))).toMatchObject({ status: "ok", added: 0, duplicates: 2 });
    // The first sync asked from a day before the start date, for NZD only.
    const asked = stripe.requests.filter((url) => url.pathname === "/v1/balance_transactions");
    expect(asked[0].searchParams.get("created[gte]")).toBe(String(Date.UTC(2026, 8, 30) / 1000));
    expect(asked[0].searchParams.get("currency")).toBe("nzd");
    expect(asked[0].searchParams.getAll("expand[]")).toEqual(["data.source"]);
  });

  it("ST4: a converted foreign charge is in NZD, saying the original amount and Stripe's rate", async () => {
    stripe.transactions = [ST3, ST4];
    expect(await syncStripe(await organisation(), actorOf(bookkeeper))).toMatchObject({ status: "ok", added: 2 });
    expect(await line("stripe:txn_2")).toMatchObject({ date: "2026-10-02", amount: "85.00", description: "Charge (USD 50.00 at 1.7)", currencyCode: "NZD" });
    expect(await line("stripe:txn_2:fee")).toMatchObject({ amount: "-3.05", description: "Stripe fees" });
  });

  it("ST5-ST8: refunds, disputes, tax on fees and payouts come in as Stripe reports them, paging through", async () => {
    stripe.transactions = [ST3, ST4, ST5, ST6, ST7, ST8];
    expect(await syncStripe(await organisation(), actorOf(bookkeeper))).toMatchObject({ status: "ok", added: 7 });
    const all = await lines();
    expect(all.filter((entry) => ["stripe:txn_3", "stripe:txn_3:fee"].includes(entry.externalId!)).map((entry) => [entry.amount, entry.description])).toEqual([
      ["-115.00", "Refund"],
    ]);
    expect(all.filter((entry) => entry.externalId!.startsWith("stripe:txn_4")).map((entry) => [entry.date, entry.amount, entry.description])).toEqual([
      ["2026-10-06", "-85.00", "Dispute"],
      ["2026-10-06", "-25.00", "Stripe fees"],
    ]);
    expect(all.filter((entry) => entry.externalId!.startsWith("stripe:txn_5")).map((entry) => [entry.amount, entry.description, entry.externalId])).toEqual([
      ["100.00", "Charge", "stripe:txn_5"],
      ["-3.00", "Stripe fees", "stripe:txn_5:fee"],
      ["-0.45", "Tax on Stripe fees", "stripe:txn_5:tax"],
    ]);
    expect(await line("stripe:txn_6")).toMatchObject({ date: "2026-10-08", amount: "-50.00", description: "Payout to bank" });
    // A won dispute adds back what Stripe returns.
    const won = linesFromStripe(txn({ id: "txn_7", type: "adjustment", reporting_category: "dispute_reversal", amount: 8500, created: nz(20, 9) }), "Pacific/Auckland");
    expect(won.map((entry) => [entry.amount, entry.description])).toEqual([["85.00", "Dispute reversal"]]);
  });

  it("ST8: the payout reconciles as a transfer to the bank account the money landed in", async () => {
    const payout = (await line("stripe:txn_6"))!;
    const reconciled = await as(bookkeeper, (tx) =>
      reconcileStatementLine(tx, payout.id, { idempotencyKey: key("rec"), kind: "transfer", otherAccountCode: "1000" }),
    );
    expect(reconciled.line.status).toBe("reconciled");
  });

  it("ST9: the lines add up to the change in Stripe's balance, which is kept as the statement balance", async () => {
    const all = await lines();
    expect(all).toHaveLength(11);
    expect(toFixedString(sum(all.map((entry) => dec(entry.amount))), 2)).toBe("15.09");
    const nets = [11159, 8195, -11500, -11000, 9655, -5000].reduce((total, net) => total + net, 0);
    expect(nets).toBe(1509);
    stripe.balance = { available: [{ amount: 1000, currency: "nzd" }], pending: [{ amount: 509, currency: "nzd" }] };
    await syncStripe(await organisation(), actorOf(bookkeeper));
    const account = await as(viewer, (tx) => getBankAccount(tx, stripeAccountId));
    expect(account.statementBalance).toBe("15.09");
    expect(toFixedString(add(dec("10.00"), dec("5.09")), 2)).toBe("15.09");
    expect(account.stripe).toMatchObject({ active: true, lastSyncStatus: "ok" });
  });

  it("a key that can't read the balance fails the sync with the reason; the schedule syncs when due", async () => {
    stripe.status = 403;
    const failed = await syncStripe(await organisation(), actorOf(bookkeeper));
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("The key can't read this");
    expect(await as(viewer, (tx) => getStripeStatus(tx))).toMatchObject({ lastSyncStatus: "failed" });
    stripe.status = 200;
    const asked = stripe.requests.length;
    await syncDueStripe();
    expect(stripe.requests.length).toBe(asked);
    await as(owner, (tx) => tx.query("update stripe_connections set last_synced_at = now() - interval '7 hours' where status = 'active'"));
    await syncDueStripe();
    expect(stripe.requests.length).toBeGreaterThan(asked);
    expect(await as(viewer, (tx) => getStripeStatus(tx))).toMatchObject({ lastSyncStatus: "ok" });
  });

  it("ST10: disconnecting deletes the key; reconnecting and relinking adds no line twice", async () => {
    const before = (await lines()).length;
    expect((await stripeRoute.DELETE(apiRequest(`/api/bank-feeds/stripe?organisationId=${org}`, { method: "DELETE", cookie: viewerCookie }), params({}))).status).toBe(403);
    await as(owner, (tx) => disconnectStripe(tx));
    const stored = await as(owner, (tx) => tx.query<{ api_key_ciphertext: string | null }>("select api_key_ciphertext from stripe_connections"));
    expect(stored.rows.every((row) => row.api_key_ciphertext === null)).toBe(true);
    expect((await as(viewer, (tx) => getBankAccount(tx, stripeAccountId))).stripe).toBeNull();
    await connectStripe(await organisation(), actorOf(owner), { apiKey: "rk_live_secondkey12345678" });
    await as(owner, (tx) => linkStripeBalance(tx, stripeAccountId, { currency: "NZD", startDate: "2026-10-01" }));
    expect(await syncStripe(await organisation(), actorOf(bookkeeper))).toMatchObject({ status: "ok", added: 0 });
    expect(await lines()).toHaveLength(before);
  });
});
