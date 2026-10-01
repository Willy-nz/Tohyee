import { afterAll, beforeAll, expect, it } from "vitest";
import * as claimExportRoute from "@/app/api/rd/claim/export/route";
import * as claimRoute from "@/app/api/rd/claim/route";
import * as ruleChangeRoute from "@/app/api/rd/overhead-rules/[ruleId]/change/route";
import * as ruleEndRoute from "@/app/api/rd/overhead-rules/[ruleId]/end/route";
import * as rulesRoute from "@/app/api/rd/overhead-rules/route";
import * as remindersRoute from "@/app/api/rd/reminders/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { createContact } from "@/lib/contacts/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAllocation } from "@/lib/payroll/allocations";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import { listPayItems } from "@/lib/payroll/pay-items";
import { approvePayRun, createPayRun, setPayRunEmployeeLines } from "@/lib/payroll/pay-runs";
import { daysBetween } from "@/lib/rd/amounts";
import { buildClaimReport, type RdClaimReport } from "@/lib/rd/claim";
import type { RdOverheadRule } from "@/lib/rd/overheads";
import { createActivity, createApproval, updateActivity } from "@/lib/rd/register";
import { createTag, listDocumentLines, type RdLine } from "@/lib/rd/tags";
import { createTrackingValue, getTrackingSetup } from "@/lib/tracking/service";
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

const PDF_HEAD = "%PDF-1.7\n%âãÏÓ\n";
function pdfBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x41);
  bytes.set(Buffer.from(PDF_HEAD, "latin1"));
  return bytes;
}

async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const noContext = undefined as never;

/**
 * The RDTI claim report, stage R3: examples RD3, RD4, RD7, RD10, RD16, RD23,
 * RD27 and RD28-RD42 in docs/ACCOUNTING-EXAMPLES.md ("R&D Tax Incentive").
 * Each test gets its own organisation (Kea, 31 March balance date, 2026-27).
 */
describeWithDatabase("R&D claim report (RD28-RD42)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let sam: SessionUser;
  let ana: SessionUser;
  let vic: SessionUser;
  const cookies = new Map<string, string>();
  let organisations = 0;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "rd-claim-integration-test-secret-key-at-least-32";
    server = await startTestServer();
    jess = await createTestUser("rdc-jess@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    sam = await createTestUser("rdc-sam@example.com", { displayName: "Sam Bookkeeper" });
    ana = await createTestUser("rdc-ana@example.com", { displayName: "Ana Admin" });
    vic = await createTestUser("rdc-vic@example.com", { displayName: "Vic Viewer" });
    for (const user of [jess, sam, ana, vic]) cookies.set(user.email, await sessionCookieFor(user));
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  async function setup() {
    organisations += 1;
    const org = `rdc-${organisations}-kea`;
    await createTestOrganisation(jess, org);
    for (const [user, role] of [
      [sam, "bookkeeper"],
      [ana, "admin"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
    }
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const asSam = asUser(sam);

    const call = (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string> | null,
      options: { method?: string; body?: unknown } = {},
    ) => handler(apiRequest(path, { cookie: cookies.get(user.email), ...options }), (routeParams ? params(routeParams) : noContext) as never);

    const multipart = async (
      user: SessionUser,
      handler: (request: Request, context: never) => Promise<Response>,
      path: string,
      routeParams: Record<string, string> | null,
      fields: Record<string, string>,
      file: { name: string; content: Uint8Array } | null,
    ) => {
      const form = new FormData();
      form.set("organisationId", org);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      if (file) form.set("file", new File([new Uint8Array(file.content)], file.name));
      const encoded = new Response(form);
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      const request = new Request(`http://tohyee.test${path}`, {
        method: "POST",
        headers: {
          cookie: cookies.get(user.email)!,
          origin: "http://tohyee.test",
          "content-type": encoded.headers.get("content-type")!,
          "content-length": String(bytes.length),
        },
        body: bytes,
      });
      return handler(request, (routeParams ? params(routeParams) : noContext) as never);
    };

    const activity = async (fields: Record<string, unknown>) =>
      (await asSam((tx) => createActivity(tx, { idempotencyKey: key("activity"), projectName: "Low-power soil sensor", firstIncomeYear: 2027, ...fields }))).activity;
    const approve = (activityIds: string[], first = "2027", last = "2029") =>
      asSam((tx) =>
        createApproval(tx, {
          idempotencyKey: key("approval"),
          kind: "general",
          reference: "RDGA-12345",
          letterDate: todayIsoDate(),
          firstIncomeYear: first,
          lastIncomeYear: last,
          activityIds: activityIds.join(","),
          note: undefined,
          letter: { fileName: "IRD letter.pdf", content: pdfBytes(300) },
        }),
      );
    const c1 = await activity({ code: "C1", name: "Prototype and field-test a low-power soil-moisture sensor", kind: "core", place: "nz" });
    const supplier = async (name: string) => (await as((tx) => createContact(tx, { idempotencyKey: key("contact"), name, isSupplier: true }))).contact;
    const bill = async (contactId: string, billDate: string, lines: Array<Record<string, unknown>>) => {
      const draft = await as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId, billDate, dueDate: billDate, supplierInvoiceNumber: key("INV"), amountsMode: "exclusive", lines }, null),
      );
      return (await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("approve") }))).bill;
    };
    const costLine = async (contactId: string, date: string, amount: string, accountCode = "6140", description = "Sensor components") => {
      const b = await bill(contactId, date, [{ description, quantity: "1", unitPrice: amount, accountCode, taxCode: "GST" }]);
      return (await as((tx) => listDocumentLines(tx, "bill", b.id))).lines[0];
    };
    const tag = async (line: RdLine, fields: Record<string, unknown>) =>
      (await asSam((tx) => createTag(tx, { idempotencyKey: key("tag"), sourceType: line.sourceType, lineId: line.lineId, eligibility: "eligible", category: "materials_overheads", ...fields }))).tag;
    const report = (year: number | null = 2027, user = jess, options: { payrollDetail?: boolean; showReminders?: boolean; today?: string } = {}) =>
      asUser(user)((tx) => buildClaimReport(tx, year, { payrollDetail: true, showReminders: false, ...options }));
    const viaRoute = async (user: SessionUser, year = 2027) => {
      const response = await call(user, claimRoute.GET, `/api/rd/claim?organisationId=${org}&incomeYear=${year}`, null);
      expect(response.status).toBe(200);
      return (await body<{ report: RdClaimReport }>(response)).report;
    };
    return { org, as, asSam, asUser, call, multipart, activity, approve, c1, supplier, bill, costLine, tag, report, viaRoute };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  /** Kea's payroll (RD28-RD30): Hana 100% C1, Ben 60% C1 / 40% Operations, Mere 70% C1 / 30% S1. */
  async function payroll(w: World, s1Id: string) {
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((category) => category.kind === "department")!.id;
    const setupAfter = await w.as((tx) => createTrackingValue(tx, { categoryId: department, name: "Operations" }));
    const operations = setupAfter.categories.find((category) => category.id === department)!.values.find((value) => value.name === "Operations")!.id;
    const group = (await w.as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Fortnightly salaries", payFrequency: "fortnightly" }))).group.id;
    const employee = async (firstName: string, lastName: string, annualSalary: string, extra: Record<string, unknown> = {}) =>
      (
        await w.as((tx) =>
          createEmployee(tx, {
            idempotencyKey: key("employee"),
            firstName,
            lastName,
            taxCode: "M",
            irdNumber: "123456789",
            kiwiSaverStatus: "not_enrolled",
            kiwiSaverEmployeeRate: "3.5",
            kiwiSaverEmployerRate: "3.5",
            studentLoan: false,
            payBasis: "salary",
            payFrequency: "fortnightly",
            annualSalary,
            startDate: "2026-04-01",
            bankAccount: "03-1234-0123456-00",
            payGroupId: group,
            ...extra,
          }),
        )
      ).employee.id;
    const hana = await employee("Hana", "Rewi", "62400.00", { kiwiSaverStatus: "enrolled", esctRate: "30" });
    const ben = await employee("Ben", "Tait", "52000.00");
    const mere = await employee("Mere", "Ngata", "70000.00");
    const allocate = (employeeId: string, lines: unknown[], effectiveFrom = "2026-04-01") =>
      w.as((tx) => addAllocation(tx, employeeId, { idempotencyKey: key("allocation"), effectiveFrom, lines }));
    await allocate(hana, [{ percentage: "100", rdActivityId: w.c1.id }]);
    await allocate(ben, [
      { percentage: "60", rdActivityId: w.c1.id },
      { percentage: "40", departmentId: operations },
    ]);
    await allocate(mere, [
      { percentage: "70", rdActivityId: w.c1.id },
      { percentage: "30", rdActivityId: s1Id },
    ]);
    const items = await w.as((tx) => listPayItems(tx));
    const item = (kind: string) => items.find((entry) => entry.kind === kind)!.id;
    const run = (await w.as((tx) => createPayRun(tx, { idempotencyKey: key("payrun"), payGroupId: group, periodStart: "2026-07-06", payDate: "2026-07-22" }))).payRun;
    await w.as((tx) =>
      setPayRunEmployeeLines(tx, run.id, hana, {
        lines: [
          { payItemId: item("ordinary_time"), amount: "2400.00" },
          { payItemId: item("reimbursement"), amount: "50.00", description: "Soil test kits" },
        ],
      }),
    );
    const approved = (await w.as((tx) => approvePayRun(tx, run.id, { idempotencyKey: key("approve") }))).payRun;
    return { hana, ben, mere, operations, run: approved, allocate };
  }

  it("RD28-RD32: pay counts from the allocation the pay run used, only when it's 100% R&D, rounded down", async () => {
    const w = await setup();
    const s1 = await w.activity({ code: "S1", name: "Literature and patent search", kind: "supporting", supports: [w.c1.id] });
    await w.approve([w.c1.id, s1.id]);
    const p = await payroll(w, s1.id);
    expect(p.run.employees.find((entry) => entry.employeeId === p.hana)!.pay).toMatchObject({ kiwiSaverEmployer: "84.00" });

    const r = await w.report();
    const c1 = r.activities.find((row) => row.activity.code === "C1")!;
    const s1Row = r.activities.find((row) => row.activity.code === "S1")!;
    // RD28 2,484.00 + RD30 1,884.61 to C1; RD30 807.69 to S1.
    expect(c1.categories.employee).toBe("4368.61");
    expect(s1Row.categories.employee).toBe("807.69");
    expect(r.payroll).toMatchObject({ detail: true, counted: "5176.30", defaultSplit: "1200.00", excluded: "50.00" });
    const pays = r.payroll.pays!;
    const hanaPay = pays.find((pay) => pay.employeeId === p.hana)!;
    expect(hanaPay).toMatchObject({ employeeName: "Hana Rewi", cost: "2484.00", excluded: "50.00", fullTimeRd: true, notRd: "0.00", payRunReference: p.run.reference });
    expect(hanaPay.shares).toMatchObject([{ activityId: w.c1.id, percentage: "100.00", amount: "2484.00", source: "allocation", counts: true }]);
    const merePay = pays.find((pay) => pay.employeeId === p.mere)!;
    expect(merePay).toMatchObject({ cost: "2692.31", fullTimeRd: true, notRd: "0.01" });
    expect(merePay.shares.map((share) => share.amount)).toEqual(["1884.61", "807.69"]);
    // RD29: Ben's 60% is listed, not counted.
    const benPay = pays.find((pay) => pay.employeeId === p.ben)!;
    expect(benPay).toMatchObject({ cost: "2000.00", fullTimeRd: false });
    const defaultSplit = r.notCounted.find((group) => group.reason === "default_split")!;
    expect(defaultSplit).toMatchObject({ label: "Default split, no time record", amount: "1200.00" });
    expect(defaultSplit.items).toMatchObject([{ employeeName: "Ben Tait", amount: "1200.00", activityCode: "C1" }]);
    expect(r.notes).toContain("Reimbursements of 50.00 on pay runs aren't employee costs and aren't counted (decision 66).");

    // RD32: the allocations were entered today, after the period ending 19 Jul 2026.
    const days = daysBetween("2026-07-19", todayIsoDate());
    expect(hanaPay.daysAfterPeriod).toBe(days);
    expect(hanaPay.enteredLate).toBe(days > 14);
    expect(hanaPay.timelinessText).toBe(`allocation entered ${days} days after the pay period`);

    // RD31: a backdated allocation entered after approval doesn't change the posted pay.
    await p.allocate(p.hana, [
      { percentage: "50", rdActivityId: w.c1.id },
      { percentage: "50", departmentId: p.operations },
    ]);
    const again = await w.report();
    expect(again.payroll.pays!.find((pay) => pay.employeeId === p.hana)).toMatchObject({ fullTimeRd: true, shares: [{ amount: "2484.00" }] });
    expect(again.activities.find((row) => row.activity.code === "C1")!.categories.employee).toBe("4368.61");
    // Nothing posted by the report.
    expect(again.figures.status).toBe("under_minimum");

    // A pay run approved before timesheets (P9) kept no shares: the report finds the allocation it used (decision 67).
    await w.as(async (tx) => {
      await tx.query("alter table payroll_pay_run_shares disable trigger user");
      await tx.query("delete from payroll_pay_run_shares where pay_run_id = $1", [p.run.id]);
      await tx.query("alter table payroll_pay_run_shares enable trigger user");
    });
    const older = await w.report();
    expect(older.payroll).toMatchObject({ counted: "5176.30", defaultSplit: "1200.00" });
    expect(older.payroll.pays!.find((pay) => pay.employeeId === p.mere)!.shares.map((share) => share.amount)).toEqual(["1884.61", "807.69"]);
    expect(older.payroll.pays!.find((pay) => pay.employeeId === p.hana)).toMatchObject({ fullTimeRd: true, usesTimesheets: false, shares: [{ amount: "2484.00", counts: true }] });
  });

  it("RD33: without payroll access, employee costs show as totals and the CSV names nobody", async () => {
    const w = await setup();
    const s1 = await w.activity({ code: "S1", name: "Literature and patent search", kind: "supporting", supports: [w.c1.id] });
    await w.approve([w.c1.id, s1.id]);
    await payroll(w, s1.id);

    for (const user of [sam, vic]) {
      const r = await w.viaRoute(user);
      expect(r.payroll).toMatchObject({ detail: false, pays: null, counted: "5176.30", defaultSplit: "1200.00" });
      const c1 = r.activities.find((row) => row.activity.code === "C1")!;
      expect(c1.categories.employee).toBe("4368.61");
      expect(c1.items.filter((item) => item.source === "payroll")).toMatchObject([{ amount: "4368.61", payCount: 2, employeeName: null }]);
      expect(JSON.stringify(r)).not.toContain("Hana");
      expect(JSON.stringify(r)).not.toContain("Tait");
      expect(r.reminders).toBeNull();
    }
    const jessView = await w.viaRoute(jess);
    expect(jessView.payroll.detail).toBe(true);
    expect(JSON.stringify(jessView)).toContain("Hana Rewi");
    expect(Array.isArray(jessView.reminders)).toBe(true);

    const exportAs = async (user: SessionUser) => {
      const response = await w.call(user, claimExportRoute.POST, "/api/rd/claim/export", null, { method: "POST", body: { organisationId: w.org, incomeYear: 2027 } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/csv");
      expect(response.headers.get("content-disposition")).toContain("rd-claim-2026-27.csv");
      return response.text();
    };
    const samCsv = await exportAs(sam);
    expect(samCsv).not.toContain("Hana");
    expect(samCsv).toContain("Pay runs (each employee's pay needs payroll access)");
    const jessCsv = await exportAs(jess);
    expect(jessCsv).toContain("Hana Rewi");
    // The export kept in history has no employee in it either (decision 74).
    const history = await w.as((tx) => tx.query<{ snapshot: unknown }>("select snapshot from rd_history where record_type = 'claim_export'"));
    expect(history.rows).toHaveLength(2);
    expect(JSON.stringify(history.rows)).not.toContain("Hana");
  });

  it("RD34: an overhead rule needs a basis, a description and the workings; it's applied to untagged lines, rounded down", async () => {
    const w = await setup();
    const s1 = await w.activity({ code: "S1", name: "Literature and patent search", kind: "supporting", supports: [w.c1.id] });
    await w.approve([w.c1.id, s1.id]);
    const landlord = await w.supplier("Harbour Property Ltd");
    for (const date of ["2026-04-01", "2026-05-01", "2026-06-01"]) await w.costLine(landlord.id, date, "4000.00", "6150", "Rent");
    const july = await w.costLine(landlord.id, "2026-07-01", "4000.00", "6150", "Rent");
    await w.tag(july, { activityId: s1.id, percentage: "20" });

    const fields = { idempotencyKey: key("rule"), accountCode: "6150", activityId: w.c1.id, percentage: "15", basis: "floor_area", basisDetail: "Lab 30 m² of 200 m²", effectiveFrom: "2026-04-01" };
    const plan = { name: "floor plan.pdf", content: pdfBytes(400) };
    const post = (user: SessionUser, extra: Record<string, string>, file: typeof plan | null = plan) =>
      w.multipart(user, rulesRoute.POST, "/api/rd/overhead-rules", null, { ...fields, idempotencyKey: key("rule"), ...extra }, file);
    const refusal = async (response: Response) => {
      expect(response.status).toBe(400);
      return (await body<{ error: string }>(response)).error;
    };
    expect(await refusal(await post(sam, {}, null))).toBe("Attach the workings that show how the % was worked out (IR1240 p 15, p 102).");
    expect(await refusal(await post(sam, { basis: "" }))).toBe("Choose the basis for the percentage (IR1240 p 15).");
    expect(await refusal(await post(sam, { basisDetail: " " }))).toContain("Say how the percentage was worked out");
    expect(await refusal(await post(sam, { accountCode: "2200" }))).toBe("An overhead rule needs an expense account.");
    expect((await post(vic, {})).status).toBe(403);

    const created = await post(sam, {});
    expect(created.status).toBe(201);
    const rule = (await body<{ rule: RdOverheadRule }>(created)).rule;
    expect(rule).toMatchObject({ accountCode: "6150", percentage: "15.00", basis: "floor_area", basisLabel: "Floor area used for the R&D", createdByEmail: sam.email, status: "active" });
    expect(rule.files.map((file) => file.fileName)).toEqual(["floor plan.pdf"]);
    // The database refuses a rule without workings, and a changed percentage.
    await expect(
      w.as((tx) =>
        tx.query(
          `insert into rd_overhead_rules (idempotency_key, request_hash, account_id, activity_id, percentage, basis, basis_detail, effective_from, created_by_email, updated_by_email)
           select 'raw', 'x', id, $1, 10, 'time', 'x', '2026-04-01', 'x', 'x' from accounts where code = '6150'`,
          [s1.id],
        ),
      ),
    ).rejects.toThrow(/workings/);
    await expect(w.as((tx) => tx.query("update rd_overhead_rules set percentage = 20 where id = $1", [rule.id]))).rejects.toThrow(/kept as entered/);
    await expect(w.as((tx) => tx.query("delete from rd_overhead_rules where id = $1", [rule.id]))).rejects.toThrow();

    // Over 100% on an account, or a second rule for the same activity, is refused.
    expect(await refusal(await post(sam, { activityId: s1.id, percentage: "90", effectiveFrom: "2026-05-01" }))).toBe(
      "The rules on this account would total 105.00% on 2026-05-01. An account's rules can total at most 100%.",
    );
    const duplicate = await post(sam, { effectiveFrom: "2026-06-01" });
    expect(duplicate.status).toBe(409);

    const r = await w.report();
    const applied = r.overheads.find((entry) => entry.rule.id === rule.id)!;
    expect(applied.shares.map((share) => [share.postedOn, share.lineAmount, share.amount])).toEqual([
      ["2026-04-01", "4000.00", "600.00"],
      ["2026-05-01", "4000.00", "600.00"],
      ["2026-06-01", "4000.00", "600.00"],
    ]);
    expect(applied.amount).toBe("1800.00");
    expect(applied.skipped.map((line) => line.postedOn)).toEqual(["2026-07-01"]);
    expect(r.activities.find((row) => row.activity.code === "C1")!.categories.materials_overheads).toBe("1800.00");
    expect(r.activities.find((row) => row.activity.code === "S1")!.categories.materials_overheads).toBe("800.00");
  });

  it("RD35: changing a rule keeps the old one; from the same date the report shows the earlier figure, from a later date both apply", async () => {
    const w = await setup();
    await w.approve([w.c1.id]);
    const landlord = await w.supplier("Harbour Property Ltd");
    for (const date of ["2026-04-01", "2026-05-01", "2026-06-01"]) await w.costLine(landlord.id, date, "4000.00", "6150", "Rent");
    const plan = { name: "floor plan.pdf", content: pdfBytes(400) };
    const create = await w.multipart(
      jess,
      rulesRoute.POST,
      "/api/rd/overhead-rules",
      null,
      { idempotencyKey: key("rule"), accountCode: "6150", activityId: w.c1.id, percentage: "15", basis: "floor_area", basisDetail: "Lab 30 m² of 200 m²", effectiveFrom: "2026-04-01" },
      plan,
    );
    const first = (await body<{ rule: RdOverheadRule }>(create)).rule;
    const change = (ruleId: string, fields: Record<string, string>, file: typeof plan | null = { name: "new plan.pdf", content: pdfBytes(410) }) =>
      w.multipart(jess, ruleChangeRoute.POST, `/api/rd/overhead-rules/${ruleId}/change`, { ruleId }, { idempotencyKey: key("change"), basis: "floor_area", basisDetail: "Lab 40 m² of 200 m²", ...fields }, file);

    expect((await change(first.id, { percentage: "20", effectiveFrom: "2026-03-01" })).status).toBe(400);
    expect((await change(first.id, { percentage: "20", effectiveFrom: "2026-04-01" }, null)).status).toBe(400);
    const retro = await change(first.id, { percentage: "20", effectiveFrom: "2026-04-01" });
    expect(retro.status).toBe(201);
    const second = (await body<{ rule: RdOverheadRule }>(retro)).rule;
    expect(second).toMatchObject({ percentage: "20.00", replacesId: first.id, effectiveFrom: "2026-04-01", enteredAfterStart: true });
    // The old rule is kept, marked replaced, and can't be changed again.
    expect((await change(first.id, { percentage: "25", effectiveFrom: "2026-04-01" })).status).toBe(400);
    const retroReport = await w.report();
    const applied = retroReport.overheads.find((entry) => entry.rule.id === second.id)!;
    expect(applied.amount).toBe("2400.00");
    expect(applied.previous).toMatchObject({ amount: "1800.00", rule: { id: first.id, status: "replaced", percentage: "15.00" } });
    expect(retroReport.overheads.map((entry) => entry.rule.id)).toEqual([second.id]);
    expect(retroReport.activities[0].categories.materials_overheads).toBe("2400.00");

    // From a later date the earlier rule ends the day before and still applies.
    const later = await change(second.id, { percentage: "25", effectiveFrom: "2026-06-01" });
    expect(later.status).toBe(201);
    const third = (await body<{ rule: RdOverheadRule }>(later)).rule;
    const laterReport = await w.report();
    expect(laterReport.overheads.map((entry) => [entry.rule.percentage, entry.rule.effectiveFrom, entry.rule.effectiveTo, entry.amount, entry.previous])).toEqual([
      ["20.00", "2026-04-01", "2026-05-31", "1600.00", { amount: "1800.00", rule: expect.objectContaining({ id: first.id }) }],
      ["25.00", "2026-06-01", null, "1000.00", null],
    ]);
    expect(laterReport.activities[0].categories.materials_overheads).toBe("2600.00");

    // Ending a rule keeps it; it applies up to its last day.
    const ended = await w.call(jess, ruleEndRoute.POST, `/api/rd/overhead-rules/${third.id}/end`, { ruleId: third.id }, {
      method: "POST",
      body: { organisationId: w.org, effectiveTo: "2026-05-31" },
    });
    expect(ended.status).toBe(400);
    const endedOk = await w.call(jess, ruleEndRoute.POST, `/api/rd/overhead-rules/${third.id}/end`, { ruleId: third.id }, {
      method: "POST",
      body: { organisationId: w.org, effectiveTo: "2026-06-30" },
    });
    expect(endedOk.status).toBe(200);
    expect((await body<{ rule: RdOverheadRule }>(endedOk)).rule.history.map((entry) => entry.action)).toEqual(["created", "ended"]);
    const list = await w.call(vic, rulesRoute.GET, `/api/rd/overhead-rules?organisationId=${w.org}`, null);
    expect((await body<{ rules: RdOverheadRule[] }>(list)).rules.map((rule) => [rule.percentage, rule.status])).toEqual([
      ["15.00", "replaced"],
      ["20.00", "active"],
      ["25.00", "active"],
    ]);
  });

  it("RD3, RD16, RD36: only approved activities count; the overseas limit is shared across categories; the credit is rounded down", async () => {
    const w = await setup();
    const s2 = await w.activity({ code: "S2", name: "Sensor calibration at Calibra Labs, Australia", kind: "supporting", place: "overseas", supports: [w.c1.id] });
    const parts = await w.supplier("Sensor Parts Ltd");
    const calibra = await w.supplier("Calibra Labs Pty Ltd");
    await w.tag(await w.costLine(parts.id, "2026-07-20", "73200.00"), { activityId: w.c1.id });
    await w.tag(await w.costLine(calibra.id, "2026-08-01", "5000.00", "6140", "Calibration"), { activityId: s2.id, category: "contract" });
    await w.tag(await w.costLine(calibra.id, "2026-08-02", "4000.00", "6140", "Calibration materials"), { activityId: s2.id });

    // RD3: before an approval is entered, nothing counts.
    const before = await w.report();
    expect(before.figures).toMatchObject({ totalEligible: "0.00", credit: "0.00", status: "nothing" });
    expect(before.notCounted.find((group) => group.reason === "no_approval")).toMatchObject({ label: "No approval entered for 2026-27", amount: "82200.00" });

    await w.approve([w.c1.id, s2.id]);
    const r = await w.report();
    expect(r.figures).toMatchObject({
      nzTotal: "73200.00",
      overseasSpent: "9000.00",
      overseasLimit: "8133.33",
      overseasOverLimit: "866.67",
      totalEligible: "81333.33",
      status: "meets_minimum",
      credit: "12199.99",
      coreShare: "90.00",
    });
    expect(r.figures.projects[0].categories).toMatchObject({ materials_overheads: "76814.81", contract: "4518.52" });
    expect(r.figures.buckets.filter((bucket) => bucket.overseas).map((bucket) => [bucket.category, bucket.counted])).toEqual([
      ["materials_overheads", "3614.81"],
      ["contract", "4518.52"],
    ]);
    // The deadlines for a 31 March balance date (RD24).
    expect(r.deadlines.supported && r.deadlines.deadlines.find((entry) => entry.kind === "supplementary_return")).toMatchObject({ dueDate: "2027-08-06" });
  });

  it("RD37, RD38: supporting activity before its core activity moves to the core activity's year; without an approved core activity it doesn't count", async () => {
    const w = await setup();
    const s1 = await w.activity({ code: "S1", name: "Literature and patent search", kind: "supporting", supports: [w.c1.id], firstIncomeYear: 2026 });
    const c2 = await w.activity({ code: "C2", name: "Battery chemistry", kind: "core", projectName: "Battery" });
    const s3 = await w.activity({ code: "S3", name: "Sensor housing materials survey", kind: "supporting", supports: [c2.id], projectName: "Battery" });
    await w.approve([w.c1.id, s1.id, s3.id]);
    const library = await w.supplier("Patent Search Ltd");
    await w.tag(await w.costLine(library.id, "2026-03-15", "600.00", "6140", "Patent search"), { activityId: s1.id });
    await w.tag(await w.costLine(library.id, "2026-08-15", "450.00", "6140", "Materials survey"), { activityId: s3.id });

    const earlier = await w.report(2026);
    expect(earlier.notCounted.find((group) => group.reason === "claim_next_year")).toMatchObject({
      label: "Supporting activity before its core activity: claim with 2026-27",
      amount: "600.00",
    });
    expect(earlier.figures.totalEligible).toBe("0.00");

    const r = await w.report(2027);
    expect(r.activities.find((row) => row.activity.code === "S1")).toMatchObject({ counted: "600.00", items: [expect.objectContaining({ carriedIn: true, incomeYear: 2026 })] });
    // Under the $50,000 minimum, so it's counted but not claimed.
    expect(r.figures.buckets.find((bucket) => bucket.carriedIn)).toMatchObject({ activityCode: "S1", amount: "600.00", counted: "600.00", claimed: "0.00" });
    expect(r.figures.totalEligible).toBe("600.00");
    expect(r.notCounted.find((group) => group.reason === "no_core_activity")).toMatchObject({
      label: "Supporting activity: none of the core activities it supports has an approval for 2026-27",
      amount: "450.00",
    });
  });

  it("RD39: feedstock and non-employee commercial production are listed and left out; commercial production on employee costs counts", async () => {
    const w = await setup();
    await w.approve([w.c1.id]);
    const parts = await w.supplier("Sensor Parts Ltd");
    await w.tag(await w.costLine(parts.id, "2026-07-01", "60000.00"), { activityId: w.c1.id });
    await w.tag(await w.costLine(parts.id, "2026-07-02", "2500.00", "6140", "Trial batch components"), { activityId: w.c1.id, feedstock: true });
    await w.tag(await w.costLine(parts.id, "2026-07-03", "1000.00", "6140", "Production-line parts"), { activityId: w.c1.id, commercialProduction: true });
    await w.tag(await w.costLine(parts.id, "2026-07-04", "500.00", "6140", "Recruitment fee"), { activityId: w.c1.id, category: "employee", commercialProduction: true });
    const r = await w.report();
    expect(r.notCounted.map((group) => [group.reason, group.amount])).toEqual([
      ["feedstock", "2500.00"],
      ["commercial_production", "1000.00"],
    ]);
    expect(r.figures).toMatchObject({ totalEligible: "60500.00", credit: "9075.00" });
    expect(r.figures.projects[0]).toMatchObject({ commercialProduction: "500.00" });
  });

  it("RD42: an export keeps the summary with who and when, and the report shows what changed since", async () => {
    const w = await setup();
    await w.approve([w.c1.id]);
    const parts = await w.supplier("Sensor Parts Ltd");
    await w.tag(await w.costLine(parts.id, "2026-07-01", "60000.00"), { activityId: w.c1.id });
    expect((await w.report()).lastExport).toBeNull();
    const exported = await w.call(jess, claimExportRoute.POST, "/api/rd/claim/export", null, { method: "POST", body: { organisationId: w.org, incomeYear: 2027 } });
    const csv = await exported.text();
    expect(csv.split("\r\n")[0]).toBe("Section,Project,Activity,Category,Date,Description,Employee,Amount");
    expect(csv).toContain("Claim,,,R&D tax credit,,,,9000.00");
    expect(csv).toContain('Return,Low-power soil sensor,,"Materials, consumables and overheads",,,,60000.00');

    const unchanged = await w.report();
    expect(unchanged.lastExport).toMatchObject({ exportedByEmail: jess.email, differences: [] });
    await w.tag(await w.costLine(parts.id, "2026-07-02", "1000.00"), { activityId: w.c1.id });
    const changed = await w.report();
    expect(changed.lastExport!.differences).toEqual(
      expect.arrayContaining([
        { figure: "Materials, consumables and overheads (Low-power soil sensor)", before: "60000.00", after: "61000.00" },
        { figure: "Total eligible R&D expenditure", before: "60000.00", after: "61000.00" },
        { figure: "R&D tax credit", before: "9000.00", after: "9150.00" },
      ]),
    );
    const history = await w.as((tx) => tx.query<{ action: string; changed_by_email: string }>("select action, changed_by_email from rd_history where record_type = 'claim_export'"));
    expect(history.rows).toEqual([{ action: "exported", changed_by_email: jess.email }]);
  });

  it("RD27, RD41: the report is read-only, flags material changes, and only owners and admins get reminders", async () => {
    const w = await setup();
    await w.approve([w.c1.id]);
    const parts = await w.supplier("Sensor Parts Ltd");
    await w.tag(await w.costLine(parts.id, "2026-07-01", "60000.00"), { activityId: w.c1.id });
    await w.asSam((tx) => updateActivity(tx, w.c1.id, { version: 1, systematicApproach: "Changed method after approval." }));
    const journals = async () => Number((await w.as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    const before = await journals();
    const r = await w.report(2027, jess, { showReminders: true, today: "2027-05-01" });
    expect(await journals()).toBe(before);
    expect(r.materialChanges).toEqual([
      "C1 (Low-power soil sensor) changed since its approval was entered, so the supplementary return's “no material change” declaration can't be prefilled for that project (RD3, RD27).",
    ]);
    expect(r.reminders!.map((reminder) => reminder.kind)).toEqual(["material_change_variation"]);

    expect((await w.call(sam, remindersRoute.GET, `/api/rd/reminders?organisationId=${w.org}`, null)).status).toBe(403);
    const admin = await w.call(ana, remindersRoute.GET, `/api/rd/reminders?organisationId=${w.org}`, null);
    expect(admin.status).toBe(200);
    expect(Array.isArray((await body<{ reminders: unknown[] }>(admin)).reminders)).toBe(true);
    expect((await claimRoute.GET(apiRequest(`/api/rd/claim?organisationId=${w.org}`), noContext)).status).toBe(401);
  });
});
