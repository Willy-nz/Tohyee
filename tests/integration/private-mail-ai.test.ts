import { afterAll, beforeAll, expect, it } from "vitest";
import * as tokensRoute from "@/app/api/ai/tokens/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as aiKeysRoute from "@/app/api/my-mail/ai-keys/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { claimFarmMailState, fetchFarmMailConnection } from "@/lib/farming/calendar";
import { getOrganisation } from "@/lib/organisations/registry";
import { MailOwner } from "@/lib/private-mail/access";
import { chooseMyFolders, myFolderChoices, savePrivateMailbox, startMyMailConnect } from "@/lib/private-mail/store";
import { syncPrivateCopy } from "@/lib/private-mail/sync";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * The AI's private-mail scope (#250 part 2; PM15-PM19, Claude's rules, not
 * yet reviewed). Gmail is a canned fake with made-up mail.
 */
const ORG = "private-mail-ai";
const noContext = undefined as unknown;
type Json = Record<string, unknown>;

const MAIL = [
  { id: "g1", threadId: "t1", at: "2026-10-10T21:00:00Z", from: "Soil Lab <results@soillab.example>", subject: "Soil test results paddock twelve", text: "The Olsen P for paddock twelve is 32.", labels: ["Label_1"] },
  { id: "g2", threadId: "t2", at: "2026-10-12T03:00:00Z", from: "Board <secretary@finchboard.example>", subject: "Board papers", text: "Directorship papers.", labels: ["Label_3"] },
];

let rpcId = 0;
async function rpc(token: string, method: string, rpcParams?: unknown) {
  rpcId += 1;
  const response = await mcpRoute.POST(
    new Request("http://tohyee.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params: rpcParams }),
    }),
    noContext,
  );
  return (await response.json()) as Json;
}
const toolNames = async (token: string) => ((await rpc(token, "tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
const instructions = async (token: string) => ((await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result as { instructions: string }).instructions;
async function call(token: string, name: string, args: Json = {}): Promise<{ text: string; isError: boolean }> {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  if (body.error) return { text: String((body.error as Json).message), isError: true };
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

describeWithDatabase("the AI's private-mail scope", () => {
  let server: TestServer;
  let jess: SessionUser;
  let ana: SessionUser;
  let mere: SessionUser;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const enc = (text: string) => Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  async function makeKey(user: SessionUser, name: string, accessLevel = "read") {
    const response = await tokensRoute.POST(
      apiRequest("/api/ai/tokens", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, name, accessLevel, confirmFullAccess: accessLevel === "full" } }),
      noContext,
    );
    const body = (await response.json()) as { token: string; key: { id: string } };
    ids[name] = body.key.id;
    return body.token;
  }
  const keysRoute = async (user: SessionUser, method: "GET" | "PUT", body?: Json) => {
    const cookie = await sessionCookieFor(user);
    const response =
      method === "GET"
        ? await aiKeysRoute.GET(apiRequest(`/api/my-mail/ai-keys?organisationId=${ORG}`, { cookie }), params({}))
        : await aiKeysRoute.PUT(apiRequest("/api/my-mail/ai-keys", { method: "PUT", cookie, body: { organisationId: ORG, ...body } }), params({}));
    return { status: response.status, body: (await response.json()) as Json };
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "private-mail-ai-test-secret-key-0123456789abcdef";
    server = await startTestServer();
    jess = await createTestUser("pma-jess@example.com", { displayName: "Jess" });
    ana = await createTestUser("pma-ana@example.com", { displayName: "Ana" });
    mere = await createTestUser("pma-mere@example.com", { displayName: "Mere" });
    await createTestOrganisation(jess, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'admin')", [ORG, ana.id, mere.id]);
    setMailFetchForTests(async (input: string) => {
      const url = new URL(input);
      if (url.host === "oauth2.googleapis.com") return reply({ access_token: "a", refresh_token: "r", expires_in: 3600 });
      if (url.pathname.endsWith("/users/me/profile")) return reply({ emailAddress: "jess@kowhaidairies.example" });
      if (url.pathname.endsWith("/users/me/labels")) return reply({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Farm", type: "user" }, { id: "Label_3", name: "Directorships", type: "user" }] });
      if (url.pathname.endsWith("/users/me/messages")) {
        const label = url.searchParams.get("labelIds");
        return reply({ messages: MAIL.filter((mail) => !label || mail.labels.includes(label)).map((mail) => ({ id: mail.id })) });
      }
      const mail = MAIL.find((entry) => entry.id === url.pathname.split("/").pop())!;
      return reply({ id: mail.id, threadId: mail.threadId, internalDate: String(Date.parse(mail.at)), payload: { mimeType: "text/plain", headers: [{ name: "From", value: mail.from }, { name: "Subject", value: mail.subject }], body: { data: enc(mail.text) } } });
    });
    const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
    await as(jess, (tx) => saveMailSettings(tx, { googleClientId: "g.apps.googleusercontent.com", googleClientSecret: "s", microsoftClientId: "m", microsoftClientSecret: "s" }));
    const { url } = await as(jess, async (tx) => startMyMailConnect(tx, await MailOwner.of(tx), { provider: "google", historyDays: 90 }, "https://tohyee.test"));
    const claimed = await as(jess, (tx) => claimFarmMailState(tx, new URL(url).searchParams.get("state")!));
    const saved = await as(jess, async (tx) => savePrivateMailbox(tx, claimed, await fetchFarmMailConnection(claimed, "c", "https://tohyee.test"), new Date("2026-10-19T09:00:00Z")));
    const organisation = (await getOrganisation(ORG))!;
    const available = await myFolderChoices(organisation, saved.id);
    await as(jess, async (tx) => chooseMyFolders(tx, await MailOwner.of(tx), saved.id, [{ id: "Label_1" }], available));
    const copyId = (await as(jess, (tx) => tx.query<{ id: string }>("select id::text from private_mail_copies"))).rows[0].id;
    await syncPrivateCopy(organisation, copyId, new Date("2026-10-19T09:15:00Z"));
    tokens.look = await makeKey(jess, "Claude for my mail");
    tokens.post = await makeKey(jess, "Claude for the books", "post");
    tokens.ana = await makeKey(ana, "Ana's Claude");
    tokens.mere = await makeKey(mere, "Mere's Claude");
  });

  afterAll(async () => {
    setMailFetchForTests(null);
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("PM15, PM16 only the Owner gives the scope, only to their own Look only keys", async () => {
    // No key reads mail until Jess says so.
    expect(await toolNames(tokens.look)).not.toContain("search_my_mail");
    const listed = await keysRoute(jess, "GET");
    expect(listed.body.keys).toEqual([
      { id: ids["Claude for the books"], name: "Claude for the books", startsWith: expect.any(String), lookOnly: false, canReadMail: false },
      { id: ids["Claude for my mail"], name: "Claude for my mail", startsWith: expect.any(String), lookOnly: true, canReadMail: false },
    ]);
    // Not a key that can write, not someone else's key.
    expect((await keysRoute(jess, "PUT", { tokenId: ids["Claude for the books"], canReadMail: true })).status).toBe(400);
    expect((await keysRoute(jess, "PUT", { tokenId: ids["Ana's Claude"], canReadMail: true })).status).toBe(404);
    // Mere (an admin) can't give hers, or list anyone's.
    expect((await keysRoute(mere, "PUT", { tokenId: ids["Mere's Claude"], canReadMail: true })).status).toBe(404);
    expect((await keysRoute(mere, "GET")).status).toBe(404);
    // Ana, another Owner, can't give Jess's key the scope.
    expect((await keysRoute(ana, "PUT", { tokenId: ids["Claude for my mail"], canReadMail: true })).status).toBe(404);
    const given = await keysRoute(jess, "PUT", { tokenId: ids["Claude for my mail"], canReadMail: true });
    expect(given.status).toBe(200);
    expect((given.body.keys as Json[]).find((key) => key.id === ids["Claude for my mail"])).toMatchObject({ canReadMail: true });
    // Audited with no details.
    const audit = await inOrganisation(ORG, { userId: jess.id, email: jess.email }, (tx) => tx.query<{ details: unknown }>("select details from audit_events where event_type = 'private_mail.ai_key_allowed'"));
    expect(audit.rows).toEqual([{ details: {} }]);
  });

  it("PM17 the Owner's key searches and reads her mail, citing it; no other key can", async () => {
    expect(await toolNames(tokens.look)).toEqual(expect.arrayContaining(["search_my_mail", "read_my_mail"]));
    expect(await instructions(tokens.look)).toContain("private mail");
    for (const token of [tokens.post, tokens.ana, tokens.mere]) {
      expect(await toolNames(token)).not.toContain("search_my_mail");
      expect(await call(token, "search_my_mail", { query: "olsen" })).toEqual({ text: "Unknown tool: search_my_mail.", isError: true });
    }
    expect(await instructions(tokens.ana)).not.toContain("private mail");
    const found = await call(tokens.look, "search_my_mail", { query: "olsen paddock" });
    const answer = JSON.parse(found.text) as { emails: Array<{ messageId: string; subject: string; cite: string }> };
    expect(answer.emails).toMatchObject([{ subject: "Soil test results paddock twelve", cite: expect.stringContaining('Email "Soil test results paddock twelve" from Soil Lab <results@soillab.example>, 2026-10-10') }]);
    const read = JSON.parse((await call(tokens.look, "read_my_mail", { messageId: answer.emails[0].messageId })).text) as { emails: Array<{ text: string; cite: string }> };
    expect(read.emails[0].text).toBe("The Olsen P for paddock twelve is 32.");
    expect(read.emails[0].cite).toContain(`My mail message ${answer.emails[0].messageId}`);
    // The directorship label was never ticked: nothing of it to find.
    expect(JSON.parse((await call(tokens.look, "search_my_mail", { query: "directorship" })).text)).toEqual({ emails: [], more: null });
    // Ana gives her own key the scope: it sees only her own (empty) mail, never Jess's.
    expect((await keysRoute(ana, "PUT", { tokenId: ids["Ana's Claude"], canReadMail: true })).status).toBe(200);
    expect(JSON.parse((await call(tokens.ana, "search_my_mail", { query: "olsen" })).text)).toEqual({ emails: [], more: null });
    expect(await call(tokens.ana, "read_my_mail", { messageId: answer.emails[0].messageId })).toEqual({ text: "Not found.", isError: true });
  });

  it("PM18 losing Owner or taking the scope away stops it at once", async () => {
    await memberRoute.PATCH(apiRequest(`/api/organisations/${ORG}/members/${jess.id}`, { method: "PATCH", cookie: await sessionCookieFor(ana), body: { role: "admin" } }), params({ organisationId: ORG, userId: jess.id }));
    expect(await toolNames(tokens.look)).not.toContain("search_my_mail");
    expect((await call(tokens.look, "search_my_mail", { query: "olsen" })).isError).toBe(true);
    await memberRoute.PATCH(apiRequest(`/api/organisations/${ORG}/members/${jess.id}`, { method: "PATCH", cookie: await sessionCookieFor(ana), body: { role: "owner" } }), params({ organisationId: ORG, userId: jess.id }));
    expect(await toolNames(tokens.look)).toContain("search_my_mail");
    expect((await keysRoute(jess, "PUT", { tokenId: ids["Claude for my mail"], canReadMail: false })).status).toBe(200);
    expect(await toolNames(tokens.look)).not.toContain("search_my_mail");
    expect((await call(tokens.look, "read_my_mail", { messageId: "1" })).isError).toBe(true);
  });

  it("PM19 a key with the scope only looks: its mail tools run read-only and it has no write tools", async () => {
    await keysRoute(jess, "PUT", { tokenId: ids["Claude for my mail"], canReadMail: true });
    const names = await toolNames(tokens.look);
    expect(names).toContain("search_my_mail");
    expect(names).not.toContain("create_contact");
    expect((await call(tokens.look, "create_contact", { name: "Soil Lab" })).isError).toBe(true);
  });
});
