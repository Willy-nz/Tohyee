import { afterAll, beforeAll, expect, it } from "vitest";
import * as decideRoute from "@/app/api/ai/action-requests/[requestId]/decide/route";
import * as requestsRoute from "@/app/api/ai/action-requests/route";
import * as settingsRoute from "@/app/api/ai/action-approval-settings/route";
import { mcpServerFor } from "@/lib/ai/mcp-server";
import type { AiTokenIdentity } from "@/lib/ai/tokens";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { listTopBarNotices } from "@/lib/notices/top-bar";
import { getMembership } from "@/lib/organisations/registry";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-approvals";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

/** A person approves the AI's voids, deletes and roll-backs (#697, decision 1633; AIH1-AIH6). Made-up figures. */
describeWithDatabase("a person approves the AI's voids and deletes", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie = "";
  let bookkeeperCookie = "";
  let viewerCookie = "";
  let identity: AiTokenIdentity;
  let customerId = "";

  const asOwner = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  /** A tool call through the MCP server, as the AI makes it. */
  const call = async (name: string, args: Json) => {
    const answer = await mcpServerFor(identity).callTool(name, args);
    const first = answer.content[0] as { type: string; text: string };
    return { isError: answer.isError === true, text: first.text, data: answer.isError ? ({} as Json) : (JSON.parse(first.text) as Json) };
  };
  const setRequired = (required: boolean, cookie = ownerCookie) =>
    settingsRoute.PUT(apiRequest("/api/ai/action-approval-settings", { method: "PUT", cookie, body: { organisationId: ORG, required } }), noContext);
  const decide = async (requestId: unknown, decision: string, cookie = ownerCookie) => {
    const response = await decideRoute.POST(apiRequest(`/api/ai/action-requests/${String(requestId)}/decide`, { method: "POST", cookie, body: { organisationId: ORG, decision } }), params({ requestId: String(requestId) }));
    return { status: response.status, body: (await response.json()) as { request: Json; error?: Json } };
  };
  const approvedInvoice = async () => {
    const invoice = (
      await asOwner((tx) =>
        createInvoice(tx, { idempotencyKey: key("inv"), contactId: customerId, invoiceDate: "2026-06-01", dueDate: "2026-06-20", amountsMode: "no_tax", lines: [{ description: "Pendant", quantity: "1", unitPrice: "100.00", accountCode: "4000" }] }),
      )
    ).invoice;
    await asOwner((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }));
    return invoice.id;
  };
  const statusOf = async (invoiceId: string) => (await asOwner((tx) => getInvoice(tx, invoiceId))).status;
  /** The AI's two calls: the preview, then the one that would do it. */
  const askToVoid = async (invoiceId: string) => {
    const args = { invoiceId, voidDate: "2026-06-05" };
    const first = await call("void_invoice", args);
    expect(first.data).toMatchObject({ preview: true, actsOn: { id: invoiceId, status: "approved", total: "100.00" } });
    return { args: { ...args, confirmHash: first.data.confirmHash }, second: await call("void_invoice", { ...args, confirmHash: first.data.confirmHash, idempotencyKey: key("void") }) };
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@ai-approvals.nz", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("bookkeeper@ai-approvals.nz");
    viewer = await createTestUser("viewer@ai-approvals.nz");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [ORG, bookkeeper.id, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    bookkeeperCookie = await sessionCookieFor(bookkeeper);
    viewerCookie = await sessionCookieFor(viewer);
    const membership = (await getMembership(ORG, owner.id))!;
    identity = { tokenId: "41", kind: "key", tokenName: "Claude", accessLevel: "full", effectiveLevel: "full", toolScope: null, user: { id: owner.id, email: owner.email, displayName: "Owner" }, membership };
    customerId = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Aroha Made-up", isCustomer: true }))).contact.id;
  });
  afterAll(async () => {
    await server?.teardown();
  });

  it("AIH1: off (as it starts), the AI's second call does it, as before", async () => {
    const invoiceId = await approvedInvoice();
    const { second } = await askToVoid(invoiceId);
    expect(second.isError).toBe(false);
    expect(second.data).not.toHaveProperty("waitingForApproval");
    expect(await statusOf(invoiceId)).toBe("voided");
  });

  it("AIH2: only an owner turns it on; then the second call changes nothing and leaves a request with the same preview", async () => {
    expect((await setRequired(true, bookkeeperCookie)).status).toBe(403);
    expect((await setRequired(true)).status).toBe(200);
    const invoiceId = await approvedInvoice();
    const { args, second } = await askToVoid(invoiceId);
    expect(second.data).toMatchObject({ waitingForApproval: true, note: expect.stringContaining("Nothing has been changed yet") });
    expect(await statusOf(invoiceId)).toBe("approved");
    // Asking again (a new idempotency key) is the same request, not a second one.
    const again = await call("void_invoice", { ...args, idempotencyKey: key("void-again") });
    expect(again.data.requestId).toBe(second.data.requestId);
    // A preview still shows, and a wrong hash is refused as the tool itself would.
    expect((await call("void_invoice", { invoiceId, voidDate: "2026-06-05" })).data).toMatchObject({ preview: true });
    const wrong = await call("void_invoice", { invoiceId, voidDate: "2026-06-05", confirmHash: "not-it", idempotencyKey: key("x") });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("again without confirmHash");

    // People who can approve see it, with what the AI saw; a viewer doesn't.
    const listed = (await (await requestsRoute.GET(apiRequest(`/api/ai/action-requests?organisationId=${ORG}`, { cookie: bookkeeperCookie }), noContext)).json()) as { waiting: Json[] };
    expect(listed.waiting).toHaveLength(1);
    expect(listed.waiting[0]).toMatchObject({ toolName: "void_invoice", title: "Void an invoice", via: 'AI key "Claude"', status: "pending", preview: { actsOn: { id: invoiceId, total: "100.00" } } });
    expect((await requestsRoute.GET(apiRequest(`/api/ai/action-requests?organisationId=${ORG}`, { cookie: viewerCookie }), noContext)).status).toBe(403);
    const notice = (role: "owner" | "bookkeeper" | "viewer") => asOwner((tx) => listTopBarNotices(tx, role)).then((notices) => notices.filter((entry) => entry.id === "ai-actions-waiting"));
    expect(await notice("bookkeeper")).toEqual([{ id: "ai-actions-waiting", message: "Your AI is waiting for a person to approve 1 change.", href: "/operations/ai" }]);
    expect(await notice("viewer")).toEqual([]);

    // AIH3: a viewer can't decide; a bookkeeper approves and it's done, as them, and the AI is told.
    expect((await decide(second.data.requestId, "approve", viewerCookie)).status).toBe(403);
    expect((await decide(second.data.requestId, "maybe")).status).toBe(400);
    const approved = await decide(second.data.requestId, "approve", bookkeeperCookie);
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({ status: "approved", decidedByEmail: bookkeeper.email });
    expect(await statusOf(invoiceId)).toBe("voided");
    expect((await decide(second.data.requestId, "approve")).status).toBe(409);
    const told = await call("void_invoice", { ...args, idempotencyKey: key("void-after") });
    expect(told.data).toMatchObject({ approved: true, approvedBy: bookkeeper.email });
    expect(await notice("owner")).toEqual([]);
    const audit = await asOwner((tx) => tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = 'ai_action_request' order by id"));
    expect(audit.rows.map((row) => `${row.event_type} ${row.actor_email}`)).toEqual([`ai_action.requested ${owner.email}`, `ai_action.approved ${bookkeeper.email}`]);
  });

  it("AIH4: declined, nothing changes and the AI is told not to ask again", async () => {
    const invoiceId = await approvedInvoice();
    const { args, second } = await askToVoid(invoiceId);
    const declined = await decide(second.data.requestId, "decline");
    expect(declined.body.request).toMatchObject({ status: "declined", decidedByEmail: owner.email });
    expect(await statusOf(invoiceId)).toBe("approved");
    const told = await call("void_invoice", { ...args, idempotencyKey: key("void-declined") });
    expect(told.data).toMatchObject({ declined: true, note: expect.stringContaining("Nothing was changed") });
    expect(await statusOf(invoiceId)).toBe("approved");
  });

  it("AIH5: if it changed after the AI asked, approving does nothing and says so", async () => {
    const invoiceId = await approvedInvoice();
    const { second } = await askToVoid(invoiceId);
    // A person voids it on the screen in the meantime.
    await asOwner((tx) => voidInvoice(tx, invoiceId, { idempotencyKey: key("person-void"), voidDate: "2026-06-06", source: "web" }));
    const approved = await decide(second.data.requestId, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({ status: "failed", error: expect.stringContaining("changed since the first call") });
  });

  it("AIH6: previews, the AI's ordinary work and turning it off again are untouched", async () => {
    const posted = await call("create_contact", { idempotencyKey: key("k"), name: "Second Made-up", isCustomer: true });
    expect(posted.isError).toBe(false);
    expect((await setRequired(false)).status).toBe(200);
    const invoiceId = await approvedInvoice();
    const { second } = await askToVoid(invoiceId);
    expect(second.data).not.toHaveProperty("waitingForApproval");
    expect(await statusOf(invoiceId)).toBe("voided");
  });
});
