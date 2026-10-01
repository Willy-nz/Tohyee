import { expect } from "vitest";
import * as accessRoute from "@/app/api/payroll/access/route";
import * as approveRoute from "@/app/api/payroll/pay-runs/[payRunId]/approve/route";
import * as payRunEmployeeRoute from "@/app/api/payroll/pay-runs/[payRunId]/employees/[employeeId]/route";
import * as payRunsRoute from "@/app/api/payroll/pay-runs/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import type { PayRun } from "@/lib/payroll/pay-runs";
import { apiRequest, createTestOrganisation, createTestUser, inOrganisation, key, params, sessionCookieFor } from "./test-server";

/**
 * The people and pay runs the payroll P5 tests (bank files PBF1-PBF7,
 * payslips PSLIP1-PSLIP6) share: Harbour Cafe Ltd, PRUN1's pay run
 * (PAYRUN-1: Hemi Walker and Kiri Tane, fortnightly, pay date 14 Oct 2026)
 * and PRUN3's (PAYRUN-2: Aroha Ngata, four-weekly).
 */

const noContext = undefined as unknown;

export type Handler = (request: Request, context: never) => Promise<Response>;

export type P5World = {
  org: string;
  jess: SessionUser;
  mere: SessionUser;
  ben: SessionUser;
  noah: SessionUser;
  vic: SessionUser;
  people: Record<string, string>;
  groups: Record<string, string>;
  asUser: <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => Promise<T>;
  call: (
    handler: Handler,
    user: SessionUser,
    path: string,
    options?: { method?: string; body?: Record<string, unknown>; context?: unknown },
  ) => Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }>;
  approvedRun: (payGroupId: string, periodStart: string, payDate?: string, lines?: Record<string, unknown[]>) => Promise<PayRun>;
  draftRun: (payGroupId: string, periodStart: string, payDate: string) => Promise<PayRun>;
};

export async function setUpP5World(org: string, domain: string, emails: Record<string, string | null> = {}): Promise<P5World> {
  const jess = await createTestUser(`jess@${domain}`);
  await createTestOrganisation(jess, org);
  const mere = await createTestUser(`mere@${domain}`);
  const ben = await createTestUser(`ben@${domain}`);
  const noah = await createTestUser(`noah@${domain}`);
  const vic = await createTestUser(`vic@${domain}`);
  for (const [user, role] of [
    [mere, "admin"],
    [ben, "bookkeeper"],
    [noah, "bookkeeper"],
    [vic, "viewer"],
  ] as const) {
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [org, user.id, role]);
  }
  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);

  const call: P5World["call"] = async (handler, user, path, options = {}) => {
    const method = options.method ?? "GET";
    const url = method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${org}` : path;
    const response = await handler(
      apiRequest(url, {
        method,
        cookie: await sessionCookieFor(user),
        body: options.body === undefined ? undefined : { organisationId: org, ...options.body },
      }),
      (options.context ?? noContext) as never,
    );
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON (a PDF)
    }
    return { status: response.status, body, text, headers: response.headers };
  };

  for (const user of [mere, ben]) {
    const response = await accessRoute.PUT(
      apiRequest("/api/payroll/access", { method: "PUT", cookie: await sessionCookieFor(jess), body: { organisationId: org, userId: user.id, hasPayrollAccess: true } }),
      noContext,
    );
    expect(response.status).toBe(200);
  }
  await asUser(jess, (tx) => updateOrganisationSettings(tx, { displayName: "Harbour Cafe Ltd", postalAddress: "1 Wharf St, Dunedin" }));

  const group = async (name: string, payFrequency: string) =>
    (await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("group"), name, payFrequency }))).group.id;
  const groups = {
    fortnightly: await group("Fortnightly salaries", "fortnightly"),
    fourWeekly: await group("Four-weekly", "four_weekly"),
    weekly: await group("Weekly wages", "weekly"),
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
          ...overrides,
        }),
      )
    ).employee.id;
  const people: Record<string, string> = {};
  people.hemi = await employee({
    firstName: "Hemi",
    lastName: "Walker",
    payFrequency: "fortnightly",
    annualSalary: "70000.00",
    kiwiSaverStatus: "enrolled",
    esctRate: "30",
    payGroupId: groups.fortnightly,
    bankAccount: "01-0242-0123456-00",
    email: emails.hemi ?? null,
  });
  people.kiri = await employee({
    firstName: "Kiri",
    lastName: "Tane",
    payFrequency: "fortnightly",
    annualSalary: "52000.00",
    payGroupId: groups.fortnightly,
    bankAccount: "12-3191-0654321-01",
    email: emails.kiri ?? null,
  });
  people.aroha = await employee({
    firstName: "Aroha",
    lastName: "Ngata",
    taxCode: "M SL",
    studentLoan: true,
    payFrequency: "four_weekly",
    annualSalary: "45500.00",
    kiwiSaverStatus: "enrolled",
    esctRate: "17.5",
    payGroupId: groups.fourWeekly,
    bankAccount: "02-0108-0987654-000",
    email: emails.aroha ?? null,
  });
  people.sione = await employee({
    firstName: "Sione",
    lastName: "Fifita",
    payFrequency: "weekly",
    payBasis: "hourly",
    hourlyRate: "22.50",
    ordinaryHoursPerWeek: "32",
    kiwiSaverStatus: "enrolled",
    kiwiSaverEmployeeRate: "4",
    esctRate: "17.5",
    payGroupId: groups.weekly,
    bankAccount: "06-0475-0123456-02",
    email: emails.sione ?? null,
  });

  const draftRun = async (payGroupId: string, periodStart: string, payDate: string) => {
    const created = await call(payRunsRoute.POST, ben, "/api/payroll/pay-runs", {
      method: "POST",
      body: { idempotencyKey: key("payrun"), payGroupId, periodStart, payDate },
    });
    expect(created.status).toBe(201);
    return created.body.payRun as PayRun;
  };

  const approvedRun = async (payGroupId: string, periodStart: string, payDate = "2026-10-14", lines: Record<string, unknown[]> = {}) => {
    const payRunId = (await draftRun(payGroupId, periodStart, payDate)).id;
    for (const [employeeId, employeeLines] of Object.entries(lines)) {
      const set = await call(payRunEmployeeRoute.PUT, ben, `/api/payroll/pay-runs/${payRunId}/employees/${employeeId}`, {
        method: "PUT",
        body: { lines: employeeLines },
        context: params({ payRunId, employeeId }),
      });
      expect(set.status).toBe(200);
    }
    const approved = await call(approveRoute.POST, ben, `/api/payroll/pay-runs/${payRunId}/approve`, {
      method: "POST",
      body: { idempotencyKey: key("approve") },
      context: params({ payRunId }),
    });
    expect(approved.status).toBe(201);
    return approved.body.payRun as PayRun;
  };

  return { org, jess, mere, ben, noah, vic, people, groups, asUser, call, approvedRun, draftRun };
}
