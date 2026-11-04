import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as listRoute from "@/app/api/signing-requests/route";
import * as signRoute from "@/app/api/sign/[organisationId]/[token]/route";
import * as signDocumentRoute from "@/app/api/sign/[organisationId]/[token]/document/route";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { getSigningRequest, listSigningRequests, sendDueReminders } from "@/lib/signing/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Any uploaded PDF, several signers, and reminders (decision 1410). Made-up people only. */

async function pdf(text: string): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780 });
  return Buffer.from(await doc.save()).toString("base64");
}

describeWithDatabase("signing any uploaded PDF", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  const ORG = "signing-uploads-co";
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const emails = (requestId: string) => as(owner)((tx) => tx.query<{ purpose: string; to_email: string; subject: string; body: string }>("select purpose, to_email, subject, body from signing_emails where request_id = $1 order by id", [requestId])).then((r) => r.rows);
  const tokenFor = async (requestId: string, email: string) => (await emails(requestId)).filter((each) => (each.purpose === "link" || each.purpose === "reminder") && each.to_email === email).at(-1)!.body.match(/\/sign\/[^/]+\/([A-Za-z0-9_-]{43})/)![1];
  const linkGet = (token: string) => signRoute.GET(new Request(`http://tohyee.test/api/sign/${ORG}/${token}`), params({ organisationId: ORG, token }));

  async function sign(requestId: string, email: string, name: string) {
    const token = await tokenFor(requestId, email);
    const post = (body: Record<string, unknown>, session?: string) =>
      signRoute.POST(new Request(`http://tohyee.test/api/sign/${ORG}/${token}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-signing-session": session } : {}) }, body: JSON.stringify(body) }), params({ organisationId: ORG, token }));
    await post({ action: "send_code" });
    const code = (await emails(requestId)).filter((each) => each.purpose === "code" && each.to_email === email).at(-1)!.subject.slice(-6);
    const { session } = (await (await post({ action: "verify_code", code })).json()) as { session: string };
    await signDocumentRoute.GET(new Request(`http://tohyee.test/api/sign/${ORG}/${token}/document`, { headers: { "x-signing-session": session } }), params({ organisationId: ORG, token }));
    const sha = (await as(owner)((tx) => getSigningRequest(tx, requestId))).documentSha256;
    return post({ action: "sign", method: "typed", typedName: name, consent: true, documentSha256: sha }, session);
  }

  const send = async (body: Record<string, unknown>, cookie = ownerCookie) =>
    listRoute.POST(apiRequest("/api/signing-requests", { method: "POST", cookie, body: { organisationId: ORG, idempotencyKey: key("up"), title: "Lease renewal, 12 Made-up St", fileName: "lease.pdf", contentBase64: await pdf("Lease (made up)"), ...body } }), undefined);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    // Emails are checked as queued; nothing here sends them.
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    owner = await createTestUser("uploads-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    viewer = await createTestUser("uploads-viewer@example.com", { displayName: "Vee" });
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    const smtp = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await as(owner)((tx) => updateOrganisationEmailSettings(tx, { fromName: "Rata Ltd", fromAddress: "office@rata.test", username: "office@rata.test", password: "made-up-password" }, smtp));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const people = [
    { name: "Aroha Ngata", email: "aroha@rata.test" },
    { name: "Tane Rewi", email: "tane@rata.test" },
    { name: "Hana Smith", email: "hana@rata.test" },
  ];

  it("any order: everyone is asked at once; reminders resend new links to those who haven't signed", async () => {
    expect((await send({ signers: people }, viewerCookie)).status).toBe(403);
    expect((await send({ signers: people, title: "" })).status).toBe(400);
    expect((await send({ signers: [...people, people[0]] })).status).toBe(400);
    expect((await send({ signers: people, remindEveryDays: 45 })).status).toBe(400);
    const response = await send({ signers: people, signingOrder: "any_order", remindEveryDays: 3 });
    expect(response.status).toBe(201);
    const { request } = (await response.json()) as { request: Awaited<ReturnType<typeof getSigningRequest>> };
    expect(request.signers.map((signer) => signer.status)).toEqual(["ready", "ready", "ready"]);
    expect((await emails(request.id)).filter((each) => each.purpose === "link").map((each) => each.to_email).sort()).toEqual(people.map((each) => each.email).sort());
    // A viewer doesn't see uploaded documents.
    expect(await as(viewer)((tx) => listSigningRequests(tx))).toEqual([]);

    expect((await sign(request.id, "tane@rata.test", "Tane Rewi")).status).toBe(200);
    const aroha = await tokenFor(request.id, "aroha@rata.test");
    // Not due yet.
    expect(await as(owner)((tx) => sendDueReminders(tx, null, new Date(Date.now() + 2 * 86_400_000)))).toBe(0);
    // Three days on: Aroha and Hana get a reminder with a new link; Tane, who signed, doesn't.
    expect(await as(owner)((tx) => sendDueReminders(tx, null, new Date(Date.now() + 3 * 86_400_000 + 60_000)))).toBe(1);
    const reminders = (await emails(request.id)).filter((each) => each.purpose === "reminder");
    expect(reminders.map((each) => each.to_email).sort()).toEqual(["aroha@rata.test", "hana@rata.test"]);
    expect(reminders[0].subject).toMatch(/^Reminder: Please sign: Lease renewal/);
    expect(reminders[0].body).toContain("http://tohyee.test/sign/");
    // The old link stops working; the new one works.
    expect((await linkGet(aroha)).status).toBe(404);
    expect((await linkGet(await tokenFor(request.id, "aroha@rata.test"))).status).toBe(200);
    // Not again until three more days.
    expect(await as(owner)((tx) => sendDueReminders(tx, null, new Date(Date.now() + 4 * 86_400_000)))).toBe(0);
    expect((await as(owner)((tx) => getSigningRequest(tx, request.id))).events.filter((event) => event.event === "reminded")).toHaveLength(2);

    await sign(request.id, "aroha@rata.test", "Aroha Ngata");
    expect((await sign(request.id, "hana@rata.test", "Hana Smith")).status).toBe(200);
    const done = await as(owner)((tx) => getSigningRequest(tx, request.id));
    expect([done.state, done.signers.every((signer) => signer.status === "signed")]).toEqual(["completed", true]);
    // Done: no more reminders.
    expect(await as(owner)((tx) => sendDueReminders(tx, null, new Date(Date.now() + 20 * 86_400_000)))).toBe(0);
  });

  it("in order: the next person is asked once the one before signs; a decline stops it for everyone", async () => {
    const { request } = (await (await send({ signers: people, signingOrder: "in_order" })).json()) as { request: { id: string } };
    expect((await emails(request.id)).filter((each) => each.purpose === "link").map((each) => each.to_email)).toEqual(["aroha@rata.test"]);
    await sign(request.id, "aroha@rata.test", "Aroha Ngata");
    expect((await emails(request.id)).filter((each) => each.purpose === "link").map((each) => each.to_email)).toEqual(["aroha@rata.test", "tane@rata.test"]);
    // Tane declines: Hana is never asked, and the request is declined.
    const token = await tokenFor(request.id, "tane@rata.test");
    const post = (body: Record<string, unknown>, session?: string) =>
      signRoute.POST(new Request(`http://tohyee.test/api/sign/${ORG}/${token}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-signing-session": session } : {}) }, body: JSON.stringify(body) }), params({ organisationId: ORG, token }));
    await post({ action: "send_code" });
    const code = (await emails(request.id)).filter((each) => each.purpose === "code" && each.to_email === "tane@rata.test").at(-1)!.subject.slice(-6);
    const { session } = (await (await post({ action: "verify_code", code })).json()) as { session: string };
    expect((await post({ action: "decline", reason: "The rent figure is wrong." }, session)).status).toBe(200);
    const declined = await as(owner)((tx) => getSigningRequest(tx, request.id));
    expect([declined.state, declined.signers.map((signer) => signer.status)]).toEqual(["declined", ["signed", "declined", "waiting"]]);
    expect((await emails(request.id)).some((each) => each.to_email === "hana@rata.test")).toBe(false);

    // A new version is a new request; the declined one stays as it was.
    const again = await send({ signers: people, contentBase64: await pdf("Lease (made up), corrected rent") });
    const next = (await again.json()) as { request: { id: string; documentSha256: string } };
    expect(next.request.documentSha256).not.toBe(declined.documentSha256);
  });
});
