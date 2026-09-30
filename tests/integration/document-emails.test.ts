import { deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import * as pdfRoute from "@/app/api/documents/pdf/route";
import * as emailsRoute from "@/app/api/email/documents/route";
import * as retryRoute from "@/app/api/email/documents/[emailId]/retry/route";
import * as prepareRoute from "@/app/api/email/prepare/route";
import * as settingsRoute from "@/app/api/email/settings/route";
import * as testRoute from "@/app/api/email/settings/test/route";
import * as statementsRoute from "@/app/api/email/statements/route";
import * as templatesRoute from "@/app/api/email/templates/route";
import * as msCallbackRoute from "@/app/api/email/microsoft/callback/route";
import * as msConnectRoute from "@/app/api/email/microsoft/connect/route";
import * as msDisconnectRoute from "@/app/api/email/microsoft/disconnect/route";
import * as googleCallbackRoute from "@/app/api/email/google/callback/route";
import * as googleConnectRoute from "@/app/api/email/google/connect/route";
import * as googleDisconnectRoute from "@/app/api/email/google/disconnect/route";
import * as logoRoute from "@/app/api/organisations/[organisationId]/logo/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { setMailFetchForTests } from "@/lib/crm/mail/providers";
import { saveMailSettings } from "@/lib/crm/mail/service";
import { createPerson } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import type { DocumentEmail, StatementRun, StatementRunPreview } from "@/lib/email/documents";
import { processOrganisationOutbox } from "@/lib/email/outbox";
import { approveInvoice, createInvoice, getInvoice } from "@/lib/invoices/service";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { approvePurchaseOrder, createPurchaseOrder } from "@/lib/purchase-orders/service";
import { createQuote, finaliseQuote, getQuote } from "@/lib/quotes/service";
import { getRecordExtras } from "@/lib/records/extras";
import { decryptSecret } from "@/lib/secrets";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/**
 * Emailing documents from the organisation's own account, against a real
 * SMTP server running in this process (smtp-server), so the message that
 * arrives is checked as a mail client would see it: from, reply-to, to and
 * cc, subject, message, and the PDF (read back to find its total).
 */

const SMTP_USER = "accounts@glimmers.test";
const SMTP_PASSWORD = "app-password-1234";
const noContext = undefined as unknown;

type Received = { from: string; recipients: string[]; mail: ParsedMail };

describeWithDatabase("emailing documents", () => {
  let server: TestServer;
  let smtp: SMTPServer;
  let smtpPort = 0;
  let mode: "ok" | "busy" | "reject" = "ok";
  let received: Received[] = [];
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let bookkeeperCookie: string;
  let viewerCookie: string;
  let organisations = 0;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "test-secret-key-for-document-emails-0123456789";
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    owner = await createTestUser("email-owner@example.com", { serverAdmin: true });
    bookkeeper = await createTestUser("email-bookkeeper@example.com");
    viewer = await createTestUser("email-viewer@example.com");
    ownerCookie = await sessionCookieFor(owner);
    bookkeeperCookie = await sessionCookieFor(bookkeeper);
    viewerCookie = await sessionCookieFor(viewer);
    smtp = new SMTPServer({
      secure: false,
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === SMTP_USER && auth.password === SMTP_PASSWORD) return callback(null, { user: SMTP_USER });
        return callback(Object.assign(new Error("Invalid username or password"), { responseCode: 535 }));
      },
      onRcptTo(_address, _session, callback) {
        if (mode === "reject") return callback(Object.assign(new Error("No such user here"), { responseCode: 550 }));
        return callback();
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          if (mode === "busy") return callback(Object.assign(new Error("Too many messages, try again later"), { responseCode: 451 }));
          simpleParser(Buffer.concat(chunks), { keepCidLinks: true }).then(
            (mail) => {
              received.push({
                from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
                recipients: session.envelope.rcptTo.map((rcpt) => rcpt.address),
                mail,
              });
              callback(null, "Queued as TEST123");
            },
            (error: Error) => callback(error),
          );
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    smtpPort = (smtp.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => smtp?.close(() => resolve()));
    await server?.teardown();
  });

  beforeEach(() => {
    mode = "ok";
    received = [];
  });

  async function call(route: (request: Request, context: never) => Promise<Response>, path: string, options: { method?: string; cookie?: string; body?: unknown; context?: unknown } = {}) {
    const response = await route(apiRequest(path, { method: options.method, cookie: options.cookie ?? ownerCookie, body: options.body }), (options.context ?? noContext) as never);
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON (a PDF)
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  async function setup(options: { emailSetUp?: boolean } = {}) {
    organisations += 1;
    const org = `email-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      org,
      bookkeeper.id,
      viewer.id,
    ]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      updateOrganisationSettings(tx, {
        displayName: "Glimmers",
        postalAddress: "PO Box 5, Dunedin",
        gstNumber: "123-456-789",
        paymentDetails: "Pay into 12-3456-7890123-00",
        crmEnabled: true,
      }),
    );
    const kobe = (
      await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true, email: "accounts@kobe.test", postalAddress: "12 George St, Dunedin" }))
    ).contact;
    await as((tx) => createPerson(tx, { contactId: kobe.id, firstName: "Mia", email: "mia@kobe.test", isPrimary: true }));
    const invoice = async (contactId = kobe.id, approve = true) => {
      const draft = (
        await as((tx) =>
          createInvoice(tx, {
            idempotencyKey: key("i"),
            contactId,
            invoiceDate: "2026-07-20",
            dueDate: "2026-08-20",
            amountsMode: "exclusive",
            lines: [
              { description: "Paw print pendant", quantity: "2", unitPrice: "120.00", accountCode: "4000", taxCode: "GST" },
              { description: "Engraving", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" },
            ],
          }),
        )
      ).invoice;
      return approve ? (await as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("ap") }))).invoice : draft;
    };
    if (options.emailSetUp !== false) {
      const saved = await call(settingsRoute.PUT, "/api/email/settings", {
        method: "PUT",
        body: {
          organisationId: org,
          fromName: "Glimmers",
          fromAddress: SMTP_USER,
          replyTo: "jess@glimmers.test",
          host: "127.0.0.1",
          port: smtpPort,
          security: "none",
          username: SMTP_USER,
          password: SMTP_PASSWORD,
        },
      });
      expect(saved.status).toBe(200);
    }
    const organisation = (await getOrganisation(org))!;
    const send = () => processOrganisationOutbox(organisation);
    return { org, as, kobe, invoice, send, organisation };
  }

  async function queue(org: string, body: Record<string, unknown>, cookie = bookkeeperCookie) {
    return call(emailsRoute.POST, "/api/email/documents", { method: "POST", cookie, body: { organisationId: org, idempotencyKey: key("email"), ...body } });
  }

  async function emailsFor(org: string, kind: string, id: string): Promise<DocumentEmail[]> {
    const listed = await call(emailsRoute.GET, `/api/email/documents?organisationId=${org}&kind=${kind}&id=${id}`, { cookie: viewerCookie });
    return listed.json.emails as DocumentEmail[];
  }

  async function pdfText(bytes: Buffer | Uint8Array): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }

  it("keeps the account's password on the server, and only admins see or change the settings", async () => {
    const w = await setup();
    const read = await call(settingsRoute.GET, `/api/email/settings?organisationId=${w.org}`);
    expect(read.status).toBe(200);
    expect(read.text).not.toContain(SMTP_PASSWORD);
    expect(read.json.settings).toMatchObject({ configured: true, hasPassword: true, fromAddress: SMTP_USER, replyTo: "jess@glimmers.test", host: "127.0.0.1", security: "none" });
    const stored = await w.as((tx) => tx.query<{ smtp_password_ciphertext: string }>("select smtp_password_ciphertext from organisation_email_settings"));
    expect(stored.rows[0].smtp_password_ciphertext).toMatch(/^v1:/);
    expect(stored.rows[0].smtp_password_ciphertext).not.toContain(SMTP_PASSWORD);
    expect((await call(settingsRoute.GET, `/api/email/settings?organisationId=${w.org}`, { cookie: bookkeeperCookie })).status).toBe(403);
    const plainToGmail = await call(settingsRoute.PUT, "/api/email/settings", {
      method: "PUT",
      body: { organisationId: w.org, fromName: "Glimmers", host: "smtp.gmail.com", port: 587, security: "none", username: SMTP_USER },
    });
    expect(plainToGmail.status).toBe(400);
    expect(plainToGmail.json.error).toMatch(/only allowed to a mail server on this computer/);
    // A blank password keeps the saved one.
    const kept = await call(settingsRoute.PUT, "/api/email/settings", {
      method: "PUT",
      body: { organisationId: w.org, fromName: "Glimmers Ltd", host: "127.0.0.1", port: smtpPort, security: "none", username: SMTP_USER, password: "" },
    });
    expect(kept.json.settings).toMatchObject({ configured: true, fromName: "Glimmers Ltd", fromAddress: SMTP_USER });

    const tested = await call(testRoute.POST, "/api/email/settings/test", { method: "POST", body: { organisationId: w.org } });
    expect(tested.json).toMatchObject({ ok: true, to: owner.email });
    expect(received).toHaveLength(1);
    expect(received[0].mail.subject).toBe("Test email from Tohyee for Glimmers");
    expect(received[0].mail.from?.value[0]).toMatchObject({ name: "Glimmers Ltd", address: SMTP_USER });
  });

  it("a test email with the wrong password says so in plain English", async () => {
    const w = await setup();
    await call(settingsRoute.PUT, "/api/email/settings", {
      method: "PUT",
      body: { organisationId: w.org, fromName: "Glimmers", host: "127.0.0.1", port: smtpPort, security: "none", username: SMTP_USER, password: "wrong" },
    });
    const tested = await call(testRoute.POST, "/api/email/settings/test", { method: "POST", body: { organisationId: w.org, to: "me@glimmers.test" } });
    expect(tested.json.ok).toBe(false);
    expect(tested.json.error).toMatch(/didn't accept the username and password\. For Gmail, use an app password/);
    expect(tested.json.settings).toMatchObject({ lastTest: { ok: false } });
  });

  it("emails an approved invoice with its PDF, from the organisation's account, and records it in the history", async () => {
    const w = await setup();
    const invoice = await w.invoice();
    const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: bookkeeperCookie });
    expect(prepared.status).toBe(200);
    expect(prepared.json.email).toMatchObject({
      configured: true,
      from: `Glimmers <${SMTP_USER}>`,
      replyTo: "jess@glimmers.test",
      to: ["accounts@kobe.test", "mia@kobe.test"],
      subject: "Invoice INV-0001 from Glimmers",
      attachmentName: "Invoice INV-0001.pdf",
    });
    const body = (prepared.json.email as { body: string }).body;
    expect(body).toContain("Hi Kobe Cafe,");
    expect(body).toContain("Here's invoice INV-0001 for $316.25.");
    expect(body).toContain("The amount due is $316.25, due on 20 Aug 2026.");

    expect((await queue(w.org, { kind: "invoice", id: invoice.id, to: ["accounts@kobe.test"], subject: "x", body: "y" }, viewerCookie)).status).toBe(403);
    const queued = await queue(w.org, {
      kind: "invoice",
      id: invoice.id,
      to: "accounts@kobe.test, mia@kobe.test",
      cc: "jess@glimmers.test",
      subject: "Invoice INV-0001 from Glimmers",
      body,
    });
    expect(queued.status).toBe(201);
    expect(queued.json.email).toMatchObject({ status: "queued", to: ["accounts@kobe.test", "mia@kobe.test"], cc: ["jess@glimmers.test"] });
    // Nothing is "sent" until the SMTP server has taken it.
    expect(received).toHaveLength(0);
    expect(await w.send()).toMatchObject({ sent: 1, failed: 0, retrying: 0, waiting: 0 });

    expect(received).toHaveLength(1);
    const { mail, from, recipients } = received[0];
    expect(from).toBe(SMTP_USER);
    expect(recipients.sort()).toEqual(["accounts@kobe.test", "jess@glimmers.test", "mia@kobe.test"]);
    expect(mail.from?.value[0]).toEqual({ name: "Glimmers", address: SMTP_USER });
    expect(mail.replyTo?.value[0].address).toBe("jess@glimmers.test");
    expect((Array.isArray(mail.to) ? mail.to : [mail.to]).flatMap((to) => to!.value.map((v) => v.address))).toEqual(["accounts@kobe.test", "mia@kobe.test"]);
    expect(mail.subject).toBe("Invoice INV-0001 from Glimmers");
    expect(mail.text).toContain("Here's invoice INV-0001 for $316.25.");
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]).toMatchObject({ filename: "Invoice INV-0001.pdf", contentType: "application/pdf" });
    const text = await pdfText(mail.attachments[0].content);
    expect(text).toContain("Tax invoice");
    expect(text).toContain("INV-0001");
    expect(text).toContain("123-456-789");
    expect(text).toContain("316.25");
    expect(text).toContain("Pay into 12-3456-7890123-00");

    const [sent] = await emailsFor(w.org, "invoice", invoice.id);
    expect(sent).toMatchObject({ status: "sent", attempts: 1, messageId: mail.messageId, requestedByEmail: bookkeeper.email });
    expect(sent.smtpResponse).toContain("Queued as TEST123");
    const history = await w.as((tx) => getRecordExtras(tx, "owner", "invoice", invoice.id));
    const emailed = history.history.find((entry) => entry.eventType === "document_email.sent");
    expect(emailed?.actorEmail).toBe(bookkeeper.email);
    expect(emailed?.summary).toContain("Emailed to accounts@kobe.test, mia@kobe.test (cc jess@glimmers.test) with Invoice INV-0001.pdf");
    // The invoice itself is untouched.
    const after = await w.as((tx) => getInvoice(tx, invoice.id));
    expect([after.status, after.amountDue]).toEqual(["approved", "316.25"]);

    // The same request again (a retried click) doesn't send twice.
    const idempotencyKey = key("same");
    const first = await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Again", body: "Again", idempotencyKey });
    const again = await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Again", body: "Again", idempotencyKey });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect((again.json.email as DocumentEmail).id).toBe((first.json.email as DocumentEmail).id);

    const pdf = await call(pdfRoute.GET, `/api/documents/pdf?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: viewerCookie });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toContain("Invoice INV-0001.pdf");
  });

  it("refuses addresses that could add headers, and takes line breaks out of the subject", async () => {
    const w = await setup();
    const invoice = await w.invoice();
    const injected = await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test\r\nBcc: spy@evil.test", subject: "Hi", body: "Hi" });
    expect(injected.status).toBe(400);
    expect(injected.json.error).toMatch(/"Bcc:" isn't an email address/);
    const named = await queue(w.org, { kind: "invoice", id: invoice.id, to: '"Kobe" <accounts@kobe.test>', subject: "Hi", body: "Hi" });
    expect(named.status).toBe(400);
    const queued = await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Invoice\r\nBcc: spy@evil.test", body: "Hi" });
    expect((queued.json.email as DocumentEmail).subject).toBe("Invoice Bcc: spy@evil.test");
    await w.send();
    expect(received[0].recipients).toEqual(["accounts@kobe.test"]);
    expect(received[0].mail.bcc).toBeUndefined();
    expect(received[0].mail.headers.has("bcc")).toBe(false);
    expect(received[0].mail.attachments.map((a) => a.filename)).toEqual(["Invoice INV-0001.pdf"]);
  });

  it("drafts can't be emailed, and without an email account the dialog says how to set one up", async () => {
    const w = await setup({ emailSetUp: false });
    const draft = await w.invoice(w.kobe.id, false);
    const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${draft.id}`, { cookie: bookkeeperCookie });
    expect(prepared.status).toBe(400);
    expect(prepared.json.error).toBe("Approve the invoice before emailing it.");
    const approved = await w.invoice();
    const notSetUp = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${approved.id}`, { cookie: bookkeeperCookie });
    expect(notSetUp.json.email).toMatchObject({ configured: false, notice: expect.stringContaining("Settings > Email") });
    const refused = await queue(w.org, { kind: "invoice", id: approved.id, to: "accounts@kobe.test", subject: "Hi", body: "Hi" });
    expect(refused.status).toBe(503);
  });

  it("a busy server is tried again later; a refused address fails and can be sent again", async () => {
    const w = await setup();
    const invoice = await w.invoice();
    mode = "busy";
    const queued = await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Invoice", body: "Hello" });
    expect(await w.send()).toMatchObject({ sent: 0, retrying: 1, waiting: 1 });
    let [email] = await emailsFor(w.org, "invoice", invoice.id);
    expect(email).toMatchObject({ status: "queued", attempts: 1 });
    expect(email.lastError).toMatch(/busy or is limiting how much this account sends.*try again later/);
    expect(email.lastError).toContain("Too many messages, try again later");
    mode = "ok";
    // Not due yet: nothing happens.
    expect(await w.send()).toMatchObject({ sent: 0, waiting: 1 });
    expect(await processOrganisationOutbox(w.organisation, { now: new Date(Date.now() + 2 * 60_000) })).toMatchObject({ sent: 1 });
    [email] = await emailsFor(w.org, "invoice", invoice.id);
    expect(email).toMatchObject({ id: (queued.json.email as DocumentEmail).id, status: "sent", attempts: 2 });
    expect(received).toHaveLength(1);
    const history = await w.as((tx) => getRecordExtras(tx, "owner", "invoice", invoice.id));
    expect(history.history.map((entry) => entry.eventType)).toEqual(
      expect.arrayContaining(["document_email.queued", "document_email.retrying", "document_email.sent"]),
    );

    mode = "reject";
    await queue(w.org, { kind: "invoice", id: invoice.id, to: "nobody@kobe.test", subject: "Invoice", body: "Hello" });
    expect(await w.send()).toMatchObject({ failed: 1 });
    const [failed] = await emailsFor(w.org, "invoice", invoice.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, messageId: null });
    expect(failed.lastError).toMatch(/refused the sender or recipient address/);
    const failedHistory = await w.as((tx) => getRecordExtras(tx, "owner", "invoice", invoice.id));
    expect(failedHistory.history.at(-1)?.summary).toMatch(/^Email to nobody@kobe.test failed: The email server refused/);
    // A finished email can't be changed, even in the database.
    await expect(w.as((tx) => tx.query("update document_emails set status = 'sent' where id = $1", [failed.id]))).rejects.toThrow(/finished/);
    await expect(w.as((tx) => tx.query("delete from document_emails where id = $1", [failed.id]))).rejects.toThrow(/can't be deleted/);

    mode = "ok";
    const retried = await call(retryRoute.POST, `/api/email/documents/${failed.id}/retry`, {
      method: "POST",
      cookie: bookkeeperCookie,
      body: { organisationId: w.org, idempotencyKey: key("retry") },
      context: params({ emailId: failed.id }),
    });
    expect(retried.status).toBe(201);
    await w.send();
    expect(received.at(-1)?.recipients).toEqual(["nobody@kobe.test"]);
  });

  it("a wrong password fails straight away instead of being retried", async () => {
    const w = await setup();
    await w.as((tx) =>
      tx.query("update organisation_email_settings set smtp_username = 'someone-else@glimmers.test'"),
    );
    const invoice = await w.invoice();
    await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Invoice", body: "Hello" });
    expect(await w.send()).toMatchObject({ failed: 1, retrying: 0 });
    const [email] = await emailsFor(w.org, "invoice", invoice.id);
    expect(email.lastError).toMatch(/didn't accept the username and password/);
  });

  it("quotes show as sent only from a real send, and keep their status; credit notes and purchase orders go too", async () => {
    const w = await setup();
    const quote = (
      await w.as((tx) =>
        createQuote(tx, {
          idempotencyKey: key("q"),
          contactId: w.kobe.id,
          quoteDate: "2026-07-15",
          expiryDate: "2026-08-14",
          amountsMode: "exclusive",
          lines: [{ description: "Paw print pendant", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).quote;
    const draftPrepare = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=quote&id=${quote.id}`, { cookie: bookkeeperCookie });
    expect(draftPrepare.json.error).toMatch(/Finalise the quote/);
    await w.as((tx) => finaliseQuote(tx, quote.id, { idempotencyKey: key("f") }));
    const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=quote&id=${quote.id}`, { cookie: bookkeeperCookie });
    const email = prepared.json.email as { subject: string; body: string; to: string[] };
    expect(email.subject).toBe("Quote QU-0001 from Glimmers");
    await queue(w.org, { kind: "quote", id: quote.id, to: email.to, subject: email.subject, body: email.body });
    expect((await emailsFor(w.org, "quote", quote.id))[0].status).toBe("queued");
    await w.send();
    expect((await emailsFor(w.org, "quote", quote.id))[0].status).toBe("sent");
    expect((await w.as((tx) => getQuote(tx, quote.id))).status).toBe("finalised");
    expect(await pdfText(received[0].mail.attachments[0].content)).toContain("115.00");

    const creditNote = (
      await w.as((tx) =>
        createCreditNote(tx, {
          idempotencyKey: key("cn"),
          contactId: w.kobe.id,
          creditNoteDate: "2026-07-25",
          amountsMode: "exclusive",
          lines: [{ description: "Engraving refund", quantity: "1", unitPrice: "35.00", accountCode: "4000", taxCode: "GST" }],
        }),
      )
    ).creditNote;
    await w.as((tx) => approveCreditNote(tx, creditNote.id, { idempotencyKey: key("ap") }));
    await queue(w.org, { kind: "credit_note", id: creditNote.id, to: "accounts@kobe.test", subject: "Credit note", body: "Credit" });

    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("s"), name: "Paw Supplies", isSupplier: true, email: "orders@paw.test" }))).contact;
    const order = (
      await w.as((tx) =>
        createPurchaseOrder(tx, {
          idempotencyKey: key("po"),
          contactId: supplier.id,
          orderDate: "2026-07-01",
          deliveryDate: "2026-07-10",
          deliveryAddress: "12 Stuart St, Dunedin 9016",
          amountsMode: "exclusive",
          lines: [{ description: "Silver blanks", quantity: "10", unitPrice: "5.00", accountCode: "5100", taxCode: "GST" }],
        }),
      )
    ).purchaseOrder;
    await w.as((tx) => approvePurchaseOrder(tx, order.id, { idempotencyKey: key("appr") }));
    const poPrepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=purchase_order&id=${order.id}`, { cookie: bookkeeperCookie });
    expect(poPrepared.json.email).toMatchObject({ to: ["orders@paw.test"], subject: "Purchase order PO-0001 from Glimmers", attachmentName: "Purchase order PO-0001.pdf" });
    const po = poPrepared.json.email as { subject: string; body: string; to: string[] };
    await queue(w.org, { kind: "purchase_order", id: order.id, to: po.to, subject: po.subject, body: po.body });
    received = [];
    expect(await w.send()).toMatchObject({ sent: 2 });
    const names = received.map((r) => r.mail.attachments[0].filename).sort();
    expect(names).toEqual(["Credit note CN-0001.pdf", "Purchase order PO-0001.pdf"]);
    const poText = await pdfText(received.find((r) => r.mail.attachments[0].filename === "Purchase order PO-0001.pdf")!.mail.attachments[0].content);
    expect(poText).toContain("Purchase order");
    expect(poText).toContain("57.50");
    expect(poText).toContain("12 Stuart St, Dunedin 9016");
  });

  it("templates are edited in Settings, with placeholders checked", async () => {
    const w = await setup();
    const bad = await call(templatesRoute.PUT, "/api/email/templates", {
      method: "PUT",
      body: { organisationId: w.org, kind: "invoice", subject: "Invoice {number}", body: "Hi {first name}" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/\{first name\} isn't something Tohyee can fill in/);
    expect(
      (await call(templatesRoute.PUT, "/api/email/templates", { method: "PUT", cookie: bookkeeperCookie, body: { organisationId: w.org, kind: "invoice", subject: "a", body: "b" } }))
        .status,
    ).toBe(403);
    const saved = await call(templatesRoute.PUT, "/api/email/templates", {
      method: "PUT",
      body: { organisationId: w.org, kind: "invoice", subject: "{organisation}: invoice {number}", body: "Kia ora {contact}, ${amount due} is due {due date}. Ref {reference}." },
    });
    expect(saved.status).toBe(200);
    const invoice = await w.invoice();
    const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: bookkeeperCookie });
    expect(prepared.json.email).toMatchObject({ subject: "Glimmers: invoice INV-0001", body: "Kia ora Kobe Cafe, $316.25 is due 20 Aug 2026. Ref ." });
  });

  it("emails statements: one customer, or everyone with a balance, with results per customer", async () => {
    const w = await setup();
    await w.invoice();
    const paw = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Paw Walkers", isCustomer: true }))).contact;
    await w.invoice(paw.id);
    const noBalance = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Quiet Customer", isCustomer: true, email: "quiet@example.test" }))).contact;

    const statement = { statementKind: "outstanding", asAt: "2026-07-31" };
    const one = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=statement&id=${w.kobe.id}&statementKind=outstanding&asAt=2026-07-31`, {
      cookie: bookkeeperCookie,
    });
    expect(one.json.email).toMatchObject({
      subject: "Statement from Glimmers",
      attachmentName: "Statement Kobe Cafe 2026-07-31.pdf",
      body: expect.stringContaining("Here's your statement as at 31 Jul 2026. The balance owing is $316.25."),
    });

    const preview = await call(statementsRoute.GET, `/api/email/statements?organisationId=${w.org}&statementKind=outstanding&asAt=2026-07-31`, { cookie: bookkeeperCookie });
    const recipients = (preview.json as unknown as StatementRunPreview).recipients;
    expect(recipients.map((r) => [r.name, r.balance, r.to, r.skipReason])).toEqual([
      ["Kobe Cafe", "316.25", ["accounts@kobe.test", "mia@kobe.test"], null],
      ["Paw Walkers", "316.25", [], "No email address on the contact"],
    ]);
    expect(recipients.some((r) => r.contactId === noBalance.id)).toBe(false);

    const run = await call(statementsRoute.POST, "/api/email/statements", {
      method: "POST",
      cookie: bookkeeperCookie,
      body: { organisationId: w.org, idempotencyKey: key("run"), statement },
    });
    expect(run.status).toBe(201);
    const queuedRun = run.json.run as StatementRun;
    expect(queuedRun.emails.map((e) => [e.contactName, e.status])).toEqual([["Kobe Cafe", "queued"]]);
    expect(queuedRun.skipped.map((s) => s.name)).toEqual(["Paw Walkers"]);
    await w.send();
    expect(received).toHaveLength(1);
    expect(received[0].mail.attachments[0].filename).toBe("Statement Kobe Cafe 2026-07-31.pdf");
    const text = await pdfText(received[0].mail.attachments[0].content);
    expect(text).toContain("Statement");
    expect(text).toContain("Outstanding as at 31 Jul 2026");
    expect(text).toContain("INV-0001");
    expect(text).toContain("316.25");
    const [sent] = await emailsFor(w.org, "statement", w.kobe.id);
    expect(sent).toMatchObject({ status: "sent", batchId: queuedRun.id });
    const contactHistory = await w.as((tx) => getRecordExtras(tx, "owner", "contact", w.kobe.id));
    expect(contactHistory.history.some((entry) => entry.eventType === "document_email.sent")).toBe(true);
  });

  // ------------------------------------------------------------------ logo and HTML emails

  /** A 4 x 2 pixel PNG (red), made here so the test needs no files. */
  function tinyPng(): Buffer {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc = (bytes: Buffer) => {
      let c = 0xffffffff;
      for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const check = Buffer.alloc(4);
      check.writeUInt32BE(crc(body));
      return Buffer.concat([length, body, check]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4, 0);
    header.writeUInt32BE(2, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [220, 40, 60]).flat()]);
    const pixels = deflateSync(Buffer.concat([row, row]));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
  }

  async function uploadLogo(org: string, content: Buffer, fileName = "logo.png", cookie = ownerCookie) {
    return call(logoRoute.PUT, `/api/organisations/${org}/logo`, {
      method: "PUT",
      cookie,
      body: { fileName, fileBase64: content.toString("base64") },
      context: params({ organisationId: org }),
    });
  }

  it("a logo is uploaded in Settings (PNG or JPEG, 512 KB at most) and stored in the organisation's database", async () => {
    const w = await setup();
    const png = tinyPng();
    expect((await uploadLogo(w.org, png, "logo.png", bookkeeperCookie)).status).toBe(403);
    const notImage = await uploadLogo(w.org, Buffer.from("%PDF-1.7 not a logo"), "logo.png");
    expect([notImage.status, notImage.json.error]).toEqual([400, "logo.png isn't a PNG or JPEG image. Save the logo as PNG or JPEG."]);
    const tooBig = await uploadLogo(w.org, Buffer.concat([png, Buffer.alloc(600 * 1024)]), "big.png");
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toMatch(/A logo can be at most 512 KB/);
    const saved = await uploadLogo(w.org, png, "Glimmers logo.png");
    expect(saved.status).toBe(200);
    expect(saved.json.logo).toMatchObject({ fileName: "Glimmers logo.png", contentType: "image/png", width: 4, height: 2, byteSize: png.length });
    const stored = await w.as((tx) => tx.query<{ content: Buffer }>("select content from organisation_logo"));
    expect(Buffer.compare(stored.rows[0].content, png)).toBe(0);
    const image = await call(logoRoute.GET, `/api/organisations/${w.org}/logo`, { cookie: viewerCookie, context: params({ organisationId: w.org }) });
    expect([image.status, image.headers.get("content-type")]).toEqual([200, "image/png"]);
    // On the server's PDFs, top left.
    const invoice = await w.invoice();
    const pdf = await pdfRoute.GET(apiRequest(`/api/documents/pdf?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: viewerCookie }), noContext as never);
    expect(Buffer.from(await pdf.arrayBuffer()).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
    const removed = await call(logoRoute.DELETE, `/api/organisations/${w.org}/logo`, { method: "DELETE", context: params({ organisationId: w.org }) });
    expect(removed.json).toEqual({ logo: null });
    const info = await call(logoRoute.GET, `/api/organisations/${w.org}/logo?info=1`, { cookie: viewerCookie, context: params({ organisationId: w.org }) });
    expect(info.json).toEqual({ logo: null });
  });

  it("emails are HTML with the logo as an inline (CID) image, everything typed escaped, and a plain-text version", async () => {
    const w = await setup();
    await uploadLogo(w.org, tinyPng());
    const invoice = await w.invoice();
    const body = "Hi <b>Kobe</b> & friends,\n\nHere's invoice INV-0001.\nThanks,\nGlimmers";
    await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Invoice INV-0001 <from> Glimmers", body });
    expect(await w.send()).toMatchObject({ sent: 1 });
    const { mail } = received[0];
    // The plain-text version, exactly as typed.
    expect(mail.text?.trim()).toBe(body);
    const html = String(mail.html);
    expect(html).toContain("Hi &lt;b&gt;Kobe&lt;/b&gt; &amp; friends,");
    expect(html).not.toContain("<b>Kobe</b>");
    expect(html).toContain("Here&#39;s invoice INV-0001.<br>Thanks,<br>Glimmers");
    expect(html).toContain("<title>Invoice INV-0001 &lt;from&gt; Glimmers</title>");
    // The summary box and footer.
    expect(html).toMatch(/Invoice number<\/td>\s*<td[^>]*>INV-0001<\/td>/);
    expect(html).toMatch(/Total<\/td>\s*<td[^>]*>\$316\.25<\/td>/);
    expect(html).toMatch(/Due date<\/td>\s*<td[^>]*>20 Aug 2026<\/td>/);
    expect(html).toContain("PO Box 5, Dunedin");
    expect(html).toContain("jess@glimmers.test");
    // No remote images or links: the only image is the inline logo.
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/^cid:logo-[0-9a-f]{16}@tohyee$/);
    expect(html).not.toMatch(/https?:\/\//);
    const inline = mail.attachments.find((attachment) => attachment.contentDisposition === "inline");
    expect(inline).toMatchObject({ contentType: "image/png", cid: sources[0].slice(4), related: true });
    const pdf = mail.attachments.find((attachment) => attachment.contentType === "application/pdf");
    expect(pdf?.filename).toBe("Invoice INV-0001.pdf");
    expect(pdf?.content.toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
  });

  // ------------------------------------------------------------------ Microsoft 365 / Outlook (sign in)

  type GraphState = { sent: Array<{ body: Record<string, unknown>; token: string }>; tokenRequests: URLSearchParams[]; sendStatus: number; tokens: number };

  /** A fake Microsoft sign-in server and Graph: tokens, /me and /me/sendMail. */
  function fakeMicrosoft(state: GraphState) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const target = new URL(url);
      if (target.host === "login.microsoftonline.com" && target.pathname === "/glimmers.onmicrosoft.com/oauth2/v2.0/token") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        state.tokenRequests.push(form);
        state.tokens += 1;
        return Response.json({ access_token: `access-${state.tokens}`, refresh_token: `refresh-${state.tokens}`, expires_in: 3600 });
      }
      if (target.host === "graph.microsoft.com" && target.pathname === "/v1.0/me") {
        return Response.json({ mail: "Accounts@Glimmers.nz", userPrincipalName: "accounts@glimmers.onmicrosoft.com" });
      }
      if (target.host === "graph.microsoft.com" && target.pathname === "/v1.0/me/sendMail" && init?.method === "POST") {
        const token = String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
        if (state.sendStatus !== 202) {
          return Response.json({ error: { code: state.sendStatus === 429 ? "ApplicationThrottled" : "InvalidAuthenticationToken", message: "Try later" } }, { status: state.sendStatus });
        }
        state.sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, token });
        return new Response(null, { status: 202, headers: { "request-id": `req-${state.sent.length}` } });
      }
      return new Response("not found", { status: 404 });
    };
  }

  it("sends through a Microsoft 365 or Outlook mailbox an admin signed in to, with Graph's sendMail", async () => {
    const w = await setup({ emailSetUp: false });
    await uploadLogo(w.org, tinyPng());
    await w.as((tx) => saveMailSettings(tx, { microsoftClientId: "ms-client", microsoftClientSecret: "ms-secret", microsoftTenant: "glimmers.onmicrosoft.com" }));
    const graph: GraphState = { sent: [], tokenRequests: [], sendStatus: 202, tokens: 0 };
    setMailFetchForTests(fakeMicrosoft(graph));
    try {
      // Connecting: admins only; Microsoft's sign-in asks for Mail.Send, and comes back to the email settings.
      expect((await call(msConnectRoute.POST, "/api/email/microsoft/connect", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: w.org } })).status).toBe(403);
      const started = await call(msConnectRoute.POST, "/api/email/microsoft/connect", { method: "POST", body: { organisationId: w.org } });
      const signIn = new URL(started.json.url as string);
      expect(signIn.host + signIn.pathname).toBe("login.microsoftonline.com/glimmers.onmicrosoft.com/oauth2/v2.0/authorize");
      expect(signIn.searchParams.get("scope")).toBe("offline_access User.Read Mail.Send");
      expect(signIn.searchParams.get("redirect_uri")).toBe("http://tohyee.test/api/email/microsoft/callback");
      const state = signIn.searchParams.get("state")!;
      const back = await msCallbackRoute.GET(apiRequest(`/api/email/microsoft/callback?code=code-1&state=${encodeURIComponent(state)}`, { cookie: ownerCookie }));
      expect(back.status).toBe(303);
      expect(back.headers.get("location")).toBe("http://tohyee.test/operations/settings/email?connected=accounts%40glimmers.nz");
      expect(graph.tokenRequests[0].get("grant_type")).toBe("authorization_code");
      expect(graph.tokenRequests[0].get("scope")).toBe("offline_access User.Read Mail.Send");
      // The state is used once.
      const again = await msCallbackRoute.GET(apiRequest(`/api/email/microsoft/callback?code=code-1&state=${encodeURIComponent(state)}`, { cookie: ownerCookie }));
      expect(new URL(again.headers.get("location")!).searchParams.get("error")).toBe("That sign-in link has expired or was already used. Start connecting again.");

      const read = await call(settingsRoute.GET, `/api/email/settings?organisationId=${w.org}`);
      expect(read.json.settings).toMatchObject({
        configured: true,
        sendingMethod: "microsoft",
        fromName: "Glimmers",
        fromAddress: "accounts@glimmers.nz",
        microsoft: { email: "accounts@glimmers.nz", connectedByEmail: owner.email, tokensReadable: true },
        microsoftApp: { clientId: "ms-client", secretSaved: true, tenant: "glimmers.onmicrosoft.com" },
      });
      expect(read.text).not.toContain("refresh-1");
      expect(read.text).not.toContain("access-1");
      const stored = await w.as((tx) => tx.query<{ microsoft_refresh_token_ciphertext: string }>("select microsoft_refresh_token_ciphertext from organisation_email_settings"));
      expect(stored.rows[0].microsoft_refresh_token_ciphertext).toMatch(/^v1:/);

      // Sending an invoice: HTML with the logo inline, the PDF attached, replies to the mailbox.
      const invoice = await w.invoice();
      const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: bookkeeperCookie });
      expect(prepared.json.email).toMatchObject({ configured: true, from: "Glimmers <accounts@glimmers.nz>", replyTo: "accounts@glimmers.nz" });
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", cc: "jess@glimmers.test", subject: "Invoice INV-0001 from Glimmers", body: "Hi Kobe Cafe,\n\nHere's invoice INV-0001." });
      expect(await w.send()).toMatchObject({ sent: 1, failed: 0 });
      expect(received).toHaveLength(0);
      expect(graph.sent).toHaveLength(1);
      expect(graph.sent[0].token).toBe("access-1");
      const message = (graph.sent[0].body as { message: Record<string, unknown>; saveToSentItems: boolean }).message as {
        subject: string;
        body: { contentType: string; content: string };
        toRecipients: unknown[];
        ccRecipients: unknown[];
        replyTo: unknown[];
        attachments: Array<Record<string, unknown>>;
      };
      expect((graph.sent[0].body as { saveToSentItems: boolean }).saveToSentItems).toBe(true);
      expect(message.subject).toBe("Invoice INV-0001 from Glimmers");
      expect(message.body.contentType).toBe("HTML");
      expect(message.body.content).toContain("Here&#39;s invoice INV-0001.");
      expect(message.toRecipients).toEqual([{ emailAddress: { address: "accounts@kobe.test" } }]);
      expect(message.ccRecipients).toEqual([{ emailAddress: { address: "jess@glimmers.test" } }]);
      expect(message.replyTo).toEqual([{ emailAddress: { address: "accounts@glimmers.nz" } }]);
      expect(message.attachments.map((attachment) => [attachment["@odata.type"], attachment.name, attachment.contentType, attachment.isInline])).toEqual([
        ["#microsoft.graph.fileAttachment", "Invoice INV-0001.pdf", "application/pdf", false],
        ["#microsoft.graph.fileAttachment", "logo.png", "image/png", true],
      ]);
      expect(message.body.content).toContain(`src="cid:${message.attachments[1].contentId as string}"`);
      expect(Buffer.from(message.attachments[0].contentBytes as string, "base64").subarray(0, 5).toString()).toBe("%PDF-");
      const [sent] = await emailsFor(w.org, "invoice", invoice.id);
      expect(sent).toMatchObject({ status: "sent", sentVia: "microsoft", messageId: "graph:req-1" });
      expect(sent.smtpResponse).toContain("Accepted by Microsoft Graph (202)");

      // An expired access token is renewed with the refresh token, and the new refresh token replaces the old one.
      await w.as((tx) => tx.query("update organisation_email_settings set microsoft_access_token_expires_at = now() - interval '1 minute'"));
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Again", body: "Again" });
      expect(await w.send()).toMatchObject({ sent: 1 });
      expect(graph.tokenRequests[1].get("grant_type")).toBe("refresh_token");
      expect(graph.tokenRequests[1].get("refresh_token")).toBe("refresh-1");
      expect(graph.tokenRequests[1].get("scope")).toBe("offline_access User.Read Mail.Send");
      expect(graph.sent[1].token).toBe("access-2");
      const rotated = await w.as((tx) => tx.query<{ microsoft_refresh_token_ciphertext: string }>("select microsoft_refresh_token_ciphertext from organisation_email_settings"));
      expect(decryptSecret(rotated.rows[0].microsoft_refresh_token_ciphertext)).toBe("refresh-2");

      // Throttled: tried again later. The sign-in withdrawn: failed, saying to connect again.
      graph.sendStatus = 429;
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Busy", body: "Busy" });
      expect(await w.send()).toMatchObject({ retrying: 1 });
      graph.sendStatus = 401;
      await w.as((tx) => tx.query("update document_emails set next_attempt_at = now() where status = 'queued'"));
      expect(await w.send()).toMatchObject({ failed: 1 });
      const failed = (await emailsFor(w.org, "invoice", invoice.id)).find((email) => email.subject === "Busy")!;
      expect(failed.lastError).toMatch(/^Microsoft didn't accept the mailbox's sign-in\. An admin needs to connect it again in Settings > Email\./);

      // The test email goes the same way.
      graph.sendStatus = 202;
      const tested = await call(testRoute.POST, "/api/email/settings/test", { method: "POST", body: { organisationId: w.org } });
      expect(tested.json).toMatchObject({ ok: true, to: owner.email });
      expect((graph.sent.at(-1)!.body as { message: { subject: string } }).message.subject).toBe("Test email from Tohyee for Glimmers");

      // SMTP details can be saved as well (switching to SMTP), and switched back.
      const smtp = await call(settingsRoute.PUT, "/api/email/settings", {
        method: "PUT",
        body: { organisationId: w.org, fromName: "Glimmers", fromAddress: SMTP_USER, host: "127.0.0.1", port: smtpPort, security: "none", username: SMTP_USER, password: SMTP_PASSWORD },
      });
      expect(smtp.json.settings).toMatchObject({ sendingMethod: "smtp", configured: true, microsoft: { email: "accounts@glimmers.nz" } });
      const switched = await call(settingsRoute.PUT, "/api/email/settings", { method: "PUT", body: { organisationId: w.org, sendingMethod: "microsoft", replyTo: "jess@glimmers.test" } });
      expect(switched.json.settings).toMatchObject({ sendingMethod: "microsoft", replyTo: "jess@glimmers.test", fromAddress: "accounts@glimmers.nz" });

      // Disconnecting forgets the sign-in; the saved SMTP account is used again.
      const disconnected = await call(msDisconnectRoute.POST, "/api/email/microsoft/disconnect", { method: "POST", body: { organisationId: w.org } });
      expect(disconnected.json.settings).toMatchObject({ sendingMethod: "smtp", configured: true, microsoft: null });
      const tokensLeft = await w.as((tx) => tx.query("select 1 from organisation_email_settings where microsoft_refresh_token_ciphertext is not null"));
      expect(tokensLeft.rowCount).toBe(0);
    } finally {
      setMailFetchForTests(null);
    }
  });

  // ------------------------------------------------------------------ Google / Gmail (sign in)

  type GmailState = {
    sent: Array<{ mail: ParsedMail; raw: Buffer; token: string; contentType: string | null }>;
    tokenRequests: URLSearchParams[];
    sendStatus: number;
    sendReason: string;
    tokens: number;
    /** What the token endpoint does with a refresh: renew, renew with a new refresh token, or say access was withdrawn. */
    refresh: "ok" | "rotate" | "revoked";
    grantedScope: string;
  };

  /** A fake Google sign-in server, userinfo and Gmail API (the media upload of users.messages.send). */
  function fakeGoogle(state: GmailState) {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const target = new URL(url);
      if (target.host === "oauth2.googleapis.com" && target.pathname === "/token" && init?.method === "POST") {
        const form = new URLSearchParams(String(init.body ?? ""));
        state.tokenRequests.push(form);
        if (form.get("grant_type") === "refresh_token" && state.refresh === "revoked") {
          return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
        }
        state.tokens += 1;
        const first = form.get("grant_type") === "authorization_code";
        return Response.json({
          access_token: `g-access-${state.tokens}`,
          expires_in: 3599,
          scope: state.grantedScope,
          token_type: "Bearer",
          ...(first || state.refresh === "rotate" ? { refresh_token: `g-refresh-${state.tokens}` } : {}),
        });
      }
      if (target.host === "www.googleapis.com" && target.pathname === "/oauth2/v2/userinfo") {
        return Response.json({ id: "1", email: "Accounts@Glimmers.co.nz", verified_email: true });
      }
      if (target.host === "gmail.googleapis.com" && target.pathname === "/upload/gmail/v1/users/me/messages/send" && init?.method === "POST") {
        expect(target.searchParams.get("uploadType")).toBe("media");
        const headers = new Headers(init.headers);
        if (state.sendStatus !== 200) {
          return Response.json(
            { error: { code: state.sendStatus, message: "Nope", status: "PERMISSION_DENIED", errors: [{ reason: state.sendReason, domain: "global", message: "Nope" }] } },
            { status: state.sendStatus },
          );
        }
        const raw = Buffer.from(init.body as Uint8Array);
        state.sent.push({ mail: await simpleParser(raw, { keepCidLinks: true }), raw, token: String(headers.get("authorization")).replace("Bearer ", ""), contentType: headers.get("content-type") });
        return Response.json({ id: `gm-${state.sent.length}`, threadId: `th-${state.sent.length}`, labelIds: ["SENT"] });
      }
      return new Response("not found", { status: 404 });
    };
  }

  const ALL_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";

  it("sends through a Gmail or Google Workspace mailbox an admin signed in to, with the Gmail API", async () => {
    const w = await setup({ emailSetUp: false });
    await uploadLogo(w.org, tinyPng());
    await w.as((tx) => saveMailSettings(tx, { googleClientId: "g-client.apps.googleusercontent.com", googleClientSecret: "g-secret" }));
    const google: GmailState = { sent: [], tokenRequests: [], sendStatus: 200, sendReason: "", tokens: 0, refresh: "ok", grantedScope: ALL_SCOPES };
    setMailFetchForTests(fakeGoogle(google));
    const connect = async () => {
      const started = await call(googleConnectRoute.POST, "/api/email/google/connect", { method: "POST", body: { organisationId: w.org } });
      return new URL(started.json.url as string);
    };
    const finish = (query: string) => googleCallbackRoute.GET(apiRequest(`/api/email/google/callback?${query}`, { cookie: ownerCookie }));
    try {
      // Connecting: admins only; Google's sign-in asks only for gmail.send and the address, offline, and comes back to the email settings.
      expect((await call(googleConnectRoute.POST, "/api/email/google/connect", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: w.org } })).status).toBe(403);
      const signIn = await connect();
      expect(signIn.host + signIn.pathname).toBe("accounts.google.com/o/oauth2/v2/auth");
      expect(signIn.searchParams.get("client_id")).toBe("g-client.apps.googleusercontent.com");
      expect(signIn.searchParams.get("scope")).toBe(ALL_SCOPES);
      expect(signIn.searchParams.get("access_type")).toBe("offline");
      expect(signIn.searchParams.get("prompt")).toBe("consent");
      expect(signIn.searchParams.has("include_granted_scopes")).toBe(false);
      expect(signIn.searchParams.get("redirect_uri")).toBe("http://tohyee.test/api/email/google/callback");
      const state = signIn.searchParams.get("state")!;
      // A Google sign-in can't be finished at the Microsoft callback (and isn't used up by trying).
      const wrong = await msCallbackRoute.GET(apiRequest(`/api/email/microsoft/callback?code=code-1&state=${encodeURIComponent(state)}`, { cookie: ownerCookie }));
      expect(new URL(wrong.headers.get("location")!).searchParams.get("error")).toBe("That sign-in link has expired or was already used. Start connecting again.");
      expect(google.tokenRequests).toHaveLength(0);
      const back = await finish(`code=code-1&state=${encodeURIComponent(state)}`);
      expect(back.status).toBe(303);
      expect(back.headers.get("location")).toBe("http://tohyee.test/operations/settings/email?connected=accounts%40glimmers.co.nz");
      expect(google.tokenRequests[0].get("grant_type")).toBe("authorization_code");
      expect(google.tokenRequests[0].get("redirect_uri")).toBe("http://tohyee.test/api/email/google/callback");
      expect(google.tokenRequests[0].get("client_secret")).toBe("g-secret");
      const again = await finish(`code=code-1&state=${encodeURIComponent(state)}`);
      expect(new URL(again.headers.get("location")!).searchParams.get("error")).toBe("That sign-in link has expired or was already used. Start connecting again.");

      const read = await call(settingsRoute.GET, `/api/email/settings?organisationId=${w.org}`);
      expect(read.json.settings).toMatchObject({
        configured: true,
        sendingMethod: "google",
        fromName: "Glimmers",
        fromAddress: "accounts@glimmers.co.nz",
        google: { email: "accounts@glimmers.co.nz", connectedByEmail: owner.email, tokensReadable: true },
        googleApp: { clientId: "g-client.apps.googleusercontent.com", secretSaved: true },
        microsoft: null,
      });
      expect(read.text).not.toContain("g-refresh-1");
      expect(read.text).not.toContain("g-access-1");
      expect(read.text).not.toContain("g-secret");
      const stored = await w.as((tx) => tx.query<{ google_refresh_token_ciphertext: string }>("select google_refresh_token_ciphertext from organisation_email_settings"));
      expect(stored.rows[0].google_refresh_token_ciphertext).toMatch(/^v1:/);

      // Sending an invoice: Gmail gets the whole message nodemailer wrote, the same as SMTP's.
      const invoice = await w.invoice();
      const prepared = await call(prepareRoute.GET, `/api/email/prepare?organisationId=${w.org}&kind=invoice&id=${invoice.id}`, { cookie: bookkeeperCookie });
      expect(prepared.json.email).toMatchObject({ configured: true, from: "Glimmers <accounts@glimmers.co.nz>", replyTo: "accounts@glimmers.co.nz" });
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", cc: "jess@glimmers.test", subject: "Invoice INV-0001 from Glimmers", body: "Hi Kobe Cafe,\n\nHere's invoice INV-0001." });
      expect(await w.send()).toMatchObject({ sent: 1, failed: 0 });
      expect(received).toHaveLength(0);
      expect(google.sent).toHaveLength(1);
      const [first] = google.sent;
      expect(first.token).toBe("g-access-1");
      expect(first.contentType).toBe("message/rfc822");
      const mail = first.mail;
      expect(mail.from?.value).toEqual([{ address: "accounts@glimmers.co.nz", name: "Glimmers" }]);
      expect(mail.to && !Array.isArray(mail.to) ? mail.to.value.map((to) => to.address) : null).toEqual(["accounts@kobe.test"]);
      expect(mail.cc && !Array.isArray(mail.cc) ? mail.cc.value.map((cc) => cc.address) : null).toEqual(["jess@glimmers.test"]);
      expect(mail.replyTo?.value[0].address).toBe("accounts@glimmers.co.nz");
      expect(mail.subject).toBe("Invoice INV-0001 from Glimmers");
      expect(mail.text?.trim()).toBe("Hi Kobe Cafe,\n\nHere's invoice INV-0001.");
      const html = String(mail.html);
      expect(html).toContain("Here&#39;s invoice INV-0001.");
      expect(html).toMatch(/Total<\/td>\s*<td[^>]*>\$316\.25<\/td>/);
      const logoSource = [...html.matchAll(/src="cid:([^"]+)"/g)].map((match) => match[1]);
      expect(logoSource).toHaveLength(1);
      expect(mail.attachments.find((file) => file.contentDisposition === "inline")).toMatchObject({ contentType: "image/png", cid: logoSource[0], related: true });
      const pdf = mail.attachments.find((file) => file.contentType === "application/pdf")!;
      expect(pdf.filename).toBe("Invoice INV-0001.pdf");
      expect(await pdfText(pdf.content)).toContain("316.25");
      const [sent] = await emailsFor(w.org, "invoice", invoice.id);
      expect(sent).toMatchObject({ status: "sent", sentVia: "google", messageId: "gmail:gm-1" });
      expect(sent.smtpResponse).toBe("Accepted by the Gmail API (200), message gm-1");

      // An expired access token is renewed with the refresh token; Google usually keeps the same refresh token, and a new one replaces it.
      const expire = () => w.as((tx) => tx.query("update organisation_email_settings set google_access_token_expires_at = now() - interval '1 minute'"));
      const refreshToken = async () =>
        decryptSecret((await w.as((tx) => tx.query<{ google_refresh_token_ciphertext: string }>("select google_refresh_token_ciphertext from organisation_email_settings"))).rows[0].google_refresh_token_ciphertext);
      await expire();
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Again", body: "Again" });
      expect(await w.send()).toMatchObject({ sent: 1 });
      expect(google.tokenRequests[1].get("grant_type")).toBe("refresh_token");
      expect(google.tokenRequests[1].get("refresh_token")).toBe("g-refresh-1");
      expect(google.sent[1].token).toBe("g-access-2");
      expect(await refreshToken()).toBe("g-refresh-1");
      google.refresh = "rotate";
      await expire();
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Rotated", body: "Rotated" });
      expect(await w.send()).toMatchObject({ sent: 1 });
      expect(await refreshToken()).toBe("g-refresh-3");

      // Busy: tried again later. Missing permission: failed, saying to connect again.
      google.sendStatus = 429;
      google.sendReason = "rateLimitExceeded";
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Busy", body: "Busy" });
      expect(await w.send()).toMatchObject({ retrying: 1 });
      google.sendStatus = 403;
      google.sendReason = "insufficientPermissions";
      await w.as((tx) => tx.query("update document_emails set next_attempt_at = now() where status = 'queued'"));
      expect(await w.send()).toMatchObject({ failed: 1 });
      const denied = (await emailsFor(w.org, "invoice", invoice.id)).find((email) => email.subject === "Busy")!;
      expect(denied.lastError).toMatch(/^Google didn't give Tohyee permission to send from this mailbox\. An admin needs to connect it again in Settings > Email/);

      // Access withdrawn (Google says invalid_grant on the refresh): failed straight away, not retried.
      google.sendStatus = 200;
      google.refresh = "revoked";
      await expire();
      await queue(w.org, { kind: "invoice", id: invoice.id, to: "accounts@kobe.test", subject: "Revoked", body: "Revoked" });
      expect(await w.send()).toMatchObject({ failed: 1, retrying: 0 });
      const revoked = (await emailsFor(w.org, "invoice", invoice.id)).find((email) => email.subject === "Revoked")!;
      expect(revoked.lastError).toBe(
        "The Google mailbox's sign-in has expired or access was removed. An admin needs to connect it again in Settings > Email. (oauth2.googleapis.com said 400: Token has been expired or revoked.)",
      );
      const tested = await call(testRoute.POST, "/api/email/settings/test", { method: "POST", body: { organisationId: w.org } });
      expect(tested.json).toMatchObject({ ok: false, error: expect.stringMatching(/^The Google mailbox's sign-in has expired or access was removed\./) });

      // Connecting again, when someone unticks "Send email on your behalf" or cancels, says so.
      google.refresh = "ok";
      google.grantedScope = "openid https://www.googleapis.com/auth/userinfo.email";
      const unticked = await finish(`code=code-2&state=${encodeURIComponent((await connect()).searchParams.get("state")!)}`);
      expect(new URL(unticked.headers.get("location")!).searchParams.get("error")).toBe(
        'Google didn\'t give Tohyee permission to send email from this account. Connect again and tick "Send email on your behalf".',
      );
      const cancelled = await finish(`error=access_denied&state=${encodeURIComponent((await connect()).searchParams.get("state")!)}`);
      expect(new URL(cancelled.headers.get("location")!).searchParams.get("error")).toMatch(/^Google didn't give Tohyee access/);
      google.grantedScope = ALL_SCOPES;
      expect(new URL((await finish(`code=code-3&state=${encodeURIComponent((await connect()).searchParams.get("state")!)}`)).headers.get("location")!).searchParams.get("connected")).toBe(
        "accounts@glimmers.co.nz",
      );

      // The test email goes the same way.
      const retested = await call(testRoute.POST, "/api/email/settings/test", { method: "POST", body: { organisationId: w.org } });
      expect(retested.json).toMatchObject({ ok: true, to: owner.email });
      expect(google.sent.at(-1)!.mail.subject).toBe("Test email from Tohyee for Glimmers");
      expect(google.sent.at(-1)!.mail.text).toContain("It was sent from the Google mailbox accounts@glimmers.co.nz");

      // SMTP details can be saved as well (switching to SMTP), and switched back.
      const smtp = await call(settingsRoute.PUT, "/api/email/settings", {
        method: "PUT",
        body: { organisationId: w.org, fromName: "Glimmers", fromAddress: SMTP_USER, host: "127.0.0.1", port: smtpPort, security: "none", username: SMTP_USER, password: SMTP_PASSWORD },
      });
      expect(smtp.json.settings).toMatchObject({ sendingMethod: "smtp", configured: true, google: { email: "accounts@glimmers.co.nz" } });
      const switched = await call(settingsRoute.PUT, "/api/email/settings", { method: "PUT", body: { organisationId: w.org, sendingMethod: "google", replyTo: "jess@glimmers.test" } });
      expect(switched.json.settings).toMatchObject({ sendingMethod: "google", replyTo: "jess@glimmers.test", fromAddress: "accounts@glimmers.co.nz" });

      // Disconnecting forgets the sign-in; the saved SMTP account is used again.
      expect((await call(googleDisconnectRoute.POST, "/api/email/google/disconnect", { method: "POST", cookie: bookkeeperCookie, body: { organisationId: w.org } })).status).toBe(403);
      const disconnected = await call(googleDisconnectRoute.POST, "/api/email/google/disconnect", { method: "POST", body: { organisationId: w.org } });
      expect(disconnected.json.settings).toMatchObject({ sendingMethod: "smtp", configured: true, google: null });
      const tokensLeft = await w.as((tx) => tx.query("select 1 from organisation_email_settings where google_refresh_token_ciphertext is not null or google_access_token_ciphertext is not null"));
      expect(tokensLeft.rowCount).toBe(0);
      const history = await w.as((tx) => tx.query<{ sent_via: string }>("select distinct sent_via from document_emails where sent_via is not null"));
      expect(history.rows.map((row) => row.sent_via)).toEqual(["google"]);
    } finally {
      setMailFetchForTests(null);
    }
  });
});
