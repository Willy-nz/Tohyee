import { afterAll, beforeAll, expect, it } from "vitest";
import * as contactDirectDebitRoute from "@/app/api/contacts/[contactId]/direct-debit/route";
import * as invoiceDirectDebitRoute from "@/app/api/invoices/[invoiceId]/direct-debit/route";
import * as gocardlessRoute from "@/app/api/online-payments/gocardless/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount } from "@/lib/bank/accounts";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { listPayments, recordPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { listTopBarNotices } from "@/lib/notices/top-bar";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  checkGoCardless,
  connectGoCardless,
  disconnectGoCardless,
  getContactDirectDebit,
  getGoCardlessStatus,
  getInvoiceDirectDebit,
  retryDirectDebit,
  setInvoiceDirectDebitSkip,
  startDirectDebit,
  updateGoCardlessSettings,
} from "@/lib/payments/gocardless";
import { setGoCardlessFetchForTests } from "@/lib/payments/gocardless-client";
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

const TOKEN = "sandbox_abcdefghijklmnopqrstuvwxyz0123456789";
const noContext = undefined as unknown;

type FakePayment = { id: string; amount: number; currency: string; charge_date: string | null; status: string; links: { mandate: string }; metadata: Record<string, string>; key: string };

/** A pretend GoCardless (sandbox): billing requests and their flows, mandates, payments and payouts. */
const gc = {
  hosts: new Set<string>(),
  billingRequests: new Map<string, { id: string; status: string; mandate: string | null }>(),
  mandates: new Map<string, { id: string; status: string; next_possible_charge_date: string | null }>(),
  payments: [] as FakePayment[],
  payouts: [] as Array<{ id: string; amount: number; deducted_fees: number; currency: string; status: string; arrival_date: string; reference: string; payout_type: string; created_at: string }>,
  cancelled: [] as string[],
  retried: [] as string[],
  /** GC10: the next payment is made, but the answer is lost on the way back. */
  loseNextAnswer: false,
};

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  gc.hosts.add(url.host);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (headers.Authorization !== `Bearer ${TOKEN}`) return Response.json({ error: { message: "Invalid token", type: "invalid_api_usage" } }, { status: 401 });
  if (headers["GoCardless-Version"] !== "2015-07-06") return Response.json({ error: { message: "version" } }, { status: 400 });
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, Record<string, unknown>>) : {};
  const path = url.pathname;
  if (path === "/creditors") return Response.json({ creditors: [{ id: "CR123", name: "Aroha Ltd" }] });
  if (path === "/billing_requests" && init?.method === "POST") {
    const id = `BRQ${gc.billingRequests.size + 1}`;
    gc.billingRequests.set(id, { id, status: "pending", mandate: null });
    return Response.json({ billing_requests: { id, status: "pending", links: {} } }, { status: 201 });
  }
  if (path === "/billing_request_flows") {
    const request = (body.billing_request_flows.links as { billing_request: string }).billing_request;
    return Response.json({ billing_request_flows: { id: `BRF_${request}`, authorisation_url: `https://pay-sandbox.gocardless.com/billing/static/flow?id=BRF_${request}`, expires_at: "2099-01-01T00:00:00.000Z" } }, { status: 201 });
  }
  const request = /^\/billing_requests\/(\w+)$/.exec(path);
  if (request) {
    const found = gc.billingRequests.get(request[1])!;
    return Response.json({ billing_requests: { id: found.id, status: found.status, links: { mandate_request_mandate: found.mandate } } });
  }
  const mandate = /^\/mandates\/(\w+)$/.exec(path);
  if (mandate) return Response.json({ mandates: gc.mandates.get(mandate[1]) });
  if (path === "/payments" && init?.method === "POST") {
    const idem = headers["Idempotency-Key"];
    const earlier = gc.payments.find((payment) => payment.key === idem);
    if (earlier) {
      return Response.json(
        { error: { message: "A resource has already been created with this idempotency key", errors: [{ reason: "idempotent_creation_conflict", links: { conflicting_resource_id: earlier.id } }] } },
        { status: 409 },
      );
    }
    const asked = body.payments as { amount: number; currency: string; charge_date?: string; links: { mandate: string }; metadata: Record<string, string> };
    const payment: FakePayment = {
      id: `PM${gc.payments.length + 1}`,
      amount: asked.amount,
      currency: asked.currency,
      charge_date: asked.charge_date ?? null,
      status: "pending_submission",
      links: asked.links,
      metadata: asked.metadata,
      key: idem,
    };
    gc.payments.push(payment);
    if (gc.loseNextAnswer) {
      gc.loseNextAnswer = false;
      throw new Error("socket hang up");
    }
    return Response.json({ payments: payment }, { status: 201 });
  }
  const action = /^\/payments\/(\w+)\/actions\/(cancel|retry)$/.exec(path);
  if (action) {
    const payment = gc.payments.find((entry) => entry.id === action[1])!;
    if (action[2] === "cancel") {
      if (payment.status !== "pending_submission") {
        return Response.json({ error: { message: "This payment can no longer be cancelled", errors: [{ reason: "cancellation_failed" }] } }, { status: 422 });
      }
      payment.status = "cancelled";
      gc.cancelled.push(payment.id);
    } else {
      payment.status = "pending_submission";
      gc.retried.push(payment.id);
    }
    return Response.json({ payments: payment });
  }
  const payment = /^\/payments\/(\w+)$/.exec(path);
  if (payment) return Response.json({ payments: gc.payments.find((entry) => entry.id === payment[1]) });
  if (path === "/payouts") {
    expect(url.searchParams.get("status")).toBe("paid");
    return Response.json({ payouts: gc.payouts, meta: { cursors: { after: null } } });
  }
  return Response.json({ error: { message: "not found" } }, { status: 404 });
}

const paymentFor = (invoiceId: string) => gc.payments.filter((entry) => entry.metadata.tohyee_invoice === invoiceId);

/**
 * Examples GC1-GC10 in docs/ACCOUNTING-EXAMPLES.md ("Direct debit with
 * GoCardless"), with Jess's answers of 8 Oct 2026. A pretend GoCardless
 * answers; the examples run in order on one organisation. Clearing account
 * 1070 GoCardless, payouts to 1000, fees to 6020 Bank fees.
 */
describeWithDatabase("direct debit with GoCardless (GC1-GC10)", () => {
  const org = "direct-debit-co";
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let viewer: SessionUser;
  const cookies = new Map<string, string>();
  let kobeId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actor = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const check = async (today: string) => checkGoCardless(await organisation(), actor(mere), today);
  const journalCount = async () => Number((await as(viewer, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);

  async function invoice(unitPrice: string, dueDate: string) {
    const draft = (
      await as(jess, (tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId: kobeId,
          invoiceDate: "2026-10-01",
          dueDate,
          amountsMode: "exclusive",
          lines: [{ description: "Coffee beans", quantity: "1", unitPrice, accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).invoice;
    return (await as(jess, (tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }))).invoice;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setGoCardlessFetchForTests(fakeFetch);
    server = await startTestServer();
    jess = await createTestUser("gc-jess@example.com", { displayName: "Jess" });
    mere = await createTestUser("gc-mere@example.com", { displayName: "Mere" });
    viewer = await createTestUser("gc-viewer@example.com");
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, mere.id, viewer.id]);
    for (const user of [jess, mere, viewer]) cookies.set(user.email, await sessionCookieFor(user));
    await as(jess, (tx) => updateOrganisationSettings(tx, { displayName: "Aroha Ltd" }));
    await as(jess, (tx) => createBankAccount(tx, { code: "1070", name: "GoCardless", accountType: "bank" }));
    kobeId = (await as(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", email: "accounts@kobe.example", isCustomer: true }))).contact.id;
  });

  afterAll(async () => {
    setGoCardlessFetchForTests(null);
    await server?.teardown();
  });

  it("GC1: an admin connects GoCardless and turns direct debit on; nothing is posted", async () => {
    const journals = await journalCount();
    await expect(startDirectDebit(await organisation(), actor(mere), kobeId)).rejects.toThrow("GoCardless isn't connected");
    await expect(connectGoCardless(await organisation(), actor(jess), { token: "sandbox_wrongwrongwrongwrongwrong", environment: "sandbox" })).rejects.toThrow(
      "GoCardless refused the access token",
    );
    const refused = await gocardlessRoute.POST(
      apiRequest("/api/online-payments/gocardless", { method: "POST", cookie: cookies.get(mere.email), body: { organisationId: org, token: TOKEN, environment: "sandbox" } }),
      noContext,
    );
    expect(refused.status).toBe(403);
    const connected = await gocardlessRoute.POST(
      apiRequest("/api/online-payments/gocardless", { method: "POST", cookie: cookies.get(jess.email), body: { organisationId: org, token: TOKEN, environment: "sandbox" } }),
      noContext,
    );
    expect(connected.status).toBe(201);
    const text = await connected.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).gocardless).toMatchObject({ connected: true, environment: "sandbox", creditorName: "Aroha Ltd", enabled: false });
    expect([...gc.hosts]).toEqual(["api-sandbox.gocardless.com"]);
    const stored = await as(viewer, (tx) => tx.query<{ access_token_ciphertext: string }>("select access_token_ciphertext from gocardless_settings"));
    expect(stored.rows[0].access_token_ciphertext).not.toContain(TOKEN);

    await expect(as(jess, (tx) => updateGoCardlessSettings(tx, { enabled: true }))).rejects.toThrow("Choose the account collected money waits in");
    await expect(as(jess, (tx) => updateGoCardlessSettings(tx, { enabled: true, clearingAccountCode: "1070", payoutAccountCode: "1070", feesAccountCode: "6020" }))).rejects.toThrow(
      "must be different bank accounts",
    );
    await expect(as(jess, (tx) => updateGoCardlessSettings(tx, { enabled: true, clearingAccountCode: "1070", payoutAccountCode: "1000", feesAccountCode: "1000" }))).rejects.toThrow(
      "must be an expense account",
    );
    await expect(as(jess, (tx) => updateGoCardlessSettings(tx, { enabled: true, clearingAccountCode: "4000", payoutAccountCode: "1000", feesAccountCode: "6020" }))).rejects.toThrow(
      "must be a NZD bank account",
    );
    const on = await as(jess, (tx) => updateGoCardlessSettings(tx, { enabled: true, clearingAccountCode: "1070", payoutAccountCode: "1000", feesAccountCode: "6020" }));
    expect(on).toMatchObject({ enabled: true, clearingAccountCode: "1070", payoutAccountCode: "1000", feesAccountCode: "6020", failed: [] });
    expect(await journalCount()).toBe(journals);
  });

  it("GC2: Kobe Cafe gets a link to GoCardless's page; once the authority is active the contact shows it", async () => {
    const viewerTry = await contactDirectDebitRoute.POST(
      apiRequest(`/api/contacts/${kobeId}/direct-debit`, { method: "POST", cookie: cookies.get(viewer.email), body: { organisationId: org } }),
      params({ contactId: kobeId }),
    );
    expect(viewerTry.status).toBe(403);
    const started = await startDirectDebit(await organisation(), actor(mere), kobeId);
    expect(started).toMatchObject({ available: true, current: { status: "pending", url: "https://pay-sandbox.gocardless.com/billing/static/flow?id=BRF_BRQ1" } });
    await expect(startDirectDebit(await organisation(), actor(mere), kobeId)).rejects.toThrow("Kobe Cafe already has a link to set it up");

    await check("2026-10-20");
    expect((await as(viewer, (tx) => getContactDirectDebit(tx, kobeId))).current?.status).toBe("pending");
    gc.billingRequests.set("BRQ1", { id: "BRQ1", status: "fulfilled", mandate: "MD1" });
    gc.mandates.set("MD1", { id: "MD1", status: "pending_submission", next_possible_charge_date: "2026-10-23" });
    await check("2026-10-20");
    expect((await as(viewer, (tx) => getContactDirectDebit(tx, kobeId))).current).toMatchObject({ status: "pending", mandateId: "MD1", providerStatus: "pending_submission" });
    gc.mandates.set("MD1", { id: "MD1", status: "active", next_possible_charge_date: "2026-10-22" });
    await check("2026-10-20");
    expect((await as(viewer, (tx) => getContactDirectDebit(tx, kobeId))).current).toMatchObject({ status: "active", url: null });
    await expect(startDirectDebit(await organisation(), actor(mere), kobeId)).rejects.toThrow("Kobe Cafe already has an active direct debit authority");
  });

  let inv30 = "";

  it("GC3: INV-0030 for 115.00 due 30 Oct is asked for three days before, to be collected on 30 Oct; nothing is posted", async () => {
    inv30 = (await invoice("100.00", "2026-10-30")).id;
    const journals = await journalCount();
    expect(await check("2026-10-26")).toMatchObject({ collected: 0, error: null });
    expect(paymentFor(inv30)).toHaveLength(0);
    expect(await check("2026-10-27")).toMatchObject({ collected: 1, error: null });
    expect(paymentFor(inv30).map((entry) => [entry.amount, entry.currency, entry.charge_date, entry.links.mandate])).toEqual([[11500, "NZD", "2026-10-30", "MD1"]]);
    expect(await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv30))).toMatchObject({
      available: true,
      skipped: false,
      canRetry: false,
      collections: [{ amount: "115.00", chargeDate: "2026-10-30", status: "scheduled" }],
    });
    expect(await as(viewer, (tx) => listPayments(tx, inv30))).toHaveLength(0);
    expect(await journalCount()).toBe(journals);
    expect(await check("2026-10-28")).toMatchObject({ collected: 0 });
    expect(paymentFor(inv30)).toHaveLength(1);
  });

  it("GC4: confirmed, the payment is recorded into 1070 (Dr 1070 115.00, Cr 1100 115.00)", async () => {
    paymentFor(inv30)[0].status = "confirmed";
    expect(await check("2026-10-30")).toMatchObject({ recorded: 1, error: null });
    const [payment] = await as(viewer, (tx) => listPayments(tx, inv30));
    expect(payment).toMatchObject({ paymentDate: "2026-10-30", amount: "115.00", bankAccountCode: "1070" });
    const journal = await as(viewer, (tx) => getJournal(tx, payment.journalId));
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1070", "115.00", "0.00"],
      ["1100", "0.00", "115.00"],
    ]);
    expect(await as(viewer, (tx) => getInvoice(tx, inv30))).toMatchObject({ amountDue: "0.00" });
    // GC10: the same answer again changes nothing; paid out, it's still the one payment.
    expect(await check("2026-10-31")).toMatchObject({ recorded: 0 });
    paymentFor(inv30)[0].status = "paid_out";
    expect(await check("2026-11-01")).toMatchObject({ recorded: 0, collected: 0 });
    expect(await as(viewer, (tx) => listPayments(tx, inv30))).toHaveLength(1);
  });

  it("GC5: the payout of 113.85 after a 1.15 fee posts Dr 1000 113.85, Dr 6020 1.15, Cr 1070 115.00, once", async () => {
    gc.payouts.push({
      id: "PO1",
      amount: 11385,
      deducted_fees: 115,
      currency: "NZD",
      status: "paid",
      arrival_date: "2026-11-05",
      reference: "AROHA-PO1",
      payout_type: "merchant",
      created_at: new Date().toISOString(),
    });
    expect(await check("2026-11-05")).toMatchObject({ payouts: 1, error: null });
    const posted = await as(viewer, (tx) => tx.query<{ journal_id: string; amount: string; fees: string }>("select journal_id::text, amount::text, fees::text from gocardless_payouts"));
    expect(posted.rows.map((row) => [row.amount, row.fees])).toEqual([["113.85", "1.15"]]);
    const journal = await as(viewer, (tx) => getJournal(tx, posted.rows[0].journal_id));
    expect(journal.postingDate).toBe("2026-11-05");
    expect(journal.lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount])).toEqual([
      ["1000", "113.85", "0.00"],
      ["6020", "1.15", "0.00"],
      ["1070", "0.00", "115.00"],
    ]);
    // GC10: the same payout again isn't posted twice.
    expect(await check("2026-11-06")).toMatchObject({ payouts: 0 });
  });

  let inv32 = "";

  it("GC6: a failure voids the payment, the invoice is due again, and it isn't retried until someone presses Try again", async () => {
    inv32 = (await invoice("50.00", "2026-11-06")).id;
    expect(await check("2026-11-03")).toMatchObject({ collected: 1 });
    const [asked] = paymentFor(inv32);
    asked.status = "confirmed";
    expect(await check("2026-11-06")).toMatchObject({ recorded: 1 });
    expect(await as(viewer, (tx) => getInvoice(tx, inv32))).toMatchObject({ amountDue: "0.00" });
    asked.status = "failed";
    expect(await check("2026-11-09")).toMatchObject({ failed: 1, collected: 0 });
    const payments = await as(viewer, (tx) => listPayments(tx, inv32));
    expect(payments.map((entry) => entry.status)).toEqual(["voided"]);
    expect(await as(viewer, (tx) => getInvoice(tx, inv32))).toMatchObject({ amountDue: "57.50" });
    expect(await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv32))).toMatchObject({
      canRetry: true,
      collections: [{ status: "failed", failureReason: "GoCardless says it failed." }],
    });
    expect((await as(viewer, (tx) => getGoCardlessStatus(tx))).failed).toMatchObject([{ invoiceId: inv32, contactName: "Kobe Cafe", amount: "57.50" }]);
    expect(await as(viewer, (tx) => listTopBarNotices(tx))).toContainEqual({
      id: "gocardless-failed",
      message: "1 direct debit collection failed.",
      href: "/operations/settings/online-payments",
    });
    // No automatic retry, and no new collection either.
    expect(await check("2026-11-10")).toMatchObject({ collected: 0 });
    expect(paymentFor(inv32)).toHaveLength(1);
    expect(gc.retried).toEqual([]);

    const viewerTry = await invoiceDirectDebitRoute.POST(
      apiRequest(`/api/invoices/${inv32}/direct-debit`, { method: "POST", cookie: cookies.get(viewer.email), body: { organisationId: org } }),
      params({ invoiceId: inv32 }),
    );
    expect(viewerTry.status).toBe(403);
    const retried = await retryDirectDebit(await organisation(), actor(mere), inv32);
    expect(retried).toMatchObject({ canRetry: false, collections: [{ status: "scheduled", retries: 1 }] });
    expect(gc.retried).toEqual([asked.id]);
    expect(await as(viewer, (tx) => listTopBarNotices(tx))).not.toContainEqual(expect.objectContaining({ id: "gocardless-failed" }));
    asked.status = "confirmed";
    expect(await check("2026-11-13")).toMatchObject({ recorded: 1 });
    expect((await as(viewer, (tx) => listPayments(tx, inv32))).map((entry) => [entry.status, entry.amount])).toEqual([
      ["voided", "57.50"],
      ["active", "57.50"],
    ]);
    expect(await as(viewer, (tx) => getInvoice(tx, inv32))).toMatchObject({ amountDue: "0.00" });
  });

  it("GC8: with 100.00 of 230.00 paid by transfer, only the 130.00 due is collected; a payment after asking cancels and asks again", async () => {
    const inv31 = (await invoice("200.00", "2026-11-20")).id;
    await as(mere, (tx) => recordPayment(tx, inv31, { idempotencyKey: key("pay"), paymentDate: "2026-11-10", amount: "100.00", bankAccountCode: "1000" }));
    expect(await check("2026-11-17")).toMatchObject({ collected: 1 });
    expect(paymentFor(inv31).map((entry) => entry.amount)).toEqual([13000]);

    const inv33 = (await invoice("100.00", "2026-11-20")).id;
    expect(await check("2026-11-17")).toMatchObject({ collected: 1 });
    await as(mere, (tx) => recordPayment(tx, inv33, { idempotencyKey: key("pay"), paymentDate: "2026-11-18", amount: "15.00", bankAccountCode: "1000" }));
    await check("2026-11-18");
    expect(paymentFor(inv33).map((entry) => [entry.amount, entry.status])).toEqual([
      [11500, "cancelled"],
      [10000, "pending_submission"],
    ]);
    expect((await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv33))).collections.map((entry) => [entry.status, entry.amount, entry.notice])).toEqual([
      ["cancelled", "115.00", "Cancelled because only 100.00 is due now."],
      ["scheduled", "100.00", null],
    ]);
  });

  it("GC9: voided before the charge date, the collection is cancelled; once sent to the bank, it's flagged instead", async () => {
    const inv34 = (await invoice("100.00", "2026-11-27")).id;
    expect(await check("2026-11-24")).toMatchObject({ collected: 1 });
    await as(jess, (tx) => voidInvoice(tx, inv34, { idempotencyKey: key("void"), voidDate: "2026-11-25" }));
    await check("2026-11-25");
    expect(paymentFor(inv34).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect((await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv34))).collections).toMatchObject([{ status: "cancelled" }]);

    const inv35 = (await invoice("100.00", "2026-11-27")).id;
    expect(await check("2026-11-24")).toMatchObject({ collected: 1 });
    paymentFor(inv35)[0].status = "submitted";
    await as(jess, (tx) => voidInvoice(tx, inv35, { idempotencyKey: key("void"), voidDate: "2026-11-25" }));
    await check("2026-11-25");
    const [flagged] = (await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv35))).collections;
    expect(flagged.status).toBe("scheduled");
    expect(flagged.notice).toContain("had already sent this collection to the bank");
  });

  it("Don't collect this one: a ticked invoice isn't collected, and ticking cancels a collection not yet sent", async () => {
    const skipped = (await invoice("100.00", "2026-12-04")).id;
    const viewerTry = await invoiceDirectDebitRoute.PUT(
      apiRequest(`/api/invoices/${skipped}/direct-debit`, { method: "PUT", cookie: cookies.get(viewer.email), body: { organisationId: org, skip: true } }),
      params({ invoiceId: skipped }),
    );
    expect(viewerTry.status).toBe(403);
    expect(await as(mere, (tx) => setInvoiceDirectDebitSkip(tx, skipped, true))).toMatchObject({ skipped: true });
    const later = (await invoice("100.00", "2026-12-04")).id;
    expect(await check("2026-12-01")).toMatchObject({ collected: 1 });
    expect(paymentFor(skipped)).toHaveLength(0);
    expect(paymentFor(later)).toHaveLength(1);
    await as(mere, (tx) => setInvoiceDirectDebitSkip(tx, later, true));
    await check("2026-12-02");
    expect(paymentFor(later).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect((await as(viewer, (tx) => getInvoiceDirectDebit(tx, later))).collections[0].notice).toBe("Cancelled because it's marked \"don't collect\".");
  });

  it("GC10: a collection whose answer was lost is found again by its idempotency key, not asked for twice", async () => {
    const inv36 = (await invoice("100.00", "2026-12-11")).id;
    gc.loseNextAnswer = true;
    const first = await check("2026-12-08");
    expect(first.error).toContain("GoCardless couldn't be reached");
    expect(paymentFor(inv36)).toHaveLength(1);
    expect((await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv36))).collections).toHaveLength(0);
    expect(await check("2026-12-08")).toMatchObject({ collected: 1, error: null });
    expect(paymentFor(inv36)).toHaveLength(1);
    expect((await as(viewer, (tx) => getInvoiceDirectDebit(tx, inv36))).collections).toMatchObject([{ status: "scheduled", amount: "115.00" }]);
    expect((await as(viewer, (tx) => getGoCardlessStatus(tx))).lastCheckStatus).toBe("ok");
  });

  it("GC7: Kobe Cafe cancels the authority; collections GoCardless cancels are cancelled, invoices stay due, nothing new is asked for", async () => {
    await expect(as(jess, (tx) => disconnectGoCardless(tx))).rejects.toThrow("on the way");
    const open = gc.payments.filter((entry) => entry.status === "pending_submission");
    expect(open.length).toBeGreaterThan(0);
    gc.mandates.set("MD1", { id: "MD1", status: "cancelled", next_possible_charge_date: null });
    for (const entry of open) entry.status = "cancelled";
    const fresh = (await invoice("100.00", "2026-12-18")).id;
    await check("2026-12-15");
    expect((await as(viewer, (tx) => getContactDirectDebit(tx, kobeId))).current).toMatchObject({ status: "ended", endedReason: "GoCardless says the authority is cancelled." });
    expect(paymentFor(fresh)).toHaveLength(0);
    for (const entry of open) {
      const state = await as(viewer, (tx) => getInvoiceDirectDebit(tx, entry.metadata.tohyee_invoice));
      expect(state.collections.at(-1)?.status).toBe("cancelled");
      expect(state.available).toBe(false);
    }
    const lost = open.find((entry) => entry.amount === 11500)!;
    expect(await as(viewer, (tx) => getInvoice(tx, lost.metadata.tohyee_invoice))).toMatchObject({ status: "approved", amountDue: "115.00" });
    // A new link can be asked for now the old authority has ended.
    expect(await startDirectDebit(await organisation(), actor(mere), kobeId)).toMatchObject({ current: { status: "pending" } });
  });

  it("disconnects once nothing is on the way; the token is deleted", async () => {
    // The GC9 collection already sent to the bank is still on its way.
    await expect(as(jess, (tx) => disconnectGoCardless(tx))).rejects.toThrow("collection is on the way");
    for (const entry of gc.payments.filter((item) => item.status === "submitted")) entry.status = "cancelled";
    await check("2026-12-16");
    const off = await as(jess, (tx) => disconnectGoCardless(tx));
    expect(off).toMatchObject({ connected: false, enabled: false });
    const stored = await as(viewer, (tx) => tx.query<{ access_token_ciphertext: string | null }>("select access_token_ciphertext from gocardless_settings"));
    expect(stored.rows[0].access_token_ciphertext).toBeNull();
    const seen = await gocardlessRoute.GET(apiRequest(`/api/online-payments/gocardless?organisationId=${org}`, { cookie: cookies.get(viewer.email) }), noContext);
    expect(seen.status).toBe(200);
  });
});
