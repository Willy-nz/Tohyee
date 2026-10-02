import { afterAll, beforeAll, expect, it } from "vitest";
import { createAccount } from "@/lib/accounts/service";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { correctJournal, getJournal } from "@/lib/ledger/journals";
import { updatePeriodControls } from "@/lib/ledger/period-controls";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addDays } from "@/lib/payroll/leave/dates";
import { type LeaveLiabilityPosting, listLeaveLiabilityPostings, postLeaveLiability } from "@/lib/payroll/leave-liability";
import { saveOpeningBalances } from "@/lib/payroll/leave-opening";
import { createLeaveBooking } from "@/lib/payroll/leave-records";
import { leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { getPayrollSettings, updatePayrollSettings } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun } from "@/lib/payroll/pay-runs";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
import * as postingsRoute from "@/app/api/payroll/leave/liability/postings/route";
import * as voidRoute from "@/app/api/payroll/leave/liability/postings/[postingId]/void/route";
import * as settingsRoute from "@/app/api/payroll/settings/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-leave-liability-co";

/**
 * Examples HL52-HL56 in docs/ACCOUNTING-EXAMPLES.md (posting the leave
 * liability, decisions 177 and 182-187): Hemi from HL43-HL47 (opening
 * balances as at Sun 4 Oct 2026, a week's annual holidays 12-16 Oct, sick
 * and an alternative holiday 21-22 Oct, last day Fri 30 Oct 2026), 100% to
 * the Workshop Department; a "Leave expense" account and an "Employee
 * entitlements" current liability account.
 */
describeWithDatabase("Posting the leave liability (HL52-HL56)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let wiremu: SessionUser;
  let vic: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  let group = "";
  let workshop = "";
  let departmentCategory = "";
  const people: Record<string, string> = {};
  const postings: Record<string, LeaveLiabilityPosting> = {};

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => as(jess, work);
  const report = { fileName: "previous-payroll-leave-report.pdf", content: new TextEncoder().encode("%PDF-1.4\nleave and earnings at 4 Oct 2026\n%%EOF") };
  const fixedWeek = { kind: "fixed", days: Array.from({ length: 7 }, (_, index) => ({ ordinaryHours: index < 5 ? "8" : "0", extras: [] })) };

  const employee = async (firstName: string, startDate: string, payGroupId: string) =>
    (
      await asJess((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName,
          lastName: "Liability",
          taxCode: "M",
          irdNumber: "123456789",
          kiwiSaverStatus: "not_enrolled",
          kiwiSaverEmployeeRate: "3.5",
          kiwiSaverEmployerRate: "3.5",
          studentLoan: false,
          payBasis: "hourly",
          hourlyRate: "30",
          ordinaryHoursPerWeek: "40",
          payFrequency: "weekly",
          bankAccount: "03-1234-0123456-00",
          startDate,
          payGroupId,
        }),
      )
    ).employee.id;

  /** HL43's weekly rows: 1,200.00 and 5 days, with 27 Oct 2025 (Labour Day worked) and 15 Dec 2025 (a bonus) different. */
  const rows = (from: string, to: string) => {
    const result: Array<Record<string, unknown>> = [];
    for (let monday = from; monday <= to; monday = addDays(monday, 7)) {
      const gross = monday === "2025-10-27" ? "1320.00" : monday === "2025-12-15" ? "2200.00" : "1200.00";
      result.push({ periodStart: monday, periodEnd: addDays(monday, 6), gross, irregular: monday === "2025-12-15" ? "1000.00" : "0", days: 5 });
    }
    return result;
  };

  const payWeek = async (periodStart: string) => {
    const run = (await asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: group, periodStart, payDate: addDays(periodStart, 9) }))).payRun;
    await asJess((tx) => approvePayRun(tx, run.id, { idempotencyKey: key("approve") }));
  };
  const withCookie = async (user: SessionUser, body: Record<string, unknown>) => {
    const response = await postingsRoute.POST(
      apiRequest("/api/payroll/leave/liability/postings", { method: "POST", cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } }),
      undefined as never,
    );
    return { status: response.status, body: (await response.json()) as { posting: LeaveLiabilityPosting; created: boolean; error?: string } };
  };
  const voidPosting = async (user: SessionUser, postingId: string, voidDate: string) => {
    const response = await voidRoute.POST(
      apiRequest(`/api/payroll/leave/liability/postings/${postingId}/void`, {
        method: "POST",
        cookie: await sessionCookieFor(user),
        body: { organisationId: ORG, idempotencyKey: key("void"), voidDate },
      }),
      params({ postingId }),
    );
    return { status: response.status, body: (await response.json()) as { posting: LeaveLiabilityPosting; error?: string } };
  };
  const journalLines = async (journalId: string) =>
    (await asJess((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount, line.description, line.tracking]);
  const workshopTag = () => ({ [departmentCategory]: workshop });

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollliability.test");
    wiremu = await createTestUser("wiremu@payrollliability.test");
    vic = await createTestUser("vic@payrollliability.test");
    await createTestOrganisation(jess, ORG);
    for (const [user, role] of [
      [wiremu, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    await asJess((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    departmentCategory = (await asJess((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const setup = await asJess((tx) => createTrackingValue(tx, { categoryId: departmentCategory, name: "Workshop" }));
    workshop = setup.categories.find((category) => category.id === departmentCategory)!.values.find((value) => value.name === "Workshop")!.id;
    await asJess((tx) => createAccount(tx, { code: "6220", name: "Leave expense", accountType: "expense" }));
    await asJess((tx) => createAccount(tx, { code: "2260", name: "Employee entitlements", accountType: "current_liability" }));
    await asJess((tx) => createAccount(tx, { code: "2270", name: "Other entitlements", accountType: "current_liability" }));
    await asJess((tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "otago" }));
    group = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    people.hemi = await employee("Hemi", "2024-03-04", group);
    await asJess((tx) => addAllocation(tx, people.hemi, { idempotencyKey: key("allocation"), effectiveFrom: "2024-03-04", lines: [{ percentage: "100", departmentId: workshop }] }));
    await asJess((tx) => addLeaveSettings(tx, people.hemi, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    await asJess((tx) =>
      saveOpeningBalances(tx, {
        idempotencyKey: key("opening"),
        employeeId: people.hemi,
        asAt: "2026-10-04",
        annualWeeks: "2.5",
        annualLastEntitled: "2026-03-04",
        annualCashedUpWeeks: "0.5",
        sickDays: "14",
        familyViolenceDays: "10",
        alternativeHolidays: ["2025-10-27"],
        earnings: rows("2025-10-06", "2026-09-28"),
        source: "Previous payroll's leave and earnings reports at 4 Oct 2026",
        report,
      }),
    );
    // HL44-HL46: 5-11 Oct worked; annual holidays 12-16 Oct; sick Wed 21 Oct and the alternative holiday Thu 22 Oct.
    await payWeek("2026-10-05");
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "annual", startDate: "2026-10-12", endDate: "2026-10-16" }));
    await payWeek("2026-10-12");
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "sick", startDate: "2026-10-21" }));
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "alternative", startDate: "2026-10-22" }));
    await payWeek("2026-10-19");
    // HL47: his last day is Fri 30 Oct 2026; the final pay 26 Oct-1 Nov is approved.
    await asJess((tx) => tx.query("update payroll_employees set finish_date = '2026-10-30' where id = $1", [people.hemi]));
    await payWeek("2026-10-26");
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("HL54: a posting without the two accounts set is refused", async () => {
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-11" }))).rejects.toThrow(
      "Choose the leave expense account and the employee entitlements account under Payroll › Pay items before posting the leave liability.",
    );
  });

  it("HL56: the accounts are payroll settings (admins); the wrong kinds of account are refused", async () => {
    const put = async (user: SessionUser, body: Record<string, unknown>) => {
      const response = await settingsRoute.PUT(apiRequest("/api/payroll/settings", { method: "PUT", cookie: await sessionCookieFor(user), body: { organisationId: ORG, ...body } }), undefined as never);
      return { status: response.status, body: (await response.json()) as { settings?: Record<string, unknown>; error?: string } };
    };
    expect((await put(jess, { leaveExpenseAccountCode: "2260" })).body.error).toBe(
      "Account 2260 (Employee entitlements) isn't an expense account. The leave expense goes to an expense or direct costs account.",
    );
    expect((await put(jess, { leaveLiabilityAccountCode: "2800" })).body.error).toBe(
      "Account 2800 (Term loan) isn't a current liability account. Employee entitlements are a current liability (short-term employee benefits).",
    );
    expect((await put(jess, { leaveLiabilityAccountCode: "2240" })).body.error).toBe("Account 2240 (Wages payable) is a control account, so the leave liability can't use it.");
    const saved = await put(jess, { leaveExpenseAccountCode: "6220", leaveLiabilityAccountCode: "2260" });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toEqual({ approverMustDiffer: false, irdPaymentFrequency: "monthly", leaveExpenseAccountCode: "6220", leaveLiabilityAccountCode: "2260", timesheetFirstDay: 1, standardWeek: "40.00" });
    // A bookkeeper without payroll access can't change them.
    expect((await put(wiremu, { leaveExpenseAccountCode: "6200" })).status).toBe(403);
  });

  it("HL52: the first posting at Sun 11 Oct 2026: Dr Leave expense 6,327.45 / Cr Employee entitlements 6,327.45 (Workshop)", async () => {
    // Only people with payroll access (and the bookkeeper role) can post.
    expect((await withCookie(wiremu, { idempotencyKey: key("post"), asAt: "2026-10-11" })).status).toBe(403);
    const viewerList = await postingsRoute.GET(apiRequest(`/api/payroll/leave/liability/postings?organisationId=${ORG}`, { cookie: await sessionCookieFor(vic) }), undefined as never);
    expect(viewerList.status).toBe(403);

    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-11" }));
    expect(liability.totals.total).toBe("6327.45");
    const idempotencyKey = key("post");
    const first = await withCookie(jess, { idempotencyKey, asAt: "2026-10-11" });
    expect(first.status).toBe(201);
    postings.first = first.body.posting;
    expect(postings.first).toMatchObject({
      reference: "LEAVELIAB-1",
      asAt: "2026-10-11",
      liability: "6327.45",
      change: "6327.45",
      previousReference: null,
      expenseAccountCode: "6220",
      liabilityAccountCode: "2260",
      status: "active",
      departments: [{ departmentId: workshop, department: "Workshop", liability: "6327.45" }],
    });
    const journal = await asJess((tx) => getJournal(tx, postings.first.journalId));
    expect([journal.postingDate, journal.reference, journal.description, journal.origin]).toEqual(["2026-10-11", "LEAVELIAB-1", "Leave liability at 11 Oct 2026", "payroll"]);
    expect(await journalLines(postings.first.journalId)).toEqual([
      ["6220", "6327.45", "0.00", "Leave expense", workshopTag()],
      ["2260", "0.00", "6327.45", "Employee entitlements", workshopTag()],
    ]);
    // Never naming Hemi, and the same key again is the same posting.
    expect(JSON.stringify(journal)).not.toContain("Hemi");
    const again = await withCookie(jess, { idempotencyKey, asAt: "2026-10-11" });
    expect([again.status, again.body.posting.id]).toEqual([200, postings.first.id]);
    // Audited without figures (decision 186).
    const audit = await asJess((tx) =>
      tx.query<{ event_type: string; details: Record<string, unknown> }>(
        "select event_type, details from audit_events where event_type like 'payroll_leave_liability.%' or (event_type = 'ledger.journal_posted' and details->>'reference' like 'LEAVELIAB-%') order by id",
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(["ledger.journal_posted", "payroll_leave_liability.posted"]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/6327|6,327/);
  });

  it("HL54: a posting dated before the last one, or while a row in the report has a problem (naming them), is refused", async () => {
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-04" }))).rejects.toThrow(
      "LEAVELIAB-1 posted the leave liability at 11 Oct 2026, so a posting can't be dated before it. Void it first to post an earlier date.",
    );
    // Mere started in 2020 and has no opening balances, so Tohyee doesn't keep her leave.
    const own = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly M", payFrequency: "weekly" }))).group.id;
    people.mere = await employee("Mere", "2020-01-06", own);
    await asJess((tx) => addLeaveSettings(tx, people.mere, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-18" }))).rejects.toThrow(
      /^The leave liability at 18 Oct 2026 can't be posted while the liability report has problems: Mere Liability: .*opening balances/,
    );
    await asJess((tx) => tx.query("update payroll_employees set finish_date = '2026-10-12' where id = $1", [people.mere]));
  });

  it("HL55: the posting at Sun 18 Oct 2026 takes the week's holiday: 5,204.25 − 6,327.45 = −1,123.20; then it's voided", async () => {
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-18" }));
    const row = liability.rows.find((entry) => entry.employeeId === people.hemi)!;
    expect([row.annualWeeks, row.weeklyRate, row.annualValue, row.runningEightPercent, row.alternativeValue, row.total]).toEqual([
      "1.5000",
      "1221.95",
      "1832.93",
      "3131.32",
      "240.00",
      "5204.25",
    ]);
    postings.second = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-18" }))).posting;
    expect(postings.second).toMatchObject({ reference: "LEAVELIAB-2", liability: "5204.25", change: "-1123.20", previousReference: "LEAVELIAB-1" });
    expect(await journalLines(postings.second.journalId)).toEqual([
      ["2260", "1123.20", "0.00", "Employee entitlements", workshopTag()],
      ["6220", "0.00", "1123.20", "Leave expense", workshopTag()],
    ]);
    // Nothing changed since: nothing to post.
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-18" }))).rejects.toThrow(
      "Nothing to post: the leave liability at 18 Oct 2026 is the 5,204.25 LEAVELIAB-2 left.",
    );
    // The latest is voided first; never in a locked period; never corrected in the ledger.
    const outOfOrder = await voidPosting(jess, postings.first.id, "2026-10-18");
    expect([outOfOrder.status, outOfOrder.body.error]).toEqual([409, "LEAVELIAB-2 measured from LEAVELIAB-1. Void it first (the latest posting is voided first)."]);
    expect((await voidPosting(jess, postings.second.id, "2026-10-17")).body.error).toBe("The void date can't be before LEAVELIAB-2's date (2026-10-18).");
    expect((await voidPosting(wiremu, postings.second.id, "2026-10-18")).status).toBe(403);
    await expect(asJess((tx) => correctJournal(tx, { idempotencyKey: key("correct"), originalJournalId: postings.second.journalId, postingDate: "2026-10-18", reference: "X", lines: [] }))).rejects.toThrow(
      "was posted by a leave liability posting (LEAVELIAB-2), so it can't be corrected in the ledger. To undo it, void the posting under Payroll › Leave.",
    );
    const voided = await voidPosting(jess, postings.second.id, "2026-10-18");
    expect(voided.status).toBe(201);
    expect(voided.body.posting).toMatchObject({ status: "voided", voidDate: "2026-10-18" });
    const reversal = await asJess((tx) => getJournal(tx, voided.body.posting.voidJournalId!));
    expect([reversal.reference, reversal.correctionKind, reversal.relatedJournalId]).toEqual(["VOID-LEAVELIAB-2", "reversal", postings.second.journalId]);
    expect(await journalLines(reversal.id)).toEqual([
      ["2260", "0.00", "1123.20", "Employee entitlements", workshopTag()],
      ["6220", "1123.20", "0.00", "Leave expense", workshopTag()],
    ]);
    expect((await voidPosting(jess, postings.second.id, "2026-10-18")).body.error).toBe("LEAVELIAB-2 has already been voided.");
  });

  it("HL56: the employee entitlements account can't change while a posting left a liability in it; the expense account can", async () => {
    await expect(asJess((tx) => updatePayrollSettings(tx, { leaveLiabilityAccountCode: "2270" }))).rejects.toThrow(
      "LEAVELIAB-1 left the leave liability in 2260, so that account can't change until a posting brings it to 0.00 or the postings are voided (decision 184).",
    );
    await asJess((tx) => updatePayrollSettings(tx, { leaveExpenseAccountCode: "6200" }));
    await asJess((tx) => updatePayrollSettings(tx, { leaveExpenseAccountCode: "6220" }));
  });

  it("HL54: a posting in a locked period is refused", async () => {
    await asJess((tx) => updatePeriodControls(tx, { lockDate: "2026-10-31" }));
    await expect(asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-31" }))).rejects.toThrow(
      "2026-10-31 is in a locked period (locked up to 2026-10-31).",
    );
    await asJess((tx) => updatePeriodControls(tx, { lockDate: null, reason: "HL54 test" }));
  });

  it("HL53: at Sat 31 Oct 2026 Hemi has finished but his final pay (paid 4 Nov) isn't: 5,302.89 − 6,327.45 from LEAVELIAB-1", async () => {
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-31" }));
    expect(liability.rows.map((row) => [row.name, row.finishDate, row.finalPayDate, row.holidayPayOnFinishing, row.total, row.kiwiSaverRate, row.kiwiSaver, row.problem])).toEqual([
      ["Hemi Liability", "2026-10-30", "2026-11-04", "5302.89", "5302.89", null, "0.00", null],
    ]);
    postings.third = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-10-31" }))).posting;
    expect(postings.third).toMatchObject({ reference: "LEAVELIAB-3", liability: "5302.89", kiwiSaver: "0.00", change: "-1024.56", previousReference: "LEAVELIAB-1" });
    expect(postings.third.departments).toEqual([{ departmentId: workshop, department: "Workshop", liability: "5302.89", kiwiSaver: "0.00" }]);
    expect(await journalLines(postings.third.journalId)).toEqual([
      ["2260", "1024.56", "0.00", "Employee entitlements", workshopTag()],
      ["6220", "0.00", "1024.56", "Leave expense", workshopTag()],
    ]);
    // 2260 still holds 5,302.89, so it can't change yet (decision 184).
    await expect(asJess((tx) => updatePayrollSettings(tx, { leaveLiabilityAccountCode: "2270" }))).rejects.toThrow("LEAVELIAB-3 left the leave liability in 2260");
  });

  it("HL57: at Wed 4 Nov 2026 the final pay is paid: 0.00 − 5,302.89, and the account comes to 0.00 (Mere is never in it)", async () => {
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-11-04" }));
    expect(liability.rows).toEqual([]);
    postings.fourth = (await asJess((tx) => postLeaveLiability(tx, { idempotencyKey: key("post"), asAt: "2026-11-04" }))).posting;
    expect(postings.fourth).toMatchObject({ reference: "LEAVELIAB-4", liability: "0.00", total: "0.00", change: "-5302.89", previousReference: "LEAVELIAB-3", departments: [] });
    expect(await journalLines(postings.fourth.journalId)).toEqual([
      ["2260", "5302.89", "0.00", "Employee entitlements", workshopTag()],
      ["6220", "0.00", "5302.89", "Leave expense", workshopTag()],
    ]);
    // 6,327.45 − 1,123.20 + 1,123.20 − 1,024.56 − 5,302.89 = 0.00, and the account can change now.
    const balance = await asJess((tx) =>
      tx.query<{ total: string }>(
        `select coalesce(sum(l.credit_amount - l.debit_amount), 0)::text as total from ledger_journal_lines l join accounts a on a.id = l.account_id where a.code = '2260'`,
      ),
    );
    expect(Number(balance.rows[0].total)).toBe(0);
    await asJess((tx) => updatePayrollSettings(tx, { leaveLiabilityAccountCode: "2270" }));
    expect((await asJess((tx) => getPayrollSettings(tx))).leaveLiabilityAccountCode).toBe("2270");
    const list = await asJess((tx) => listLeaveLiabilityPostings(tx));
    expect(list.map((entry) => [entry.reference, entry.status])).toEqual([
      ["LEAVELIAB-4", "active"],
      ["LEAVELIAB-3", "active"],
      ["LEAVELIAB-2", "voided"],
      ["LEAVELIAB-1", "active"],
    ]);
  });

  it("decision 183: postings and their Departments can't be changed or deleted in the database", async () => {
    await expect(asJess((tx) => tx.query("update payroll_leave_liability_postings set liability = 1 where id = $1", [postings.first.id]))).rejects.toThrow(
      "Leave liability postings can't be changed; void them instead",
    );
    await expect(asJess((tx) => tx.query("delete from payroll_leave_liability_departments where posting_id = $1", [postings.first.id]))).rejects.toThrow(
      "Leave liability postings can't be changed or deleted",
    );
  });
});
