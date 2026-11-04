import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as quoteSigningRoute from "@/app/api/quotes/[quoteId]/signing/route";
import * as signRoute from "@/app/api/sign/[organisationId]/[token]/route";
import * as signDocumentRoute from "@/app/api/sign/[organisationId]/[token]/document/route";
import * as signCopyRoute from "@/app/api/sign/[organisationId]/[token]/copy/route";
import * as requestRoute from "@/app/api/signing-requests/[requestId]/route";
import * as fileRoute from "@/app/api/signing-requests/[requestId]/file/route";
import * as voidRoute from "@/app/api/signing-requests/[requestId]/void/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { getCustomerSetup } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import { approveInvoice } from "@/lib/invoices/service";
import { getJournal } from "@/lib/ledger/journals";
import { acceptQuote, acceptQuoteAsSalesOrder, createQuote, declineQuote, finaliseQuote, getQuote } from "@/lib/quotes/service";
import { checkSigningCopy, getSigningRequest, listSigningRequests, signAsMember } from "@/lib/signing/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/** E-signatures with quotes (examples QT9-QT11, decisions 1396-1410). Made-up people and addresses only. */

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describeWithDatabase("signing requests (quotes)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;
  let count = 0;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-that-is-long-enough-123456";
    // Emails are checked as queued; nothing here sends them.
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    owner = await createTestUser("sign-owner@example.com", { serverAdmin: true, displayName: "Hemi" });
    viewer = await createTestUser("sign-viewer@example.com", { displayName: "Vee" });
    outsider = await createTestUser("sign-outsider@example.com", { displayName: "Otto" });
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { email?: boolean } = {}) {
    count += 1;
    const org = `signing-${count}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>, who: SessionUser = owner) => inOrganisation(org, { userId: who.id, email: who.email }, work);
    if (options.email !== false) {
      const smtp = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
      await as((tx) => updateOrganisationEmailSettings(tx, { fromName: "Kobe Paws", fromAddress: "accounts@kobe-paws.test", username: "accounts@kobe-paws.test", password: "made-up-password" }, smtp));
    }
    const terms = (await as((tx) => getCustomerSetup(tx))).paymentTerms;
    const twentieth = terms.find((t) => t.name === "20th of the following month")!.id;
    const kobe = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true, paymentTermId: twentieth, email: "aroha@kobe-cafe.test" }))).contact;
    const quote = async () => {
      const draft = (
        await as((tx) =>
          createQuote(tx, {
            idempotencyKey: key("quote"),
            contactId: kobe.id,
            quoteDate: "2026-07-15",
            expiryDate: "2026-08-14",
            amountsMode: "exclusive",
            lines: [
              { description: "Paw print pendant", quantity: "2", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" },
              { description: "Engraving", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" },
            ],
          }),
        )
      ).quote;
      return (await as((tx) => finaliseQuote(tx, draft.id, { idempotencyKey: key("fin") }))).quote;
    };
    const send = async (quoteId: string, signers: unknown[] = [{ name: "Aroha Ngata", email: "aroha@kobe-cafe.test" }], cookie = ownerCookie) =>
      quoteSigningRoute.POST(apiRequest(`/api/quotes/${quoteId}/signing`, { method: "POST", cookie, body: { organisationId: org, idempotencyKey: key("send"), signers } }), params({ quoteId }));
    const emails = (requestId: string) => as((tx) => tx.query<{ purpose: string; to_email: string; subject: string; body: string }>("select purpose, to_email, subject, body from signing_emails where request_id = $1 order by id", [requestId])).then((r) => r.rows);
    const tokenFrom = (body: string) => body.match(/\/sign\/[^/]+\/([A-Za-z0-9_-]{43})/)![1];
    const link = (token: string, organisationId = org) => ({
      get: (session?: string) => signRoute.GET(new Request(`http://tohyee.test/api/sign/${organisationId}/${token}`, { headers: session ? { "x-signing-session": session } : {} }), params({ organisationId, token })),
      post: (body: Record<string, unknown>, session?: string) =>
        signRoute.POST(
          new Request(`http://tohyee.test/api/sign/${organisationId}/${token}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Made-up Phone Browser", "x-forwarded-for": "203.0.113.9", ...(session ? { "x-signing-session": session } : {}) }, body: JSON.stringify(body) }),
          params({ organisationId, token }),
        ),
      document: (session?: string) => signDocumentRoute.GET(new Request(`http://tohyee.test/api/sign/${organisationId}/${token}/document`, { headers: session ? { "x-signing-session": session } : {} }), params({ organisationId, token })),
    });
    /** Gets the code from the queued email and enters it; returns the session. */
    const verify = async (token: string, requestId: string) => {
      const sent = await link(token).post({ action: "send_code" });
      expect(sent.status).toBe(200);
      const code = (await emails(requestId)).filter((email) => email.purpose === "code").at(-1)!.subject.match(/(\d{6})$/)![1];
      const verified = await link(token).post({ action: "verify_code", code });
      expect(verified.status).toBe(200);
      return ((await verified.json()) as { session: string }).session;
    };
    return { org, as, kobe, quote, send, emails, tokenFrom, link, verify };
  }

  it("QT9: the customer opens the link, proves their email, reads the quote and signs: the quote is accepted with no invoice", async () => {
    const w = await setup();
    const quote = await w.quote();
    const sent = await w.send(quote.id);
    expect(sent.status).toBe(201);
    const { request, emailNote } = (await sent.json()) as { request: Awaited<ReturnType<typeof getSigningRequest>>; emailNote: string | null };
    expect(emailNote).toBeNull();
    expect([request.state, request.sourceKind, request.sourceId, request.title]).toEqual(["sent", "quote", quote.id, `Quote QU-0001 from Test ${w.org}`]);
    // The fingerprint is the SHA-256 of the exact PDF bytes kept.
    const kept = await w.as((tx) => tx.query<{ content: Buffer; sha256: string }>("select content, sha256 from signing_files where id = $1", [request.documentFileId]));
    expect(sha(new Uint8Array(kept.rows[0].content))).toBe(request.documentSha256);
    expect(kept.rows[0].sha256).toBe(request.documentSha256);

    const linkEmail = (await w.emails(request.id)).find((email) => email.purpose === "link")!;
    expect([linkEmail.to_email, linkEmail.subject]).toEqual(["aroha@kobe-cafe.test", `Please sign: Quote QU-0001 from Test ${w.org}`]);
    const token = w.tokenFrom(linkEmail.body);
    // The token is long and random, and only its hash is kept.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await w.as((tx) => tx.query("select 1 from signing_signers where token_hash = $1", [token]))).rowCount).toBe(0);

    // Before the code, the page shows who it's for with the email hidden, and the document is refused.
    const view = (await (await w.link(token).get()).json()) as { verified: boolean; maskedEmail: string; documentSha256: string; signerName: string };
    expect([view.verified, view.maskedEmail, view.signerName, view.documentSha256]).toEqual([false, "a***@kobe-cafe.test", "Aroha Ngata", request.documentSha256]);
    expect((await w.link(token).document()).status).toBe(403);
    expect((await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: request.documentSha256 })).status).toBe(403);

    // A wrong code counts against the tries; the right one starts a session.
    await w.link(token).post({ action: "send_code" });
    const wrong = await w.link(token).post({ action: "verify_code", code: "000000" === (await w.emails(request.id)).find((e) => e.purpose === "code")!.subject.slice(-6) ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toMatch(/isn't right\. 4 tries left/);
    // A second code within a minute is refused.
    expect((await w.link(token).post({ action: "send_code" })).status).toBe(409);
    const code = (await w.emails(request.id)).find((email) => email.purpose === "code")!.subject.slice(-6);
    const session = ((await (await w.link(token).post({ action: "verify_code", code })).json()) as { session: string }).session;
    expect(((await (await w.link(token).get(session)).json()) as { verified: boolean }).verified).toBe(true);

    // Signing before opening the document, without consent, or for a different fingerprint, is refused.
    expect((await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: request.documentSha256 }, session)).status).toBe(400);
    const pdf = await w.link(token).document(session);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(sha(new Uint8Array(await pdf.arrayBuffer()))).toBe(request.documentSha256);
    expect((await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: false, documentSha256: request.documentSha256 }, session)).status).toBe(400);
    expect((await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: "0".repeat(64) }, session)).status).toBe(409);

    const signed = await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: request.documentSha256 }, session);
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ signed: true, complete: true });

    const done = await w.as((tx) => getSigningRequest(tx, request.id));
    expect([done.state, done.signers[0].status, done.signers[0].method, done.signers[0].typedName, done.signers[0].verifiedBy]).toEqual(["completed", "signed", "typed", "Aroha Ngata", "email_code"]);
    const signer = await w.as((tx) => tx.query<{ ip_address: string; user_agent: string; consent_text: string; signed_sha256: string }>("select ip_address, user_agent, consent_text, signed_sha256 from signing_signers where request_id = $1", [request.id]));
    expect(signer.rows[0]).toEqual({ ip_address: "203.0.113.9", user_agent: "Made-up Phone Browser", consent_text: "I agree to sign electronically", signed_sha256: request.documentSha256 });
    expect(done.events.map((event) => event.event)).toEqual(["sent", "link_emailed", "link_opened", "code_sent", "verified", "viewed", "signed", "completed"]);

    // The quote is accepted, with no invoice or sales order yet, and nothing posted.
    const accepted = await w.as((tx) => getQuote(tx, quote.id));
    expect([accepted.status, accepted.invoiceId, accepted.salesOrderId, accepted.acceptedSigningRequestId, accepted.closedByEmail]).toEqual(["accepted", null, null, request.id, "aroha@kobe-cafe.test"]);
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);

    // The link was one-time: it no longer opens. Nor does it for another organisation.
    expect((await w.link(token).get()).status).toBe(404);

    // The signed copy: the original's pages plus a signature page and the certificate, checked by its fingerprint.
    const copy = await fileRoute.GET(apiRequest(`/api/signing-requests/${request.id}/file?organisationId=${w.org}&which=signed`, { cookie: ownerCookie }), params({ requestId: request.id }));
    const signedBytes = new Uint8Array(await copy.arrayBuffer());
    expect(sha(signedBytes)).toBe(done.signedSha256);
    const { extractText } = await import("unpdf");
    const text = (await extractText(new Uint8Array(signedBytes), { mergePages: true })).text;
    expect(text).toContain("Signing certificate");
    expect(text).toContain("Aroha Ngata");
    expect(text).toContain(request.documentSha256.slice(0, 8));
    expect(text).toContain("I agree to sign electronically");
    expect((await w.as((tx) => checkSigningCopy(tx, signedBytes))).result).toBe("signed");
    expect((await w.as((tx) => checkSigningCopy(tx, new Uint8Array(kept.rows[0].content)))).result).toBe("document");
    const tampered = new Uint8Array(signedBytes);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    expect((await w.as((tx) => checkSigningCopy(tx, tampered))).result).toBe("changed");

    // Each signer is emailed a link to download the signed copy.
    const finished = (await w.emails(request.id)).find((email) => email.purpose === "completed" && email.to_email === "aroha@kobe-cafe.test")!;
    const copyToken = finished.body.match(/\/sign\/[^/]+\/([A-Za-z0-9_-]{43})\/copy/)![1];
    const downloaded = await signCopyRoute.GET(new Request("http://tohyee.test/"), params({ organisationId: w.org, token: copyToken }));
    expect(sha(new Uint8Array(await downloaded.arrayBuffer()))).toBe(done.signedSha256);
  });

  it("QT10: an accepted-by-signing quote becomes an invoice (or a sales order), once", async () => {
    const w = await setup();
    const quote = await w.quote();
    const { request } = (await (await w.send(quote.id)).json()) as { request: { id: string; documentSha256: string } };
    const token = w.tokenFrom((await w.emails(request.id)).find((email) => email.purpose === "link")!.body);
    const session = await w.verify(token, request.id);
    await w.link(token).document(session);
    expect((await w.link(token).post({ action: "sign", method: "drawn", typedName: "Aroha Ngata", signaturePng: PNG, consent: true, documentSha256: request.documentSha256 }, session)).status).toBe(200);

    const makeKey = key("make");
    const made = await w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: makeKey, invoiceDate: "2026-07-22" }));
    expect([made.created, made.invoice.status, made.invoice.invoiceDate, made.invoice.dueDate, made.invoice.reference, made.invoice.total]).toEqual([true, "draft", "2026-07-22", "2026-08-20", "QU-0001", "316.25"]);
    expect([made.quote.status, made.quote.invoiceId, made.quote.acceptedSigningRequestId, made.quote.closedByEmail]).toEqual(["accepted", made.invoice.id, request.id, "aroha@kobe-cafe.test"]);
    const again = await w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: makeKey, invoiceDate: "2026-07-22" }));
    expect([again.created, again.invoice.id]).toEqual([false, made.invoice.id]);
    await expect(w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("again"), invoiceDate: "2026-07-22" }))).rejects.toThrow("already accepted, and its invoice is made");
    await expect(w.as((tx) => acceptQuoteAsSalesOrder(tx, quote.id, { idempotencyKey: key("so"), orderDate: "2026-07-22" }))).rejects.toThrow("already accepted");
    const approved = (await w.as((tx) => approveInvoice(tx, made.invoice.id, { idempotencyKey: key("approve") }))).invoice;
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount])).toEqual([
      ["1100", "316.25", "0.00"],
      ["4000", "0.00", "275.00"],
      ["2100", "0.00", "41.25"],
    ]);

    // Another signed quote can become a sales order instead.
    const second = await w.quote();
    const next = (await (await w.send(second.id)).json()) as { request: { id: string; documentSha256: string } };
    const token2 = w.tokenFrom((await w.emails(next.request.id)).find((email) => email.purpose === "link")!.body);
    const session2 = await w.verify(token2, next.request.id);
    await w.link(token2).document(session2);
    await w.link(token2).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: next.request.documentSha256 }, session2);
    const order = await w.as((tx) => acceptQuoteAsSalesOrder(tx, second.id, { idempotencyKey: key("so"), orderDate: "2026-07-23" }));
    expect([order.quote.salesOrderId, order.salesOrder.status]).toEqual([order.salesOrder.id, "draft"]);
    // The database refuses changing a signed-accepted quote any other way.
    await expect(w.as((tx) => tx.query("update quotes set reference = 'x' where id = $1", [second.id]))).rejects.toThrow("can't be changed");
  });

  it("QT11: the customer declines with a reason; accepting in Tohyee voids the open request", async () => {
    const w = await setup();
    const quote = await w.quote();
    const { request } = (await (await w.send(quote.id)).json()) as { request: { id: string } };
    const token = w.tokenFrom((await w.emails(request.id)).find((email) => email.purpose === "link")!.body);
    const session = await w.verify(token, request.id);
    expect((await w.link(token).post({ action: "decline", reason: "" }, session)).status).toBe(400);
    expect((await w.link(token).post({ action: "decline", reason: "We went with a different design." }, session)).status).toBe(200);
    const declined = await w.as((tx) => getSigningRequest(tx, request.id));
    expect([declined.state, declined.signers[0].status, declined.signers[0].declineReason]).toEqual(["declined", "declined", "We went with a different design."]);
    expect((await w.as((tx) => getQuote(tx, quote.id))).status).toBe("declined");
    expect((await w.emails(request.id)).some((email) => email.purpose === "declined" && email.to_email === owner.email)).toBe(true);
    await expect(w.as((tx) => acceptQuote(tx, quote.id, { idempotencyKey: key("a"), invoiceDate: "2026-07-20" }))).rejects.toThrow("already declined");

    // Accepted in Tohyee while out for signing: the request is voided and its link stops working.
    const second = await w.quote();
    const open = (await (await w.send(second.id)).json()) as { request: { id: string } };
    const token2 = w.tokenFrom((await w.emails(open.request.id)).find((email) => email.purpose === "link")!.body);
    // Only one request per quote at a time.
    expect((await w.send(second.id)).status).toBe(409);
    await w.as((tx) => acceptQuote(tx, second.id, { idempotencyKey: key("a"), invoiceDate: "2026-07-20" }));
    const voided = await w.as((tx) => getSigningRequest(tx, open.request.id));
    expect([voided.state, voided.voidReason]).toEqual(["voided", "The quote was accepted in Tohyee."]);
    expect((await w.link(token2).get()).status).toBe(404);
    expect((await w.emails(open.request.id)).some((email) => email.purpose === "voided")).toBe(true);

    // Declined in Tohyee: the same.
    const third = await w.quote();
    const open3 = (await (await w.send(third.id)).json()) as { request: { id: string } };
    await w.as((tx) => declineQuote(tx, third.id, { idempotencyKey: key("d") }));
    expect((await w.as((tx) => getSigningRequest(tx, open3.request.id))).voidReason).toBe("The quote was declined in Tohyee.");
  });

  it("voids, expiry, codes and the one-time link", async () => {
    const w = await setup();
    const quote = await w.quote();
    const { request } = (await (await w.send(quote.id)).json()) as { request: { id: string } };
    const token = w.tokenFrom((await w.emails(request.id)).find((email) => email.purpose === "link")!.body);
    await w.link(token).post({ action: "send_code" });
    const code = (await w.emails(request.id)).find((email) => email.purpose === "code")!.subject.slice(-6);
    // An expired code is refused, even if it's right.
    await w.as((tx) => tx.query("update signing_signers set code_expires_at = now() - interval '1 minute' where request_id = $1", [request.id]));
    const late = await w.link(token).post({ action: "verify_code", code });
    expect(((await late.json()) as { error: string }).error).toMatch(/expired/);
    // Five wrong tries use the code up.
    await w.as((tx) => tx.query("update signing_signers set code_expires_at = now() + interval '10 minutes', code_sent_at = now() - interval '2 minutes' where request_id = $1", [request.id]));
    for (let attempt = 0; attempt < 5; attempt += 1) await w.link(token).post({ action: "verify_code", code: code === "123456" ? "654321" : "123456" });
    const spent = await w.link(token).post({ action: "verify_code", code });
    expect(((await spent.json()) as { error: string }).error).toMatch(/Too many wrong codes/);

    // A viewer can't void; the sender voids with a reason; the link stops working and voiding again is refused.
    const voidAs = (cookie: string, reason: string) => voidRoute.POST(apiRequest(`/api/signing-requests/${request.id}/void`, { method: "POST", cookie, body: { organisationId: w.org, reason } }), params({ requestId: request.id }));
    expect((await voidAs(viewerCookie, "Wrong customer")).status).toBe(403);
    expect((await voidAs(ownerCookie, "")).status).toBe(400);
    expect((await voidAs(ownerCookie, "Wrong customer")).status).toBe(200);
    expect((await w.link(token).get()).status).toBe(404);
    expect((await voidAs(ownerCookie, "Again")).status).toBe(409);
    // The quote is still finalised, so it can be sent again.
    expect((await w.as((tx) => getQuote(tx, quote.id))).status).toBe("finalised");

    // Past its expiry, a request shows as expired and its link stops working.
    const again = (await (await w.send(quote.id)).json()) as { request: { id: string } };
    const token2 = w.tokenFrom((await w.emails(again.request.id)).find((email) => email.purpose === "link")!.body);
    expect((await w.link(token2).get()).status).toBe(200);
    await w.as(async (tx) => {
      // Time passing: the guard (rightly) refuses changing an expiry, so it's lifted for this one test update.
      await tx.query("alter table signing_requests disable trigger signing_requests_guard");
      await tx.query("update signing_requests set expires_at = now() - interval '1 second' where id = $1", [again.request.id]);
      await tx.query("alter table signing_requests enable trigger signing_requests_guard");
    });
    expect((await w.as((tx) => getSigningRequest(tx, again.request.id))).state).toBe("expired");
    expect((await w.link(token2).get()).status).toBe(404);
  });

  it("refuses without email for people outside the organisation; a member signs in Tohyee instead", async () => {
    const w = await setup({ email: false });
    const quote = await w.quote();
    const refused = await w.send(quote.id);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Email isn't set up.*Aroha Ngata/);

    const sent = await w.send(quote.id, [{ name: "Hemi", email: owner.email }]);
    expect(sent.status).toBe(201);
    const { request, emailNote } = (await sent.json()) as { request: Awaited<ReturnType<typeof getSigningRequest>>; emailNote: string };
    expect(emailNote).toMatch(/Email isn't set up/);
    expect(request.signers[0].userId).toBe(owner.id);
    expect(await w.emails(request.id)).toEqual([]);
    const meta = { ip: "198.51.100.4", userAgent: "Made-up Desktop", origin: "http://tohyee.test" };
    const input = { method: "drawn", typedName: "Hemi", signaturePng: PNG, consent: true, documentSha256: request.documentSha256 };
    // Someone else can't sign for them, and they must open it first.
    await expect(w.as((tx) => signAsMember(tx, request.id, input, meta), viewer)).rejects.toThrow("not one of the people asked to sign");
    await expect(w.as((tx) => signAsMember(tx, request.id, input, meta))).rejects.toThrow("Open the document");
    await fileRoute.GET(apiRequest(`/api/signing-requests/${request.id}/file?organisationId=${w.org}`, { cookie: ownerCookie }), params({ requestId: request.id }));
    const done = await w.as((tx) => signAsMember(tx, request.id, input, meta));
    expect([done.state, done.signers[0].method, done.signers[0].verifiedBy]).toEqual(["completed", "drawn", "tohyee_sign_in"]);
    expect((await w.as((tx) => getQuote(tx, quote.id))).status).toBe("accepted");
  });

  it("permissions, other organisations and the append-only records", async () => {
    const w = await setup();
    const other = await setup();
    const quote = await w.quote();
    // A viewer can't send.
    expect((await w.send(quote.id, undefined, viewerCookie)).status).toBe(403);
    const { request } = (await (await w.send(quote.id)).json()) as { request: { id: string; documentFileId: string } };
    const token = w.tokenFrom((await w.emails(request.id)).find((email) => email.purpose === "link")!.body);
    // A viewer sees quote requests; someone not in the organisation doesn't.
    expect((await w.as((tx) => listSigningRequests(tx, { sourceKind: "quote", sourceId: quote.id }), viewer)).map((each) => each.id)).toEqual([request.id]);
    const outsiderCookie = await sessionCookieFor(outsider);
    expect((await requestRoute.GET(apiRequest(`/api/signing-requests/${request.id}?organisationId=${w.org}`, { cookie: outsiderCookie }), params({ requestId: request.id }))).status).toBe(404);
    // A link token only opens in its own organisation.
    expect((await w.link(token, other.org).get()).status).toBe(404);
    expect((await w.link(token, "not-an-org!").get()).status).toBe(404);
    expect((await w.link("x".repeat(43)).get()).status).toBe(404);

    // Nothing about the document, who signs or what happened can be changed or removed.
    await expect(w.as((tx) => tx.query("update signing_files set file_name = 'x.pdf' where id = $1", [request.documentFileId]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("delete from signing_files where id = $1", [request.documentFileId]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("truncate signing_files cascade"))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("update signing_requests set document_sha256 = $2 where id = $1", [request.id, "1".repeat(64)]))).rejects.toThrow("can't be changed after it's sent");
    await expect(w.as((tx) => tx.query("update signing_requests set title = 'Something else' where id = $1", [request.id]))).rejects.toThrow("can't be changed after it's sent");
    await expect(w.as((tx) => tx.query("delete from signing_requests where id = $1", [request.id]))).rejects.toThrow("can't be deleted");
    await expect(w.as((tx) => tx.query("update signing_signers set email = 'someone@else.test' where request_id = $1", [request.id]))).rejects.toThrow("Who signs can't be changed");
    await expect(w.as((tx) => tx.query("delete from signing_signers where request_id = $1", [request.id]))).rejects.toThrow("can't be removed");
    await expect(w.as((tx) => tx.query("update signing_events set event = 'signed' where request_id = $1", [request.id]))).rejects.toThrow();
    await expect(w.as((tx) => tx.query("delete from signing_events where request_id = $1", [request.id]))).rejects.toThrow();
    // A request can't point at a document with another fingerprint.
    await expect(
      w.as((tx) =>
        tx.query(
          "insert into signing_requests (command_source, idempotency_key, request_hash, title, source_kind, document_file_id, document_sha256, signing_order, expires_at, created_by_email) values ('t', 'k', 'h', 'T', 'upload', $1, $2, 'in_order', now() + interval '1 day', 'x')",
          [request.documentFileId, "2".repeat(64)],
        ),
      ),
    ).rejects.toThrow("fingerprint doesn't match");

    // Once signed, the signature can't be changed.
    const session = await w.verify(token, request.id);
    await w.link(token).document(session);
    const sha256 = (await w.as((tx) => getSigningRequest(tx, request.id))).documentSha256;
    await w.link(token).post({ action: "sign", method: "typed", typedName: "Aroha Ngata", consent: true, documentSha256: sha256 }, session);
    await expect(w.as((tx) => tx.query("update signing_signers set typed_name = 'Someone Else' where request_id = $1", [request.id]))).rejects.toThrow("can't be changed");
    await expect(w.as((tx) => tx.query("update signing_requests set status = 'voided', voided_at = now(), void_reason = 'x' where id = $1", [request.id]))).rejects.toThrow("is completed");
  });
});
