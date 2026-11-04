import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { writeLog } from "@/lib/sales-platforms/log";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * #531 (decision 1246): get_organisation reports the connection's real
 * access, capped by the role now. #532 part 3 (decisions 1247-1249): read-only
 * sales platform diagnostics, on made-up stores and log lines.
 */

const ORG = "ai-shop-diag";
const OTHER_ORG = "ai-shop-other";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

// Made-up secrets that must never be in an answer.
const CIPHERTEXT = "credentials-ciphertext-must-not-leak";
const TOKEN_CIPHERTEXT = "token-ciphertext-must-not-leak";
const WEBHOOK_KEY = "WhKeyMustNotLeak0123456789abcdefghijklmnopq";
const SHOP_TOKEN = "shpat_madeuptoken0123456789";

let rpcId = 0;
async function call(token: string, name: string, args: Json = {}) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
    noContext,
  );
  const body = (await response.json()) as Json;
  // A tool this key can't use is a JSON-RPC error, not a tool result.
  if (body.error) return { isError: true, text: String((body.error as Json).message), data: null };
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0].text, data: result.isError ? null : (JSON.parse(result.content[0].text) as Json) };
}

async function rpc(token: string, method: string) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: method === "initialize" ? { protocolVersion: "2025-06-18" } : {} }),
    }),
    noContext,
  );
  return (await response.json()) as { result: Json };
}

describeWithDatabase("AI access level and sales platform diagnostics (#531, #532)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let partner: SessionUser;
  let viewer: SessionUser;
  const tokens: Record<string, string> = {};
  let offId: string;
  let shopId: string;

  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function makeKey(user: SessionUser, name: string, accessLevel: string, organisationId = ORG) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", {
        method: "POST",
        cookie: await sessionCookieFor(user),
        body: { organisationId, name, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) },
      }),
      noContext,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  async function connection(
    tx: OrgTx,
    domain: string,
    values: { syncProducts: boolean; post: boolean; scopes: string[]; lastSync: string | null; lastError?: string; lastSuccess?: string; failures?: number },
  ) {
    const ids = async (sql: string) => (await tx.query<{ id: string }>(sql)).rows.map((row) => row.id);
    const accounts = await ids("select id::text from accounts order by code limit 5");
    const untaxed = (await ids("select id::text from tax_codes order by id limit 1"))[0];
    const inserted = await tx.query<{ id: string }>(
      `insert into sales_platform_connections (platform, store_domain, store_name, store_currency, prices_include_tax, auth_method,
              credentials_ciphertext, access_token_ciphertext, webhook_key, sync_customers, sync_products, connected_by_email, granted_scopes,
              post_to_accounts, start_date, clearing_account_id, payout_account_id, fees_account_id, sales_account_id, shipping_account_id,
              untaxed_tax_code_id, last_sync_at, last_error, last_successful_sync_at, failures, status)
       values ('shopify', $1, $1, 'NZD', true, 'client_credentials', $2, $3, $4, true, $5, 'owner@example.com', $6,
               $7, case when $7 then date '2026-07-01' end, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               case when $17 >= 3 then 'paused' else 'active' end)
       returning id::text`,
      [
        domain,
        CIPHERTEXT,
        TOKEN_CIPHERTEXT,
        `${WEBHOOK_KEY}-${domain}`,
        values.syncProducts,
        values.scopes,
        values.post,
        accounts[0],
        accounts[1],
        accounts[2],
        accounts[3],
        accounts[4],
        untaxed,
        values.lastSync,
        values.lastError ?? null,
        values.lastSuccess ?? (values.lastError ? null : values.lastSync),
        values.failures ?? 0,
      ],
    );
    return inserted.rows[0].id;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    partner = await createTestUser("partner@example.com");
    viewer = await createTestUser("viewer@example.com");
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER_ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')", [ORG, partner.id]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    tokens.full = await makeKey(owner, "full", "full");
    tokens.partnerFull = await makeKey(partner, "partner full", "full");
    tokens.draft = await makeKey(owner, "draft", "draft");
    tokens.viewer = await makeKey(viewer, "viewer", "read");
    tokens.other = await makeKey(owner, "other", "read", OTHER_ORG);

    const now = Date.now();
    await asOwner(async (tx) => {
      // A store whose product sync and posting are both off.
      offId = await connection(tx, "kowhai-off.myshopify.com", { syncProducts: false, post: false, scopes: ["read_customers", "read_products"], lastSync: new Date(now - 5 * 60000).toISOString() });
      // A store posting with every setting, but the app wasn't given read_orders or the payout scopes.
      shopId = await connection(tx, "glimmers-test.myshopify.com", {
        syncProducts: true,
        post: true,
        scopes: ["read_customers", "read_products"],
        lastSync: new Date(now - 3 * 3600000).toISOString(),
        lastError: `Shopify said 401 for token ${SHOP_TOKEN}.`,
        lastSuccess: new Date(now - 26 * 3600000).toISOString(),
        failures: 4,
      });
      await writeLog(tx, shopId, { source: "connection", action: "webhooks", message: `Webhooks set up at https://books.example.nz/api/sales-platforms/webhooks/${ORG}/${WEBHOOK_KEY}.` });
      // An old problem: a variant with no SKU, then 220 other lines so it's on an older page.
      await writeLog(tx, shopId, { source: "sync", action: "skipped", recordKind: "product_variant", externalId: "9001", message: "Shopify variant Paw print pendant has no SKU, so it wasn't matched to an item or added." });
      await writeLog(tx, shopId, { source: "sync", action: "skipped", recordKind: "product_variant", externalId: "9002", message: 'Shopify variant Nose charm wasn\'t matched or added: its SKU "NOSE CHARM!" can\'t be an item code (1-50 letters, numbers, dots, dashes, slashes or underscores).' });
      // Skipped once, then linked: no longer a problem.
      await writeLog(tx, shopId, { source: "sync", action: "skipped", recordKind: "product_variant", externalId: "9003", message: "Shopify variant Gift box has no SKU, so it wasn't matched to an item or added." });
      await writeLog(tx, shopId, { source: "sync", action: "linked", recordKind: "product_variant", externalId: "9003", message: "Linked Shopify variant Gift box (SKU BOX-1) to item BOX-1 (same code)." });
      for (let index = 0; index < 220; index += 1) {
        await writeLog(tx, shopId, { source: "sync", action: "kept", recordKind: "customer", externalId: `c${index}`, message: `Kept Tohyee's email for customer ${index}.` });
      }
      // #578: a customer's email in the message.
      await writeLog(tx, shopId, {
        source: "sync",
        action: "skipped",
        recordKind: "customer",
        externalId: "7001",
        message: "Shopify customer Aroha (aroha.made-up@example.com) wasn't added: contact Aroha has the same name but a different email, so they may be different people.",
      });
      await writeLog(tx, shopId, { source: "sync", action: "sync", message: "Synced glimmers-test.myshopify.com: 1 linked, 3 skipped." });
    });
  }, 120_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("#531: a Full access owner's get_organisation says full, as the server's instructions do", async () => {
    const answer = await call(tokens.full, "get_organisation");
    expect(answer.data).toMatchObject({ yourRole: "owner", access: "full", accessLabel: "Full access", accessGranted: "full" });
    expect(answer.data).not.toHaveProperty("accessNote");
    expect((await rpc(tokens.full, "initialize")).result.instructions).toContain('at the level "Full access"');
    expect(await call(tokens.draft, "get_organisation")).toMatchObject({ data: { access: "draft", accessLabel: "Make drafts" } });
    expect(await call(tokens.viewer, "get_organisation")).toMatchObject({ data: { access: "read", accessLabel: "Look only", yourRole: "viewer" } });
  });

  it("#531: after a role downgrade it reports the reduced level, and enforcement follows it", async () => {
    await coreQuery("update organisation_members set role = 'bookkeeper' where organisation_id = $1 and user_id = $2", [ORG, partner.id]);
    const asBookkeeper = await call(tokens.partnerFull, "get_organisation");
    expect(asBookkeeper.data).toMatchObject({ yourRole: "bookkeeper", access: "post", accessLabel: "Make and post", accessGranted: "full" });
    expect(asBookkeeper.data!.accessNote).toContain('works as "Make and post"');
    expect((await rpc(tokens.partnerFull, "initialize")).result.instructions).toContain('at the level "Make and post"');
    const refused = await call(tokens.partnerFull, "create_item", { code: "X1", name: "X" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Full access");

    await coreQuery("update organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2", [ORG, partner.id]);
    expect(await call(tokens.partnerFull, "get_organisation")).toMatchObject({ data: { access: "read", accessGranted: "full" } });
    const listed = ((await rpc(tokens.partnerFull, "tools/list")).result.tools as Json[]).map((tool) => tool.name);
    expect(listed).toContain("get_organisation");
    expect(listed).not.toContain("create_contact");
  });

  it("#532: tells disabled product sync, missing SKU, missing scope and disabled posting apart, without changing anything", async () => {
    const before = await asOwner((tx) => tx.query<{ lines: string; changed: string }>("select (select count(*) from sales_platform_sync_log)::text as lines, (select max(updated_at) from sales_platform_connections)::text as changed"));
    const status = await call(tokens.viewer, "get_sales_platform_status");
    expect(status.isError, status.text).toBe(false);
    const byId = Object.fromEntries((status.data!.connections as Json[]).map((entry) => [entry.connectionId, entry])) as Record<string, Json>;

    // Product sync off; posting off (not "no sales").
    const off = byId[offId] as { imports: Record<string, Json>; posting: Json; freshness: Json; scopes: Json };
    expect(off.imports.products).toMatchObject({ status: "off", notBroughtIn: 0 });
    expect(off.imports.products.why).toContain("turned off");
    expect(off.imports.customers).toMatchObject({ status: "on" });
    expect(off.imports.orders).toMatchObject({ status: "off" });
    expect(off.imports.orders.why).toContain("says nothing about whether the store has sales");
    expect(off.posting).toMatchObject({ on: false, startDate: null });
    expect(off.freshness).toMatchObject({ behind: false, lastError: null });

    // Products on with a missing SKU and a bad SKU still open (9003 was linked later); posting on but read_orders missing.
    const shop = byId[shopId] as { imports: Record<string, Json & { problems: Record<string, { count: number; examples: Json[] }> }>; posting: Json; freshness: Json; scopes: Json };
    expect(shop.imports.products).toMatchObject({ status: "on", notBroughtIn: 2 });
    expect(shop.imports.products.problems.missing_sku.count).toBe(1);
    expect(shop.imports.products.problems.missing_sku.examples[0]).toMatchObject({ externalId: "9001" });
    expect(shop.imports.products.problems.invalid_sku.count).toBe(1);
    expect(shop.posting).toMatchObject({ on: true, startDate: "2026-07-01", missingSettings: [] });
    expect(shop.scopes).toMatchObject({ applies: true, missingNow: ["read_orders", "read_shopify_payments_payouts", "read_shopify_payments_accounts"] });
    expect(shop.imports.orders).toMatchObject({ status: "setup_needed" });
    expect(shop.imports.orders.why).toContain("read_orders");
    expect(shop.imports.payouts).toMatchObject({ status: "setup_needed" });
    // #572: the store refused the login (401): paused, behind, needs reconnecting; the last success is before the last attempt.
    expect(shop.freshness).toMatchObject({ behind: true, behindReason: "paused", needsReconnect: true, failuresInARow: 4 });
    expect(shop.freshness.action).toContain("Reconnect");
    expect(Date.parse(shop.freshness.lastSuccessfulSyncAt as string)).toBeLessThan(Date.parse(shop.freshness.lastSyncAt as string));
    expect(shop.freshness.minutesSinceLastSuccessfulSync).toBeGreaterThanOrEqual(26 * 60 - 1);
    // #578: withoutSku counts the variant still skipped for having no SKU.
    expect(shop.imports.products).toMatchObject({ withoutSku: 1, withoutSkuParts: { linked: 0, notBroughtIn: 1 } });

    // Nothing changed.
    const after = await asOwner((tx) => tx.query<{ lines: string; changed: string }>("select (select count(*) from sales_platform_sync_log)::text as lines, (select max(updated_at) from sales_platform_connections)::text as changed"));
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("#532: the log reader pages back to an older skip and filters by outcome, kind and record", async () => {
    const first = await call(tokens.viewer, "list_sales_platform_log", { connectionId: shopId, limit: 200 });
    expect((first.data!.entries as Json[]).length).toBe(200);
    expect((first.data!.entries as Json[]).some((entry) => entry.externalId === "9001")).toBe(false);
    const older = await call(tokens.viewer, "list_sales_platform_log", { connectionId: shopId, limit: 200, beforeId: first.data!.nextBeforeId });
    const missing = (older.data!.entries as Json[]).find((entry) => entry.externalId === "9001");
    expect(missing).toMatchObject({ action: "skipped", recordKind: "product_variant", reason: "missing_sku" });
    expect(older.data!.end).toBe("No older lines match.");

    const problems = await call(tokens.viewer, "list_sales_platform_log", { outcome: "problem", recordKind: "product_variant" });
    expect((problems.data!.entries as Json[]).map((entry) => [entry.externalId, entry.reason])).toEqual([
      ["9003", "missing_sku"],
      ["9002", "invalid_sku"],
      ["9001", "missing_sku"],
    ]);
    const one = await call(tokens.viewer, "list_sales_platform_log", { externalId: "9003" });
    expect((one.data!.entries as Json[]).map((entry) => entry.action)).toEqual(["linked", "skipped"]);
    expect((await call(tokens.viewer, "list_sales_platform_log", { connectionId: offId })).data).toEqual({ entries: [], end: "No older lines match." });
    expect((await call(tokens.viewer, "list_sales_platform_log", { action: "deleted" })).isError).toBe(true);
  });

  it("#532: never returns credentials, tokens or the webhook address", async () => {
    const texts = [
      (await call(tokens.full, "get_sales_platform_status", { includeDisconnected: true })).text,
      (await call(tokens.full, "list_sales_platform_log", { limit: 200 })).text,
      (await call(tokens.full, "list_sales_platform_log", { action: "webhooks" })).text,
    ];
    for (const text of texts) {
      for (const secret of [CIPHERTEXT, TOKEN_CIPHERTEXT, WEBHOOK_KEY, SHOP_TOKEN, "owner@example.com", "/api/sales-platforms/webhooks"]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(texts[2]).toContain("https://books.example.nz/[removed]");
    // #578: customers' emails aren't in the words; the record is named by its externalId.
    for (const text of texts) expect(text).not.toContain("aroha.made-up@example.com");
    expect(texts[0]).toContain("Shopify customer Aroha wasn't added");
    expect(texts[0]).toContain('"externalId":"7001"');
    expect(texts[0]).toContain("Shopify said 401 for token [removed].");
  });

  it("#532: another organisation's key sees only its own (none)", async () => {
    expect((await call(tokens.other, "get_sales_platform_status")).data).toEqual({ connections: [], note: "No sales platform has been connected." });
    expect((await call(tokens.other, "get_sales_platform_status", { connectionId: shopId })).isError).toBe(true);
    expect((await call(tokens.other, "list_sales_platform_log", { connectionId: shopId })).isError).toBe(true);
  });
});
