import type { AddressInfo } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as emailSettingsRoute from "@/app/api/email/settings/route";
import * as payItemsRoute from "@/app/api/payroll/pay-items/route";
import * as voidRoute from "@/app/api/payroll/pay-runs/[payRunId]/void/route";
import * as payslipPdfRoute from "@/app/api/payroll/pay-runs/[payRunId]/payslips/[employeeId]/pdf/route";
import * as payslipRoute from "@/app/api/payroll/pay-runs/[payRunId]/payslips/[employeeId]/route";
import * as payslipsRoute from "@/app/api/payroll/pay-runs/[payRunId]/payslips/route";
import { processOrganisationOutbox } from "@/lib/email/outbox";
import { getOrganisation } from "@/lib/organisations/registry";
import type { PayItem } from "@/lib/payroll/pay-items";
import type { PayRun } from "@/lib/payroll/pay-runs";
import { payslipLayout } from "@/lib/payroll/payslip-layout";
import type { Payslip, PayslipSummary } from "@/lib/payroll/payslips";
import { type P5World, setUpP5World } from "../helpers/payroll-p5";
import { apiRequest, describeWithDatabase, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples PSLIP1-PSLIP6 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll —
 * payslips", not yet approved by Jess), through the API routes against
 * PostgreSQL, with the PDF read back and the email sent to a real SMTP
 * server in this process.
 */

const SMTP_USER = "payroll@harbourcafe.test";
const SMTP_PASSWORD = "app-password-5678";

describeWithDatabase("payroll: payslips (PSLIP1-PSLIP6)", () => {
  let server: TestServer;
  let smtp: SMTPServer;
  let w: P5World;
  let run1: PayRun; // PAYRUN-1 (PRUN1)
  let run2: PayRun; // PAYRUN-2 (PRUN3)
  let run3: PayRun; // PAYRUN-3: PRUN2's Sione, weekly
  const received: Array<{ recipients: string[]; mail: ParsedMail }> = [];
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const previousOutbox = process.env.TOHYEE_EMAIL_OUTBOX;

  const payslip = async (user: P5World["ben"], payRunId: string, employeeId: string) =>
    w.call(payslipRoute.GET, user, `/api/payroll/pay-runs/${payRunId}/payslips/${employeeId}`, { context: params({ payRunId, employeeId }) });

  const slip = async (payRunId: string, employeeId: string) => {
    const response = await payslip(w.ben, payRunId, employeeId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.payslip as Payslip;
  };

  const emailPayslips = (user: P5World["ben"], payRunId: string, body: Record<string, unknown> = {}) =>
    w.call(payslipsRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/payslips`, {
      method: "POST",
      body: { idempotencyKey: key("payslips"), ...body },
      context: params({ payRunId }),
    });

  async function pdfText(bytes: Buffer | Uint8Array): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
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
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          simpleParser(Buffer.concat(chunks)).then(
            (mail) => {
              received.push({ recipients: session.envelope.rcptTo.map((rcpt) => rcpt.address), mail });
              callback(null, "Queued as PAYSLIP1");
            },
            (error: Error) => callback(error),
          );
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));

    w = await setUpP5World("payroll-payslips-co", "paypayslips.test", { hemi: "hemi@harbourcafe.test" });
    run1 = await w.approvedRun(w.groups.fortnightly, "2026-09-28");
    expect(run1.reference).toBe("PAYRUN-1");
    run2 = await w.approvedRun(w.groups.fourWeekly, "2026-09-14");
    expect(run2.reference).toBe("PAYRUN-2");
    const added = await w.call(payItemsRoute.POST, w.mere, "/api/payroll/pay-items", {
      method: "POST",
      body: { idempotencyKey: key("item"), name: "Tool allowance", kind: "allowance", accountCode: "6200", taxable: true, countsForKiwiSaver: true },
    });
    expect(added.status).toBe(201);
    const items = Object.fromEntries(
      ((await w.call(payItemsRoute.GET, w.ben, "/api/payroll/pay-items")).body.payItems as PayItem[]).map((item) => [item.name, item]),
    );
    run3 = await w.approvedRun(w.groups.weekly, "2026-10-05", "2026-10-14", {
      [w.people.sione]: [
        { payItemId: items["Ordinary time"].id, quantity: "32" },
        { payItemId: items.Overtime.id, quantity: "4" },
        { payItemId: items["Tool allowance"].id, amount: "25" },
        { payItemId: items.Reimbursement.id, amount: "42.60", description: "Fuel receipt" },
        { payItemId: items["Union fees"].id, amount: "8.50" },
      ],
    });
    expect(run3.reference).toBe("PAYRUN-3");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => smtp?.close(() => resolve()));
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
    if (previousOutbox === undefined) delete process.env.TOHYEE_EMAIL_OUTBOX;
    else process.env.TOHYEE_EMAIL_OUTBOX = previousOutbox;
  });

  const PSLIP1_YTD = {
    gross: "2692.31",
    paye: "555.58",
    studentLoan: "0.00",
    kiwiSaverEmployee: "94.23",
    deductions: "0.00",
    netPay: "2042.50",
    kiwiSaverEmployer: "94.23",
    esct: "28.20",
  };

  describe("what a payslip shows", () => {
    it("PSLIP1: Hemi's payslip for PAYRUN-1", async () => {
      const hemi = await slip(run1.id, w.people.hemi);
      expect(hemi).toMatchObject({
        payRunReference: "PAYRUN-1",
        employer: { name: "Harbour Cafe Ltd", postalAddress: "1 Wharf St, Dunedin" },
        employee: { name: "Hemi Walker", startDate: "2026-04-01" },
        periodStart: "2026-09-28",
        periodEnd: "2026-10-11",
        payDate: "2026-10-14",
        payFrequencyWords: "fortnightly",
        taxCode: "M",
        kiwiSaverEmployeeRate: "3.50",
        kiwiSaverEmployerRate: "3.50",
        earnings: [{ name: "Ordinary time", hours: null, rate: null, amount: "2692.31", notTaxed: false }],
        deductions: [],
        totalHours: null,
        pay: PSLIP1_YTD,
        kiwiSaverEmployerNet: "66.03",
        taxYear: { start: "2026-04-01", end: "2027-03-31" },
        yearToDate: PSLIP1_YTD,
        bankAccount: "**-****-******6-00",
        fileName: "Payslip Hemi Walker 2026-10-14.pdf",
      });
      const layout = payslipLayout(hemi);
      expect(layout.details).toEqual([
        ["Employer", "Harbour Cafe Ltd"],
        ["Employee", "Hemi Walker"],
        ["Started", "1 Apr 2026"],
        ["Pay period", "28 Sep 2026 to 11 Oct 2026 (fortnightly)"],
        ["Pay date", "14 Oct 2026"],
        ["Tax code", "M"],
        ["Paid into", "**-****-******6-00"],
      ]);
      expect(layout.deductions).toEqual([
        ["PAYE (incl. ACC earners' levy)", "555.58"],
        ["KiwiSaver employee (3.50%)", "94.23"],
      ]);
      expect(layout.netPay).toBe("2,042.50");
      expect(layout.employer).toEqual([
        ["KiwiSaver employer (3.50%)", "94.23"],
        ["ESCT (tax on the employer's KiwiSaver)", "28.20"],
        ["Paid to your KiwiSaver", "66.03"],
      ]);
      // The full account number never leaves the server.
      expect(JSON.stringify(hemi)).not.toContain("0123456");

      const aroha = payslipLayout(await slip(run2.id, w.people.aroha));
      expect(aroha.deductions).toEqual([
        ["PAYE (incl. ACC earners' levy)", "589.72"],
        ["Student loan", "197.28"],
        ["KiwiSaver employee (3.50%)", "122.50"],
      ]);
      expect(aroha.netPay).toBe("2,590.50");
    });

    it("PSLIP3: hours, rates, an allowance, a reimbursement and a deduction", async () => {
      const sione = await slip(run3.id, w.people.sione);
      expect(sione.earnings).toEqual([
        { name: "Ordinary time", description: null, hours: "32.00", rate: "22.50", amount: "720.00", notTaxed: false },
        { name: "Overtime", description: null, hours: "4.00", rate: "33.75", amount: "135.00", notTaxed: false },
        { name: "Tool allowance", description: null, hours: null, rate: null, amount: "25.00", notTaxed: false },
        { name: "Reimbursement", description: "Fuel receipt", hours: null, rate: null, amount: "42.60", notTaxed: true },
      ]);
      expect(sione.deductions).toEqual([{ name: "Union fees", description: null, hours: null, rate: null, amount: "8.50", notTaxed: false }]);
      expect(sione.totalHours).toBe("36.00");
      expect(sione.pay).toEqual({
        gross: "922.60",
        paye: "148.40",
        studentLoan: "0.00",
        kiwiSaverEmployee: "35.20",
        deductions: "8.50",
        netPay: "730.50",
        kiwiSaverEmployer: "30.80",
        esct: "5.25",
      });
      const layout = payslipLayout(sione);
      expect(layout.earnings.map((row) => [row.label, row.hours, row.rate, row.amount])).toEqual([
        ["Ordinary time", "32.00", "22.50", "720.00"],
        ["Overtime", "4.00", "33.75", "135.00"],
        ["Tool allowance", "", "", "25.00"],
        ["Reimbursement: Fuel receipt (not taxed)", "", "", "42.60"],
      ]);
      expect(layout.gross).toEqual({ label: "Gross pay", hours: "36.00", rate: "", amount: "922.60" });
      expect(layout.deductions).toEqual([
        ["PAYE (incl. ACC earners' levy)", "148.40"],
        ["KiwiSaver employee (4.00%)", "35.20"],
        ["Union fees", "8.50"],
      ]);
      expect(layout.netPay).toBe("730.50");
    });

    it("PSLIP4: the PDF shows the same", async () => {
      const response = await w.call(payslipPdfRoute.GET, w.ben, `/api/payroll/pay-runs/${run1.id}/payslips/${w.people.hemi}/pdf?download=true`, {
        context: params({ payRunId: run1.id, employeeId: w.people.hemi }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toContain('attachment; filename="Payslip Hemi Walker 2026-10-14.pdf"');
      // The bytes, read as a PDF reader would.
      const handler = await payslipPdfRoute.GET(
        apiRequest(`/api/payroll/pay-runs/${run1.id}/payslips/${w.people.hemi}/pdf?organisationId=${w.org}`, { cookie: await sessionCookieFor(w.ben) }),
        params({ payRunId: run1.id, employeeId: w.people.hemi }) as never,
      );
      expect(handler.status).toBe(200);
      const text = await pdfText(new Uint8Array(await handler.arrayBuffer()));
      for (const expected of ["Payslip", "Harbour Cafe Ltd", "Hemi Walker", "28 Sep 2026 to 11 Oct 2026 (fortnightly)", "14 Oct 2026", "Ordinary time", "2,692.31", "555.58", "94.23", "2,042.50", "28.20", "66.03", "**-****-******6-00", "Year to date (1 Apr 2026 to 31 Mar 2027)"]) {
        expect(text).toContain(expected);
      }
    });
  });

  describe("year to date", () => {
    it("PSLIP2: counts approved pay runs in the tax year up to this one, never voided ones", async () => {
      const second = await w.approvedRun(w.groups.fortnightly, "2026-10-12", "2026-10-28");
      expect(second.reference).toBe("PAYRUN-4");
      const hemi = await slip(second.id, w.people.hemi);
      expect(hemi.yearToDate).toEqual({
        gross: "5384.62",
        paye: "1111.16",
        studentLoan: "0.00",
        kiwiSaverEmployee: "188.46",
        deductions: "0.00",
        netPay: "4085.00",
        kiwiSaverEmployer: "188.46",
        esct: "56.40",
      });
      expect((await slip(second.id, w.people.kiri)).yearToDate).toMatchObject({ gross: "4000.00", paye: "686.00", netPay: "3314.00" });
      expect((await slip(run1.id, w.people.hemi)).yearToDate).toEqual(PSLIP1_YTD);

      const voided = await w.call(voidRoute.POST, w.ben, `/api/payroll/pay-runs/${second.id}/void`, {
        method: "POST",
        body: { idempotencyKey: key("void"), voidDate: "2026-10-28" },
        context: params({ payRunId: second.id }),
      });
      expect(voided.status).toBe(201);
      const gone = await payslip(w.ben, second.id, w.people.hemi);
      expect(gone.status).toBe(409);
      expect(gone.body.error).toBe("PAYRUN-4 is voided, so it has no payslips.");
      const again = await w.approvedRun(w.groups.fortnightly, "2026-10-12", "2026-10-28");
      expect(again.reference).toBe("PAYRUN-5");
      expect((await slip(again.id, w.people.hemi)).yearToDate).toMatchObject({ gross: "5384.62", netPay: "4085.00" });

      const draft = await w.draftRun(w.groups.fortnightly, "2026-10-26", "2026-11-11");
      const fromDraft = await payslip(w.ben, draft.id, w.people.hemi);
      expect(fromDraft.status).toBe(409);
      expect(fromDraft.body.error).toBe(`${draft.reference} is a draft, so it has no payslips. Approve it first.`);
    });
  });

  describe("email and access", () => {
    it("PSLIP5: refused without an email account; Kiri has no email address", async () => {
      const notSetUp = await emailPayslips(w.ben, run1.id);
      expect(notSetUp.status).toBe(503);
      const kiriOnly = await emailPayslips(w.ben, run1.id, { employeeIds: [w.people.kiri] });
      expect(kiriOnly.status).toBe(400);
      expect(kiriOnly.body.error).toBe("Kiri Tane has no email address. Add it under Payroll › Employees.");
    });

    it("PSLIP5: emails Hemi's payslip with its PDF; the message and the audit log have no figures", async () => {
      const saved = await w.call(emailSettingsRoute.PUT, w.jess, "/api/email/settings", {
        method: "PUT",
        body: {
          fromName: "Harbour Cafe Ltd",
          fromAddress: SMTP_USER,
          host: "127.0.0.1",
          port: (smtp.server.address() as AddressInfo).port,
          security: "none",
          username: SMTP_USER,
          password: SMTP_PASSWORD,
        },
      });
      expect(saved.status).toBe(200);
      const idempotencyKey = key("payslips");
      const queued = await emailPayslips(w.ben, run1.id, { idempotencyKey });
      expect(queued.status).toBe(201);
      expect(queued.body.emails).toEqual([expect.objectContaining({ employeeId: w.people.hemi, name: "Hemi Walker", to: ["hemi@harbourcafe.test"], status: "queued" })]);
      expect(queued.body.skipped).toEqual([
        { employeeId: w.people.kiri, name: "Kiri Tane", reason: "Kiri Tane has no email address. Add it under Payroll › Employees." },
      ]);
      const replay = await emailPayslips(w.ben, run1.id, { idempotencyKey });
      expect(replay.status).toBe(200);
      expect((replay.body.emails as unknown[]).length).toBe(1);

      const organisation = (await getOrganisation(w.org))!;
      expect(await processOrganisationOutbox(organisation)).toMatchObject({ sent: 1, failed: 0 });
      expect(received).toHaveLength(1);
      const { mail, recipients } = received[0];
      expect(recipients).toEqual(["hemi@harbourcafe.test"]);
      expect(mail.subject).toBe("Payslip for 14 Oct 2026 from Harbour Cafe Ltd");
      expect(mail.text?.trim()).toBe("Kia ora Hemi,\n\nYour payslip for 28 Sep 2026 to 11 Oct 2026, paid on 14 Oct 2026, is attached.\n\nHarbour Cafe Ltd");
      expect(mail.html || "").not.toContain("2,042.50");
      expect(mail.attachments[0]).toMatchObject({ filename: "Payslip Hemi Walker 2026-10-14.pdf", contentType: "application/pdf" });
      const text = await pdfText(mail.attachments[0].content);
      expect(text).toContain("2,042.50");
      expect(text).toContain("Hemi Walker");

      const listed = await w.call(payslipsRoute.GET, w.ben, `/api/payroll/pay-runs/${run1.id}/payslips`, { context: params({ payRunId: run1.id }) });
      const summaries = listed.body.payslips as PayslipSummary[];
      expect(summaries.map((entry) => [entry.name, entry.netPay, entry.hasEmail, entry.lastEmail?.status ?? null])).toEqual([
        ["Kiri Tane", "1657.00", false, null],
        ["Hemi Walker", "2042.50", true, "sent"],
      ]);

      const events = await w.asUser(w.jess, (tx) =>
        tx.query<{ event_type: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
          "select event_type, entity_type, entity_id, details from audit_events where event_type like 'document_email.%' order by id",
        ),
      );
      expect(events.rows.map((row) => [row.event_type, row.entity_type, row.entity_id, row.details.employeeId, row.details.kind])).toEqual([
        ["document_email.queued", "payroll_pay_run", run1.id, w.people.hemi, "payslip"],
        ["document_email.sent", "payroll_pay_run", run1.id, w.people.hemi, "payslip"],
      ]);
      const everything = JSON.stringify(events.rows);
      for (const figure of ["2042", "2,042", "2692", "555.58", "94.23", "0123456"]) expect(everything).not.toContain(figure);
      const stored = await w.asUser(w.jess, (tx) => tx.query<{ body: string; subject: string }>("select subject, body from document_emails where document_kind = 'payslip'"));
      expect(JSON.stringify(stored.rows)).not.toContain("2,042.50");
    });

    it("PSLIP6: payroll access and the bookkeeper role", async () => {
      for (const user of [w.noah, w.vic]) {
        const seen = await payslip(user, run1.id, w.people.hemi);
        expect(seen.status).toBe(403);
        expect(seen.body.error).toContain(user === w.noah ? "You need payroll access to see payroll" : "This needs the bookkeeper role or higher");
        expect((await emailPayslips(user, run1.id)).status).toBe(403);
        const pdf = await w.call(payslipPdfRoute.GET, user, `/api/payroll/pay-runs/${run1.id}/payslips/${w.people.hemi}/pdf`, {
          context: params({ payRunId: run1.id, employeeId: w.people.hemi }),
        });
        expect(pdf.status).toBe(403);
      }
      expect((await payslip(w.mere, run1.id, w.people.hemi)).status).toBe(200);
      const notOnRun = await payslip(w.ben, run1.id, w.people.aroha);
      expect(notOnRun.status).toBe(404);
      expect(notOnRun.body.error).toBe("That employee isn't on PAYRUN-1.");
    });
  });
});
