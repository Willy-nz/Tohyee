import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { newSessionId } from "@/lib/ai/mcp-tool-list";
import { hashAiToken } from "@/lib/ai/token-format";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Decisions 1342-1344: when what a connection may use changes mid-session (its
 * level, its owner's role, a new release), the client is told on its next
 * request, and calls are always checked against the level now. Made-up people.
 */

const ORG = "ai-tool-list";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;
type Message = { jsonrpc: "2.0"; id?: number; method?: string; result?: Json; error?: { message: string } };

let rpcId = 0;
async function post(token: string, method: string, params: Json, options: { session?: string | null; accept?: string } = {}) {
  rpcId += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: options.accept ?? "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (options.session) headers["mcp-session-id"] = options.session;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }) }),
    noContext,
  );
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages: Message[] = type.startsWith("text/event-stream")
    ? text
        .split("\n\n")
        .filter(Boolean)
        .map((event) => JSON.parse(event.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Message)
    : [JSON.parse(text) as Message];
  return { response, stream: type.startsWith("text/event-stream"), messages, answer: messages[messages.length - 1] };
}

const notified = (messages: Message[]) => messages.some((message) => message.method === "notifications/tools/list_changed");
const toolNames = (answer: Message) => ((answer.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name);
const organisationAnswer = (answer: Message) => JSON.parse((answer.result as { content: { text: string }[] }).content[0].text) as Json;

describeWithDatabase("the AI's tool list follows the connection (decisions 1342-1344)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let partner: SessionUser;
  let partnerFull: string;
  let ownerRead: string;

  async function makeKey(user: SessionUser, name: string, accessLevel: string) {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", {
        method: "POST",
        cookie: await sessionCookieFor(user),
        body: { organisationId: ORG, name, accessLevel, ...(accessLevel === "full" ? { confirmFullAccess: true } : {}) },
      }),
      noContext,
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  const setRole = (role: string) => coreQuery("update organisation_members set role = $3 where organisation_id = $1 and user_id = $2", [ORG, partner.id, role]);

  async function connect(token: string) {
    const init = await post(token, "initialize", { protocolVersion: "2025-06-18" });
    expect((init.answer.result as Json).capabilities).toEqual({ tools: { listChanged: true } });
    const session = init.response.headers.get("mcp-session-id");
    expect(session).toMatch(/^tsv1\./);
    const listed = await post(token, "tools/list", {}, { session });
    expect(listed.stream).toBe(false);
    return { session, tools: toolNames(listed.answer) };
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    partner = await createTestUser("partner@example.com");
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')", [ORG, partner.id]);
    partnerFull = await makeKey(partner, "partner full", "full");
    ownerRead = await makeKey(owner, "owner look only", "read");
  }, 120_000);

  afterAll(async () => {
    await setRole("owner").catch(() => undefined);
    await server?.teardown();
  });

  it("an up-to-date client gets plain JSON answers, and no session means no guess", async () => {
    const { session } = await connect(ownerRead);
    const answer = await post(ownerRead, "tools/call", { name: "get_organisation", arguments: {} }, { session });
    expect(answer.stream).toBe(false);
    expect(organisationAnswer(answer.answer)).not.toHaveProperty("toolListNote");
    const noSession = await post(ownerRead, "tools/call", { name: "get_organisation", arguments: {} });
    expect(noSession.stream).toBe(false);
    expect(organisationAnswer(noSession.answer)).not.toHaveProperty("toolListNote");
  });

  it("level raised: the next answer says the list changed, get_organisation says it's out of date, and a fresh list has the new tools", async () => {
    const { session, tools } = await connect(ownerRead);
    expect(tools).not.toContain("unmatch_bank_lines");
    // The owner raises this connection to Full access.
    await coreQuery("update ai_access_tokens set access_level = 'full' where token_hash = $1", [hashAiToken(ownerRead)]);

    const next = await post(ownerRead, "tools/call", { name: "get_organisation", arguments: {} }, { session });
    expect(next.stream).toBe(true);
    expect(next.messages[0]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const organisation = organisationAnswer(next.answer);
    expect(organisation).toMatchObject({ access: "full", toolListUpToDate: false });
    expect(organisation.toolListNote).toContain("refresh its tools");
    expect(organisation.toolsNow).toContain("unmatch_bank_lines");
    expect(organisation.toolsNow).toContain("get_bank_batch");

    // A client that only reads JSON still gets the note.
    const jsonOnly = await post(ownerRead, "tools/call", { name: "get_organisation", arguments: {} }, { session, accept: "application/json" });
    expect(jsonOnly.stream).toBe(false);
    expect(organisationAnswer(jsonOnly.answer)).toMatchObject({ toolListUpToDate: false });

    const relisted = await post(ownerRead, "tools/list", {}, { session });
    expect(relisted.stream).toBe(false);
    expect(toolNames(relisted.answer)).toEqual(expect.arrayContaining(["unmatch_bank_lines", "get_bank_batch", "get_sales_platform_status"]));
    const after = await post(ownerRead, "tools/call", { name: "get_organisation", arguments: {} }, { session });
    expect(after.stream).toBe(false);
    expect(organisationAnswer(after.answer)).not.toHaveProperty("toolListNote");
  });

  it("role lowered: the client is told, the tools go from the list, and calls to them are refused", async () => {
    await setRole("owner");
    const { session, tools } = await connect(partnerFull);
    expect(tools).toContain("unmatch_bank_lines");
    await setRole("viewer");

    // The client still thinks it has unmatch_bank_lines: refused, with the refresh note.
    const refused = await post(partnerFull, "tools/call", { name: "unmatch_bank_lines", arguments: {} }, { session });
    expect(notified(refused.messages)).toBe(true);
    expect(refused.answer.error?.message).toContain("unmatch_bank_lines");
    expect(refused.answer.error?.message).toContain("Your tool list is out of date");

    const relisted = await post(partnerFull, "tools/list", {}, { session });
    const now = toolNames(relisted.answer);
    expect(now).toContain("get_organisation");
    expect(now).not.toContain("unmatch_bank_lines");
    expect(now).not.toContain("create_draft_invoice");
    // Still refused once the list is fresh: enforcement doesn't depend on the list.
    const again = await post(partnerFull, "tools/call", { name: "create_draft_invoice", arguments: {} }, { session });
    expect(again.stream).toBe(false);
    expect(again.answer.error?.message).toContain("create_draft_invoice");
    await setRole("owner");
  });

  it("deploy: a session from before a restart whose tool set has since changed is told to refresh", async () => {
    // A session id Tohyee made before the restart, when the tools were different.
    const oldSession = newSessionId("0123456789abcdef");
    const next = await post(ownerRead, "ping", {}, { session: oldSession });
    expect(next.stream).toBe(true);
    expect(notified(next.messages)).toBe(true);
    expect(next.answer).toMatchObject({ result: {} });
    // A session id Tohyee didn't make is ignored.
    const foreign = await post(ownerRead, "ping", {}, { session: "some-other-server-session" });
    expect(foreign.stream).toBe(false);
  });
});
