import { afterAll, beforeAll, expect, it } from "vitest";
import * as feedRoute from "@/app/api/bank-accounts/[accountId]/feed/route";
import * as akahuAccountsRoute from "@/app/api/bank-feeds/akahu/accounts/route";
import * as akahuLinksRoute from "@/app/api/bank-feeds/akahu/links/route";
import * as akahuSettingsRoute from "@/app/api/bank-feeds/akahu/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, getBankAccount, listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { setAkahuFetchForTests } from "@/lib/bank/akahu/client";
import { getAkahuSettings } from "@/lib/bank/akahu/settings";
import { akahuLoginStatus } from "@/lib/bank/akahu/setup";
import { syncBankFeedAccount } from "@/lib/bank/akahu/sync";
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
 * A pretend Akahu (made-up tokens and accounts, #543). "Main" shares an
 * everyday account, a credit card in credit and a term deposit with no
 * transactions; "empty" shares nothing; "blocked" answers 403 and "bad"
 * 401. `down` makes transactions fail, and `more` adds a transaction.
 */
const akahu = { down: false, more: false };

const MAIN_ACCOUNTS = [
  { _id: "acc_everyday", name: "Everyday", formatted_account: "01-0123-0456789-00", type: "CHECKING", status: "ACTIVE", attributes: ["TRANSACTIONS"], balance: { current: 950 } },
  { _id: "acc_visa", name: "Visa", formatted_account: "4111-xxxx-xxxx-1111", type: "CREDITCARD", status: "ACTIVE", attributes: ["TRANSACTIONS"], balance: { current: 25.5 } },
  { _id: "acc_term", name: "Term deposit", type: "TERMDEPOSIT", status: "ACTIVE", attributes: [], balance: { current: 10000 } },
];

async function fakeAkahu(input: string, init?: RequestInit): Promise<Response> {
  const headers = init?.headers as Record<string, string>;
  const app = headers["X-Akahu-Id"];
  if (app === "app_token_bad") return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
  if (app === "app_token_blocked") return Response.json({ success: false, message: "Forbidden" }, { status: 403 });
  const url = new URL(input);
  const accounts = app === "app_token_empty" ? [] : MAIN_ACCOUNTS;
  if (url.pathname.endsWith("/accounts")) return Response.json({ success: true, items: accounts });
  const match = /\/accounts\/(acc_\w+)\/transactions/.exec(url.pathname);
  if (match) {
    if (akahu.down) return Response.json({ success: false, message: "Akahu is having a moment" }, { status: 500 });
    const items = [
      { _id: `trans_${match[1]}_1`, _account: match[1], date: "2026-10-01T03:00:00.000Z", description: "PAID ONE", amount: -10, balance: 90 },
      { _id: `trans_${match[1]}_2`, _account: match[1], date: "2026-10-02T03:00:00.000Z", description: "PAID TWO", amount: 25, balance: 115 },
    ];
    if (akahu.more) items.push({ _id: `trans_${match[1]}_3`, _account: match[1], date: "2026-10-03T03:00:00.000Z", description: "PAID THREE", amount: -5, balance: 110 });
    return Response.json({ success: true, items, cursor: { next: null } });
  }
  return Response.json({ success: true });
}

/**
 * The guided Akahu setup (#543, decisions 1288-1291), in order: bad tokens,
 * a saved login with nothing linked, zero accounts, linking several at once,
 * the first sync, a repeat sync with nothing new, a failure, and existing
 * links never replaced.
 */
describeWithDatabase("guided Akahu setup and feed statuses (#543)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let cookie: string;
  const org = "akahu-guided";
  const ids: Record<string, string> = {};
  let main = "";
  let empty = "";

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
  const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> });
  const save = async (fields: Record<string, unknown>) =>
    json(await akahuSettingsRoute.PUT(apiRequest("/api/bank-feeds/akahu/settings", { method: "PUT", cookie, body: { organisationId: org, ...fields } }), undefined as unknown));
  const list = async (connectionId: string) =>
    json(await akahuAccountsRoute.GET(apiRequest(`/api/bank-feeds/akahu/accounts?organisationId=${org}&connectionId=${connectionId}`, { cookie }), undefined as unknown));
  const linkMany = async (fields: Record<string, unknown>) =>
    json(await akahuLinksRoute.POST(apiRequest("/api/bank-feeds/akahu/links", { method: "POST", cookie, body: { organisationId: org, startDate: "2026-09-01", ...fields } }), undefined as unknown));
  const login = async (connectionId: string) => (await as((tx) => getAkahuSettings(tx))).logins.find((entry) => entry.connectionId === connectionId)!;
  const organisation = async () => (await getOrganisation(org))!;
  const lineCount = async (code: string) => (await as((tx) => listStatementLines(tx, ids[code], {}))).total;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    setAkahuFetchForTests(fakeAkahu);
    server = await startTestServer();
    owner = await createTestUser("akahu-guided-owner@example.com", { serverAdmin: true });
    cookie = await sessionCookieFor(owner);
    await createTestOrganisation(owner, org);
    await as((tx) => createBankAccount(tx, { code: "1901", name: "Everyday", accountType: "bank" }));
    await as((tx) => createBankAccount(tx, { code: "2901", name: "Visa card", accountType: "credit_card" }));
    await as((tx) => createBankAccount(tx, { code: "1902", name: "Old savings", accountType: "bank" }));
    for (const account of await as((tx) => listBankAccounts(tx))) ids[account.code] = account.id;
  });
  afterAll(async () => {
    setAkahuFetchForTests(null);
    await server?.teardown();
  });

  it("invalid tokens and missing permissions are refused with a next step, and nothing is saved", async () => {
    expect(await save({ add: true, appToken: "app_token_bad", userToken: "user_token_bad" })).toMatchObject({
      status: 400,
      body: {
        error:
          "Akahu refused the tokens: Unauthorized. Copy the App ID token and user token again from the Developers page at my.akahu.nz. Both must come from the same personal app.",
      },
    });
    expect(await save({ add: true, appToken: "app_token_blocked", userToken: "user_token_blocked" })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/^Akahu says this app isn't allowed to do that: Forbidden\. At my\.akahu\.nz › Developers, check the app's IP address ranges/) },
    });
    expect((await as((tx) => getAkahuSettings(tx))).logins).toEqual([]);
  });

  it("incomplete setup: a saved login with nothing linked says accounts need linking", async () => {
    const saved = await save({ add: true, appToken: "app_token_main", userToken: "user_token_main" });
    expect(saved).toMatchObject({ status: 200, body: { accountCount: 3 } });
    main = saved.body.connectionId as string;
    const state = await login(main);
    expect(state.tokensCheckedAt).not.toBeNull();
    expect(akahuLoginStatus(state)).toMatchObject({ state: "needs_linking", label: "Accounts need linking", lastSuccessAt: null });
  });

  it("zero available accounts: a second login that shares nothing lists none, and keeps its own status", async () => {
    const saved = await save({ add: true, name: "Empty login", appToken: "app_token_empty", userToken: "user_token_empty" });
    expect(saved).toMatchObject({ status: 200, body: { accountCount: 0 } });
    empty = saved.body.connectionId as string;
    expect(await list(empty)).toMatchObject({ status: 200, body: { accounts: [] } });
  });

  it("multiple logins: one login's accounts are listed on their own, with Akahu's attributes", async () => {
    const listed = await list(main);
    expect((listed.body.accounts as Array<{ id: string; attributes: string[]; connectionId: string }>).map((entry) => [entry.id, entry.attributes, entry.connectionId])).toEqual([
      ["acc_everyday", ["TRANSACTIONS"], main],
      ["acc_visa", ["TRANSACTIONS"], main],
      ["acc_term", [], main],
    ]);
  });

  it("linking several at once is all or none, and never two into one account", async () => {
    expect(
      await linkMany({
        connectionId: main,
        links: [
          { akahuAccountId: "acc_everyday", accountId: ids["1901"] },
          { akahuAccountId: "acc_visa", accountId: ids["1901"] },
        ],
      }),
    ).toMatchObject({ status: 400, body: { error: "Two Akahu accounts can't go into the same Tohyee account." } });
    expect(
      await linkMany({
        connectionId: main,
        links: [
          { akahuAccountId: "acc_everyday", accountId: ids["1901"] },
          { akahuAccountId: "acc_gone", accountId: ids["2901"] },
        ],
      }),
    ).toMatchObject({ status: 400, body: { error: "Akahu no longer shares one of the chosen accounts. Look again." } });
    expect((await as((tx) => getBankAccount(tx, ids["1901"]))).feed.active).toBe(false);
  });

  it("successful import: linked accounts sync, with counts and the last successful sync kept", async () => {
    const linked = await linkMany({
      connectionId: main,
      links: [
        { akahuAccountId: "acc_everyday", accountId: ids["1901"] },
        { akahuAccountId: "acc_visa", accountId: ids["2901"] },
      ],
    });
    expect(linked.status).toBe(201);
    expect(akahuLoginStatus(await login(main)).state).toBe("ready");
    expect(await syncBankFeedAccount(await organisation(), ids["1901"])).toMatchObject({ added: 2, duplicates: 0 });
    expect(await syncBankFeedAccount(await organisation(), ids["2901"])).toMatchObject({ added: 2 });
    const state = await login(main);
    expect(state.linkedAccounts.map((feed) => [feed.code, feed.lastSyncStatus, feed.lastSyncAdded, feed.linesBroughtIn])).toEqual([
      ["1901", "ok", 2, 2],
      ["2901", "ok", 2, 2],
    ]);
    expect(akahuLoginStatus(state)).toMatchObject({ state: "ok", label: "Last sync succeeded" });
    // Akahu signs a card in credit positive, and it stays positive (decision 1291).
    expect((await as((tx) => getBankAccount(tx, ids["2901"]))).statementBalance).toBe("25.50");
    // The other login keeps its own status.
    expect(akahuLoginStatus(await login(empty)).state).toBe("needs_linking");
  });

  it("a repeat sync with nothing new adds nothing and says so; a new transaction comes in once", async () => {
    const before = (await login(main)).linkedAccounts[0].lastSyncOkAt;
    expect(await syncBankFeedAccount(await organisation(), ids["1901"])).toMatchObject({ added: 0, duplicates: 2 });
    expect(await lineCount("1901")).toBe(2);
    const feed = (await login(main)).linkedAccounts[0];
    expect([feed.lastSyncStatus, feed.lastSyncAdded]).toEqual(["ok", 0]);
    expect(new Date(feed.lastSyncOkAt!) >= new Date(before!)).toBe(true);
    akahu.more = true;
    expect(await syncBankFeedAccount(await organisation(), ids["1901"])).toMatchObject({ added: 1 });
    expect(await syncBankFeedAccount(await organisation(), ids["1901"])).toMatchObject({ added: 0 });
    expect(await lineCount("1901")).toBe(3);
  });

  it("sync failure: the error shows, and the last success is kept", async () => {
    const lastOk = (await login(main)).linkedAccounts[0].lastSyncOkAt;
    akahu.down = true;
    await expect(syncBankFeedAccount(await organisation(), ids["1901"])).rejects.toThrow("Akahu is having a moment");
    akahu.down = false;
    const state = await login(main);
    expect(state.linkedAccounts[0]).toMatchObject({ lastSyncStatus: "failed", lastSyncError: "Akahu is having a moment", lastSyncOkAt: lastOk });
    expect(akahuLoginStatus(state)).toMatchObject({ state: "failed", lastSuccessAt: expect.any(String) });
    // A failure that isn't about the tokens doesn't mark them refused.
    expect(state.tokenProblem).toBeNull();
  });

  it("existing mappings aren't silently replaced", async () => {
    // Already linked Akahu accounts show where they go.
    const listed = (await list(main)).body.accounts as Array<{ id: string; linkedAccountId: string | null }>;
    expect(listed.find((entry) => entry.id === "acc_everyday")?.linkedAccountId).toBe(ids["1901"]);
    // An account Akahu can't get transactions for isn't linked.
    expect(await linkMany({ connectionId: main, links: [{ akahuAccountId: "acc_term", accountId: ids["1902"] }] })).toMatchObject({
      status: 400,
      body: { error: "Term deposit can't be linked. Akahu can't get transactions for this account." },
    });
    // 1901 has a working feed from Everyday: linking it to the card instead is refused, and the per-account route says the same.
    expect(await linkMany({ connectionId: main, links: [{ akahuAccountId: "acc_visa", accountId: ids["1901"] }] })).toMatchObject({
      status: 400,
      body: { error: "Visa: 1901 already has a bank feed from Everyday · 01-0123-0456789-00. Stop that feed first if you want to change it." },
    });
    const single = await json(
      await feedRoute.POST(
        apiRequest(`/api/bank-accounts/${ids["1901"]}/feed`, { method: "POST", cookie, body: { organisationId: org, connectionId: main, akahuAccountId: "acc_visa", startDate: "2026-09-01" } }),
        params({ accountId: ids["1901"] }),
      ),
    );
    expect(single.status).toBe(400);
    expect((await as((tx) => getBankAccount(tx, ids["1901"]))).feed).toMatchObject({ akahuAccountId: "acc_everyday", active: true });
    // The same Akahu account can't go into a second Tohyee account either.
    expect(await linkMany({ connectionId: main, links: [{ akahuAccountId: "acc_everyday", accountId: ids["1902"] }] })).toMatchObject({
      status: 400,
      body: { error: "Everyday: That Akahu account is already linked to 1901 Everyday." },
    });
  });
});
