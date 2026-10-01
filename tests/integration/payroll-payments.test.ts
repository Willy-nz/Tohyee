import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as accessRoute from "@/app/api/payroll/access/route";
import * as irdPaymentVoidRoute from "@/app/api/payroll/ird-payments/[paymentId]/void/route";
import * as irdPaymentsRoute from "@/app/api/payroll/ird-payments/route";
import * as approveRoute from "@/app/api/payroll/pay-runs/[payRunId]/approve/route";
import * as paymentVoidRoute from "@/app/api/payroll/pay-runs/[payRunId]/payments/[paymentId]/void/route";
import * as paymentsRoute from "@/app/api/payroll/pay-runs/[payRunId]/payments/route";
import * as voidRoute from "@/app/api/payroll/pay-runs/[payRunId]/void/route";
import * as payRunsRoute from "@/app/api/payroll/pay-runs/route";
import * as settingsRoute from "@/app/api/payroll/settings/route";
import { listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { reconcileStatementLine, suggestionsForLine, unreconcileStatementLine } from "@/lib/bank/reconcile";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, getJournal, type JournalWithLines } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import type { IrdPayment, IrdPeriodSummary } from "@/lib/payroll/ird-payments";
import type { PayRun } from "@/lib/payroll/pay-runs";
import type { PayRunPayments, WagePayment } from "@/lib/payroll/wage-payments";
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

const ORG = "payroll-payments-co";
const noContext = undefined as unknown;
const b64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Examples PPAY1-PPAY12 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll — paying
 * wages and IRD (examples not yet approved by Jess)"). The tests run in
 * order: PRUN1's pay run is PAYRUN-1 and PRUN3's is PAYRUN-2; wage payments
 * are WAGES-1, WAGES-2... and IRD payments IRD-1, IRD-2...
 */
describeWithDatabase("payroll: paying wages and IRD (PPAY1-PPAY12)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let mere: SessionUser; // admin, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  let noah: SessionUser; // bookkeeper, no payroll access
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const people: Record<string, string> = {};
  let run1 = ""; // PAYRUN-1 (PRUN1)
  let run2 = ""; // PAYRUN-2 (PRUN3)
  const wages: Record<string, WagePayment> = {};
  const ird: Record<string, IrdPayment> = {};

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const call = async (
    handler: (request: Request, context: never) => Promise<Response>,
    user: SessionUser,
    path: string,
    options: { method?: string; body?: Record<string, unknown>; context?: unknown } = {},
  ) => {
    const method = options.method ?? "GET";
    const url = method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path;
    const response = await handler(
      apiRequest(url, {
        method,
        cookie: await sessionCookieFor(user),
        body: options.body === undefined ? undefined : { organisationId: ORG, ...options.body },
      }),
      (options.context ?? noContext) as never,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const pay = (user: SessionUser, payRunId: string, input: Record<string, unknown>) =>
    call(paymentsRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/payments`, {
      method: "POST",
      body: { idempotencyKey: key("wages"), bankAccountCode: "1000", paymentDate: "2026-10-14", ...input },
      context: params({ payRunId }),
    });

  const payments = async (user: SessionUser, payRunId: string) => {
    const response = await call(paymentsRoute.GET, user, `/api/payroll/pay-runs/${payRunId}/payments`, { context: params({ payRunId }) });
    expect(response.status).toBe(200);
    return response.body.payments as PayRunPayments;
  };

  const voidWages = (user: SessionUser, payRunId: string, paymentId: string, voidDate: string) =>
    call(paymentVoidRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/payments/${paymentId}/void`, {
      method: "POST",
      body: { idempotencyKey: key("wages-void"), voidDate },
      context: params({ payRunId, paymentId }),
    });

  const period = async (user: SessionUser, periodStart: string) => {
    const response = await call(irdPaymentsRoute.GET, user, `/api/payroll/ird-payments?periodStart=${periodStart}`);
    expect(response.status).toBe(200);
    return response.body.period as IrdPeriodSummary;
  };

  const payIrd = (user: SessionUser, input: Record<string, unknown>) =>
    call(irdPaymentsRoute.POST, user, "/api/payroll/ird-payments", {
      method: "POST",
      body: { idempotencyKey: key("ird"), bankAccountCode: "1000", periodStart: "2026-10-01", ...input },
    });

  const voidIrd = (user: SessionUser, paymentId: string, voidDate: string) =>
    call(irdPaymentVoidRoute.POST, user, `/api/payroll/ird-payments/${paymentId}/void`, {
      method: "POST",
      body: { idempotencyKey: key("ird-void"), voidDate },
      context: params({ paymentId }),
    });

  const voidRun = (user: SessionUser, payRunId: string, voidDate: string) =>
    call(voidRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/void`, {
      method: "POST",
      body: { idempotencyKey: key("run-void"), voidDate },
      context: params({ payRunId }),
    });

  const journal = (id: string) => asUser(jess, (tx) => getJournal(tx, id));
  const lines = (posted: JournalWithLines) => posted.lines.map((line) => [line.accountCode, line.description, line.debitAmount, line.creditAmount]);
  const owing = (summary: IrdPeriodSummary) => Object.fromEntries(summary.liabilities.map((entry) => [entry.liability, entry.owing]));

  const giveAccess = async (to: SessionUser) => {
    const response = await accessRoute.PUT(
      apiRequest("/api/payroll/access", {
        method: "PUT",
        cookie: await sessionCookieFor(jess),
        body: { organisationId: ORG, userId: to.id, hasPayrollAccess: true },
      }),
      noContext,
    );
    expect(response.status).toBe(200);
  };

  const employee = async (overrides: Record<string, unknown>) =>
    (
      await asUser(jess, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "salary",
          startDate: "2026-04-01",
          bankAccount: "03-1234-0123456-00",
          ...overrides,
        }),
      )
    ).employee.id;

  const approvedRun = async (payGroupId: string, periodStart: string) => {
    const created = await call(payRunsRoute.POST, ben, "/api/payroll/pay-runs", {
      method: "POST",
      body: { idempotencyKey: key("payrun"), payGroupId, periodStart, payDate: "2026-10-14" },
    });
    expect(created.status).toBe(201);
    const payRunId = (created.body.payRun as PayRun).id;
    const approved = await call(approveRoute.POST, ben, `/api/payroll/pay-runs/${payRunId}/approve`, {
      method: "POST",
      body: { idempotencyKey: key("approve") },
      context: params({ payRunId }),
    });
    expect(approved.status).toBe(201);
    return approved.body.payRun as PayRun;
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@paypayments.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@paypayments.test");
    ben = await createTestUser("ben@paypayments.test");
    noah = await createTestUser("noah@paypayments.test");
    vic = await createTestUser("vic@paypayments.test");
    for (const [user, role] of [
      [mere, "admin"],
      [ben, "bookkeeper"],
      [noah, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    await giveAccess(mere);
    await giveAccess(ben);
    const group = async (name: string, payFrequency: string) =>
      (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name, payFrequency }))).group.id;
    const fortnightly = await group("Fortnightly salaries", "fortnightly");
    const fourWeekly = await group("Four-weekly", "four_weekly");
    people.hemi = await employee({
      firstName: "Hemi",
      lastName: "Walker",
      payFrequency: "fortnightly",
      annualSalary: "70000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      payGroupId: fortnightly,
    });
    people.kiri = await employee({ firstName: "Kiri", lastName: "Tane", payFrequency: "fortnightly", annualSalary: "52000.00", payGroupId: fortnightly });
    people.aroha = await employee({
      firstName: "Aroha",
      lastName: "Ngata",
      taxCode: "M SL",
      studentLoan: true,
      payFrequency: "four_weekly",
      annualSalary: "45500.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "17.5",
      payGroupId: fourWeekly,
    });
    const first = await approvedRun(fortnightly, "2026-09-28");
    expect(first.reference).toBe("PAYRUN-1");
    expect(first.totals).toMatchObject({ netPay: "3699.50", paye: "898.58", esct: "28.20" });
    run1 = first.id;
    const second = await approvedRun(fourWeekly, "2026-09-14");
    expect(second.reference).toBe("PAYRUN-2");
    expect(second.totals).toMatchObject({ netPay: "2590.50", paye: "589.72", studentLoan: "197.28", esct: "21.35" });
    run2 = second.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  describe("paying wages", () => {
    it("PPAY1: refuses paying more than the net pay, or before the pay date", async () => {
      const before = await payments(ben, run1);
      expect(before).toMatchObject({ reference: "PAYRUN-1", netPay: "3699.50", paid: "0.00", unpaid: "3699.50", paidAs: null, payments: [] });
      const tooMuch = await pay(ben, run1, { amount: "3699.51" });
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.body.error).toBe("That's more than the 3,699.50 of net pay left to pay on PAYRUN-1.");
      const early = await pay(ben, run1, { amount: "3699.50", paymentDate: "2026-10-13" });
      expect(early.status).toBe(400);
      expect(early.body.error).toBe("The payment date can't be before PAYRUN-1's pay date (2026-10-14).");
      const notBank = await pay(ben, run1, { amount: "3699.50", bankAccountCode: "6200" });
      expect(notBank.status).toBe(400);
      expect(notBank.body.error).toContain("isn't a bank account");
    });

    it("PPAY1: one payment of 3,699.50 posts WAGES-1: Dr 2240 Wages payable, Cr 1000", async () => {
      const idempotencyKey = key("wages");
      const paid = await pay(ben, run1, { amount: "3699.50", idempotencyKey });
      expect(paid.status).toBe(201);
      const payment = paid.body.payment as WagePayment;
      expect(payment).toMatchObject({
        reference: "WAGES-1",
        payRunReference: "PAYRUN-1",
        employeeId: null,
        employeeName: null,
        paymentDate: "2026-10-14",
        bankAccountCode: "1000",
        amount: "3699.50",
        status: "active",
      });
      wages.one = payment;
      const posted = await journal(payment.journalId);
      expect(posted).toMatchObject({
        reference: "WAGES-1",
        postingDate: "2026-10-14",
        origin: "payroll",
        description: "Wages paid for pay run PAYRUN-1: Fortnightly salaries, 2026-09-28 to 2026-10-11",
      });
      expect(lines(posted)).toEqual([
        ["2240", "Net pay", "3699.50", "0.00"],
        ["1000", "Net pay", "0.00", "3699.50"],
      ]);
      expect(await payments(ben, run1)).toMatchObject({ paid: "3699.50", unpaid: "0.00", paidAs: "whole" });
      const retry = await pay(ben, run1, { amount: "3699.50", idempotencyKey });
      expect(retry.status).toBe(200);
      expect((retry.body.payment as WagePayment).id).toBe(payment.id);
      const again = await pay(ben, run1, { amount: "0.01" });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("PAYRUN-1's net pay is already paid in full.");
      // The journal can't be corrected in the ledger.
      await expect(
        asUser(jess, (tx) =>
          correctJournal(tx, { idempotencyKey: key("fix"), originalJournalId: payment.journalId, postingDate: "2026-10-20", reference: "FIX", lines: [] }),
        ),
      ).rejects.toThrow("was posted by a payroll payment (WAGES-1), so it can't be corrected in the ledger. To undo it, void the payment under Payroll.");
    });

    it("PPAY3: a pay run with wage payments can't be voided; voiding WAGES-1 posts its exact reversal", async () => {
      const refused = await voidRun(jess, run1, "2026-10-20");
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("PAYRUN-1 has wage payments (WAGES-1). Void them first.");
      // The database refuses it too.
      await expect(
        asUser(jess, (tx) => tx.query("update payroll_pay_runs set status = 'voided', void_date = '2026-10-20', void_journal_id = approval_journal_id, voided_at = now() where id = $1", [run1])),
      ).rejects.toThrow(/wage payments/);

      const early = await voidWages(ben, run1, wages.one.id, "2026-10-13");
      expect(early.status).toBe(400);
      expect(early.body.error).toBe("The void date can't be before the payment date (2026-10-14).");
      const voided = await voidWages(ben, run1, wages.one.id, "2026-10-14");
      expect(voided.status).toBe(201);
      const payment = voided.body.payment as WagePayment;
      expect(payment).toMatchObject({ status: "voided", voidDate: "2026-10-14" });
      const reversal = await journal(payment.voidJournalId!);
      expect(reversal).toMatchObject({ reference: "VOID-WAGES-1", correctionKind: "reversal", relatedJournalId: wages.one.journalId });
      expect(lines(reversal)).toEqual([
        ["2240", "Net pay", "0.00", "3699.50"],
        ["1000", "Net pay", "3699.50", "0.00"],
      ]);
      expect(await payments(ben, run1)).toMatchObject({ paid: "0.00", unpaid: "3699.50", paidAs: null });
      const twice = await voidWages(ben, run1, wages.one.id, "2026-10-15");
      expect(twice.status).toBe(409);
      expect(twice.body.error).toBe("WAGES-1 has already been voided.");
    });

    it("PPAY2: paying each employee separately; journals never name them; no mixing", async () => {
      const tooMuch = await pay(ben, run1, { amount: "2042.51", employeeId: people.hemi });
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.body.error).toBe("That's more than the 2,042.50 of Hemi Walker's net pay left to pay on PAYRUN-1.");
      const notOnRun = await pay(ben, run1, { amount: "10.00", employeeId: people.aroha });
      expect(notOnRun.status).toBe(400);
      expect(notOnRun.body.error).toBe("That employee isn't on PAYRUN-1.");

      const hemi = await pay(ben, run1, { amount: "2042.50", employeeId: people.hemi });
      expect(hemi.status).toBe(201);
      wages.hemi = hemi.body.payment as WagePayment;
      expect(wages.hemi).toMatchObject({ reference: "WAGES-2", employeeId: people.hemi, employeeName: "Hemi Walker", amount: "2042.50" });
      const posted = await journal(wages.hemi.journalId);
      expect(posted.description).toBe("Wages paid for pay run PAYRUN-1: Fortnightly salaries, 2026-09-28 to 2026-10-11 (one employee)");
      expect(lines(posted)).toEqual([
        ["2240", "Net pay", "2042.50", "0.00"],
        ["1000", "Net pay", "0.00", "2042.50"],
      ]);
      expect(JSON.stringify(posted)).not.toMatch(/Hemi|Walker/);

      const mixed = await pay(ben, run1, { amount: "1657.00" });
      expect(mixed.status).toBe(409);
      expect(mixed.body.error).toBe("PAYRUN-1 is being paid per employee. Pay the rest per employee too, or void those payments first.");

      const kiri = await pay(ben, run1, { amount: "1657.00", employeeId: people.kiri });
      expect(kiri.status).toBe(201);
      wages.kiri = kiri.body.payment as WagePayment;
      expect(wages.kiri.reference).toBe("WAGES-3");
      const listed = await payments(ben, run1);
      expect(listed).toMatchObject({ paid: "3699.50", unpaid: "0.00", paidAs: "per_employee" });
      expect(listed.employees.map((entry) => [entry.name, entry.netPay, entry.paid, entry.unpaid])).toEqual([
        ["Kiri Tane", "1657.00", "1657.00", "0.00"],
        ["Hemi Walker", "2042.50", "2042.50", "0.00"],
      ]);
      expect(listed.payments.map((entry) => [entry.reference, entry.status])).toEqual([
        ["WAGES-3", "active"],
        ["WAGES-2", "active"],
        ["WAGES-1", "voided"],
      ]);

      const whole = await pay(ben, run2, { amount: "2590.50" });
      expect(whole.status).toBe(201);
      wages.aroha = whole.body.payment as WagePayment;
      expect(wages.aroha.reference).toBe("WAGES-4");
      const perEmployee = await pay(ben, run2, { amount: "0.01", employeeId: people.aroha });
      expect(perEmployee.status).toBe(409);
      expect(perEmployee.body.error).toBe("PAYRUN-2 is being paid as a whole. Pay the rest as a whole too, or void those payments first.");
    });
  });

  describe("paying IRD", () => {
    it("PPAY4: October 2026 owes the deductions of PAYRUN-1 and PAYRUN-2, due Friday 20 Nov 2026", async () => {
      const october = await period(ben, "2026-10-01");
      expect(october).toMatchObject({
        frequency: "monthly",
        start: "2026-10-01",
        end: "2026-10-31",
        dueDate: "2026-11-20",
        dueWeekday: "Friday",
        payBy: "2026-11-20",
        totalFromPayRuns: "2119.04",
        totalPaid: "0.00",
        totalOwing: "2119.04",
      });
      expect(october.liabilities.map((entry) => [entry.liability, entry.label, entry.accountCode, entry.fromPayRuns, entry.paid, entry.owing])).toEqual([
        ["paye", "PAYE (incl. ACC earners' levy)", "2200", "1488.30", "0.00", "1488.30"],
        ["student_loan", "Student loan", "2230", "197.28", "0.00", "197.28"],
        ["kiwisaver", "KiwiSaver (employee and employer)", "2210", "383.91", "0.00", "383.91"],
        ["esct", "ESCT", "2220", "49.55", "0.00", "49.55"],
      ]);
      expect(october.payRuns.map((entry) => entry.reference)).toEqual(["PAYRUN-1", "PAYRUN-2"]);
      const list = await call(irdPaymentsRoute.GET, ben, "/api/payroll/ird-payments");
      expect(list.status).toBe(200);
      expect(list.body.frequency).toBe("monthly");
      expect((list.body.periods as IrdPeriodSummary[]).map((entry) => [entry.start, entry.totalOwing])).toEqual([["2026-10-01", "2119.04"]]);
    });

    it("PPAY5: a part payment of PAYE, then the rest in one payment", async () => {
      const first = await payIrd(ben, { paymentDate: "2026-11-19", lines: [{ liability: "paye", amount: "1000.00" }] });
      expect(first.status).toBe(201);
      ird.one = first.body.payment as IrdPayment;
      expect(ird.one).toMatchObject({ reference: "IRD-1", periodStart: "2026-10-01", periodEnd: "2026-10-31", amount: "1000.00", status: "active" });
      const posted = await journal(ird.one.journalId);
      expect(posted).toMatchObject({ reference: "IRD-1", origin: "payroll", description: "IRD payroll payment for 2026-10-01 to 2026-10-31" });
      expect(lines(posted)).toEqual([
        ["2200", "PAYE", "1000.00", "0.00"],
        ["1000", "IRD payroll payment", "0.00", "1000.00"],
      ]);
      const after = await period(ben, "2026-10-01");
      expect(owing(after)).toEqual({ paye: "488.30", student_loan: "197.28", kiwisaver: "383.91", esct: "49.55" });
      expect(after.totalOwing).toBe("1119.04");

      // PPAY6: each liability is checked on its own.
      const over = await payIrd(ben, {
        paymentDate: "2026-11-20",
        lines: [
          { liability: "paye", amount: "488.31" },
          { liability: "student_loan", amount: "197.27" },
        ],
      });
      expect(over.status).toBe(400);
      expect(over.body.error).toBe("That's more than the 488.30 of PAYE owing for 2026-10-01 to 2026-10-31.");

      const rest = await payIrd(ben, {
        paymentDate: "2026-11-20",
        lines: [
          { liability: "paye", amount: "488.30" },
          { liability: "student_loan", amount: "197.28" },
          { liability: "kiwisaver", amount: "383.91" },
          { liability: "esct", amount: "49.55" },
        ],
      });
      expect(rest.status).toBe(201);
      ird.two = rest.body.payment as IrdPayment;
      expect(ird.two).toMatchObject({ reference: "IRD-2", amount: "1119.04" });
      expect(lines(await journal(ird.two.journalId))).toEqual([
        ["2200", "PAYE", "488.30", "0.00"],
        ["2230", "Student loan", "197.28", "0.00"],
        ["2210", "KiwiSaver", "383.91", "0.00"],
        ["2220", "ESCT", "49.55", "0.00"],
        ["1000", "IRD payroll payment", "0.00", "1119.04"],
      ]);
      const paidUp = await period(ben, "2026-10-01");
      expect(paidUp).toMatchObject({ totalPaid: "2119.04", totalOwing: "0.00" });
      expect(paidUp.payments.map((entry) => entry.reference)).toEqual(["IRD-2", "IRD-1"]);
    });

    it("PPAY6: overpaying, empty periods and periods that aren't IRD's are refused", async () => {
      const over = await payIrd(ben, { paymentDate: "2026-11-20", lines: [{ liability: "esct", amount: "0.01" }] });
      expect(over.status).toBe(400);
      expect(over.body.error).toBe("That's more than the 0.00 of ESCT owing for 2026-10-01 to 2026-10-31.");
      const empty = await payIrd(ben, { periodStart: "2026-11-01", paymentDate: "2026-11-20", lines: [{ liability: "paye", amount: "1.00" }] });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toBe("Nothing is owing to IRD for 2026-11-01 to 2026-11-30.");
      const odd = await payIrd(ben, { periodStart: "2026-10-14", paymentDate: "2026-11-20", lines: [{ liability: "paye", amount: "1.00" }] });
      expect(odd.status).toBe(400);
      expect(odd.body.error).toBe("For monthly IRD payments the period starts on the 1st of a month.");
      const early = await payIrd(ben, { paymentDate: "2026-09-30", lines: [{ liability: "paye", amount: "1.00" }] });
      expect(early.status).toBe(400);
      expect(early.body.error).toBe("The payment date can't be before the period starts (2026-10-01).");
      const unknown = await payIrd(ben, { paymentDate: "2026-11-20", lines: [{ liability: "union_fees", amount: "1.00" }] });
      expect(unknown.status).toBe(400);
    });

    it("PPAY7: wage and IRD payments are suggested and matched on the bank statement; matched payments can't be voided", async () => {
      const accountId = (await asUser(jess, (tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
      const csv = "Date,Amount,Payee,Particulars,Code,Reference\n14/10/2026,-2042.50,WAGES,,,\n14/10/2026,-1657.00,WAGES,,,\n20/11/2026,-1119.04,INLAND REVENUE,,,\n";
      await asUser(ben, (tx) => importStatementFile(tx, accountId, { idempotencyKey: key("import"), fileName: "statement.csv", fileBase64: b64(csv) }));
      const statement = (await asUser(vic, (tx) => listStatementLines(tx, accountId, { status: "all" }))).lines;
      const line = (amount: string) => statement.find((entry) => entry.amount === amount)!;

      // A viewer (no payroll access) sees the suggestion, with no name in it.
      const suggestions = await asUser(vic, (tx) => suggestionsForLine(tx, line("-2042.50").id));
      expect(suggestions.matches[0]).toMatchObject({
        journalId: wages.hemi.journalId,
        amount: "-2042.50",
        exact: true,
        origin: "payroll",
        reference: "WAGES-2",
        description: "Net pay",
      });
      await asUser(ben, (tx) =>
        reconcileStatementLine(tx, line("-2042.50").id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [suggestions.matches[0].journalLineId] }),
      );
      const irdMatch = (await asUser(vic, (tx) => suggestionsForLine(tx, line("-1119.04").id))).matches[0];
      expect(irdMatch).toMatchObject({ journalId: ird.two.journalId, exact: true, reference: "IRD-2" });
      await asUser(ben, (tx) => reconcileStatementLine(tx, line("-1119.04").id, { idempotencyKey: key("rec"), kind: "match", journalLineIds: [irdMatch.journalLineId] }));

      const refused = await voidWages(ben, run1, wages.hemi.id, "2026-10-20");
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/reconciled with a bank statement line .*Unreconcile it first/);
      const irdRefused = await voidIrd(ben, ird.two.id, "2026-11-25");
      expect(irdRefused.status).toBe(400);
      expect(irdRefused.body.error).toMatch(/Unreconcile it first/);
    });

    it("PPAY8: period locks refuse wage payments, voids and IRD payments dated in a locked period", async () => {
      await asUser(jess, (tx) => updatePeriodControls(tx, { lockDate: "2026-10-31" }));
      const locked = "2026-10-30 is in a locked period (locked up to 2026-10-31). Use a later date, or ask an owner or admin to reopen the period on Period close.";
      const voidLocked = await voidWages(ben, run2, wages.aroha.id, "2026-10-30");
      expect(voidLocked.status).toBe(400);
      expect(voidLocked.body.error).toBe(locked);
      const voided = await voidWages(ben, run2, wages.aroha.id, "2026-11-02");
      expect(voided.status).toBe(201);
      const payLocked = await pay(ben, run2, { amount: "2590.50", paymentDate: "2026-10-30" });
      expect(payLocked.status).toBe(400);
      expect(payLocked.body.error).toBe(locked);
      const irdLocked = await payIrd(ben, { paymentDate: "2026-10-30", lines: [{ liability: "paye", amount: "1.00" }] });
      expect(irdLocked.status).toBe(400);
      expect(irdLocked.body.error).toBe(locked);
      expect((await payments(ben, run2)).unpaid).toBe("2590.50");
      await asUser(jess, (tx) => updatePeriodControls(tx, { lockDate: null, reason: "PPAY8 test" }));
    });

    it("PPAY12: undoing in order: unreconcile, void the IRD payments, then the pay run", async () => {
      const refused = await voidRun(jess, run2, "2026-11-25");
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("IRD-1, IRD-2 pay 2026-10-01 to 2026-10-31, which includes PAYRUN-2's pay date. Void them first.");
      const accountId = (await asUser(jess, (tx) => tx.query<{ id: string }>("select id::text from accounts where code = '1000'"))).rows[0].id;
      const irdLine = (await asUser(vic, (tx) => listStatementLines(tx, accountId, { status: "all" }))).lines.find((entry) => entry.amount === "-1119.04")!;
      await asUser(ben, (tx) => unreconcileStatementLine(tx, irdLine.id, { idempotencyKey: key("unrec") }));
      for (const payment of [ird.two, ird.one]) {
        const voided = await voidIrd(ben, payment.id, "2026-11-25");
        expect(voided.status).toBe(201);
        const reversal = await journal((voided.body.payment as IrdPayment).voidJournalId!);
        expect(reversal).toMatchObject({ reference: `VOID-${payment.reference}`, correctionKind: "reversal" });
      }
      const done = await voidRun(jess, run2, "2026-11-25");
      expect(done.status).toBe(201);
      const october = await period(ben, "2026-10-01");
      expect(owing(october)).toEqual({ paye: "898.58", student_loan: "0.00", kiwisaver: "160.26", esct: "28.20" });
      expect(october.totalOwing).toBe("1087.04");
      expect(october.payRuns.map((entry) => entry.reference)).toEqual(["PAYRUN-1"]);
      const voidedRun = await pay(ben, run2, { amount: "1.00", paymentDate: "2026-11-26" });
      expect(voidedRun.status).toBe(409);
      expect(voidedRun.body.error).toBe("PAYRUN-2 is voided, so its wages can't be paid.");
    });

    it("PPAY9: twice a month, PAYRUN-1 is in 1-15 Oct 2026, due 20 Oct; overlapping periods are refused", async () => {
      const third = await payIrd(ben, { paymentDate: "2026-11-20", lines: [{ liability: "paye", amount: "100.00" }] });
      expect(third.status).toBe(201);
      expect((third.body.payment as IrdPayment).reference).toBe("IRD-3");
      const put = (user: SessionUser, irdPaymentFrequency: string) =>
        call(settingsRoute.PUT, user, "/api/payroll/settings", { method: "PUT", body: { approverMustDiffer: false, irdPaymentFrequency } });
      expect((await put(ben, "twice_monthly")).status).toBe(403);
      const changed = await put(mere, "twice_monthly");
      expect(changed.status).toBe(200);
      expect(changed.body.settings).toEqual({ approverMustDiffer: false, irdPaymentFrequency: "twice_monthly" });
      const first = await period(ben, "2026-10-01");
      expect(first).toMatchObject({ frequency: "twice_monthly", start: "2026-10-01", end: "2026-10-15", dueDate: "2026-10-20", totalFromPayRuns: "1087.04" });
      const overlap = await payIrd(ben, { paymentDate: "2026-11-20", lines: [{ liability: "paye", amount: "1.00" }] });
      expect(overlap.status).toBe(409);
      expect(overlap.body.error).toBe("IRD-3 already pays 2026-10-01 to 2026-10-31. Pay that period, or void IRD-3 first.");
      expect((await put(mere, "monthly")).status).toBe(200);
    });
  });

  describe("PPAY10: payroll access and privacy", () => {
    it("needs the bookkeeper role and payroll access", async () => {
      for (const user of [noah, vic]) {
        expect((await call(paymentsRoute.GET, user, `/api/payroll/pay-runs/${run1}/payments`, { context: params({ payRunId: run1 }) })).status).toBe(403);
        expect((await pay(user, run1, { amount: "1.00" })).status).toBe(403);
        expect((await call(irdPaymentsRoute.GET, user, "/api/payroll/ird-payments")).status).toBe(403);
        expect((await payIrd(user, { paymentDate: "2026-11-20", lines: [{ liability: "paye", amount: "1.00" }] })).status).toBe(403);
        expect((await voidIrd(user, ird.one.id, "2026-11-26")).status).toBe(403);
      }
      const noAccess = await call(irdPaymentsRoute.GET, noah, "/api/payroll/ird-payments");
      expect(noAccess.body.error).toMatch(/^You need payroll access to see payroll/);
    });

    it("journal lines never name employees; audit events hold no amounts, bank accounts or IRD numbers", async () => {
      const journals = await asUser(jess, (tx) =>
        tx.query<{ text: string }>(
          `select string_agg(coalesce(j.description, '') || ' ' || coalesce(l.description, ''), ' ') as text
             from ledger_journals j join ledger_journal_lines l on l.journal_id = j.id where j.origin = 'payroll'`,
        ),
      );
      expect(journals.rows[0].text).not.toMatch(/Hemi|Walker|Kiri|Tane|Aroha|Ngata/);
      const audit = await asUser(jess, (tx) =>
        tx.query<{ event_type: string; details: Record<string, unknown> }>(
          "select event_type, details from audit_events where event_type like 'payroll_wage_payment.%' or event_type like 'payroll_ird_payment.%' order by id",
        ),
      );
      expect(audit.rows.map((row) => row.event_type)).toEqual(
        expect.arrayContaining(["payroll_wage_payment.recorded", "payroll_wage_payment.voided", "payroll_ird_payment.recorded", "payroll_ird_payment.voided"]),
      );
      const text = JSON.stringify(audit.rows);
      for (const secret of ["123456789", "03-1234-0123456-00", "3699.50", "2042.50", "1657.00", "2590.50", "1000.00", "1119.04", "488.30"]) {
        expect(text).not.toContain(secret);
      }
      for (const row of audit.rows) expect(row.details.amount).toBeUndefined();
      const posted = await asUser(jess, (tx) =>
        tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'ledger.journal_posted' and details->>'origin' = 'payroll'"),
      );
      for (const row of posted.rows) expect(row.details.total).toBeUndefined();
    });
  });
});
