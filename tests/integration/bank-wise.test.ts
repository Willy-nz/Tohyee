import { afterAll, beforeAll, expect, it } from "vitest";
import * as wiseRoute from "@/app/api/bank-feeds/wise/route";
import * as syncRoute from "@/app/api/bank-feeds/wise/sync/route";
import * as linkRoute from "@/app/api/bank-accounts/[accountId]/wise/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { linkPayPalBalance } from "@/lib/bank/paypal/service";
import { setWiseFetchForTests, type WiseStatementTransaction } from "@/lib/bank/wise/client";
import { connectWise, disconnectWise, getWiseStatus, linesFromWise, linkWiseBalance, syncDueWise, syncWise } from "@/lib/bank/wise/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { dec, sum, toFixedString } from "@/lib/money/decimal";
import { getOrganisation } from "@/lib/organisations/registry";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const TOKEN = "wise-personal-token-0123456789abcdef";
/** The examples run to 9 Oct 2026; syncs look up to this moment. */
const LATER = new Date("2026-10-10T00:00:00Z");
const PROFILE = 4242;

function tx(
  reference: string,
  date: string,
  currency: string,
  amount: number,
  running: number,
  fields: { fee?: number; details?: WiseStatementTransaction["details"]; forAmount?: { value: number; currency: string } } = {},
): WiseStatementTransaction {
  return {
    type: amount < 0 ? "DEBIT" : "CREDIT",
    date,
    amount: { value: amount, currency },
    totalFees: { value: fields.fee ?? 0, currency },
    details: fields.details ?? { type: "TRANSFER" },
    exchangeDetails: fields.forAmount ? { forAmount: fields.forAmount } : null,
    runningBalance: { value: running, currency },
    referenceNumber: reference,
  };
}

// UTC times; NZDT is UTC+13 in October.
const WI3 = tx("DEPOSIT-111", "2026-09-30T22:00:00Z", "USD", 500, 500, {
  details: { type: "DEPOSIT", senderName: "ACME INC", paymentReference: "INV-0012", description: "Received money from ACME INC" },
});
const WI4_USD = tx("BALANCE-222", "2026-10-01T22:00:00Z", "USD", -300, 200, {
  fee: 2.25,
  details: { type: "CONVERSION", sourceAmount: { value: 300, currency: "USD" }, targetAmount: { value: 489.12, currency: "NZD" } },
});
const WI4_NZD = tx("BALANCE-222", "2026-10-01T22:00:00Z", "NZD", 489.12, 489.12, {
  details: { type: "CONVERSION", sourceAmount: { value: 300, currency: "USD" }, targetAmount: { value: 489.12, currency: "NZD" } },
});
const WI5 = tx("CARD-333", "2026-10-02T22:00:00Z", "NZD", -46, 443.12, { details: { type: "CARD", merchant: { name: "Z Energy" } } });
const WI6 = tx("CARD-444", "2026-10-03T22:00:00Z", "NZD", -22.45, 420.67, {
  fee: 0.2,
  details: { type: "CARD", merchant: { name: "Coles" } },
  forAmount: { value: 20, currency: "AUD" },
});
const WI7 = tx("TRANSFER-555", "2026-10-05T22:00:00Z", "NZD", -404.1, 16.57, { fee: 4.1, details: { type: "TRANSFER", description: "To Kauri Supplies" } });

/** A pretend Wise: one business profile, balances, and statements filtered by time and currency. */
const wise = {
  statements: { NZD: [] as WiseStatementTransaction[], USD: [] as WiseStatementTransaction[] } as Record<string, WiseStatementTransaction[]>,
  statementStatus: 200,
  profiles: [{ id: PROFILE, type: "BUSINESS", businessName: "Kobe Co" }] as Array<Record<string, unknown>>,
  requests: [] as URL[],
};

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  wise.requests.push(url);
  const auth = String((init?.headers as Record<string, string>).Authorization);
  if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${TOKEN}2`) return Response.json({ message: "Invalid token" }, { status: 401 });
  const path = url.pathname.replace(/^\/2026Q4/, "");
  if (path === "/profiles") return Response.json(wise.profiles);
  if (path === `/profiles/${PROFILE}/balances`) {
    expect(url.searchParams.get("types")).toBe("STANDARD");
    const total = (currency: string) => wise.statements[currency].at(-1)?.runningBalance?.value ?? 0;
    return Response.json([
      { id: 11, currency: "NZD", type: "STANDARD", amount: { value: total("NZD"), currency: "NZD" } },
      { id: 22, currency: "USD", type: "STANDARD", amount: { value: total("USD"), currency: "USD" } },
    ]);
  }
  const statement = /^\/profiles\/4242\/balance-statements\/(\d+)\/statement\.json$/.exec(path);
  if (statement) {
    if (wise.statementStatus !== 200) return Response.json({ message: "Strong customer authentication is required" }, { status: wise.statementStatus });
    expect(url.searchParams.get("type")).toBe("COMPACT");
    const currency = url.searchParams.get("currency")!;
    expect(statement[1]).toBe(currency === "NZD" ? "11" : "22");
    const start = Date.parse(url.searchParams.get("intervalStart")!);
    const end = Date.parse(url.searchParams.get("intervalEnd")!);
    expect(end - start).toBeLessThanOrEqual(469 * 86_400_000);
    const transactions = wise.statements[currency].filter((item) => Date.parse(String(item.date)) >= start && Date.parse(String(item.date)) <= end);
    // Wise lists the newest first; Tohyee sorts them.
    return Response.json({
      transactions: [...transactions].reverse(),
      endOfStatementBalance: { value: transactions.at(-1)?.runningBalance?.value ?? 0, currency },
    });
  }
  return Response.json({ message: "not found" }, { status: 404 });
}

/**
 * Examples WI1-WI10 in docs/ACCOUNTING-EXAMPLES.md ("Wise as a bank feed").
 * Base currency NZD, 1080 Wise NZD, 1090 Wise USD. A pretend Wise answers;
 * the examples run in order, as they build on each other.
 */
describeWithDatabase("Wise as a bank feed (WI1-WI10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  const org = "wise-co";
  let nzdId = "";
  let usdId = "";

  const as = <T>(user: SessionUser, work: (t: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const organisation = async () => (await getOrganisation(org))!;
  const actorOf = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const lines = async (accountId: string) =>
    (await as(viewer, (t) => listStatementLines(t, accountId, { status: "all" }))).lines.sort(
      (a, b) => a.date.localeCompare(b.date) || a.externalId!.localeCompare(b.externalId!),
    );
  const sync = async () => syncWise(await organisation(), actorOf(bookkeeper), LATER);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setWiseFetchForTests(fakeFetch);
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
    nzdId = (await as(owner, (t) => createBankAccount(t, { code: "1080", name: "Wise NZD", accountType: "bank" }))).id;
    usdId = (await as(owner, (t) => createBankAccount(t, { code: "1090", name: "Wise USD", accountType: "bank", currencyCode: "USD" }))).id;
  });

  afterAll(async () => {
    setWiseFetchForTests(null);
    await server?.teardown();
  });

  it("WI1: a business account's token is checked with Wise and stored encrypted; a personal-only token is refused", async () => {
    const post = (cookie: string, token: string) =>
      wiseRoute.POST(apiRequest("/api/bank-feeds/wise", { method: "POST", cookie, body: { organisationId: org, token } }), params({}));
    expect((await post(bookkeeperCookie, TOKEN)).status).toBe(403);
    const wrong = await post(ownerCookie, "not-the-right-token-0000000000");
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(await wrong.json())).toContain("Wise refused the token");
    wise.profiles = [{ id: 1, type: "PERSONAL", fullName: "Jess" }];
    const personal = await post(ownerCookie, TOKEN);
    expect(JSON.stringify(await personal.json())).toContain("no Wise business profile");
    wise.profiles = [
      { id: 1, type: "PERSONAL", fullName: "Jess" },
      { id: PROFILE, type: "BUSINESS", businessName: "Kobe Co" },
    ];
    const response = await post(ownerCookie, TOKEN);
    expect(response.status).toBe(201);
    const { wise: status } = (await response.json()) as { wise: Record<string, unknown> };
    expect(status).toMatchObject({ connected: true, profileId: PROFILE, profileName: "Kobe Co", syncEveryHours: 6 });
    expect((status.balances as Array<{ id: number; currency: string }>).map((balance) => [balance.id, balance.currency])).toEqual([
      [11, "NZD"],
      [22, "USD"],
    ]);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const stored = await as(owner, (t) => t.query<{ token_ciphertext: string }>("select token_ciphertext from wise_connections"));
    expect(stored.rows[0].token_ciphertext).not.toContain(TOKEN);
  });

  it("WI2: each Wise currency links to a bank account in that currency; one feed per account", async () => {
    await expect(as(owner, (t) => linkWiseBalance(t, usdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow(
      "Wise's balance is in NZD; 1090 is in USD.",
    );
    const link = (cookie: string, accountId: string, currency: string) =>
      linkRoute.POST(
        apiRequest(`/api/bank-accounts/${accountId}/wise`, { method: "POST", cookie, body: { organisationId: org, currency, startDate: "2026-10-01" } }),
        params({ accountId }),
      );
    expect((await link(bookkeeperCookie, nzdId, "NZD")).status).toBe(403);
    expect((await link(ownerCookie, nzdId, "NZD")).status).toBe(201);
    expect((await link(ownerCookie, usdId, "USD")).status).toBe(201);
    await expect(as(owner, (t) => linkPayPalBalance(t, nzdId, { currency: "NZD", startDate: "2026-10-01" }))).rejects.toThrow();
  });

  it("WI3-WI7: money received, a conversion, card payments and a transfer, with Wise's fee split when the running balance confirms it", async () => {
    wise.statements = { NZD: [WI4_NZD, WI5, WI6, WI7], USD: [WI3, WI4_USD] };
    const synced = await syncRoute.POST(apiRequest("/api/bank-feeds/wise/sync", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }), params({}));
    expect(synced.status).toBe(200);
    // Sync now looks up to the real clock; the examples are later than that, so the rest come with LATER.
    await sync();
    expect((await lines(usdId)).map((line) => [line.date, line.amount, line.description, line.payee, line.reference, line.externalId])).toEqual([
      ["2026-10-01", "500.00", "Received money from ACME INC", "ACME INC", "INV-0012", "wise:DEPOSIT-111"],
      ["2026-10-02", "-297.75", "Converted USD to NZD", null, null, "wise:BALANCE-222"],
      ["2026-10-02", "-2.25", "Wise fees", null, null, "wise:BALANCE-222:fee"],
    ]);
    expect((await lines(nzdId)).map((line) => [line.date, line.amount, line.description, line.payee, line.balance])).toEqual([
      ["2026-10-02", "489.12", "Converted USD to NZD", null, "489.12"],
      ["2026-10-03", "-46.00", "Card payment", "Z Energy", "443.12"],
      ["2026-10-04", "-22.25", "Card payment (AUD 20.00)", "Coles", "420.67"],
      ["2026-10-04", "-0.20", "Wise fees", null, "420.67"],
      ["2026-10-06", "-400.00", "To Kauri Supplies", null, "16.57"],
      ["2026-10-06", "-4.10", "Wise fees", null, "16.57"],
    ]);
    expect(await sync()).toMatchObject({ status: "ok", added: 0 });
  });

  it("WI8: a fee is split the other way when Wise's amount leaves it out, and not split when it can't be confirmed", async () => {
    // The running balance moved by the amount less the fee: the amount is kept, the fee added.
    const excluded = tx("TRANSFER-666", "2026-10-07T22:00:00Z", "USD", -10, 189, { fee: 1 });
    wise.statements.USD = [WI3, WI4_USD, excluded];
    expect(await sync()).toMatchObject({ added: 2 });
    expect((await lines(usdId)).filter((line) => line.externalId!.startsWith("wise:TRANSFER-666")).map((line) => line.amount)).toEqual(["-10.00", "-1.00"]);
    // Nothing earlier to compare with: one line, saying why.
    const [only] = linesFromWise(WI6, null, "Pacific/Auckland");
    expect(linesFromWise(WI6, null, "Pacific/Auckland")).toHaveLength(1);
    expect(only).toMatchObject({ amount: "-22.45", externalId: "wise:CARD-444" });
    expect(only.description).toContain("Wise fee 0.20 not split: Wise's running balance couldn't confirm it");
  });

  it("WI8: a transaction brought in unsplit never gets a second fee line later", async () => {
    // A late-arriving earlier transaction gives CARD-777 a running balance to compare with on the next sync.
    const card = tx("CARD-777", "2026-10-08T22:00:00Z", "NZD", -10.5, 6.07, { fee: 0.5, details: { type: "CARD", merchant: { name: "Cafe" } } });
    wise.statements.NZD = [card];
    await sync();
    expect((await lines(nzdId)).filter((line) => line.externalId!.startsWith("wise:CARD-777")).map((line) => line.amount)).toEqual(["-10.50"]);
    wise.statements.NZD = [WI4_NZD, WI5, WI6, WI7, card];
    await sync();
    expect((await lines(nzdId)).filter((line) => line.externalId!.startsWith("wise:CARD-777")).map((line) => line.amount)).toEqual(["-10.50"]);
  });

  it("WI9: the lines add up to the change in each Wise balance, which is kept as the statement balance", async () => {
    const nzd = (await lines(nzdId)).filter((line) => line.externalId !== "wise:CARD-777");
    expect(toFixedString(sum(nzd.map((line) => dec(line.amount))), 2)).toBe("16.57");
    const usd = (await lines(usdId)).filter((line) => !line.externalId!.startsWith("wise:TRANSFER-666"));
    expect(toFixedString(sum(usd.map((line) => dec(line.amount))), 2)).toBe("200.00");
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).statementBalance).toBe("6.07");
    expect((await as(viewer, (t) => getBankAccount(t, usdId))).statementBalance).toBe("189.00");
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).wise).toMatchObject({ active: true, lastSyncStatus: "ok" });
  });

  it("WI1: an account Wise won't give statements for fails the sync with Wise's reason; the schedule syncs when due", async () => {
    wise.statementStatus = 403;
    const failed = await sync();
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("only for accounts based in the US, Canada, Australia, New Zealand, Singapore or Malaysia");
    expect(await as(viewer, (t) => getWiseStatus(t))).toMatchObject({ lastSyncStatus: "failed" });
    wise.statementStatus = 200;
    const asked = wise.requests.length;
    await syncDueWise();
    expect(wise.requests.length).toBe(asked);
    await as(owner, (t) => t.query("update wise_connections set last_synced_at = now() - interval '7 hours' where status = 'active'"));
    await syncDueWise();
    expect(wise.requests.length).toBeGreaterThan(asked);
  });

  it("WI10: disconnecting deletes the token; reconnecting and relinking adds no line twice", async () => {
    const before = (await lines(nzdId)).length;
    expect((await wiseRoute.DELETE(apiRequest(`/api/bank-feeds/wise?organisationId=${org}`, { method: "DELETE", cookie: viewerCookie }), params({}))).status).toBe(403);
    await as(owner, (t) => disconnectWise(t));
    const stored = await as(owner, (t) => t.query<{ token_ciphertext: string | null }>("select token_ciphertext from wise_connections"));
    expect(stored.rows.every((row) => row.token_ciphertext === null)).toBe(true);
    expect((await as(viewer, (t) => getBankAccount(t, nzdId))).wise).toBeNull();
    await connectWise(await organisation(), actorOf(owner), { token: `${TOKEN}2` });
    await as(owner, (t) => linkWiseBalance(t, nzdId, { currency: "NZD", startDate: "2026-10-01" }));
    expect(await sync()).toMatchObject({ status: "ok", added: 0 });
    expect(await lines(nzdId)).toHaveLength(before);
  });
});
