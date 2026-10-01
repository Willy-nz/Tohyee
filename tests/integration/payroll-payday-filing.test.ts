import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import * as accessRoute from "@/app/api/payroll/access/route";
import * as approveRoute from "@/app/api/payroll/pay-runs/[payRunId]/approve/route";
import * as payRunEmployeeRoute from "@/app/api/payroll/pay-runs/[payRunId]/employees/[employeeId]/route";
import * as filingRoute from "@/app/api/payroll/pay-runs/[payRunId]/payday-filing/route";
import * as voidRoute from "@/app/api/payroll/pay-runs/[payRunId]/void/route";
import * as payRunsRoute from "@/app/api/payroll/pay-runs/route";
import * as settingsRoute from "@/app/api/payroll/payday-filing-settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { coreQuery } from "@/lib/db/transactions";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { createPayItem, listPayItems, type PayItem } from "@/lib/payroll/pay-items";
import type { PayRun } from "@/lib/payroll/pay-runs";
import type { PaydayFilingSettings, PayRunPaydayFiling, PayRunPaydayFilingFile } from "@/lib/payroll/payday-filing-service";
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

const ORG = "payroll-payday-filing-co";
const noContext = undefined as unknown;
const PACKAGE = `Tohyee_Tohyee_v${packageJson.version}`;
const HEADER_START = "HEI2,123123123,20261014,N,N,,Mere Tipene,034771234,payroll@harbourcafe.co.nz";
const HEADER_END = `${PACKAGE},0001`;

/**
 * Examples PF1-PF8 in docs/ACCOUNTING-EXAMPLES.md ("Payday filing file
 * (examples not yet approved by Jess)"), from pay runs made and approved
 * through the API with PRUN1-PRUN3's figures. The tests run in order:
 * PAYRUN-1 is PRUN1's, PAYRUN-2 PRUN2's, PAYRUN-3 PRUN3's, PAYRUN-4 PF5's.
 */
describeWithDatabase("payroll: payday filing file (PF1-PF8)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner, payroll access
  let mere: SessionUser; // admin, payroll access
  let ben: SessionUser; // bookkeeper, payroll access
  let noah: SessionUser; // bookkeeper, no payroll access
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const groups: Record<string, string> = {};
  const people: Record<string, string> = {};
  const runs: Record<string, string> = {};
  let items: Record<string, PayItem> = {};

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const call = async (
    handler: (request: Request, context: never) => Promise<Response>,
    user: SessionUser,
    path: string,
    options: { method?: string; body?: Record<string, unknown>; context?: unknown } = {},
  ) => {
    const method = options.method ?? "GET";
    const url = method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path;
    const response = await handler(
      apiRequest(url, {
        method,
        cookie: await sessionCookieFor(user),
        body: options.body === undefined ? undefined : { organisationId: ORG, ...options.body },
      }),
      (options.context ?? noContext) as never,
    );
    return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
  };

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

  const group = async (name: string, payFrequency: string) =>
    (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name, payFrequency }))).group.id;

  const draft = async (payGroupId: string, periodStart: string, payDate = "2026-10-14") => {
    const created = await call(payRunsRoute.POST, ben, "/api/payroll/pay-runs", {
      method: "POST",
      body: { idempotencyKey: key("payrun"), payGroupId, periodStart, payDate },
    });
    expect(created.status).toBe(201);
    return created.body.payRun as PayRun;
  };

  const approve = async (payRunId: string) => {
    const approved = await call(approveRoute.POST, ben, `/api/payroll/pay-runs/${payRunId}/approve`, {
      method: "POST",
      body: { idempotencyKey: key("approve") },
      context: params({ payRunId }),
    });
    expect(approved.status).toBe(201);
    return approved.body.payRun as PayRun;
  };

  const prun2Lines = () => [
    { payItemId: items["Ordinary time"].id, quantity: "32" },
    { payItemId: items.Overtime.id, quantity: "4" },
    { payItemId: items["Tool allowance"].id, amount: "25" },
    { payItemId: items.Reimbursement.id, amount: "42.60", description: "Fuel receipt" },
    { payItemId: items["Union fees"].id, amount: "8.50" },
  ];

  const setLines = async (payRunId: string, employeeId: string, lines: unknown[]) => {
    const response = await call(payRunEmployeeRoute.PUT, ben, `/api/payroll/pay-runs/${payRunId}/employees/${employeeId}`, {
      method: "PUT",
      body: { lines },
      context: params({ payRunId, employeeId }),
    });
    expect(response.status).toBe(200);
  };

  const makeFile = (user: SessionUser, payRunId: string) =>
    call(filingRoute.POST, user, `/api/payroll/pay-runs/${payRunId}/payday-filing`, { method: "POST", body: {}, context: params({ payRunId }) });

  const filing = (user: SessionUser, payRunId: string) =>
    call(filingRoute.GET, user, `/api/payroll/pay-runs/${payRunId}/payday-filing`, { context: params({ payRunId }) });

  const journalCount = async () =>
    Number((await asUser(jess, (tx) => tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"))).rows[0].count);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@paydayfiling.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@paydayfiling.test");
    ben = await createTestUser("ben@paydayfiling.test");
    noah = await createTestUser("noah@paydayfiling.test");
    vic = await createTestUser("vic@paydayfiling.test");
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
    await asUser(jess, (tx) =>
      createPayItem(tx, { idempotencyKey: key("item"), name: "Tool allowance", kind: "allowance", accountCode: "6200", taxable: true, countsForKiwiSaver: true }),
    );
    items = Object.fromEntries((await asUser(jess, (tx) => listPayItems(tx))).map((item) => [item.name, item]));

    groups.fortnightly = await group("Fortnightly salaries", "fortnightly");
    groups.weekly = await group("Weekly wages", "weekly");
    groups.fourWeekly = await group("Four-weekly", "four_weekly");
    groups.casuals = await group("Weekly casuals", "weekly");
    people.hemi = await employee({
      firstName: "Hemi",
      lastName: "Walker",
      irdNumber: "123-456-789",
      payFrequency: "fortnightly",
      annualSalary: "70000.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "30",
      payGroupId: groups.fortnightly,
    });
    people.kiri = await employee({
      firstName: "Kiri",
      lastName: "Tane",
      irdNumber: "87-654-321",
      payFrequency: "fortnightly",
      annualSalary: "52000.00",
      payGroupId: groups.fortnightly,
    });
    const sioneLike = {
      lastName: "Fifita",
      payFrequency: "weekly",
      payBasis: "hourly",
      hourlyRate: "22.50",
      ordinaryHoursPerWeek: "32",
      kiwiSaverStatus: "enrolled",
      kiwiSaverEmployeeRate: "4",
      esctRate: "17.5",
    };
    people.sione = await employee({ ...sioneLike, firstName: "Sione", irdNumber: "100-200-300", payGroupId: groups.weekly });
    people.sina = await employee({ ...sioneLike, firstName: "Sina", irdNumber: "100-200-301", startDate: "2026-10-07", payGroupId: groups.casuals });
    people.aroha = await employee({
      firstName: "Aroha",
      lastName: "Ngata",
      irdNumber: "112-233-445",
      taxCode: "M SL",
      studentLoan: true,
      payFrequency: "four_weekly",
      annualSalary: "45500.00",
      kiwiSaverStatus: "enrolled",
      esctRate: "17.5",
      payGroupId: groups.fourWeekly,
    });

    const first = await approve((await draft(groups.fortnightly, "2026-09-28")).id);
    expect(first.reference).toBe("PAYRUN-1");
    expect(first.totals).toMatchObject({ gross: "4692.31", paye: "898.58", esct: "28.20" });
    runs.prun1 = first.id;
    const weekly = await draft(groups.weekly, "2026-10-05");
    await setLines(weekly.id, people.sione, prun2Lines());
    const second = await approve(weekly.id);
    expect(second.reference).toBe("PAYRUN-2");
    expect(second.totals).toMatchObject({ gross: "922.60", paye: "148.40", netPay: "730.50" });
    runs.prun2 = second.id;
    const third = await approve((await draft(groups.fourWeekly, "2026-09-14")).id);
    expect(third.reference).toBe("PAYRUN-3");
    expect(third.totals).toMatchObject({ paye: "589.72", studentLoan: "197.28", esct: "21.35" });
    runs.prun3 = third.id;
    const casuals = await draft(groups.casuals, "2026-10-05");
    await setLines(casuals.id, people.sina, prun2Lines());
    const fourth = await approve(casuals.id);
    expect(fourth.reference).toBe("PAYRUN-4");
    runs.pf5 = fourth.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("lists tenant migration 0064 once", () => {
    expect(tenantMigrations.filter((entry) => entry.version === "0064")).toHaveLength(1);
  });

  describe("settings (PF7)", () => {
    it("refuses a file until payday filing is set up", async () => {
      const shown = await filing(ben, runs.prun1);
      expect(shown.status).toBe(200);
      expect((shown.body.filing as PayRunPaydayFiling).settingsComplete).toBe(false);
      const refused = await makeFile(ben, runs.prun1);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(
        "Set up payday filing first: an admin enters the employer's IRD number and the payroll contact under Payroll › Pay items.",
      );
    });

    it("only admins with payroll access change the settings, checked against IRD's rules", async () => {
      const input = { employerIrdNumber: "123-123-123", contactName: "Mere Tipene", contactPhone: "03 477 1234", contactEmail: "payroll@harbourcafe.co.nz" };
      const put = (user: SessionUser, body: Record<string, unknown>) => call(settingsRoute.PUT, user, "/api/payroll/payday-filing-settings", { method: "PUT", body });
      expect((await put(ben, input)).status).toBe(403);
      expect((await put(noah, input)).status).toBe(403);
      expect((await put(mere, { ...input, contactName: "Merewhakaaro Tipene-Smith" })).body.error).toContain("up to 20 characters");
      expect((await put(mere, { ...input, contactEmail: "payroll+ird@harbourcafe.co.nz" })).body.error).toContain("@ - _ .");
      expect((await put(mere, { ...input, employerIrdNumber: "12-345" })).body.error).toContain("8 or 9 digits");
      const saved = await put(mere, input);
      expect(saved.status).toBe(200);
      expect(saved.body.settings as PaydayFilingSettings).toEqual({
        employerIrdNumber: "123123123",
        contactName: "Mere Tipene",
        contactPhone: "034771234",
        contactEmail: "payroll@harbourcafe.co.nz",
        complete: true,
      });
      const read = await call(settingsRoute.GET, ben, "/api/payroll/payday-filing-settings");
      expect(read.status).toBe(200);
      expect((read.body.settings as PaydayFilingSettings).employerIrdNumber).toBe("123123123");
      expect((await call(settingsRoute.GET, noah, "/api/payroll/payday-filing-settings")).status).toBe(403);
    });
  });

  describe("the file", () => {
    it("PF1: fortnightly salaries, byte for byte, posting nothing", async () => {
      const before = await journalCount();
      const made = await makeFile(ben, runs.prun1);
      expect(made.status).toBe(200);
      expect(made.headers.get("cache-control")).toBe("no-store");
      const file = made.body.file as PayRunPaydayFilingFile;
      expect(file.fileName).toBe("EI-20261014-PAYRUN-1.csv");
      expect(file.content).toBe(
        `${HEADER_START},2,469231,0,0,89858,0,0,0,0,0,9423,6603,2820,108704,0,0,0,${HEADER_END}\r\n` +
          "DEI,087654321,Kiri Tane,M,,,20260928,20261011,FT,0,200000,0,0,0,34300,0,0,,0,0,0,0,0,0,0,0,0\r\n" +
          "DEI,123456789,Hemi Walker,M,,,20260928,20261011,FT,0,269231,0,0,0,55558,0,0,,0,0,0,9423,6603,2820,0,0,0\r\n",
      );
      expect(file.totals.amountsDeducted).toBe("1087.04");
      expect(file.dueDate).toBe("2026-10-16");
      expect(file.sha256).toBe(createHash("sha256").update(file.content).digest("hex"));
      expect(await journalCount()).toBe(before);
    });

    it("PF2: hours from hours x rate lines; the reimbursement and union fees are left out", async () => {
      const file = (await makeFile(ben, runs.prun2)).body.file as PayRunPaydayFilingFile;
      expect(file.fileName).toBe("EI-20261014-PAYRUN-2.csv");
      expect(file.content).toBe(
        `${HEADER_START},1,88000,0,0,14840,0,0,0,0,0,3520,2555,525,21440,0,0,0,${HEADER_END}\r\n` +
          "DEI,100200300,Sione Fifita,M,,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0\r\n",
      );
    });

    it("PF3: student loan, tax code M SL", async () => {
      const file = (await makeFile(ben, runs.prun3)).body.file as PayRunPaydayFilingFile;
      expect(file.content).toBe(
        `${HEADER_START},1,350000,0,0,58972,0,0,19728,0,0,12250,10115,2135,103200,0,0,0,${HEADER_END}\r\n` +
          "DEI,112233445,Aroha Ngata,M SL,,,20260914,20261011,4W,0,350000,0,0,0,58972,0,0,,19728,0,0,12250,10115,2135,0,0,0\r\n",
      );
    });

    it("PF4: making a file again gives the same bytes", async () => {
      const once = (await makeFile(ben, runs.prun1)).body.file as PayRunPaydayFilingFile;
      const twice = (await makeFile(mere, runs.prun1)).body.file as PayRunPaydayFilingFile;
      expect(twice.content).toBe(once.content);
      expect(twice.sha256).toBe(once.sha256);
    });

    it("PF5: a new employee's start date is in her line, and the card lists her", async () => {
      const file = (await makeFile(ben, runs.pf5)).body.file as PayRunPaydayFilingFile;
      expect(file.content.split("\r\n")[1]).toBe(
        "DEI,100200301,Sina Fifita,M,20261007,,20261005,20261011,WK,3600,88000,0,0,0,14840,0,0,,0,0,0,3520,2555,525,0,0,0",
      );
      const shown = (await filing(ben, runs.pf5)).body.filing as PayRunPaydayFiling;
      expect(shown).toMatchObject({ reference: "PAYRUN-4", payDate: "2026-10-14", dueDate: "2026-10-16", settingsComplete: true, employeeCount: 1 });
      expect(shown.starting).toEqual([{ employeeId: people.sina, name: "Sina Fifita", startDate: "2026-10-07" }]);
      expect(((await filing(ben, runs.prun2)).body.filing as PayRunPaydayFiling).starting).toEqual([]);
    });
  });

  describe("refused and access (PF7, PF8)", () => {
    it("PF8: needs payroll access and the bookkeeper role", async () => {
      expect((await makeFile(noah, runs.prun1)).status).toBe(403);
      expect((await makeFile(noah, runs.prun1)).body.error).toContain("You need payroll access to see payroll");
      expect((await makeFile(vic, runs.prun1)).status).toBe(403);
      expect((await filing(noah, runs.prun1)).status).toBe(403);
    });

    it("PF8: the audit event names the file and its hash, never an amount or IRD number", async () => {
      const events = await asUser(jess, (tx) =>
        tx.query<{ details: Record<string, unknown>; actor_email: string }>(
          "select details, actor_email from audit_events where event_type = 'payroll_payday_filing.made' and entity_id = $1 order by id",
          [runs.prun1],
        ),
      );
      expect(events.rows.length).toBeGreaterThanOrEqual(1);
      const [first] = events.rows;
      expect(first.actor_email).toBe("ben@paydayfiling.test");
      expect(Object.keys(first.details).sort()).toEqual(["employeeLines", "fileName", "payRunReference", "sha256"]);
      const text = JSON.stringify(events.rows);
      for (const secret of ["123456789", "087654321", "87654321", "269231", "2692.31", "555.58"]) expect(text).not.toContain(secret);
    });

    it("PF7: drafts and voided pay runs have no file", async () => {
      const next = await draft(groups.fortnightly, "2026-10-12", "2026-10-28");
      expect(next.reference).toBe("PAYRUN-5");
      const refused = await makeFile(ben, next.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe("PAYRUN-5 is a draft, so it has no employment information file. Approve it first.");

      const voided = await call(voidRoute.POST, ben, `/api/payroll/pay-runs/${runs.prun1}/void`, {
        method: "POST",
        body: { idempotencyKey: key("void"), voidDate: "2026-10-20" },
        context: params({ payRunId: runs.prun1 }),
      });
      expect(voided.status).toBe(201);
      const afterVoid = await makeFile(ben, runs.prun1);
      expect(afterVoid.status).toBe(409);
      expect(afterVoid.body.error).toBe("PAYRUN-1 is voided, so it has no employment information file. If you filed it, amend it in myIR.");
    });
  });
});
