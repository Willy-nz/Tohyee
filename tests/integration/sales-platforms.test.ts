import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as connectionRoute from "@/app/api/sales-platforms/connections/[connectionId]/route";
import * as logRoute from "@/app/api/sales-platforms/connections/[connectionId]/log/route";
import * as syncRoute from "@/app/api/sales-platforms/connections/[connectionId]/sync/route";
import * as testRoute from "@/app/api/sales-platforms/connections/[connectionId]/test/route";
import * as connectionsRoute from "@/app/api/sales-platforms/connections/route";
import * as webhookRoute from "@/app/api/sales-platforms/webhooks/[organisationId]/[webhookKey]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { archiveContact, createContact, getContact, updateContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createItem, getItem } from "@/lib/items/service";
import { getOrganisation } from "@/lib/organisations/registry";
import {
  connectStore,
  disconnectStore,
  listConnections,
  listSyncLog,
  syncConnection,
  testConnection,
  updateConnectionSettings,
} from "@/lib/sales-platforms/service";
import { setSalesPlatformFetchForTests } from "@/lib/sales-platforms/shopify";
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

const DOMAIN = "glimmers.myshopify.com";
const TOKEN = "shpat_test_token_glimmers";
const SECRET = "shpss_test_api_secret_glimmers";
const SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";

type FakeCustomer = { id: number; first: string; last: string; email: string | null; phone: string | null; updatedAt: string };
type FakeVariant = { id: number; title: string; sku: string | null; price: string; updatedAt?: string };
type FakeProduct = { id: number; title: string; updatedAt: string; variants: FakeVariant[] };

type ShopState = {
  currency: string;
  taxesIncluded: boolean;
  scopes: string[];
  customers: FakeCustomer[];
  products: FakeProduct[];
  webhooks: Array<{ id: string; topic: string; callbackUrl: string }>;
  /** A webhook topic the fake store refuses (as Shopify refuses one already subscribed at the same address). */
  rejectTopic?: string;
  deletedWebhooks: string[];
  calls: string[];
  fail: boolean;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A pretend Shopify store: the Admin GraphQL API (2026-07) and the client credentials grant, shaped like Shopify's responses. */
function fakeShopify(state: ShopState) {
  let webhookCounter = 0;
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.host !== DOMAIN) return json({ errors: "Not Found" }, 404);
    if (state.fail) return json({ errors: "Internal error" }, 500);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.pathname === "/admin/oauth/access_token") {
      state.calls.push("token");
      if (body.client_id !== "client-glimmers" || body.client_secret !== SECRET || body.grant_type !== "client_credentials") {
        return json({ error: "invalid_client", error_description: "Client authentication failed" }, 400);
      }
      return json({ access_token: TOKEN, scope: state.scopes.join(","), expires_in: 86399 });
    }
    if (url.pathname !== "/admin/api/2026-07/graphql.json" || init?.method !== "POST") return json({ errors: "Not Found" }, 404);
    const headers = new Headers(init?.headers);
    if (headers.get("x-shopify-access-token") !== TOKEN) {
      return json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" }, 401);
    }
    const query: string = body.query;
    const variables = body.variables ?? {};
    const since = (variables.query as string | undefined)?.match(/updated_at:>='([^']+)'/)?.[1];
    const recent = <T extends { updatedAt: string }>(rows: T[]) =>
      rows.filter((row) => !since || Date.parse(row.updatedAt) >= Date.parse(since)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const page = <T,>(rows: T[]) => {
      const start = variables.after ? Number(variables.after) : 0;
      const nodes = rows.slice(start, start + variables.first);
      const end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) } };
    };
    if (query.includes("webhookSubscriptionCreate")) {
      const taken = state.webhooks.some((hook) => hook.topic === variables.topic && hook.callbackUrl === variables.webhookSubscription.callbackUrl);
      if (taken || variables.topic === state.rejectTopic) {
        return json({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["callbackUrl"], message: "Address for this topic has already been taken" }] } } });
      }
      webhookCounter += 1;
      const id = `gid://shopify/WebhookSubscription/${webhookCounter}`;
      state.webhooks.push({ id, topic: variables.topic, callbackUrl: variables.webhookSubscription.callbackUrl });
      state.calls.push(`webhook:${variables.topic}`);
      return json({ data: { webhookSubscriptionCreate: { webhookSubscription: { id }, userErrors: [] } } });
    }
    if (query.includes("webhookSubscriptionDelete")) {
      state.deletedWebhooks.push(variables.id);
      state.webhooks = state.webhooks.filter((hook) => hook.id !== variables.id);
      return json({ data: { webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] } } });
    }
    if (query.includes("customers(")) {
      state.calls.push(`customers:${since ?? "all"}`);
      const result = page(recent(state.customers));
      return json({
        data: {
          customers: {
            nodes: result.nodes.map((c) => ({
              id: `gid://shopify/Customer/${c.id}`,
              displayName: `${c.first} ${c.last}`.trim() || c.email,
              firstName: c.first,
              lastName: c.last,
              updatedAt: c.updatedAt,
              defaultEmailAddress: c.email ? { emailAddress: c.email } : null,
              defaultPhoneNumber: c.phone ? { phoneNumber: c.phone } : null,
            })),
            pageInfo: result.pageInfo,
          },
        },
      });
    }
    if (query.includes("products(")) {
      state.calls.push(`products:${since ?? "all"}`);
      const result = page(recent(state.products));
      return json({
        data: {
          products: {
            nodes: result.nodes.map((p) => ({
              id: `gid://shopify/Product/${p.id}`,
              title: p.title,
              updatedAt: p.updatedAt,
              variants: {
                nodes: p.variants.map((v) => ({
                  id: `gid://shopify/ProductVariant/${v.id}`,
                  title: v.title,
                  sku: v.sku ?? "",
                  price: v.price,
                  updatedAt: v.updatedAt ?? p.updatedAt,
                })),
                pageInfo: { hasNextPage: false },
              },
            })),
            pageInfo: result.pageInfo,
          },
        },
      });
    }
    if (query.includes("shop {")) {
      state.calls.push("shop");
      return json({
        data: {
          shop: { name: "Glimmers", myshopifyDomain: DOMAIN, currencyCode: state.currency, taxesIncluded: state.taxesIncluded },
          currentAppInstallation: { accessScopes: state.scopes.map((handle) => ({ handle })) },
        },
      });
    }
    return json({ errors: [{ message: `unexpected query ${query.slice(0, 40)}` }] });
  };
}

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("base64");

function webhook(
  path: { organisationId: string; webhookKey: string },
  topic: string,
  payload: unknown,
  options: { secret?: string; id?: string; domain?: string; signature?: string | null; tamper?: (body: string) => string } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-shopify-topic": topic,
    "x-shopify-shop-domain": options.domain ?? DOMAIN,
    "x-shopify-api-version": "2026-07",
    "x-shopify-webhook-id": options.id ?? key("wh"),
    "x-shopify-triggered-at": "2026-10-01T00:00:00Z",
  };
  const signature = options.signature === undefined ? sign(body, options.secret) : options.signature;
  if (signature !== null) headers["x-shopify-hmac-sha256"] = signature;
  const request = new Request(`https://tohyee.example.nz/api/sales-platforms/webhooks/${path.organisationId}/${path.webhookKey}`, {
    method: "POST",
    headers,
    body: options.tamper ? options.tamper(body) : body,
  });
  return webhookRoute.POST(request, params(path));
}

/** Examples SPC1-SPC10 in docs/ACCOUNTING-EXAMPLES.md ("Sales platform connections"). */
describeWithDatabase("Sales platform connections (Shopify)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@glimmers.nz", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("viewer@glimmers.nz");
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterEach(() => {
    setSalesPlatformFetchForTests(null);
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  function shop(overrides: Partial<ShopState> = {}): ShopState {
    const state: ShopState = {
      currency: "NZD",
      taxesIncluded: false,
      scopes: ["read_customers", "read_products"],
      customers: [
        { id: 1001, first: "Aroha", last: "Ngata", email: "AROHA@manukavets.nz", phone: "+64 21 555 0101", updatedAt: "2026-09-30T01:00:00Z" },
        { id: 1002, first: "Tama", last: "Rewi", email: "tama@example.co.nz", phone: null, updatedAt: "2026-09-30T02:00:00Z" },
        { id: 1003, first: "Kiri", last: "Walker", email: null, phone: null, updatedAt: "2026-09-30T03:00:00Z" },
      ],
      products: [
        { id: 2001, title: "Large candle", updatedAt: "2026-09-30T01:00:00Z", variants: [{ id: 3001, title: "Default Title", sku: "candle-l", price: "20.00" }] },
        {
          id: 2002,
          title: "Wax melts",
          updatedAt: "2026-09-30T02:00:00Z",
          variants: [
            { id: 3002, title: "Vanilla", sku: "MELT-VAN", price: "8.50" },
            { id: 3003, title: "Lavender", sku: null, price: "8.50" },
          ],
        },
      ],
      webhooks: [],
      deletedWebhooks: [],
      calls: [],
      fail: false,
      ...overrides,
    };
    setSalesPlatformFetchForTests(fakeShopify(state));
    return state;
  }

  async function setup() {
    organisations += 1;
    const org = `shop-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const actor = { userId: owner.id, email: owner.email };
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, actor, work);
    const aroha = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Aroha Ngata", email: "aroha@manukavets.nz", isCustomer: true })))
      .contact;
    const kiri = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kiri Walker", isCustomer: true }))).contact;
    const candle = (
      await as((tx) => createItem(tx, { idempotencyKey: key("i"), code: "CANDLE-L", name: "Large soy candle", itemType: "non_stock", salePrice: "20.00" }))
    ).item;
    const record = (await getOrganisation(org))!;
    return { org, as, actor, aroha, kiri, candle, record };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  async function connect(w: World, overrides: Record<string, unknown> = {}, webhookOrigin: string | null = null) {
    return connectStore(
      w.record,
      w.actor,
      { platform: "shopify", storeDomain: "glimmers", authMethod: "access_token", accessToken: TOKEN, apiSecret: SECRET, ...overrides },
      { webhookOrigin },
    );
  }

  const journals = (w: World) => w.as(async (tx) => Number((await tx.query<{ n: string }>("select count(*)::text as n from ledger_journals")).rows[0].n));
  const contactsNamed = (w: World, name: string) =>
    w.as(async (tx) => (await tx.query<{ id: string }>("select id from contacts where lower(name) = lower($1)", [name])).rows);
  const itemByCode = (w: World, code: string) =>
    w.as(async (tx) => (await tx.query<{ id: string }>("select id from items where lower(code) = lower($1)", [code])).rows[0]?.id ?? null);
  const log = async (w: World, connectionId: string) => (await w.as((tx) => listSyncLog(tx, connectionId))).entries;

  it("SPC1: connecting checks the credentials and stores them encrypted", async () => {
    const w = await setup();
    const state = shop();

    delete process.env.TOHYEE_SECRET_KEY;
    await expect(connect(w)).rejects.toThrow("TOHYEE_SECRET_KEY");
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;

    await expect(connect(w, { accessToken: "shpat_wrong" })).rejects.toThrow(/refused|401/);
    expect(await w.as((tx) => listConnections(tx))).toEqual([]);

    // A token that can change the store is refused: Tohyee only asks for read-only access.
    state.scopes = ["read_customers", "write_products", "read_products"];
    await expect(connect(w)).rejects.toThrow("write_products");
    state.scopes = ["read_customers"];
    await expect(connect(w)).rejects.toThrow("read_products");
    state.scopes = ["read_customers", "read_products"];

    const connection = await connect(w);
    expect(connection).toMatchObject({
      platform: "shopify",
      storeDomain: DOMAIN,
      storeName: "Glimmers",
      storeCurrency: "NZD",
      pricesIncludeTax: false,
      authMethod: "access_token",
      syncCustomers: true,
      syncProducts: true,
      status: "active",
      connectedByEmail: "jess@glimmers.nz",
      webhooksActive: false,
    });
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
    expect(JSON.stringify(connection)).not.toContain(SECRET);
    const stored = await w.as((tx) => tx.query<{ c: string }>("select credentials_ciphertext as c from sales_platform_connections"));
    expect(stored.rows[0].c.startsWith("v1:")).toBe(true);
    expect(stored.rows[0].c).not.toContain(TOKEN);
    expect((await w.as((tx) => listConnections(tx)))[0].webhooksNote).toContain("https");

    // The same store can't be connected twice.
    await expect(connect(w)).rejects.toThrow(/already connected/);

    // The connection is in the log; nothing touched the ledger.
    expect((await log(w, connection.id)).map((entry) => entry.action)).toEqual(["connected"]);
    expect(await journals(w)).toBe(0);
  });

  it("SPC1: a Dev Dashboard app's client ID and secret get an access token, and webhooks are subscribed on an https address", async () => {
    const w = await setup();
    const state = shop();
    const connection = await connect(
      w,
      { authMethod: "client_credentials", accessToken: undefined, apiSecret: undefined, clientId: "client-glimmers", clientSecret: SECRET },
      "https://books.glimmers.nz",
    );
    expect(connection.authMethod).toBe("client_credentials");
    expect(state.calls[0]).toBe("token");
    expect(state.webhooks.map((hook) => hook.topic).sort()).toEqual(["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "PRODUCTS_CREATE", "PRODUCTS_UPDATE"]);
    const webhookKey = state.webhooks[0].callbackUrl.split("/").pop()!;
    expect(webhookKey.length).toBeGreaterThanOrEqual(32);
    expect(state.webhooks[0].callbackUrl).toBe(`https://books.glimmers.nz/api/sales-platforms/webhooks/${w.org}/${webhookKey}`);
    expect((await w.as((tx) => listConnections(tx)))[0].webhooksActive).toBe(true);
    // The token is kept (encrypted) for about a day, so a sync doesn't ask again.
    state.calls = [];
    await syncConnection(w.record, connection.id);
    expect(state.calls).not.toContain("token");
    // A wrong client secret is refused.
    const other = await setup();
    await expect(
      connect(other, { authMethod: "client_credentials", accessToken: undefined, apiSecret: undefined, clientId: "client-glimmers", clientSecret: "wrong" }),
    ).rejects.toThrow(/refused|Client authentication failed/);
  });

  it("SPC1: webhooks are set up all or none, and testing the connection tries again", async () => {
    const w = await setup();
    const state = shop({ rejectTopic: "PRODUCTS_CREATE" });
    const connection = await connect(w, {}, "https://books.glimmers.nz");
    // The two made before the refusal were removed again, so none are left unrecorded in the store.
    expect(state.deletedWebhooks).toHaveLength(2);
    expect(state.webhooks).toEqual([]);
    expect(connection).toMatchObject({ status: "active", webhooksActive: false });
    expect(connection.webhooksNote).toContain("Address for this topic has already been taken");

    state.rejectTopic = undefined;
    const tested = await testConnection(w.record, w.actor, connection.id, { webhookOrigin: "https://books.glimmers.nz" });
    expect(tested).toMatchObject({ ok: true, connection: { webhooksActive: true, webhooksNote: null } });
    expect(state.webhooks).toHaveLength(4);
    // Testing again doesn't subscribe twice.
    await testConnection(w.record, w.actor, connection.id, { webhookOrigin: "https://books.glimmers.nz" });
    expect(state.webhooks).toHaveLength(4);
    expect((await log(w, connection.id)).map((entry) => entry.action)).toEqual(["tested", "webhooks", "tested", "webhooks", "connected"]);
  });

  it("SPC2: customers link by email or are added; unclear ones are skipped", async () => {
    const w = await setup();
    shop();
    const connection = await connect(w, { syncProducts: false });
    const result = await syncConnection(w.record, connection.id);
    expect(result).toMatchObject({ created: 1, linked: 1, skipped: 1, failed: 0 });

    const aroha = await w.as((tx) => getContact(tx, w.aroha.id));
    expect(aroha).toMatchObject({ name: "Aroha Ngata", email: "aroha@manukavets.nz", phone: "+64 21 555 0101", isCustomer: true });
    const tama = await contactsNamed(w, "Tama Rewi");
    expect(tama).toHaveLength(1);
    expect(await w.as((tx) => getContact(tx, tama[0].id))).toMatchObject({ email: "tama@example.co.nz", isCustomer: true, phone: null });
    expect(await contactsNamed(w, "Kiri Walker")).toHaveLength(1);

    const entries = await log(w, connection.id);
    const lines = entries.map((entry) => `${entry.action} ${entry.externalId ?? ""}`.trim());
    expect(lines).toEqual(expect.arrayContaining(["linked 1001", "updated 1001", "created 1002", "skipped 1003"]));
    expect(entries.find((entry) => entry.externalId === "1003")!.message).toContain("Kiri Walker");
    expect(entries.find((entry) => entry.action === "updated")!.message).toContain("phone");
    expect(entries.find((entry) => entry.action === "linked")!.contactId).toBe(w.aroha.id);

    // Two contacts with the same email: nothing is guessed.
    const other = await setup();
    await other.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Aroha (clinic)", email: "Aroha@ManukaVets.nz", isCustomer: true }));
    const otherConnection = await connect(other, { syncProducts: false });
    await syncConnection(other.record, otherConnection.id);
    const skipped = (await log(other, otherConnection.id)).find((entry) => entry.externalId === "1001")!;
    expect(skipped.action).toBe("skipped");
    expect(skipped.message).toContain("more than one");
    expect((await other.as((tx) => getContact(tx, other.aroha.id))).phone).toBeNull();

    // The only contact with the email is archived: skipped, not added again under another name.
    const third = await setup();
    await third.as(async (tx) => {
      await updateContact(tx, third.aroha.id, { name: "Aroha Ngata (old)" });
      await archiveContact(tx, third.aroha.id);
    });
    const thirdConnection = await connect(third, { syncProducts: false });
    await syncConnection(third.record, thirdConnection.id);
    const archivedSkip = (await log(third, thirdConnection.id)).find((entry) => entry.externalId === "1001")!;
    expect(archivedSkip.action).toBe("skipped");
    expect(archivedSkip.message).toContain("archived");
    expect(await contactsNamed(third, "Aroha Ngata")).toHaveLength(0);
  });

  it("SPC3: variants link by SKU or are added as non-stock items; no SKU is skipped", async () => {
    const w = await setup();
    shop();
    const connection = await connect(w, { syncCustomers: false });
    await syncConnection(w.record, connection.id);

    expect(await w.as((tx) => getItem(tx, w.candle.id))).toMatchObject({ code: "CANDLE-L", name: "Large soy candle", salePrice: "20" });
    const meltId = await itemByCode(w, "MELT-VAN");
    expect(await w.as((tx) => getItem(tx, meltId))).toMatchObject({ code: "MELT-VAN", name: "Wax melts - Vanilla", itemType: "non_stock", salePrice: "8.5" });

    const entries = await log(w, connection.id);
    expect(entries.find((entry) => entry.externalId === "3001" && entry.action === "linked")!.itemId).toBe(w.candle.id);
    const kept = entries.find((entry) => entry.externalId === "3001" && entry.action === "kept")!;
    expect(kept.message).toContain("Large soy candle");
    expect(entries.find((entry) => entry.externalId === "3002")!.action).toBe("created");
    const lavender = entries.find((entry) => entry.externalId === "3003")!;
    expect(lavender.action).toBe("skipped");
    expect(lavender.message).toContain("no SKU");
    // Nothing reached the ledger.
    expect(await journals(w)).toBe(0);
  });

  it("SPC4: syncing again with nothing changed changes nothing", async () => {
    const w = await setup();
    const state = shop();
    const connection = await connect(w);
    await syncConnection(w.record, connection.id);
    const before = (await log(w, connection.id)).length;
    state.calls = [];
    const again = await syncConnection(w.record, connection.id);
    expect(again).toMatchObject({ created: 0, linked: 0, updated: 0, kept: 0, failed: 0 });
    // Only what changed since the last sync is asked for.
    expect(state.calls.some((call) => call.startsWith("customers:2026-09-30"))).toBe(true);
    // Nothing new in the log: 1003 and Lavender are still skipped, but their lines are already there.
    expect(again.skipped).toBe(2);
    expect(await log(w, connection.id)).toHaveLength(before);
    expect(await contactsNamed(w, "Tama Rewi")).toHaveLength(1);
    // The second run skips 1003 again (it's still unclear) but adds nothing.
    expect(await w.as(async (tx) => Number((await tx.query<{ n: string }>("select count(*)::text as n from items")).rows[0].n))).toBe(2);
  });

  it("SPC5: Shopify's changes are applied unless someone changed the value in Tohyee", async () => {
    const w = await setup();
    const state = shop();
    const connection = await connect(w);
    await syncConnection(w.record, connection.id);
    const tamaId = (await contactsNamed(w, "Tama Rewi"))[0].id;
    await w.as((tx) => updateContact(tx, tamaId, { name: "Tama Rewi (wholesale)" }));

    const tama = state.customers.find((customer) => customer.id === 1002)!;
    tama.last = "Rewi-Smith";
    tama.phone = "+64 22 555 0102";
    tama.updatedAt = "2026-10-01T01:00:00Z";
    const candle = state.products.find((product) => product.id === 2001)!;
    candle.variants[0].price = "22.00";
    candle.updatedAt = "2026-10-01T01:00:00Z";
    await syncConnection(w.record, connection.id);

    expect(await w.as((tx) => getContact(tx, tamaId))).toMatchObject({ name: "Tama Rewi (wholesale)", phone: "+64 22 555 0102" });
    expect((await w.as((tx) => getItem(tx, w.candle.id))).salePrice).toBe("22");
    const entries = await log(w, connection.id);
    const kept = entries.find((entry) => entry.externalId === "1002" && entry.action === "kept")!;
    expect(kept.message).toContain("Tama Rewi (wholesale)");
    expect(kept.message).toContain("changed in Tohyee");
    expect(entries.find((entry) => entry.externalId === "3001" && entry.action === "updated")!.message).toContain("22");
  });

  it("SPC6: prices aren't copied from a store whose prices include tax, or in another currency", async () => {
    const w = await setup();
    shop({ taxesIncluded: true });
    const connection = await connect(w, { syncCustomers: false });
    expect(connection.pricesIncludeTax).toBe(true);
    await syncConnection(w.record, connection.id);
    const melt = await w.as(async (tx) => getItem(tx, await itemByCode(w, "MELT-VAN")));
    expect(melt.salePrice).toBeNull();
    expect((await log(w, connection.id)).find((entry) => entry.externalId === "3002")!.message).toContain("include tax");
    // CANDLE-L keeps its own price.
    expect((await w.as((tx) => getItem(tx, w.candle.id))).salePrice).toBe("20");

    const aud = await setup();
    shop({ currency: "AUD" });
    const audConnection = await connect(aud, { syncCustomers: false });
    await syncConnection(aud.record, audConnection.id);
    expect((await aud.as(async (tx) => getItem(tx, await itemByCode(aud, "MELT-VAN")))).salePrice).toBeNull();
    expect((await log(aud, audConnection.id)).find((entry) => entry.externalId === "3002")!.message).toContain("AUD");
  });

  it("SPC7: webhooks add and update records, and a repeated delivery does nothing", async () => {
    const w = await setup();
    shop();
    const connection = await connect(w);
    await syncConnection(w.record, connection.id);
    const webhookKey = (await w.as((tx) => tx.query<{ k: string }>("select webhook_key as k from sales_platform_connections"))).rows[0].k;
    const path = { organisationId: w.org, webhookKey };

    const mere = {
      id: 1004,
      email: "mere@example.co.nz",
      first_name: "Mere",
      last_name: "Tane",
      phone: null,
      updated_at: "2026-10-01T02:00:00Z",
      admin_graphql_api_id: "gid://shopify/Customer/1004",
    };
    const first = await webhook(path, "customers/create", mere, { id: "delivery-1" });
    expect(first.status).toBe(200);
    expect(await contactsNamed(w, "Mere Tane")).toHaveLength(1);
    const logged = (await log(w, connection.id)).length;

    const again = await webhook(path, "customers/create", { ...mere, first_name: "Merv" }, { id: "delivery-1" });
    expect(again.status).toBe(200);
    expect(await contactsNamed(w, "Mere Tane")).toHaveLength(1);
    expect(await contactsNamed(w, "Merv Tane")).toHaveLength(0);
    expect((await log(w, connection.id)).length).toBe(logged);

    const melts = {
      id: 2002,
      title: "Wax melts",
      updated_at: "2026-10-01T03:00:00Z",
      variants: [
        { id: 3002, product_id: 2002, title: "Vanilla", sku: "MELT-VAN", price: "9.00", updated_at: "2026-10-01T03:00:00Z" },
        { id: 3003, product_id: 2002, title: "Lavender", sku: "", price: "9.00", updated_at: "2026-10-01T03:00:00Z" },
      ],
    };
    expect((await webhook(path, "products/update", melts)).status).toBe(200);
    const meltId = await itemByCode(w, "MELT-VAN");
    expect((await w.as((tx) => getItem(tx, meltId))).salePrice).toBe("9");

    // An older change (sent late) changes nothing.
    const stale = { ...melts, updated_at: "2026-09-30T05:00:00Z", variants: [{ ...melts.variants[0], price: "7.00", updated_at: "2026-09-30T05:00:00Z" }] };
    expect((await webhook(path, "products/update", stale)).status).toBe(200);
    expect((await w.as((tx) => getItem(tx, meltId))).salePrice).toBe("9");

    // A topic Tohyee doesn't handle is acknowledged and ignored.
    expect((await webhook(path, "orders/create", { id: 1 })).status).toBe(200);

    // With products switched off, product webhooks are ignored.
    await w.as((tx) => updateConnectionSettings(tx, connection.id, { syncProducts: false }));
    expect((await webhook(path, "products/update", { ...melts, updated_at: "2026-10-02T00:00:00Z", variants: [{ ...melts.variants[0], price: "12.00", updated_at: "2026-10-02T00:00:00Z" }] })).status).toBe(200);
    expect((await w.as((tx) => getItem(tx, meltId))).salePrice).toBe("9");
    expect(await journals(w)).toBe(0);
  });

  it("SPC8: a webhook with a bad signature is refused and nothing is stored", async () => {
    const w = await setup();
    shop();
    const connection = await connect(w);
    const webhookKey = (await w.as((tx) => tx.query<{ k: string }>("select webhook_key as k from sales_platform_connections"))).rows[0].k;
    const path = { organisationId: w.org, webhookKey };
    const payload = { id: 1005, email: "eve@example.co.nz", first_name: "Eve", last_name: "Forger", updated_at: "2026-10-01T00:00:00Z" };

    const refused = [
      await webhook(path, "customers/create", payload, { secret: "another-secret" }),
      await webhook(path, "customers/create", payload, { tamper: (body) => body.replace("Forger", "Changed") }),
      await webhook(path, "customers/create", payload, { signature: null }),
      await webhook(path, "customers/create", payload, { domain: "someone-else.myshopify.com" }),
      await webhook({ organisationId: w.org, webhookKey: "x".repeat(43) }, "customers/create", payload),
      await webhook({ organisationId: "no-such-org", webhookKey }, "customers/create", payload),
      await webhook({ organisationId: "Bad Org!", webhookKey }, "customers/create", payload),
    ];
    expect(refused.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);

    // A properly signed delivery gets the same refusal, saying nothing about the organisation, while it's being
    // upgraded or when the server has no TOHYEE_SECRET_KEY (the store sends it again later).
    await coreQuery("update organisations set migration_status = 'failed' where id = $1", [w.org]);
    try {
      const upgrading = await webhook(path, "customers/create", payload);
      expect(upgrading.status).toBe(401);
      expect(await upgrading.json()).toEqual({ message: "Refused." });
    } finally {
      await coreQuery("update organisations set migration_status = 'current' where id = $1", [w.org]);
    }
    delete process.env.TOHYEE_SECRET_KEY;
    const noKey = await webhook(path, "customers/create", payload);
    process.env.TOHYEE_SECRET_KEY = SECRET_KEY;
    expect(noKey.status).toBe(401);

    // A body over 2 MB sent without a Content-Length is refused without being read in full.
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const huge = await webhookRoute.POST(
      new Request(`https://tohyee.example.nz/api/sales-platforms/webhooks/${w.org}/${webhookKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: endless,
        duplex: "half",
      } as RequestInit),
      params(path),
    );
    expect(huge.status).toBe(413);
    expect(sent).toBeLessThan(3 * 1024 * 1024);

    expect(await contactsNamed(w, "Eve Forger")).toHaveLength(0);
    expect(await contactsNamed(w, "Eve Changed")).toHaveLength(0);
    expect((await log(w, connection.id)).map((entry) => entry.action)).toEqual(["connected"]);
    expect((await w.as((tx) => tx.query("select 1 from sales_platform_webhook_deliveries"))).rowCount).toBe(0);
  });

  it("SPC9: disconnecting keeps contacts and items but removes credentials and links", async () => {
    const w = await setup();
    const state = shop();
    const connection = await connect(w, {}, "https://books.glimmers.nz");
    await syncConnection(w.record, connection.id);
    const webhookKey = (await w.as((tx) => tx.query<{ k: string }>("select webhook_key as k from sales_platform_connections"))).rows[0].k;
    const tamaId = (await contactsNamed(w, "Tama Rewi"))[0].id;
    const meltId = await itemByCode(w, "MELT-VAN");

    const disconnected = await disconnectStore(w.record, w.actor, connection.id);
    expect(disconnected).toMatchObject({ status: "disconnected", disconnectedByEmail: "jess@glimmers.nz", webhooksActive: false });
    expect(state.deletedWebhooks).toHaveLength(4);

    // Records stay.
    expect((await w.as((tx) => getContact(tx, tamaId))).isArchived).toBe(false);
    expect((await w.as((tx) => getContact(tx, w.aroha.id))).phone).toBe("+64 21 555 0101");
    expect((await w.as((tx) => getItem(tx, meltId))).isActive).toBe(true);
    // Credentials and links go; the log stays with a "disconnected" line.
    const row = await w.as((tx) =>
      tx.query<{ c: string | null; t: string | null }>("select credentials_ciphertext as c, access_token_ciphertext as t from sales_platform_connections"),
    );
    expect(row.rows[0]).toEqual({ c: null, t: null });
    expect((await w.as((tx) => tx.query("select 1 from sales_platform_mappings"))).rowCount).toBe(0);
    const entries = await log(w, connection.id);
    expect(entries[0].action).toBe("disconnected");
    expect(entries.some((entry) => entry.action === "created")).toBe(true);

    // The old webhook address refuses deliveries, and syncing is refused.
    const payload = { id: 1006, email: "late@example.co.nz", first_name: "Late", last_name: "Delivery", updated_at: "2026-10-01T00:00:00Z" };
    expect((await webhook({ organisationId: w.org, webhookKey }, "customers/create", payload)).status).toBe(401);
    await expect(syncConnection(w.record, connection.id)).rejects.toThrow(/disconnected/);

    // Connecting again links by email and SKU, without duplicates.
    const again = await connect(w);
    expect(again.id).not.toBe(connection.id);
    const result = await syncConnection(w.record, again.id);
    expect(result.created).toBe(0);
    expect(await contactsNamed(w, "Tama Rewi")).toHaveLength(1);
    expect(await w.as(async (tx) => Number((await tx.query<{ n: string }>("select count(*)::text as n from items")).rows[0].n))).toBe(2);
    expect((await w.as((tx) => listConnections(tx))).map((c) => c.status)).toEqual(["active", "disconnected"]);
  });

  it("SPC9: a failing store records its error and pauses after three failures", async () => {
    const w = await setup();
    const state = shop();
    const connection = await connect(w);
    state.fail = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(syncConnection(w.record, connection.id)).rejects.toThrow("500");
    }
    const [paused] = await w.as((tx) => listConnections(tx));
    expect(paused).toMatchObject({ status: "paused", failures: 3 });
    expect(paused.lastError).toContain("500");
    state.fail = false;
    await syncConnection(w.record, connection.id);
    expect((await w.as((tx) => listConnections(tx)))[0]).toMatchObject({ status: "active", failures: 0, lastError: null });
  });

  it("SPC10: viewers read the connection and log; only admins change anything", async () => {
    const w = await setup();
    shop();
    const viewerCookie = await sessionCookieFor(viewer);
    const ownerCookie = await sessionCookieFor(owner);
    const body = { organisationId: w.org, platform: "shopify", storeDomain: "glimmers", authMethod: "access_token", accessToken: TOKEN, apiSecret: SECRET };

    const viewerConnect = await connectionsRoute.POST(apiRequest("/api/sales-platforms/connections", { method: "POST", cookie: viewerCookie, body }), undefined);
    expect(viewerConnect.status).toBe(403);
    const ownerConnect = await connectionsRoute.POST(apiRequest("/api/sales-platforms/connections", { method: "POST", cookie: ownerCookie, body }), undefined);
    expect(ownerConnect.status).toBe(200);
    const { connection } = (await ownerConnect.json()) as { connection: { id: string } };
    const id = { connectionId: connection.id };

    const list = await connectionsRoute.GET(apiRequest(`/api/sales-platforms/connections?organisationId=${w.org}`, { cookie: viewerCookie }), undefined);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { connections: unknown[] }).connections).toHaveLength(1);
    const read = await logRoute.GET(apiRequest(`/api/sales-platforms/connections/${connection.id}/log?organisationId=${w.org}`, { cookie: viewerCookie }), params(id));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { entries: Array<{ action: string; actorEmail: string }> }).entries[0]).toMatchObject({
      action: "connected",
      actorEmail: "jess@glimmers.nz",
    });

    const asViewer = { cookie: viewerCookie, body: { organisationId: w.org } };
    expect((await testRoute.POST(apiRequest(`/x`, { method: "POST", ...asViewer }), params(id))).status).toBe(403);
    expect((await syncRoute.POST(apiRequest(`/x`, { method: "POST", ...asViewer }), params(id))).status).toBe(403);
    expect(
      (await connectionRoute.PATCH(apiRequest(`/x`, { method: "PATCH", cookie: viewerCookie, body: { organisationId: w.org, syncProducts: false } }), params(id)))
        .status,
    ).toBe(403);
    expect((await connectionRoute.DELETE(apiRequest(`/x?organisationId=${w.org}`, { method: "DELETE", cookie: viewerCookie }), params(id))).status).toBe(403);
    // Not signed in.
    expect((await logRoute.GET(apiRequest(`/x?organisationId=${w.org}`), params(id))).status).toBe(401);

    const asOwner = { cookie: ownerCookie, body: { organisationId: w.org } };
    const tested = await testRoute.POST(apiRequest(`/x`, { method: "POST", ...asOwner }), params(id));
    expect(tested.status).toBe(200);
    expect(((await tested.json()) as { result: { ok: boolean; storeName: string } }).result).toMatchObject({ ok: true, storeName: "Glimmers" });
    const patched = await connectionRoute.PATCH(
      apiRequest(`/x`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: w.org, syncProducts: false } }),
      params(id),
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { connection: { syncProducts: boolean } }).connection.syncProducts).toBe(false);
    const synced = await syncRoute.POST(apiRequest(`/x`, { method: "POST", ...asOwner }), params(id));
    expect(synced.status).toBe(200);
    expect(((await synced.json()) as { result: { created: number } }).result.created).toBe(1);
    // Only customers were synced, as chosen.
    expect(await itemByCode(w, "MELT-VAN")).toBeNull();
    const removed = await connectionRoute.DELETE(apiRequest(`/x?organisationId=${w.org}`, { method: "DELETE", cookie: ownerCookie }), params(id));
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { connection: { status: string } }).connection.status).toBe("disconnected");
    expect(await journals(w)).toBe(0);
  });
});
