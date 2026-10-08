import { afterAll, beforeAll, expect, it } from "vitest";
import * as simplefinRoute from "@/app/api/bank-feeds/simplefin/route";
import * as syncRoute from "@/app/api/bank-feeds/simplefin/sync/route";
import * as linkRoute from "@/app/api/bank-accounts/[accountId]/simplefin/route";
import { setMailHostResolverForTests } from "@/lib/analytics/mail-host";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listStatementLines } from "@/lib/bank/accounts";
import { linkBankFeed } from "@/lib/bank/akahu/settings";
import { importStatementFile } from "@/lib/bank/imports";
import { setSimpleFinFetchForTests } from "@/lib/bank/simplefin/client";
import {
  connectSimpleFin,
  disconnectSimpleFin,
  getSimpleFinLink,
  getSimpleFinStatus,
  lineFromSimpleFin,
  linkSimpleFinAccount,
  syncDueSimpleFin,
  syncSimpleFin,
} from "@/lib/bank/simplefin/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
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

const CLAIM = "https://bridge.example.com/simplefin/claim/";
const token = (name: string) => Buffer.from(`${CLAIM}${name}`).toString("base64");
const T1 = {
  id: "T1",
  posted: 1788336000,
  amount: "-10.00",
  description: "Fishing bait",
  payee: "John's Fishin Shack",
  memo: "JOHNS FISHIN SHACK BAIT",
};
const T2 = { id: "T2", posted: 1788364800, amount: "-130.00", description: "Grocery store" };

/** A pretend SimpleFIN Bridge: claims each token once, and answers /accounts with whatever the test sets. */
const bridge = {
  claimed: new Set<string>(),
  requests: [] as URL[],
  checking: [] as Array<Record<string, unknown>>,
  errlist: [] as Array<Record<string, unknown>>,
  balance: "25401.15",
  status: 200,
};

function account(id: string, name: string, transactions: Array<Record<string, unknown>>) {
  return {
    id,
    name,
    conn_id: "CON-1",
    currency: "USD",
    balance: id === "ACT-1" ? bridge.balance : "100.00",
    "balance-date": 1791158400,
    transactions,
  };
}

async function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (input.startsWith(CLAIM)) {
    const name = input.slice(CLAIM.length);
    if (bridge.claimed.has(name)) return new Response("Forbidden", { status: 403 });
    bridge.claimed.add(name);
    return new Response(`https://user-${name}:secret-${name}@bridge.example.com/simplefin`);
  }
  if (url.pathname === "/simplefin/accounts") {
    expect(url.username).toBe("");
    expect(String((init?.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
    bridge.requests.push(url);
    if (bridge.status !== 200) return new Response("no", { status: bridge.status });
    const only = url.searchParams.get("balances-only") === "1";
    return Response.json({
      errlist: bridge.errlist,
      connections: [{ conn_id: "CON-1", name: "Chase" }],
      accounts: [account("ACT-1", "Checking", only ? [] : bridge.checking), account("ACT-2", "Savings", [])],
    });
  }
  return new Response("not found", { status: 404 });
}

/**
 * Examples SF1-SF10 in docs/ACCOUNTING-EXAMPLES.md ("SimpleFIN bank feeds").
 * Base currency NZD, 1000 Business bank account, and a USD bank account 1020.
 * A pretend Bridge connects "Chase" with ACT-1 Checking and ACT-2 Savings
 * (both USD). The examples run in order, as they build on each other.
 */
describeWithDatabase("SimpleFIN bank feeds (SF1-SF10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  const org = "simplefin-co";
  let usdId = "";
  let nzdId = "";

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
  const actorOf = (user: SessionUser) => ({ userId: user.id, email: user.email });
  const organisation = async () => (await getOrganisation(org))!;
  const lines = async (accountId = usdId) => (await as(viewer, (tx) => listStatementLines(tx, accountId, { status: "all" }))).lines;
  const feedLines = async () =>
    (await lines()).filter((line) => line.externalId?.startsWith("simplefin:")).sort((a, b) => a.externalId!.localeCompare(b.externalId!));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setMailHostResolverForTests(async () => ["203.0.113.10"]);
    setSimpleFinFetchForTests(fakeFetch);
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
    nzdId = (await as(viewer, (tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
    usdId = (await as(owner, (tx) => createBankAccount(tx, { code: "1020", name: "USD account", accountType: "bank", currencyCode: "USD" }))).id;
    // SF7: a USD CSV imported before linking.
    await as(bookkeeper, (tx) =>
      importStatementFile(tx, usdId, {
        idempotencyKey: key("import"),
        fileName: "usd.csv",
        fileBase64: Buffer.from("Date,Amount,Payee\n02/09/2026,-10.00,JOHNS FISHIN SHACK\n").toString("base64"),
      }),
    );
  });

  afterAll(async () => {
    setSimpleFinFetchForTests(null);
    setMailHostResolverForTests(null);
    await server?.teardown();
  });

  it("SF1: a setup token is claimed once; the access URL is stored encrypted and the accounts are listed", async () => {
    const post = (cookie: string, setupToken: string) =>
      simplefinRoute.POST(apiRequest("/api/bank-feeds/simplefin", { method: "POST", cookie, body: { organisationId: org, setupToken } }), params({}));
    expect((await post(bookkeeperCookie, token("A"))).status).toBe(403);
    expect((await post(ownerCookie, "not a token")).status).toBe(400);
    const response = await post(ownerCookie, token("A"));
    expect(response.status).toBe(201);
    const { simplefin } = (await response.json()) as { simplefin: Record<string, unknown> };
    expect(simplefin).toMatchObject({ connected: true, host: "bridge.example.com", syncEveryHours: 6, requestsLast24h: 1 });
    expect(simplefin.accounts).toEqual([
      { id: "ACT-1", name: "Checking", currency: "USD", connectionName: "Chase", balance: "25401.15", linkedAccountId: null },
      { id: "ACT-2", name: "Savings", currency: "USD", connectionName: "Chase", balance: "100.00", linkedAccountId: null },
    ]);
    expect(JSON.stringify(simplefin)).not.toContain("secret-A");
    const stored = await as(owner, (tx) => tx.query<{ access_url_ciphertext: string }>("select access_url_ciphertext from simplefin_connections"));
    expect(stored.rows[0].access_url_ciphertext).not.toContain("secret-A");
    const audit = await as(viewer, (tx) =>
      tx.query<{ actor_email: string }>("select actor_email from audit_events where event_type = 'bank_feed.simplefin_connected'"),
    );
    expect(audit.rows).toEqual([{ actor_email: owner.email }]);

    // A second login needs its own name (#182, BK30); the token works once anyway.
    await expect(connectSimpleFin(await organisation(), actorOf(owner), { setupToken: token("A") })).rejects.toThrow(
      'Name this SimpleFIN login, e.g. "Will\'s BNZ login".',
    );
    await expect(connectSimpleFin(await organisation(), actorOf(owner), { name: "simplefin", setupToken: token("A") })).rejects.toThrow(
      "SimpleFIN already has a login called simplefin.",
    );
    await as(owner, (tx) => disconnectSimpleFin(tx));
    await expect(connectSimpleFin(await organisation(), actorOf(owner), { setupToken: token("A") })).rejects.toThrow(
      "This setup token has been used. Make a new one in SimpleFIN Bridge.",
    );
    await connectSimpleFin(await organisation(), actorOf(owner), { setupToken: token("B") });
  });

  it("SF2: the SimpleFIN account's currency must be the bank account's; admins link", async () => {
    await expect(as(owner, (tx) => linkSimpleFinAccount(tx, nzdId, { simplefinAccountId: "ACT-1", startDate: "2026-09-01" }))).rejects.toThrow(
      "SimpleFIN says this account is in USD; 1000 is in NZD.",
    );
    const link = (cookie: string, body: Record<string, unknown>) =>
      linkRoute.POST(
        apiRequest(`/api/bank-accounts/${usdId}/simplefin`, { method: "POST", cookie, body: { organisationId: org, ...body } }),
        params({ accountId: usdId }),
      );
    expect((await link(bookkeeperCookie, { simplefinAccountId: "ACT-1", startDate: "2026-09-01" })).status).toBe(403);
    expect((await link(ownerCookie, { simplefinAccountId: "ACT-1", startDate: "2026-09-01", timeZone: "Mars/Olympus" })).status).toBe(400);
    const response = await link(ownerCookie, { simplefinAccountId: "ACT-1", startDate: "2026-09-01", timeZone: "America/Los_Angeles" });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { link: unknown }).link).toMatchObject({
      simplefinAccountId: "ACT-1",
      simplefinAccountName: "Checking",
      connectionName: "Chase",
      currencyCode: "USD",
      startDate: "2026-09-01",
      timeZone: "America/Los_Angeles",
      lastSyncStatus: "never",
    });
    // One feed per account: a SimpleFIN-linked account can't also link Akahu.
    await as(owner, (tx) =>
      tx.query(
        `insert into simplefin_links (account_id, connection_id, simplefin_account_id, currency_code, start_date, time_zone)
         select $1, id, 'NZD-TEST', 'NZD', '2026-09-01', 'Pacific/Auckland' from simplefin_connections where status = 'active'`,
        [nzdId],
      ),
    );
    await expect(as(owner, (tx) => linkBankFeed(tx, nzdId, { akahuAccountId: "acc_abc", startDate: "2026-09-01" }))).rejects.toThrow(
      "1000 is linked to SimpleFIN. Unlink it first.",
    );
    await as(owner, (tx) => tx.query("delete from simplefin_links where account_id = $1", [nzdId]));
    // One SimpleFIN account, one bank account.
    const other = await as(owner, (tx) => createBankAccount(tx, { code: "1021", name: "USD two", accountType: "bank", currencyCode: "USD" }));
    await expect(as(owner, (tx) => linkSimpleFinAccount(tx, other.id, { simplefinAccountId: "ACT-1", startDate: "2026-09-01" }))).rejects.toThrow(
      "already linked to another bank account",
    );
  });

  it("SF3: posted lines are added in the link's time zone; pending ones aren't; a second sync adds none", async () => {
    bridge.checking = [T1, T2, { id: "T3", posted: 0, amount: "-20.00", description: "Gas", pending: true }];
    const journalsBefore = (await as(viewer, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"))).rows[0].n;
    const synced = await syncRoute.POST(
      apiRequest("/api/bank-feeds/simplefin/sync", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }),
      params({}),
    );
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { result: unknown }).result).toMatchObject({ status: "ok", requests: 1, added: 2, possibleDuplicates: 1 });
    const added = await feedLines();
    expect(added.map((line) => [line.date, line.amount, line.description, line.payee, line.particulars, line.externalId, line.currencyCode])).toEqual(
      [
        ["2026-09-02", "-10.00", "Fishing bait", "John's Fishin Shack", "JOHNS FISHIN SHACK BAIT", "simplefin:ACT-1:T1", "USD"],
        ["2026-09-02", "-130.00", "Grocery store", null, null, "simplefin:ACT-1:T2", "USD"],
      ],
    );
    expect(added.every((line) => line.status === "unreconciled" && line.source === "simplefin")).toBe(true);
    expect((await as(viewer, (tx) => tx.query<{ n: number }>("select count(*)::int as n from ledger_journals"))).rows[0].n).toBe(journalsBefore);
    expect(await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true })).toMatchObject({ status: "ok", added: 0, duplicates: 2 });
    // In the organisation's own zone, T2 (09:00 in Los Angeles) is 3 Sep.
    expect(lineFromSimpleFin("ACT-1", T2, "Pacific/Auckland")).toMatchObject({ line: { date: "2026-09-03" } });
    // The first sync asked from a day before the start date; the request named no account and no pending.
    const first = bridge.requests[bridge.requests.length - 2];
    expect(Number(first.searchParams.get("start-date"))).toBe(Date.parse("2026-08-31T00:00:00Z") / 1000);
    expect(first.searchParams.get("pending")).toBeNull();
  });

  it("SF4: a pending transaction is added once it posts; a changed posted transaction isn't changed or added twice", async () => {
    bridge.checking = [T1, { ...T2, amount: "-131.00" }, { id: "T3", posted: 1788451200, amount: "-20.00", description: "Gas" }];
    expect(await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true })).toMatchObject({ status: "ok", added: 1 });
    const added = await feedLines();
    expect(added.map((line) => [line.date, line.amount])).toEqual([
      ["2026-09-02", "-10.00"],
      ["2026-09-02", "-130.00"],
      ["2026-09-03", "-20.00"],
    ]);
    // Later syncs ask from 10 days before the last line (2 Sep), but never before the start date (1 Sep), a day early.
    const last = bridge.requests[bridge.requests.length - 1];
    expect(Number(last.searchParams.get("start-date"))).toBe(Date.parse("2026-08-31T00:00:00Z") / 1000);
  });

  it("SF5: a first sync further back asks in 90-day pieces", async () => {
    const other = await as(owner, (tx) => createBankAccount(tx, { code: "1022", name: "USD savings", accountType: "bank", currencyCode: "USD" }));
    await as(owner, (tx) => linkSimpleFinAccount(tx, other.id, { simplefinAccountId: "ACT-2", startDate: "2026-01-01" }));
    const before = bridge.requests.length;
    const result = await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true });
    const start = Date.parse("2025-12-31T00:00:00Z");
    const end = Math.floor(Date.now() / 1000) * 1000 + 86_400_000;
    const expected = Math.ceil((end - start) / (90 * 86_400_000));
    expect(result.requests).toBe(expected);
    const asked = bridge.requests.slice(before);
    expect(asked).toHaveLength(expected);
    for (const request of asked) {
      expect(Number(request.searchParams.get("end-date")) - Number(request.searchParams.get("start-date"))).toBeLessThanOrEqual(90 * 86_400);
    }
    expect(Number(asked[0].searchParams.get("start-date"))).toBe(start / 1000);
    const link = await as(viewer, (tx) => getSimpleFinLink(tx, other.id));
    expect(link).toMatchObject({ lastSyncStatus: "ok", firstLineDate: null });
  });

  it("SF6: the Bridge's balance is kept as the statement balance with its date", async () => {
    const account = await as(viewer, (tx) => getBankAccount(tx, usdId));
    expect(account.statementBalance).toBe("25401.15");
    expect(account.statementBalanceAt).toBe("2026-10-05T00:00:00.000Z");
  });

  it("SF7: a feed line matching an imported file line is flagged as a possible duplicate", async () => {
    const all = await lines();
    const fileLine = all.find((line) => !line.externalId)!;
    const feedLine = all.find((line) => line.externalId === "simplefin:ACT-1:T1")!;
    expect(feedLine.possibleDuplicateOf).toBe(fileLine.id);
  });

  it("SF8: problems the Bridge reports are shown; lines it did return are still added", async () => {
    bridge.errlist = [{ code: "con.auth", msg: "Chase needs you to sign in again", conn_id: "CON-1" }];
    bridge.checking = [T1, T2, { id: "T4", posted: 1788537600, amount: "-5.00", description: "Coffee" }];
    const result = await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true });
    expect(result).toMatchObject({ status: "failed", added: 1 });
    const message = "SimpleFIN: Chase needs you to sign in again (fix it in SimpleFIN Bridge).";
    expect(await as(viewer, (tx) => getSimpleFinLink(tx, usdId))).toMatchObject({ lastSyncStatus: "failed", lastSyncError: message });
    expect(await as(viewer, (tx) => getSimpleFinStatus(tx))).toMatchObject({ lastSyncStatus: "failed", problems: [message] });
    bridge.errlist = [];
    // A refused access is a failed sync that adds nothing.
    bridge.status = 403;
    const refused = await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true });
    expect(refused).toMatchObject({ status: "failed", added: 0 });
    expect(refused.error).toContain("SimpleFIN refused Tohyee's access");
    bridge.status = 200;
  });

  it("SF9: a transaction that can't be read is skipped with its reason; the rest are added", async () => {
    bridge.checking = [
      { id: "T5", posted: 1788624000, amount: "-1.005", description: "Odd" },
      { id: "T6", posted: 1788624000, description: "No amount" },
      { id: "T7", posted: 1788624000, amount: "12.5", description: "Refund" },
    ];
    const result = await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true });
    expect(result).toMatchObject({ status: "ok", added: 1, skipped: 2 });
    expect((await feedLines()).find((line) => line.externalId === "simplefin:ACT-1:T7")).toMatchObject({ amount: "12.50" });
    const link = await as(viewer, (tx) => getSimpleFinLink(tx, usdId));
    expect(link?.skipped).toEqual([
      { id: "T5", reason: 'The amount "-1.005" isn\'t money to the cent.' },
      { id: "T6", reason: "SimpleFIN gave no amount." },
    ]);
  });

  it("Sync now stops at 20 requests in 24 hours; the schedule stops at the Bridge's 24", async () => {
    await as(owner, async (tx) => {
      const used = (await tx.query<{ n: number }>("select count(*)::int as n from simplefin_requests where made_at > now() - interval '24 hours'"))
        .rows[0].n;
      const id = (await tx.query<{ id: string }>("select id::text from simplefin_connections where status = 'active'")).rows[0].id;
      for (let i = used; i < 20; i += 1) await tx.query("insert into simplefin_requests (connection_id) values ($1)", [id]);
    });
    const refused = await syncRoute.POST(
      apiRequest("/api/bank-feeds/simplefin/sync", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: org } }),
      params({}),
    );
    expect(refused.status).toBe(409);
    expect(JSON.stringify(await refused.json())).toContain("Tohyee has asked SimpleFIN 20 times in the last 24 hours");
    bridge.checking = [T1];
    expect(await syncSimpleFin(await organisation(), actorOf(bookkeeper))).toMatchObject({ status: "ok", requests: 1 });
    // Due syncs run only in the quarter hour after the organisation's minute, and not again until due.
    const minute = (await as(owner, (tx) => tx.query<{ m: number }>("select sync_minute as m from simplefin_connections where status = 'active'")))
      .rows[0].m;
    await as(owner, (tx) => tx.query("update simplefin_connections set last_synced_at = now() - interval '7 hours' where status = 'active'"));
    const at = (offset: number) => {
      const when = new Date();
      when.setUTCMinutes((minute + offset) % 60, 0, 0);
      return when;
    };
    const asked = bridge.requests.length;
    await syncDueSimpleFin(at(30));
    expect(bridge.requests.length).toBe(asked);
    await syncDueSimpleFin(at(5));
    expect(bridge.requests.length).toBeGreaterThan(asked);
  });

  it("SF10: disconnecting deletes the access URL and unlinks; reconnecting and relinking adds no line twice", async () => {
    const before = (await lines()).length;
    const viewerDelete = await simplefinRoute.DELETE(
      apiRequest(`/api/bank-feeds/simplefin?organisationId=${org}`, { method: "DELETE", cookie: viewerCookie }),
      params({}),
    );
    expect(viewerDelete.status).toBe(403);
    const response = await simplefinRoute.DELETE(
      apiRequest(`/api/bank-feeds/simplefin?organisationId=${org}`, { method: "DELETE", cookie: ownerCookie }),
      params({}),
    );
    expect(((await response.json()) as { simplefin: unknown }).simplefin).toMatchObject({ connected: false });
    const stored = await as(owner, (tx) =>
      tx.query<{ access_url_ciphertext: string | null }>("select access_url_ciphertext from simplefin_connections"),
    );
    expect(stored.rows.every((row) => row.access_url_ciphertext === null)).toBe(true);
    expect(await as(viewer, (tx) => getSimpleFinLink(tx, usdId))).toBeNull();
    expect(await lines()).toHaveLength(before);
    await as(owner, (tx) => tx.query("delete from simplefin_requests"));
    await connectSimpleFin(await organisation(), actorOf(owner), { setupToken: token("C") });
    await as(owner, (tx) =>
      linkSimpleFinAccount(tx, usdId, { simplefinAccountId: "ACT-1", startDate: "2026-09-01", timeZone: "America/Los_Angeles" }),
    );
    bridge.checking = [T1, T2, { id: "T3", posted: 1788451200, amount: "-20.00", description: "Gas" }];
    expect(await syncSimpleFin(await organisation(), actorOf(bookkeeper), { manual: true })).toMatchObject({ status: "ok", added: 0 });
    expect(await lines()).toHaveLength(before);
  });
});
