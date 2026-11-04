import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as agreementsRoute from "@/app/api/payroll/employees/[employeeId]/agreements/route";
import * as inductionSigningRoute from "@/app/api/farming/safety/induction-signing/route";
import * as signRoute from "@/app/api/sign/[organisationId]/[token]/route";
import * as signDocumentRoute from "@/app/api/sign/[organisationId]/[token]/document/route";
import * as fileRoute from "@/app/api/signing-requests/[requestId]/file/route";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { createEmployee } from "@/lib/payroll/employees";
import { addHazard, saveEmergency } from "@/lib/safety/hazards";
import { addInduction, changeInduction, listSignoffs } from "@/lib/safety/inductions";
import { checkSafetyHistory } from "@/lib/safety/records";
import { getSigningRequest, listSigningRequests, signAsMember } from "@/lib/signing/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** Staff paperwork signed electronically (decisions 1408-1409). Made-up people only. */

async function samplePdf(text: string): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780 });
  return Buffer.from(await doc.save()).toString("base64");
}

describeWithDatabase("signing staff paperwork", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let worker: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  const ORG = "signing-staff-co";
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const emails = (requestId: string) => as(owner)((tx) => tx.query<{ purpose: string; to_email: string; subject: string; body: string }>("select purpose, to_email, subject, body from signing_emails where request_id = $1 order by id", [requestId])).then((r) => r.rows);
  const meta = { ip: "198.51.100.8", userAgent: "Made-up Phone", origin: "http://tohyee.test" };

  async function signByLink(requestId: string, email: string, typedName: string) {
    const link = (await emails(requestId)).find((each) => each.purpose === "link" && each.to_email === email)!;
    const token = link.body.match(/\/sign\/[^/]+\/([A-Za-z0-9_-]{43})/)![1];
    const post = (body: Record<string, unknown>, session?: string) =>
      signRoute.POST(new Request(`http://tohyee.test/api/sign/${ORG}/${token}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-signing-session": session } : {}) }, body: JSON.stringify(body) }), params({ organisationId: ORG, token }));
    await post({ action: "send_code" });
    const code = (await emails(requestId)).filter((each) => each.purpose === "code").at(-1)!.subject.slice(-6);
    const { session } = (await (await post({ action: "verify_code", code })).json()) as { session: string };
    await signDocumentRoute.GET(new Request(`http://tohyee.test/api/sign/${ORG}/${token}/document`, { headers: { "x-signing-session": session } }), params({ organisationId: ORG, token }));
    const sha = (await as(owner)((tx) => getSigningRequest(tx, requestId))).documentSha256;
    return post({ action: "sign", method: "typed", typedName, consent: true, documentSha256: sha }, session);
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    // Emails are checked as queued; nothing here sends them.
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    owner = await createTestUser("staff-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    bookkeeper = await createTestUser("staff-bookkeeper@example.com", { displayName: "Bex" });
    worker = await createTestUser("staff-worker@example.com", { displayName: "Wiremu" });
    ownerCookie = await sessionCookieFor(owner);
    bookkeeperCookie = await sessionCookieFor(bookkeeper);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'farm_worker')", [ORG, bookkeeper.id, worker.id]);
    const smtp = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await as(owner)((tx) => updateOrganisationEmailSettings(tx, { fromName: "Totara Farm", fromAddress: "office@totara-farm.test", username: "office@totara-farm.test", password: "made-up-password" }, smtp));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("an employment agreement goes to the employee and the employer; only payroll access sees it", async () => {
    const employee = (
      await as(owner)((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName: "Aroha",
          lastName: "Ngata",
          email: "aroha@totara-farm.test",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "enrolled",
          kiwiSaverEmployeeRate: "4",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payFrequency: "fortnightly",
          payBasis: "salary",
          annualSalary: "60000.00",
          startDate: "2026-11-10",
        }),
      )
    ).employee;
    const send = (cookie: string, signers: unknown[]) =>
      agreementsRoute.POST(
        apiRequest(`/api/payroll/employees/${employee.id}/agreements`, { method: "POST", cookie, body: { organisationId: ORG, idempotencyKey: key("ea"), fileName: "agreement.pdf", contentBase64: signers.length ? undefined : "", signers } }),
        params({ employeeId: employee.id }),
      );
    // The bookkeeper has no payroll access.
    expect((await send(bookkeeperCookie, [{ name: "Aroha Ngata", email: "aroha@totara-farm.test" }])).status).toBe(403);
    // The employee must be one of the signers.
    const content = await samplePdf("Individual employment agreement (made up)");
    const post = (signers: unknown[]) =>
      agreementsRoute.POST(apiRequest(`/api/payroll/employees/${employee.id}/agreements`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, idempotencyKey: key("ea"), fileName: "agreement.pdf", contentBase64: content, signers, signingOrder: "in_order" } }), params({ employeeId: employee.id }));
    expect((await post([{ name: "Someone Else", email: "someone@totara-farm.test" }])).status).toBe(400);
    // Not a PDF.
    expect((await agreementsRoute.POST(apiRequest(`/api/payroll/employees/${employee.id}/agreements`, { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, idempotencyKey: key("ea"), fileName: "a.pdf", contentBase64: Buffer.from("hello").toString("base64"), signers: [{ name: "Aroha Ngata", email: "aroha@totara-farm.test" }] } }), params({ employeeId: employee.id }))).status).toBe(400);
    const sent = await post([
      { name: "Aroha Ngata", email: "aroha@totara-farm.test", roleLabel: "Employee" },
      { name: "Jess", email: owner.email, roleLabel: "For the employer" },
    ]);
    expect(sent.status).toBe(201);
    const { request } = (await sent.json()) as { request: Awaited<ReturnType<typeof getSigningRequest>> };
    expect([request.sourceKind, request.sourceId, request.title]).toEqual(["employment", employee.id, "Employment agreement, Aroha Ngata"]);
    // The bookkeeper can't see it, through the list or the file.
    expect(await as(bookkeeper)((tx) => listSigningRequests(tx, { sourceKind: "employment" }))).toEqual([]);
    expect((await fileRoute.GET(apiRequest(`/api/signing-requests/${request.id}/file?organisationId=${ORG}`, { cookie: bookkeeperCookie }), params({ requestId: request.id }))).status).toBe(404);
    expect((await signByLink(request.id, "aroha@totara-farm.test", "Aroha Ngata")).status).toBe(200);
    // Then Jess, for the employer, in Tohyee.
    await fileRoute.GET(apiRequest(`/api/signing-requests/${request.id}/file?organisationId=${ORG}`, { cookie: ownerCookie }), params({ requestId: request.id }));
    const done = await as(owner)((tx) => signAsMember(tx, request.id, { method: "typed", typedName: "Jess", consent: true, documentSha256: request.documentSha256 }, meta));
    expect(done.state).toBe("completed");
    const listed = (await (await agreementsRoute.GET(apiRequest(`/api/payroll/employees/${employee.id}/agreements?organisationId=${ORG}`, { cookie: ownerCookie }), params({ employeeId: employee.id }))).json()) as { requests: Array<{ id: string; state: string }> };
    expect(listed.requests.map((each) => [each.id, each.state])).toEqual([[request.id, "completed"]]);
  });

  it("an induction signed electronically adds the sign-off to the farm's records, with what the PDF showed", async () => {
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    const farm = (await as(owner)((tx) => saveFarm(tx, { name: "Totara Flat" })))[0].id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [farm] }));
    const pond = (await as(owner)((tx) => addHazard(tx, { farmId: farm, title: "Effluent pond", level: "high", noGo: true, controls: "Fenced; stay out." }))).recordId;
    await as(owner)((tx) => saveEmergency(tx, { farmId: farm, address: "1 Made-up Road", assemblyPoint: "Cowshed yard" }));
    const induction = await as(owner)((tx) => addInduction(tx, { farmId: farm, title: "Staff induction", audiences: ["worker"], sections: [{ heading: "Bikes", text: "Helmets on. 20 km/h on the races." }] }));
    const send = (cookie: string, body: Record<string, unknown>) =>
      inductionSigningRoute.POST(apiRequest("/api/farming/safety/induction-signing", { method: "POST", cookie, body: { organisationId: ORG, idempotencyKey: key("ind"), farmId: farm, inductionId: induction.recordId, inductionVersion: induction.version, ...body } }), undefined);
    // A stale version is refused.
    expect((await send(ownerCookie, { inductionVersion: 99, signers: [{ name: "Wiremu", email: worker.email }] })).status).toBe(400);
    const response = await send(ownerCookie, { signers: [{ name: "Wiremu", email: worker.email }, { name: "Hana Contractor", email: "hana@made-up.test" }] });
    expect(response.status).toBe(201);
    const { sent } = (await response.json()) as { sent: Array<{ request: Awaited<ReturnType<typeof getSigningRequest>> }> };
    // One request each, and the PDF is the induction with the farm's hazards and emergency details.
    expect(sent.map((each) => each.request.signers.map((signer) => signer.name))).toEqual([["Wiremu"], ["Hana Contractor"]]);
    const pdf = await fileRoute.GET(apiRequest(`/api/signing-requests/${sent[0].request.id}/file?organisationId=${ORG}`, { cookie: ownerCookie }), params({ requestId: sent[0].request.id }));
    const { extractText } = await import("unpdf");
    const text = (await extractText(new Uint8Array(await pdf.arrayBuffer()), { mergePages: true })).text;
    for (const expected of ["Staff induction", "Helmets on", "Effluent pond", "Fenced; stay out.", "1 Made-up Road", "Cowshed yard"]) expect(text).toContain(expected);

    // Wiremu (farm staff) signs in Tohyee; Hana by her link. Each adds a sign-off: one record, not a second one.
    const wiremuRequest = sent[0].request;
    // A farm worker sees their own request, though not others'.
    expect((await as(worker)((tx) => listSigningRequests(tx, { sourceKind: "induction" }))).map((each) => each.id)).toEqual([wiremuRequest.id]);
    await fileRoute.GET(apiRequest(`/api/signing-requests/${wiremuRequest.id}/file?organisationId=${ORG}`, { cookie: await sessionCookieFor(worker) }), params({ requestId: wiremuRequest.id }));
    await as(worker)((tx) => signAsMember(tx, wiremuRequest.id, { method: "typed", typedName: "Wiremu", consent: true, documentSha256: wiremuRequest.documentSha256 }, meta));
    expect((await signByLink(sent[1].request.id, "hana@made-up.test", "Hana Contractor")).status).toBe(200);

    const signoffs = await as(owner)((tx) => listSignoffs(tx, farm));
    expect(signoffs.map((signoff) => [signoff.data.person.name, signoff.data.person.userId, signoff.data.signedHow, signoff.data.inductionVersion, signoff.current])).toEqual([
      ["Hana Contractor", null, "esign", induction.version, true],
      ["Wiremu", worker.id, "esign", induction.version, true],
    ]);
    const wiremu = signoffs.find((signoff) => signoff.data.person.userId === worker.id)!;
    expect([wiremu.data.signingRequestId, wiremu.data.documentSha256, wiremu.data.hazards]).toEqual([wiremuRequest.id, wiremuRequest.documentSha256, [{ id: pond, version: 1 }]]);
    // The safety history's chain still checks out.
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problemsAt).toEqual([]);

    // A "sign again" version afterwards shows they need to sign again, as for any sign-off.
    await as(owner)((tx) => changeInduction(tx, induction.recordId, { expectedVersion: induction.version, sections: [{ heading: "Bikes", text: "Helmets on. 15 km/h now." }], needsResign: true }));
    expect((await as(owner)((tx) => listSignoffs(tx, farm))).every((signoff) => !signoff.current)).toBe(true);
    // Farm staff can't send inductions.
    expect((await send(await sessionCookieFor(worker), { signers: [{ name: "Wiremu", email: worker.email }] })).status).toBe(403);
  });
});
