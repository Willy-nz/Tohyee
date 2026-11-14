import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as gstReturnRoute from "@/app/api/reports/gst-return/route";
import { FARMING_TOOLS, LIVESTOCK_TOOLS } from "@/lib/ai/tool-modules";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setFarmingEnabled } from "@/lib/farming/paddocks";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { fileGstReturn } from "@/lib/reports/gst-return";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * #576 (decisions 1385-1387): the AI is offered only the tools for modules
 * the organisation has on, and turning one on tells the client. #577
 * (GSR11-GSR14): gst_return and the GST return screen say when the period
 * isn't registered. Made-up organisation and people.
 */

const ORG = "ai-modules";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;
type Message = { jsonrpc: "2.0"; id?: number; method?: string; result?: Json; error?: { message: string } };

let rpcId = 0;
async function post(token: string, method: string, params: Json, session?: string | null) {
  rpcId += 1;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
  if (session) headers["mcp-session-id"] = session;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }) }),
    noContext,
  );
  const stream = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
  const text = await response.text();
  const messages: Message[] = stream
    ? text.split("\n\n").filter(Boolean).map((event) => JSON.parse(event.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Message)
    : [JSON.parse(text) as Message];
  return { response, stream, messages, answer: messages[messages.length - 1] };
}

const toolNames = (answer: Message) => (answer.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
const toolAnswer = (answer: Message) => JSON.parse((answer.result as { content: { text: string }[] }).content[0].text) as Json;

describeWithDatabase("the AI's tools follow the organisation's modules (#576) and the GST return its registration (#577)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let token = "";
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);

  async function connect() {
    const init = await post(token, "initialize", { protocolVersion: "2025-06-18" });
    const session = init.response.headers.get("mcp-session-id");
    const listed = await post(token, "tools/list", {}, session);
    return { session, tools: toolNames(listed.answer) };
  }

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("modules-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: ORG, name: "look", accessLevel: "read" } }),
      noContext,
    );
    expect(response.status).toBe(201);
    token = ((await response.json()) as { token: string }).token;
  }, 120_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("without Farming: no farm tools, get_organisation says why, and a call to one is refused with the reason", async () => {
    const { session, tools } = await connect();
    for (const name of [...FARMING_TOOLS, ...LIVESTOCK_TOOLS]) expect(tools, name).not.toContain(name);
    expect(tools).toEqual(expect.arrayContaining(["get_organisation", "list_invoices", "gst_return"]));

    const organisation = toolAnswer((await post(token, "tools/call", { name: "get_organisation", arguments: {} }, session)).answer);
    expect(organisation.toolGroups).toEqual(
      expect.arrayContaining([
        { group: "accounting", label: expect.any(String), offered: true },
        { group: "farming", label: expect.any(String), offered: false, hiddenBecause: "Farming is turned off for this organisation (Settings › Modules)." },
        { group: "livestock", label: expect.any(String), offered: false, hiddenBecause: "Livestock is turned off for this organisation (Settings › Modules)." },
      ]),
    );

    const refused = await post(token, "tools/call", { name: "list_farms_and_paddocks", arguments: {} }, session);
    expect(refused.answer.error?.message).toBe("list_farms_and_paddocks isn't offered: Farming is turned off for this organisation (Settings › Modules).");
  });

  it("turning Farming on changes the tool-set version and tells the client; turning it off again takes the tools away", async () => {
    const { session, tools } = await connect();
    expect(tools).not.toContain("farm_notebook");
    const before = toolAnswer((await post(token, "tools/call", { name: "get_organisation", arguments: {} }, session)).answer).toolListVersion;

    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    const next = await post(token, "tools/call", { name: "get_organisation", arguments: {} }, session);
    expect(next.stream).toBe(true);
    expect(next.messages[0]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const organisation = toolAnswer(next.answer);
    expect(organisation.toolListVersion).not.toBe(before);
    expect(organisation).toMatchObject({ toolListUpToDate: false });
    expect(organisation.toolsNow).toEqual(expect.arrayContaining([...FARMING_TOOLS.filter((name) => AI_TOOL_PLAIN_WORDS.find((tool) => tool.name === name)?.level === "read")]));

    const relisted = await post(token, "tools/list", {}, session);
    expect(toolNames(relisted.answer)).toContain("farm_notebook");
    expect((await post(token, "tools/call", { name: "list_farms_and_paddocks", arguments: {} }, session)).answer.result).toBeDefined();

    await as((tx) => setFarmingEnabled(tx, { enabled: false }));
    const off = await post(token, "tools/call", { name: "get_organisation", arguments: {} }, session);
    expect(off.stream).toBe(true);
    expect(toolAnswer(off.answer).toolListVersion).toBe(before);
  });

  it("GSR11, GSR12: a period with no registration: the tool and the screen's API say so instead of a return of zeros, and it can't be filed", async () => {
    await as((tx) => updateOrganisationSettings(tx, { gstRegistered: false }));
    const { session } = await connect();
    const gst = toolAnswer((await post(token, "tools/call", { name: "gst_return", arguments: { periodStart: "2026-09-01", periodEnd: "2026-10-31" } }, session)).answer);
    expect(gst).toMatchObject({ notRegistered: true, registration: { status: "not_registered", registered: false, confirmed: true } });
    expect(gst).not.toHaveProperty("boxes");
    expect(gst).not.toHaveProperty("transactionLineCount");
    expect(gst.note).toContain(`isn't registered for GST for 2026-09-01 to 2026-10-31`);
    expect(gst.note).toContain("it isn't a nil return");

    const screen = await gstReturnRoute.GET(
      apiRequest(`/api/reports/gst-return?organisationId=${ORG}&periodStart=2026-09-01&periodEnd=2026-10-31`, { cookie: await sessionCookieFor(owner) }),
      noContext,
    );
    expect(((await screen.json()) as Json).registration).toMatchObject({ status: "not_registered" });

    await expect(as((tx) => fileGstReturn(tx, { idempotencyKey: key("gst"), periodStart: "2026-09-01", periodEnd: "2026-10-31" }))).rejects.toThrow(
      "isn't registered for GST for 2026-09-01 to 2026-10-31",
    );
  });

  it("GSR13: a period that straddles the registration date says so, with the return", async () => {
    await as((tx) => updateOrganisationSettings(tx, { gstRegistered: true, gstRegisteredFrom: "2026-10-15", gstNumber: "123-456-789" }));
    const { session } = await connect();
    const gst = toolAnswer((await post(token, "tools/call", { name: "gst_return", arguments: { periodStart: "2026-09-01", periodEnd: "2026-10-31" } }, session)).answer);
    expect(gst).toMatchObject({
      notRegistered: false,
      registration: { status: "partly_registered", from: "2026-10-15", coveredFrom: "2026-10-15", coveredUntil: "2026-10-31", confirmed: true },
      boxes: expect.objectContaining({ box5: "0.00" }),
    });
    expect(gst.note).toContain("registered for GST for only part of 2026-09-01 to 2026-10-31 (registration starts 2026-10-15)");

    const whole = toolAnswer((await post(token, "tools/call", { name: "gst_return", arguments: { periodStart: "2026-11-01", periodEnd: "2026-12-31" } }, session)).answer);
    expect(whole).toMatchObject({ notRegistered: false, registration: { status: "registered" }, note: "Worked out now; nothing was filed or saved." });
  });
});
