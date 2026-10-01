import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { dec, toFixedString } from "@/lib/money/decimal";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { addDays } from "@/lib/payroll/leave/dates";
import { saveOpeningBalances } from "@/lib/payroll/leave-opening";
import { addLeaveSettings, updateOrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import { createLeaveBooking } from "@/lib/payroll/leave-records";
import { getLeaveRecord, getLeaveSummary, leaveLiabilityReport } from "@/lib/payroll/leave-reports";
import { listPayItems } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun, type PayRun, type PayRunLine, setPayRunEmployeeLines } from "@/lib/payroll/pay-runs";
import * as openingRoute from "@/app/api/payroll/leave/opening/route";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "payroll-leave-opening-co";
const REFUSED = "Not supported yet (refused rather than guessed)";

/**
 * Examples HL43-HL48 in docs/ACCOUNTING-EXAMPLES.md (opening leave
 * balances, decision 168): Hemi, 30.00 an hour, Monday to Friday, 8 hours
 * a day, started Mon 4 Mar 2024; his employer moves payroll to Tohyee from
 * the pay period starting Mon 5 Oct 2026, with opening balances as at Sun
 * 4 Oct 2026. Weekly pay, Monday to Sunday, paid the Wednesday after.
 */
describeWithDatabase("Opening leave balances (HL43-HL48)", () => {
  let server: TestServer;
  let jess: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  let group = "";
  const people: Record<string, string> = {};

  const asJess = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: jess.id, email: jess.email }, work);
  const report = { fileName: "previous-payroll-leave-report.pdf", content: new TextEncoder().encode("%PDF-1.4\nleave and earnings at 4 Oct 2026\n%%EOF") };
  const fixedWeek = { kind: "fixed", days: Array.from({ length: 7 }, (_, index) => ({ ordinaryHours: index < 5 ? "8" : "0", extras: [] })) };

  const employee = async (firstName: string, startDate: string, payGroupId?: string) =>
    (
      await asJess((tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          firstName,
          lastName: "Opening",
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
          payGroupId: payGroupId ?? group,
        }),
      )
    ).employee.id;

  /** Weekly rows of 1,200.00 and 5 days from `from` to `to` (Mondays), with HL43's two different weeks. */
  const rows = (from: string, to: string) => {
    const result: Array<Record<string, unknown>> = [];
    for (let monday = from; monday <= to; monday = addDays(monday, 7)) {
      const gross = monday === "2025-10-27" ? "1320.00" : monday === "2025-12-15" ? "2200.00" : "1200.00";
      result.push({ periodStart: monday, periodEnd: addDays(monday, 6), gross, irregular: monday === "2025-12-15" ? "1000.00" : "0", days: 5 });
    }
    return result;
  };
  const hemiOpening = (overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });

  const draft = (periodStart: string, payGroupId?: string) =>
    asJess((tx) => createPayRun(tx, { idempotencyKey: key("run"), payGroupId: payGroupId ?? group, periodStart, payDate: addDays(periodStart, 9) })).then((result) => result.payRun);
  const approve = (runId: string) => asJess((tx) => approvePayRun(tx, runId, { idempotencyKey: key("approve") })).then((result) => result.payRun);
  const of = (run: PayRun, person: string) => run.employees.find((entry) => entry.employeeId === people[person])!;
  const leaveLines = (run: PayRun, person: string): PayRunLine[] => of(run, person).lines.filter((line) => line.source === "leave");

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payrollopening.test");
    await createTestOrganisation(jess, ORG);
    await asJess((tx) => updateOrganisationLeaveSettings(tx, { anniversaryRegion: "otago" }));
    group = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    people.hemi = await employee("Hemi", "2024-03-04");
    await asJess((tx) => addLeaveSettings(tx, people.hemi, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("decision 143: without opening balances Hemi's leave is refused, and the refusal says how to fix it", async () => {
    const summary = await asJess((tx) => getLeaveSummary(tx, people.hemi, "2026-10-05"));
    expect(summary.kept).toBe(false);
    expect(summary.notKeptReason).toContain("without opening balances; enter them under Payroll › Leave (decision 168)");
  });

  it("HL48: refuses opening balances without the report, the source, or with a gap in the earnings rows", async () => {
    await expect(asJess((tx) => saveOpeningBalances(tx, hemiOpening({ report: null })))).rejects.toThrow("Attach the previous payroll's leave and earnings report");
    await expect(asJess((tx) => saveOpeningBalances(tx, hemiOpening({ source: "" })))).rejects.toThrow("Say where the opening balances came from");
    const gap = rows("2025-10-06", "2026-09-28").filter((row) => row.periodStart !== "2026-01-12");
    await expect(asJess((tx) => saveOpeningBalances(tx, hemiOpening({ earnings: gap })))).rejects.toThrow("There's a gap in the earnings rows from 2026-01-12 to 2026-01-18.");
    await expect(asJess((tx) => saveOpeningBalances(tx, hemiOpening({ annualWeeks: "-0.5" })))).rejects.toThrow("give the holiday pay already paid");
  });

  it("HL43: Hemi's opening balances as at Sun 4 Oct 2026, through the API with the report attached", async () => {
    const form = new FormData();
    const { report: file, ...data } = hemiOpening();
    form.set("data", JSON.stringify({ ...data, organisationId: ORG }));
    form.set("report", new File([file.content], file.fileName, { type: "application/pdf" }));
    const response = await openingRoute.POST(
      new Request("http://tohyee.test/api/payroll/leave/opening", { method: "POST", headers: { cookie: await sessionCookieFor(jess), origin: "http://tohyee.test" }, body: form }),
      undefined as never,
    );
    const fetched = await openingRoute.GET(apiRequest(`/api/payroll/leave/opening?organisationId=${ORG}&employeeId=${people.hemi}`, { cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(fetched.status).toBe(200);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { opening: { asAt: string; earnings: unknown[]; reportFileId: string; annualWeekHours: string } };
    expect(body.opening).toMatchObject({ asAt: "2026-10-04", annualWeekHours: "40" });
    expect(body.opening.earnings).toHaveLength(52);

    const summary = await asJess((tx) => getLeaveSummary(tx, people.hemi, "2026-10-05"));
    expect(summary.kept).toBe(true);
    expect(summary.annual).toMatchObject({ weeks: "2.5000", hours: "100.00", lastEntitled: "2026-03-04", nextEntitled: "2027-03-04", cashedUpThisYear: "0.5000" });
    expect(summary.sick).toEqual({ days: "14.00", lastEntitled: "2026-09-04" });
    expect(summary.familyViolence).toEqual({ days: "10.00" });
    expect(summary.alternative?.untaken).toBe(1);
    expect(summary.runningEightPercent).toMatchObject({ since: "2026-03-04", to: "2026-10-04", gross: "36720.00", amount: "2937.60" });

    const record = await asJess((tx) => getLeaveRecord(tx, people.hemi));
    expect(record.entries.find((entry) => entry.entry.startsWith("Opening balances"))).toMatchObject({ date: "2026-10-04" });
    expect(record.entries.some((entry) => entry.entry === "Entitled to 4 weeks' annual holidays" && entry.date <= "2026-10-04")).toBe(false);
  });

  it("HL44: annual holidays Mon 12-Fri 16 Oct 2026 at AWE 63,520.00 ÷ 52 = 1,221.54; balance 2.5 → 1.5 weeks", async () => {
    const first = await draft("2026-10-05");
    expect(of(first, "hemi").problem).toBeNull();
    expect(of(first, "hemi").pay!.gross).toBe("1200.00");
    await approve(first.id);
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "annual", startDate: "2026-10-12", endDate: "2026-10-16" }));
    const run = await draft("2026-10-12");
    const annual = leaveLines(run, "hemi");
    expect(annual.map((line) => [line.payItemName, line.amount])).toEqual([["Annual leave", "1221.54"]]);
    await approve(run.id);
    const summary = await asJess((tx) => getLeaveSummary(tx, people.hemi, "2026-10-18"));
    expect(summary.annual?.weeks).toBe("1.5000");
  });

  it("HL45, HL46: sick Wed 21 Oct (240.00; 14 → 13 days) and the opening alternative holiday taken Thu 22 Oct (240.00)", async () => {
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "sick", startDate: "2026-10-21" }));
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.hemi, leaveType: "alternative", startDate: "2026-10-22" }));
    const run = await draft("2026-10-19");
    expect(leaveLines(run, "hemi").map((line) => [line.payItemName, line.amount])).toEqual([
      ["Sick leave", "240.00"],
      ["Alternative holiday", "240.00"],
    ]);
    expect(of(run, "hemi").pay!.gross).toBe("1200.00");
    await approve(run.id);
    const summary = await asJess((tx) => getLeaveSummary(tx, people.hemi, "2026-10-25"));
    expect(summary.sick?.days).toBe("13.00");
    expect(summary.alternative?.untaken).toBe(0);
    expect(summary.alternative?.holidays[0]).toMatchObject({ arose: "2025-10-27", status: "taken", on: "2026-10-22" });
  });

  it("HL52's figures: the liability report at Sun 11 Oct 2026 values Hemi at 3,053.85 + 3,033.60 + 240.00", async () => {
    const liability = await asJess((tx) => leaveLiabilityReport(tx, { asAt: "2026-10-11" }));
    const row = liability.rows.find((entry) => entry.employeeId === people.hemi)!;
    expect(row.problem).toBeNull();
    // Leave approved after 11 Oct counts from its own dates, so the balance on 11 Oct is still 2.5 weeks.
    expect([row.annualWeeks, row.weeklyRate, row.annualValue, row.runningEightPercent, row.alternativeValue, row.total]).toEqual([
      "2.5000",
      "1221.54",
      "3053.85",
      "3033.60",
      "240.00",
      "6327.45",
    ]);
  });

  it("HL47: Hemi's final pay (last day Fri 30 Oct 2026): untaken 1.5 weeks 1,832.93 and 8% 3,469.96", async () => {
    await asJess((tx) => tx.query("update payroll_employees set finish_date = '2026-10-30' where id = $1", [people.hemi]));
    const run = await draft("2026-10-26");
    expect(of(run, "hemi").problem).toBeNull();
    const lines = leaveLines(run, "hemi");
    expect(lines.map((line) => [line.payItemName, line.amount, line.leave!.basis.part ?? null])).toEqual([
      ["Public holiday", "240.00", null],
      ["Holiday pay owed on finishing", "1832.93", "untaken_entitlement"],
      ["Holiday pay owed on finishing", "3469.96", "eight_percent"],
    ]);
    const eight = lines[2].leave!.basis as Record<string, string>;
    expect(eight.since).toBe("2026-03-04");
    expect(toFixedString(dec(eight.grossEarnings), 2)).toBe("43374.47");
    await approve(run.id);
  });

  it("HL48: replacing the opening balances after an approved pay run paid leave is refused", async () => {
    await expect(asJess((tx) => saveOpeningBalances(tx, hemiOpening()))).rejects.toThrow("so opening balances can't be entered or replaced. Void it first.");
  });

  it("HL43, HL48: typed holiday pay on pay runs to the opening date is covered; after it, leave stays refused; casual is refused", async () => {
    const own = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly T", payFrequency: "weekly" }))).group.id;
    people.tama = await employee("Tama", "2024-03-04", own);
    await asJess((tx) => addLeaveSettings(tx, people.tama, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    const items = Object.fromEntries((await asJess((tx) => listPayItems(tx))).map((item) => [item.name, item]));
    // Tohyee paid Tama 21 Sep-4 Oct 2026, the second week with P3's typed "Holiday pay".
    for (const monday of ["2026-09-21", "2026-09-28"]) {
      const run = await draft(monday, own);
      if (monday === "2026-09-28") {
        await asJess((tx) =>
          setPayRunEmployeeLines(tx, run.id, people.tama, {
            lines: [
              { payItemId: items["Ordinary time"].id, quantity: "32", rate: "30" },
              { payItemId: items["Holiday pay"].id, amount: "240" },
            ],
          }),
        );
      }
      await approve(run.id);
    }
    const before = await asJess((tx) => getLeaveSummary(tx, people.tama, "2026-10-05"));
    expect(before.notKeptReason).toContain("who was paid typed holiday pay on");
    const tama = (overrides: Record<string, unknown>) => ({ ...hemiOpening(), employeeId: people.tama, idempotencyKey: key("opening"), ...overrides });
    // Rows past the day before Tohyee's first pay period are refused; to Sun 20 Sep they're accepted.
    await expect(asJess((tx) => saveOpeningBalances(tx, tama({})))).rejects.toThrow("runs past 2026-09-20");
    await expect(asJess((tx) => saveOpeningBalances(tx, tama({ asAt: "2026-09-30", earnings: rows("2025-09-22", "2026-09-14") })))).rejects.toThrow(
      "The opening date must be the end of a pay period",
    );
    await asJess((tx) => saveOpeningBalances(tx, tama({ earnings: rows("2025-09-22", "2026-09-14") })));
    const after = await asJess((tx) => getLeaveSummary(tx, people.tama, "2026-10-05"));
    expect(after.kept).toBe(true);
    // Typed holiday pay after the opening date can't be added: Tohyee now keeps Tama's leave (decision 141).
    const later = await draft("2026-10-05", own);
    await expect(
      asJess((tx) =>
        setPayRunEmployeeLines(tx, later.id, people.tama, {
          lines: [
            { payItemId: items["Ordinary time"].id, quantity: "32", rate: "30" },
            { payItemId: items["Holiday pay"].id, amount: "240" },
          ],
        }),
      ),
    ).rejects.toThrow();
    // Casual employees: the hours test needs approved timesheets.
    people.rua = await employee("Rua", "2024-03-04", own);
    await asJess((tx) => addLeaveSettings(tx, people.rua, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true, employmentType: "casual" }));
    await expect(asJess((tx) => saveOpeningBalances(tx, { ...hemiOpening(), employeeId: people.rua, idempotencyKey: key("opening") }))).rejects.toThrow(
      `${REFUSED}: opening balances for Rua Opening, who is set to casual`,
    );
  });

  it("HL48: opening balances as at Wed 7 Oct 2026 stop the pay run for 5-11 Oct; leave needing pay before the first row is refused", async () => {
    const own = (await asJess((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly M", payFrequency: "weekly" }))).group.id;
    people.mere = await employee("Mere", "2024-03-04", own);
    await asJess((tx) => addLeaveSettings(tx, people.mere, { idempotencyKey: key("settings"), pattern: fixedWeek, annualPaidInPeriod: true }));
    await asJess((tx) =>
      saveOpeningBalances(tx, {
        ...hemiOpening(),
        employeeId: people.mere,
        idempotencyKey: key("opening"),
        asAt: "2026-10-07",
        earnings: [...rows("2026-01-05", "2026-09-28"), { periodStart: "2026-10-05", periodEnd: "2026-10-07", gross: "720", irregular: "0", days: 3 }],
      }),
    );
    const across = await draft("2026-10-05", own);
    expect(of(across, "mere").problem).toBe(
      `${REFUSED}: leave for Mere Opening in a pay period across the opening balances' date (7 Oct 2026); opening balances must be as at the end of a pay period. Replace them.`,
    );
    // Rows only from Mon 5 Jan 2026: annual holidays in November need pay from November 2025.
    await asJess((tx) => createLeaveBooking(tx, { idempotencyKey: key("book"), employeeId: people.mere, leaveType: "annual", startDate: "2026-11-16", endDate: "2026-11-20" }));
    const holiday = await draft("2026-11-16", own);
    expect(of(holiday, "mere").problem).toContain(`${REFUSED}: Pay for annual holidays for Mere Opening needs pay from 16 Nov 2025, before the first opening earnings row`);
  });
});
