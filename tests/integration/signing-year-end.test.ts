import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as yearEndRoute from "@/app/api/reports/financial-statements/signing/route";
import * as signRoute from "@/app/api/sign/[organisationId]/[token]/route";
import * as signDocumentRoute from "@/app/api/sign/[organisationId]/[token]/document/route";
import * as fileRoute from "@/app/api/signing-requests/[requestId]/file/route";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { getSigningRequest, listSigningRequests, signAsMember } from "@/lib/signing/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Year-end accounts signed by the directors (decision 1407). Made-up people only. */

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describeWithDatabase("signing the year-end statements", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let count = 0;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    // Emails are checked as queued; nothing here sends them.
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    owner = await createTestUser("ye-owner@example.com", { serverAdmin: true, displayName: "Mere Director" });
    viewer = await createTestUser("ye-viewer@example.com", { displayName: "Vee" });
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    count += 1;
    const org = `ye-sign-${count}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>, who: SessionUser = owner) => inOrganisation(org, { userId: who.id, email: who.email }, work);
    const smtp = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await as((tx) => updateOrganisationEmailSettings(tx, { fromName: "Totara Ltd", fromAddress: "accounts@totara.test", username: "accounts@totara.test", password: "made-up-password" }, smtp));
    const send = (body: Record<string, unknown>, cookie = ownerCookie) =>
      yearEndRoute.POST(apiRequest("/api/reports/financial-statements/signing", { method: "POST", cookie, body: { organisationId: org, idempotencyKey: key("ye"), yearEnd: "2026-03-31", ...body } }), undefined);
    const emails = (requestId: string) => as((tx) => tx.query<{ purpose: string; to_email: string; subject: string; body: string }>("select purpose, to_email, subject, body from signing_emails where request_id = $1 order by id", [requestId])).then((r) => r.rows);
    return { org, as, send, emails };
  }

  const directors = [
    { name: "Mere Director", email: "ye-owner@example.com", roleLabel: "Director" },
    { name: "Tane Director", email: "tane@totara.test", roleLabel: "Director" },
  ];

  it("sends the year's PDF to the directors in order; the signed copy is kept with that year", async () => {
    const w = await setup();
    expect((await w.send({ signers: directors }, viewerCookie)).status).toBe(403);
    const response = await w.send({ signers: directors, signingOrder: "in_order" });
    expect(response.status).toBe(201);
    const { request } = (await response.json()) as { request: Awaited<ReturnType<typeof getSigningRequest>> };
    expect([request.sourceKind, request.sourceId, request.title]).toEqual(["year_end", "2026-03-31", `Financial statements for the year ended 31 March 2026, Test ${w.org}`]);
    expect(request.signers.map((signer) => [signer.name, signer.roleLabel, signer.status, signer.userId !== null])).toEqual([
      ["Mere Director", "Director", "ready", true],
      ["Tane Director", "Director", "waiting", false],
    ]);
    // In order: only the first director is emailed now.
    expect((await w.emails(request.id)).filter((email) => email.purpose === "link").map((email) => email.to_email)).toEqual(["ye-owner@example.com"]);
    // The kept PDF is what it says.
    const file = await fileRoute.GET(apiRequest(`/api/signing-requests/${request.id}/file?organisationId=${w.org}`, { cookie: ownerCookie }), params({ requestId: request.id }));
    expect(sha(new Uint8Array(await file.arrayBuffer()))).toBe(request.documentSha256);
    // One open request per year.
    expect((await w.send({ signers: directors })).status).toBe(409);

    // Mere signs in Tohyee (she opened the file above); then Tane is emailed.
    const meta = { ip: "198.51.100.7", userAgent: "Made-up Desktop", origin: "http://tohyee.test" };
    await w.as((tx) => signAsMember(tx, request.id, { method: "typed", typedName: "Mere Director", consent: true, documentSha256: request.documentSha256 }, meta));
    const tane = (await w.emails(request.id)).find((email) => email.purpose === "link" && email.to_email === "tane@totara.test")!;
    const token = tane.body.match(/\/sign\/[^/]+\/([A-Za-z0-9_-]{43})/)![1];
    const post = (body: Record<string, unknown>, session?: string) =>
      signRoute.POST(new Request(`http://tohyee.test/api/sign/${w.org}/${token}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-signing-session": session } : {}) }, body: JSON.stringify(body) }), params({ organisationId: w.org, token }));
    await post({ action: "send_code" });
    const code = (await w.emails(request.id)).filter((email) => email.purpose === "code").at(-1)!.subject.slice(-6);
    const { session } = (await (await post({ action: "verify_code", code })).json()) as { session: string };
    await signDocumentRoute.GET(new Request(`http://tohyee.test/api/sign/${w.org}/${token}/document`, { headers: { "x-signing-session": session } }), params({ organisationId: w.org, token }));
    expect((await post({ action: "sign", method: "typed", typedName: "Tane Director", consent: true, documentSha256: request.documentSha256 }, session)).status).toBe(200);

    const listed = (await (await yearEndRoute.GET(apiRequest(`/api/reports/financial-statements/signing?organisationId=${w.org}&yearEnd=2026-03-31`, { cookie: viewerCookie }), undefined)).json()) as { requests: Array<{ state: string; signedFileId: string | null }>; members: unknown[]; canSend: boolean };
    expect(listed.requests.map((each) => [each.state, each.signedFileId !== null])).toEqual([["completed", true]]);
    // A viewer sees the year's requests but isn't offered the members to send to.
    expect([listed.canSend, listed.members]).toEqual([false, []]);
    // Another year has none.
    expect(await w.as((tx) => listSigningRequests(tx, { sourceKind: "year_end", sourceId: "2025-03-31" }))).toEqual([]);
    const done = await w.as((tx) => getSigningRequest(tx, request.id));
    expect(done.signers.map((signer) => signer.verifiedBy)).toEqual(["tohyee_sign_in", "email_code"]);
  });

  it("a new version replaces the open request, which is voided", async () => {
    const w = await setup();
    const first = (await (await w.send({ signers: directors })).json()) as { request: { id: string } };
    const second = await w.send({ signers: [directors[1]], replacesRequestId: first.request.id });
    expect(second.status).toBe(201);
    const { request } = (await second.json()) as { request: { id: string; replacesRequestId: string } };
    expect(request.replacesRequestId).toBe(first.request.id);
    const old = await w.as((tx) => getSigningRequest(tx, first.request.id));
    expect([old.state, old.voidReason]).toEqual(["voided", `Replaced by a new version (request ${request.id}).`]);
    // Replacing something else is refused.
    expect((await w.send({ signers: directors, yearEnd: "2025-03-31", replacesRequestId: request.id })).status).toBe(400);
  });
});
