import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createInvoice } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createQuote } from "@/lib/quotes/service";
import { createSalesOrder } from "@/lib/sales-orders/service";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "ai-paging";
const OTHER = "ai-paging-other";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function call(token: string, name: string, args: Json = {}): Promise<Json> {
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
  if (body.error) throw new Error(`rpc ${(body.error as Json).code}: ${(body.error as Json).message}`);
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text) as Json;
}

const line = { description: "Paw print pendant", quantity: "1", unitPrice: "80.00", accountCode: "4000", taxCode: "GST" };
const purchaseLine = { description: "Silver blanks", quantity: "1", unitPrice: "20.00", accountCode: "5000", taxCode: "GST" };

/** #538, decision 1267: AI lists page with a cursor and never claim to be complete when they aren't. */
describeWithDatabase("AI list paging (#538, decision 1267)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let kowhai: Contact;
  let rata: Contact;
  let supplier: Contact;
  const made: Record<string, { all: string[]; kowhai: string[] }> = {};
  const otherMade: Record<string, string[]> = {};
  const tokens: Record<string, string> = {};
  const as = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);

  async function makeKey(org: string, name: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", {
        method: "POST",
        cookie: await sessionCookieFor(owner),
        body: { organisationId: org, name, accessLevel: "full", confirmFullAccess: true },
      }),
      noContext,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("paging-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(owner, OTHER);
    kowhai = (await as(ORG, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kowhai Pets", isCustomer: true }))).contact;
    rata = (await as(ORG, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Vets", isCustomer: true }))).contact;
    supplier = (await as(ORG, (tx) => createContact(tx, { idempotencyKey: key("s"), name: "Paw Supplies", isSupplier: true }))).contact;
    for (const kind of ["invoices", "salesOrders", "quotes", "purchaseOrders", "items"]) made[kind] = { all: [], kowhai: [] };
    // 57 of each: 53 for Kowhai Pets (more than a page of 50 for one customer) and 4 for Rata Vets, interleaved.
    await as(ORG, async (tx) => {
      for (let index = 0; index < 57; index += 1) {
        const customer = index % 15 === 7 ? rata : kowhai;
        const record = (kind: string, id: string) => {
          made[kind].all.push(id);
          if (customer === kowhai) made[kind].kowhai.push(id);
        };
        const date = "2026-06-15";
        record("invoices", (await createInvoice(tx, { idempotencyKey: key("i"), contactId: customer.id, invoiceDate: date, dueDate: date, amountsMode: "exclusive", lines: [line] })).invoice.id);
        record("salesOrders", (await createSalesOrder(tx, { idempotencyKey: key("so"), contactId: customer.id, orderDate: date, amountsMode: "exclusive", lines: [line] })).salesOrder.id);
        record("quotes", (await createQuote(tx, { idempotencyKey: key("q"), contactId: customer.id, quoteDate: date, amountsMode: "exclusive", lines: [line] })).quote.id);
        made.purchaseOrders.all.push(
          (await createPurchaseOrder(tx, { idempotencyKey: key("po"), contactId: supplier.id, orderDate: date, amountsMode: "exclusive", lines: [purchaseLine] })).purchaseOrder.id,
        );
        made.items.all.push((await createItem(tx, { idempotencyKey: key("item"), code: `PAW-${String(index).padStart(3, "0")}`, name: `Pendant ${index}`, itemType: "service" })).item.id);
      }
    });
    // A few in another organisation, to check nothing crosses over.
    const otherCustomer = (await as(OTHER, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Other Co", isCustomer: true }))).contact;
    otherMade.salesOrders = [];
    otherMade.invoices = [];
    await as(OTHER, async (tx) => {
      for (let index = 0; index < 3; index += 1) {
        otherMade.salesOrders.push((await createSalesOrder(tx, { idempotencyKey: key("so"), contactId: otherCustomer.id, orderDate: "2026-06-15", amountsMode: "exclusive", lines: [line] })).salesOrder.id);
        otherMade.invoices.push((await createInvoice(tx, { idempotencyKey: key("i"), contactId: otherCustomer.id, invoiceDate: "2026-06-15", dueDate: "2026-06-15", amountsMode: "exclusive", lines: [line] })).invoice.id);
      }
    });
    tokens.main = await makeKey(ORG, "Paging");
    tokens.other = await makeKey(OTHER, "Other");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** Follows nextCursor to the end; returns every id in order and each page's size. */
  async function everyPage(token: string, tool: string, field: string, args: Json) {
    const ids: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await call(token, tool, { ...args, ...(cursor ? { cursor } : {}) });
      const rows = page[field] as Json[];
      ids.push(...rows.map((row) => String(row.id)));
      sizes.push(rows.length);
      // A page claims more exactly when it gives a cursor for it.
      expect(page.more).toBe(page.nextCursor !== null);
      if (page.nextCursor === null) return { ids, sizes };
      expect(typeof page.nextCursor).toBe("string");
      cursor = String(page.nextCursor);
    }
    throw new Error("Too many pages.");
  }

  const newestFirst = (ids: string[]) => [...ids].sort((a, b) => Number(b) - Number(a));

  const lists = [
    { tool: "list_sales_orders", field: "salesOrders", kind: "salesOrders" },
    { tool: "list_invoices", field: "invoices", kind: "invoices" },
    { tool: "list_quotes", field: "quotes", kind: "quotes" },
    { tool: "list_purchase_orders", field: "purchaseOrders", kind: "purchaseOrders" },
  ];

  it.each(lists)("$tool never claims to be complete early, and its cursors return every row exactly once", async ({ tool, field, kind }) => {
    const expected = newestFirst(made[kind].all);
    expect(expected.length).toBe(57);
    // The default page (50) and the largest (200).
    const first = await call(tokens.main, tool);
    expect((first[field] as Json[]).length).toBe(50);
    expect(first).toMatchObject({ more: true, nextCursor: expected[49] });
    const biggest = await call(tokens.main, tool, { limit: 200 });
    expect((biggest[field] as Json[]).map((row) => String(row.id))).toEqual(expected);
    expect(biggest).toMatchObject({ more: false, nextCursor: null });
    // Exactly 57 a page: the page is full and there's nothing after it.
    expect(await call(tokens.main, tool, { limit: 57 })).toMatchObject({ more: false, nextCursor: null });
    for (const limit of [undefined, 7, 50]) {
      const { ids, sizes } = await everyPage(tokens.main, tool, field, limit ? { limit } : {});
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(sizes.at(-1)).toBeGreaterThan(0);
    }
  });

  it.each(lists.filter((list) => list.kind !== "purchaseOrders"))("$tool keeps a customer filter across pages", async ({ tool, field, kind }) => {
    const { ids } = await everyPage(tokens.main, tool, field, { contactId: kowhai.id, limit: 50 });
    expect(made[kind].kowhai.length).toBe(53);
    expect(ids).toEqual(newestFirst(made[kind].kowhai));
    const rows = (await call(tokens.main, tool, { contactId: kowhai.id, limit: 200 }))[field] as Json[];
    expect(new Set(rows.map((row) => row.contactId))).toEqual(new Set([kowhai.id]));
  });

  it("an empty list and the last page say clearly that there's no more", async () => {
    expect(await call(tokens.main, "list_sales_orders", { status: "closed" })).toEqual({ salesOrders: [], more: false, nextCursor: null });
    expect(await call(tokens.main, "list_invoices", { status: "voided" })).toEqual({ invoices: [], more: false, nextCursor: null });
    const oldest = newestFirst(made.salesOrders.all).at(-1)!;
    expect(await call(tokens.main, "list_sales_orders", { cursor: oldest })).toEqual({ salesOrders: [], more: false, nextCursor: null });
  });

  it("paging stays inside the key's organisation, even with a cursor from another one", async () => {
    const { ids } = await everyPage(tokens.other, "list_sales_orders", "salesOrders", { limit: 2 });
    expect(ids).toEqual(newestFirst(otherMade.salesOrders));
    const cursorFromMain = newestFirst(made.salesOrders.all)[0];
    const foreign = await call(tokens.other, "list_sales_orders", { cursor: String(Number(cursorFromMain) + 1000) });
    for (const row of foreign.salesOrders as Json[]) expect(otherMade.salesOrders).toContain(String(row.id));
    const invoices = await everyPage(tokens.other, "list_invoices", "invoices", { limit: 1 });
    expect(invoices.ids).toEqual(newestFirst(otherMade.invoices));
  });

  it("lists the service returns whole (items) page by cursor too", async () => {
    const { ids, sizes } = await everyPage(tokens.main, "list_items", "items", { limit: 20 });
    expect(sizes).toEqual([20, 20, 17]);
    expect([...ids].sort()).toEqual([...made.items.all].sort());
    expect(new Set(ids).size).toBe(57);
    await expect(call(tokens.main, "list_items", { cursor: "999999999" })).rejects.toThrow(/Start again without a cursor/);
  });

  it("contacts and the chart of accounts give a cursor too", async () => {
    const contacts = await everyPage(tokens.main, "list_contacts", "rows", { limit: 1 });
    expect(contacts.ids).toEqual([kowhai.id, supplier.id, rata.id]);
    const accounts = await call(tokens.main, "list_accounts");
    expect(accounts).toMatchObject({ more: false, nextCursor: null });
  });
});
