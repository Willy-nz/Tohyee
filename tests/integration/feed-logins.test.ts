import { afterAll, beforeAll, expect, it } from "vitest";
import * as feedRoute from "@/app/api/bank-accounts/[accountId]/feed/route";
import * as akahuAccountsRoute from "@/app/api/bank-feeds/akahu/accounts/route";
import * as akahuSettingsRoute from "@/app/api/bank-feeds/akahu/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { setAkahuFetchForTests } from "@/lib/bank/akahu/client";
import { type AkahuSettings, getAkahuSettings } from "@/lib/bank/akahu/settings";
import { syncBankFeedAccount } from "@/lib/bank/akahu/sync";
import { setStripeFetchForTests } from "@/lib/bank/stripe/client";
import { connectStripe, disconnectStripe, getStripeStatus, linkStripeBalance } from "@/lib/bank/stripe/service";
import type { OrgTx } from "@/lib/db/org-transaction";
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

/**
 * A pretend Akahu with two personal apps: Jess's (her ANZ cheque account and
 * a joint account) and Will's (his BNZ savings and the same joint account).
 * Will's tokens can be revoked, and his new tokens can be made to lose BNZ.
 */
const akahu = {
  willRevoked: false,
  willLosesBnz: false,
  requests: [] as Array<{ url: string; app: string; user: string }>,
};

const ACCOUNTS: Record<string, Array<{ _id: string; name: string }>> = {
  jess: [
    { _id: "acc_anz", name: "ANZ Cheque" },
    { _id: "acc_joint", name: "Joint account" },
  ],
  will: [
    { _id: "acc_bnz", name: "BNZ Savings" },
    { _id: "acc_joint", name: "Joint account" },
  ],
};

async function fakeAkahu(input: string, init?: RequestInit): Promise<Response> {
  const headers = init?.headers as Record<string, string>;
  const app = headers["X-Akahu-Id"];
  const user = String(headers.Authorization).replace("Bearer ", "");
  akahu.requests.push({ url: input, app, user });
  const who = app === "app_token_jess" ? "jess" : app.startsWith("app_token_will") ? "will" : null;
  if (!who || (who === "will" && akahu.willRevoked && app === "app_token_will")) {
    return Response.json({ success: false, message: "Token revoked" }, { status: 401 });
  }
  const visible = ACCOUNTS[who].filter((account) => !(who === "will" && akahu.willLosesBnz && app === "app_token_willnew" && account._id === "acc_bnz"));
  const url = new URL(input);
  if (url.pathname.endsWith("/accounts")) {
    return Response.json({ success: true, items: visible.map((account) => ({ ...account, type: "CHECKING", balance: { current: 100 } })) });
  }
  const match = /\/accounts\/(acc_\w+)\/transactions/.exec(url.pathname);
  if (match) {
    const items = visible.some((account) => account._id === match[1])
      ? [{ _id: `trans_${match[1]}_${who}`, _account: match[1], date: "2026-10-01T03:00:00.000Z", description: `PAID ${who}`, amount: -10, balance: 90 }]
      : [];
    return Response.json({ success: true, items, cursor: { next: null } });
  }
  return Response.json({ success: true });
}

/** A pretend Stripe answering /balance for two keys, each with an NZD balance. */
async function fakeStripe(input: string, init?: RequestInit): Promise<Response> {
  const auth = String((init?.headers as Record<string, string>).Authorization);
  if (!/^Bearer rk_live_(shop|markets)/.test(auth)) return Response.json({ error: { message: "Invalid API Key provided" } }, { status: 401 });
  if (new URL(input).pathname === "/v1/balance") return Response.json({ available: [{ amount: 1000, currency: "nzd" }], pending: [{ amount: 0, currency: "nzd" }] });
  return Response.json({ object: "list", data: [], has_more: false });
}

/**
 * Examples BK30-BK37 in docs/ACCOUNTING-EXAMPLES.md ("Several bank feed
 * logins per organisation", #182, approved by Jess 8 Oct 2026): Glimmers
 * has Jess's ANZ login and Will's BNZ login; 1000 is linked to Jess's ANZ
 * cheque account and 1010 to Will's BNZ savings. In order.
 */
describeWithDatabase("several bank feed logins (#182, BK30-BK37)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let cookie: string;
  const org = "glimmers-feeds";
  const ids: Record<string, string> = {};
  let jess = "";
  let will = "";

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> });
  const save = async (fields: Record<string, unknown>) =>
    json(await akahuSettingsRoute.PUT(apiRequest("/api/bank-feeds/akahu/settings", { method: "PUT", cookie, body: { organisationId: org, ...fields } }), undefined as unknown));
  const link = async (code: string, fields: Record<string, unknown>) =>
    json(
      await feedRoute.POST(
        apiRequest(`/api/bank-accounts/${ids[code]}/feed`, { method: "POST", cookie, body: { organisationId: org, startDate: "2026-09-01", ...fields } }),
        params({ accountId: ids[code] }),
      ),
    );
  const settings = () => as((tx) => getAkahuSettings(tx));
  const organisation = async () => (await getOrganisation(org))!;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setAkahuFetchForTests(fakeAkahu);
    setStripeFetchForTests(fakeStripe);
    server = await startTestServer();
    owner = await createTestUser("feeds-owner@example.com", { serverAdmin: true });
    cookie = await sessionCookieFor(owner);
    await createTestOrganisation(owner, org);
    for (const [code, name] of [
      ["1010", "BNZ savings"],
      ["1020", "Joint account"],
      ["1030", "Joint account (Will)"],
      ["1050", "Stripe shop"],
      ["1051", "Stripe markets"],
    ]) {
      await as((tx) => createBankAccount(tx, { code, name, accountType: "bank" }));
    }
    for (const account of await as((tx) => listBankAccounts(tx))) ids[account.code] = account.id;
  });
  afterAll(async () => {
    setAkahuFetchForTests(null);
    setStripeFetchForTests(null);
    await server?.teardown();
  });

  it("BK30, BK37: adding Will's BNZ login doesn't replace Jess's; a name is required and can't be used twice", async () => {
    // The first login can be left unnamed: it's called Akahu, as an existing connection becomes (BK37).
    expect((await save({ add: true, appToken: "app_token_jess", userToken: "user_token_jess" })).status).toBe(200);
    expect((await settings()).logins.map((login) => login.name)).toEqual(["Akahu"]);
    expect(await save({ add: true, appToken: "app_token_will", userToken: "user_token_will" })).toMatchObject({
      status: 400,
      body: { error: 'Name this Akahu login, e.g. "Will\'s BNZ login".' },
    });
    expect(await save({ add: true, name: "akahu", appToken: "app_token_will", userToken: "user_token_will" })).toMatchObject({
      status: 409,
      body: { error: "Akahu already has a login called akahu." },
    });
    expect((await save({ add: true, name: "Will's BNZ login", appToken: "app_token_will", userToken: "user_token_will", syncEveryHours: 4 })).status).toBe(200);
    const both = await settings();
    expect(both.logins.map((login) => [login.name, login.appTokenHint, login.syncEveryHours])).toEqual([
      ["Akahu", "app_token_…jess", 6],
      ["Will's BNZ login", "app_token_…will", 4],
    ]);
    [jess, will] = both.logins.map((login) => login.connectionId);
  });

  it("BK31: linking lists both logins' accounts, labelled by login; the link remembers its login", async () => {
    const listed = await json(
      await akahuAccountsRoute.GET(apiRequest(`/api/bank-feeds/akahu/accounts?organisationId=${org}`, { cookie }), undefined as unknown),
    );
    const accounts = listed.body.accounts as Array<{ id: string; label: string; connectionId: string }>;
    expect(accounts.map((account) => account.label)).toEqual([
      "Akahu · ANZ Cheque",
      "Akahu · Joint account",
      "Will's BNZ login · BNZ Savings",
      "Will's BNZ login · Joint account",
    ]);
    // With several logins, the link says which.
    expect(await link("1000", { akahuAccountId: "acc_anz" })).toMatchObject({ status: 400, body: { error: "There are 2 Akahu logins. Choose which one." } });
    expect((await link("1000", { akahuAccountId: "acc_anz", connectionId: jess })).status).toBe(201);
    expect(await link("1010", { akahuAccountId: "acc_anz", connectionId: will })).toMatchObject({
      status: 400,
      body: { error: "Akahu doesn't have that account for Will's BNZ login." },
    });
    expect((await link("1010", { akahuAccountId: "acc_bnz", connectionId: will })).status).toBe(201);
    expect(await as((tx) => getBankAccount(tx, ids["1010"]))).toMatchObject({ feed: { akahuAccountId: "acc_bnz", akahuLoginName: "Will's BNZ login", active: true } });
    expect((await settings()).logins.map((login) => login.linkedAccounts.map((account) => account.code))).toEqual([["1000"], ["1010"]]);
  });

  it("BK32: each account syncs with its own login's tokens", async () => {
    akahu.requests = [];
    expect(await syncBankFeedAccount(await organisation(), ids["1000"])).toMatchObject({ added: 1 });
    expect(new Set(akahu.requests.map((request) => request.app))).toEqual(new Set(["app_token_jess"]));
    akahu.requests = [];
    expect(await syncBankFeedAccount(await organisation(), ids["1010"])).toMatchObject({ added: 1 });
    expect(new Set(akahu.requests.map((request) => request.app))).toEqual(new Set(["app_token_will"]));
  });

  it("BK33: Akahu refuses Will's tokens: 1010 and his login say so; 1000 keeps syncing; nothing is retried with Jess's", async () => {
    akahu.willRevoked = true;
    akahu.requests = [];
    await expect(syncBankFeedAccount(await organisation(), ids["1010"])).rejects.toThrow("Will's BNZ login needs new tokens.");
    expect(akahu.requests.every((request) => request.app === "app_token_will")).toBe(true);
    expect(await as((tx) => getBankAccount(tx, ids["1010"]))).toMatchObject({
      feed: { lastSyncStatus: "failed", akahuLoginProblem: "Will's BNZ login needs new tokens." },
    });
    expect((await settings()).logins.map((login) => login.tokenProblem)).toEqual([null, "Will's BNZ login needs new tokens."]);
    expect(await syncBankFeedAccount(await organisation(), ids["1000"])).toMatchObject({ added: 0, duplicates: 1 });
  });

  it("BK34: new tokens for Will's login: 1010 carries on; tokens that can't see it stop it with a message", async () => {
    expect((await save({ connectionId: will, appToken: "app_token_willnew", userToken: "user_token_willnew" })).status).toBe(200);
    expect((await settings()).logins[1]).toMatchObject({ name: "Will's BNZ login", tokenProblem: null, appTokenHint: "app_token_…lnew" });
    expect(await syncBankFeedAccount(await organisation(), ids["1010"])).toMatchObject({ duplicates: 1 });
    akahu.willLosesBnz = true;
    expect((await save({ connectionId: will, appToken: "app_token_willnew", userToken: "user_token_willnew" })).status).toBe(200);
    expect(await as((tx) => getBankAccount(tx, ids["1010"]))).toMatchObject({
      feed: { active: false, lastSyncStatus: "failed", lastSyncError: "This account isn't in Will's BNZ login any more. Link it again to carry on." },
    });
    akahu.willLosesBnz = false;
  });

  it("BK36: a joint account seen by both logins can be linked to only one Tohyee account", async () => {
    expect((await link("1020", { akahuAccountId: "acc_joint", connectionId: jess })).status).toBe(201);
    expect(await link("1030", { akahuAccountId: "acc_joint", connectionId: will })).toMatchObject({
      status: 400,
      body: { error: "That Akahu account is already linked to 1020 Joint account." },
    });
  });

  it("BK35: removing Will's login stops its feeds and keeps their lines; Jess's login is untouched", async () => {
    const before = (await as((tx) => listStatementLines(tx, ids["1010"], { status: "all" }))).lines.length;
    const removed = await json(
      await akahuSettingsRoute.DELETE(apiRequest(`/api/bank-feeds/akahu/settings?organisationId=${org}&connectionId=${will}`, { method: "DELETE", cookie }), undefined as unknown),
    );
    expect((removed.body.akahu as AkahuSettings).logins.map((login) => login.name)).toEqual(["Akahu"]);
    expect(await as((tx) => getBankAccount(tx, ids["1010"]))).toMatchObject({ feed: { akahuAccountId: null, active: false } });
    expect((await as((tx) => listStatementLines(tx, ids["1010"], { status: "all" }))).lines.length).toBe(before);
    expect(await as((tx) => getBankAccount(tx, ids["1000"]))).toMatchObject({ feed: { akahuAccountId: "acc_anz", active: true } });
    expect(await syncBankFeedAccount(await organisation(), ids["1000"])).toMatchObject({ duplicates: 1 });
  });

  it("every API feed: two Stripe logins can each link their NZD balance; disconnecting one leaves the other", async () => {
    const actor = { userId: owner.id, email: owner.email };
    await connectStripe(await organisation(), actor, { name: "Shop", apiKey: "rk_live_shop0000000000" });
    await connectStripe(await organisation(), actor, { name: "Markets", apiKey: "rk_live_markets00000000" });
    const status = await as((tx) => getStripeStatus(tx));
    const [shop, markets] = status.connections.map((connection) => connection.connectionId!);
    expect(status.connections.map((connection) => connection.name)).toEqual(["Shop", "Markets"]);
    await as((tx) => linkStripeBalance(tx, ids["1050"], { connectionId: shop, currency: "NZD", startDate: "2026-09-01" }));
    await as((tx) => linkStripeBalance(tx, ids["1051"], { connectionId: markets, currency: "NZD", startDate: "2026-09-01" }));
    await expect(as((tx) => linkStripeBalance(tx, ids["1051"], { currency: "NZD", startDate: "2026-09-01" }))).rejects.toThrow(
      "There are 2 Stripe logins. Choose which one.",
    );
    await as((tx) => disconnectStripe(tx, markets));
    const after = await as((tx) => getStripeStatus(tx));
    expect(after.connections.map((connection) => [connection.name, connection.balances.map((balance) => balance.linkedAccountId)])).toEqual([
      ["Shop", [ids["1050"]]],
    ]);
  });
});
