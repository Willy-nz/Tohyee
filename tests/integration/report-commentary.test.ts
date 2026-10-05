import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as forecastItemRoute from "@/app/api/cash-flow/commentary/[commentaryId]/route";
import * as forecastRoute from "@/app/api/cash-flow/commentary/route";
import * as groupItemRoute from "@/app/api/consolidation/groups/[groupId]/commentary/[commentaryId]/route";
import * as groupRoute from "@/app/api/consolidation/groups/[groupId]/commentary/route";
import * as mcpRoute from "@/app/api/mcp/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { Commentary } from "@/lib/commentary/types";
import { suggestedByText } from "@/lib/commentary/types";
import { createGroup } from "@/lib/consolidation/groups";
import { coreQuery } from "@/lib/db/transactions";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
type Json = Record<string, unknown>;

let rpcId = 0;
async function callTool(token: string, name: string, args: Json = {}): Promise<Json> {
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

/**
 * Examples AC1-AC2 in docs/ACCOUNTING-EXAMPLES.md ("AI commentary", decision
 * 446): the connected AI suggests, a person accepts, edits or removes. Jess owns both organisations, Mere is a bookkeeper of the first,
 * Vic a viewer of both.
 */
describeWithDatabase("report commentary (AC1-AC2)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let vic: SessionUser;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    server = await startTestServer();
    jess = await createTestUser("rc-jess@example.com", { serverAdmin: true, displayName: "Jess" });
    mere = await createTestUser("rc-mere@example.com", { displayName: "Mere" });
    vic = await createTestUser("rc-vic@example.com", { displayName: "Vic" });
    await createTestOrganisation(jess, "rc-holdings");
    await createTestOrganisation(jess, "rc-retail");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ('rc-holdings', $1, 'bookkeeper')", [mere.id]);
    for (const id of ["rc-holdings", "rc-retail"]) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [id, vic.id]);
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function aiKey(organisationId: string, accessLevel: string): Promise<string> {
    const made = await tokensRoute.POST(apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(jess), body: { organisationId, name: "Claude", accessLevel } }), noContext);
    return ((await made.json()) as { token: string }).token;
  }

  it("AC1: the AI's forecast commentary is a suggestion until a bookkeeper accepts it; removed ones are kept", async () => {
    const token = await aiKey("rc-holdings", "draft");
    const suggested = (await callTool(token, "suggest_report_commentary", { report: "cash_flow_forecast", periodLabel: "Weeks from 5 Oct 2026 to 3 Jan 2027", text: "Cash dips in week 6 when GST is paid." }))
      .commentary as Commentary;
    expect(suggested).toMatchObject({ report: "cash_flow_forecast", status: "suggested", writtenByEmail: jess.email, writtenVia: 'AI key "Claude"', acceptedByEmail: null });
    expect(suggestedByText("Jess", suggested.writtenVia!)).toBe("Suggested by Jess's AI key Claude, not checked");

    // A read-only key can't suggest one.
    const readOnly = await aiKey("rc-holdings", "read");
    await expect(callTool(readOnly, "suggest_report_commentary", { report: "cash_flow_forecast", periodLabel: "x", text: "y" })).rejects.toThrow();

    // Vic (viewer) sees it but can't accept or add.
    const vicCookie = await sessionCookieFor(vic);
    const listed = await forecastRoute.GET(apiRequest("/api/cash-flow/commentary?organisationId=rc-holdings", { cookie: vicCookie }), noContext);
    expect(((await listed.json()) as { commentary: Commentary[] }).commentary.map((entry) => entry.id)).toEqual([suggested.id]);
    const vicAccept = await forecastItemRoute.PUT(
      apiRequest(`/api/cash-flow/commentary/${suggested.id}`, { method: "PUT", cookie: vicCookie, body: { organisationId: "rc-holdings" } }),
      params({ commentaryId: suggested.id }),
    );
    expect(vicAccept.status).toBe(403);
    const vicAdd = await forecastRoute.POST(apiRequest("/api/cash-flow/commentary", { method: "POST", cookie: vicCookie, body: { organisationId: "rc-holdings", periodLabel: "x", body: "y" } }), noContext);
    expect(vicAdd.status).toBe(403);

    // Mere (bookkeeper) accepts it edited.
    const mereCookie = await sessionCookieFor(mere);
    const accepted = await forecastItemRoute.PUT(
      apiRequest(`/api/cash-flow/commentary/${suggested.id}`, { method: "PUT", cookie: mereCookie, body: { organisationId: "rc-holdings", body: "Cash dips in week 6 when GST of 4,200.00 is paid." } }),
      params({ commentaryId: suggested.id }),
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { commentary: Commentary }).commentary).toMatchObject({
      status: "accepted",
      body: "Cash dips in week 6 when GST of 4,200.00 is paid.",
      writtenVia: 'AI key "Claude"',
      acceptedByEmail: mere.email,
    });

    // A person's own commentary is accepted when written.
    const added = await forecastRoute.POST(
      apiRequest("/api/cash-flow/commentary", { method: "POST", cookie: mereCookie, body: { organisationId: "rc-holdings", periodLabel: "Months from Oct 2026", body: "Looks fine." } }),
      noContext,
    );
    expect(added.status).toBe(201);
    const own = ((await added.json()) as { commentary: Commentary }).commentary;
    expect(own).toMatchObject({ status: "accepted", writtenVia: null, writtenByEmail: mere.email, acceptedByEmail: mere.email });

    // Removing hides it but keeps the row, with who removed it.
    const removed = await forecastItemRoute.DELETE(apiRequest(`/api/cash-flow/commentary/${own.id}?organisationId=rc-holdings`, { method: "DELETE", cookie: mereCookie }), params({ commentaryId: own.id }));
    expect(removed.status).toBe(200);
    const again = await forecastItemRoute.DELETE(apiRequest(`/api/cash-flow/commentary/${own.id}?organisationId=rc-holdings`, { method: "DELETE", cookie: mereCookie }), params({ commentaryId: own.id }));
    expect(again.status).toBe(404);
    const kept = await inOrganisation("rc-holdings", { userId: jess.id, email: jess.email }, (tx) =>
      tx.query<{ removed_by_email: string | null }>("select removed_by_email from report_commentaries where id = $1", [own.id]),
    );
    expect(kept.rows).toEqual([{ removed_by_email: mere.email }]);
    const audit = await inOrganisation("rc-holdings", { userId: jess.id, email: jess.email }, (tx) =>
      tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where entity_type = 'report_commentary' order by id"),
    );
    expect(audit.rows).toEqual([
      { event_type: "commentary.suggested", actor_email: jess.email },
      { event_type: "commentary.accepted", actor_email: mere.email },
      { event_type: "commentary.accepted", actor_email: mere.email },
      { event_type: "commentary.removed", actor_email: mere.email },
    ]);
  });

  it("AC2: the AI's consolidated commentary is a suggestion; only bookkeepers of every member can accept, and others can't see it", async () => {
    const group = await createGroup({ id: jess.id, email: jess.email }, { name: "RC group", parentOrganisationId: "rc-holdings", organisationIds: ["rc-retail"] });
    const token = await aiKey("rc-holdings", "draft");
    await expect(callTool(token, "suggest_report_commentary", { report: "consolidated_profit_and_loss", periodLabel: "x", text: "y" })).rejects.toThrow();
    const suggested = (
      await callTool(token, "suggest_report_commentary", { report: "consolidated_profit_and_loss", groupId: group.id, periodLabel: "1 Oct 2026 to 31 Oct 2026", text: "Management fees eliminate." })
    ).commentary as Commentary;
    expect(suggested).toMatchObject({ report: "consolidated_profit_and_loss", status: "suggested", writtenVia: 'AI key "Claude"', writtenByEmail: jess.email });

    // Vic (viewer of both) can read it, but can't accept or add.
    const vicCookie = await sessionCookieFor(vic);
    const listed = await groupRoute.GET(apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { cookie: vicCookie }), params({ groupId: group.id }));
    expect(((await listed.json()) as { commentary: Commentary[] }).commentary.map((entry) => entry.id)).toEqual([suggested.id]);
    const vicAccept = await groupItemRoute.PUT(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary/${suggested.id}`, { method: "PUT", cookie: vicCookie, body: {} }),
      params({ groupId: group.id, commentaryId: suggested.id }),
    );
    expect(vicAccept.status).toBe(403);
    const vicAdd = await groupRoute.POST(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { method: "POST", cookie: vicCookie, body: { report: "consolidated_balance_sheet", periodLabel: "x", body: "y" } }),
      params({ groupId: group.id }),
    );
    expect(vicAdd.status).toBe(403);

    // Mere isn't in Retail, so the group isn't found for her.
    const mereList = await groupRoute.GET(apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { cookie: await sessionCookieFor(mere) }), params({ groupId: group.id }));
    expect(mereList.status).toBe(404);

    // Jess accepts it as it is, then writes one of her own on the balance sheet, which is accepted; a forecast report is refused here.
    const jessCookie = await sessionCookieFor(jess);
    const accepted = await groupItemRoute.PUT(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary/${suggested.id}`, { method: "PUT", cookie: jessCookie, body: {} }),
      params({ groupId: group.id, commentaryId: suggested.id }),
    );
    expect(((await accepted.json()) as { commentary: Commentary }).commentary).toMatchObject({ status: "accepted", body: "Management fees eliminate.", acceptedByEmail: jess.email });
    const own = await groupRoute.POST(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { method: "POST", cookie: jessCookie, body: { report: "consolidated_balance_sheet", periodLabel: "As at 31 Oct 2026", body: "The loan eliminates." } }),
      params({ groupId: group.id }),
    );
    expect(((await own.json()) as { commentary: Commentary }).commentary).toMatchObject({ status: "accepted", writtenVia: null });
    const wrong = await groupRoute.POST(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { method: "POST", cookie: jessCookie, body: { report: "cash_flow_forecast", periodLabel: "x", body: "y" } }),
      params({ groupId: group.id }),
    );
    expect(wrong.status).toBe(400);

    const removed = await groupItemRoute.DELETE(
      apiRequest(`/api/consolidation/groups/${group.id}/commentary/${suggested.id}`, { method: "DELETE", cookie: jessCookie }),
      params({ groupId: group.id, commentaryId: suggested.id }),
    );
    expect(removed.status).toBe(200);
    const after = await groupRoute.GET(apiRequest(`/api/consolidation/groups/${group.id}/commentary`, { cookie: jessCookie }), params({ groupId: group.id }));
    expect(((await after.json()) as { commentary: Commentary[] }).commentary.map((entry) => entry.report)).toEqual(["consolidated_balance_sheet"]);
    const audit = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where entity_type = 'consolidation_group' and entity_id = $1 and event_type like 'consolidation_commentary.%' order by id", [group.id]);
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "consolidation_commentary.suggested",
      "consolidation_commentary.accepted",
      "consolidation_commentary.accepted",
      "consolidation_commentary.removed",
    ]);
  });
});
