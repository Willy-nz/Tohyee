import { afterAll, beforeAll, expect, it } from "vitest";
import * as employeeRoute from "@/app/api/payroll/employees/[employeeId]/route";
import * as employeesRoute from "@/app/api/payroll/employees/route";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  createEmployee,
  getEmployee,
  listEmployees,
  setEmployeeArchived,
  updateEmployee,
} from "@/lib/payroll/employees";
import { requestHash } from "@/lib/idempotency";
import { keyedSecretHash } from "@/lib/secrets";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
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

const ORG = "payroll-employees-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describeWithDatabase("payroll employee records (PR1, PR2)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const employeeInput = {
    firstName: "Aroha",
    lastName: "Ngata",
    email: "aroha@example.nz",
    phone: "021 555 0123",
    postalAddress: "12 Example Street, Wellington 6011",
    dateOfBirth: "1990-02-03",
    taxCode: "M",
    irdNumber: "123456789",
    kiwiSaverStatus: "enrolled",
    kiwiSaverEmployeeRate: "4",
    kiwiSaverEmployerRate: "3.5",
    studentLoan: true,
    payFrequency: "fortnightly",
    payBasis: "salary",
    annualSalary: "70000.00",
    hourlyRate: null,
    ordinaryHoursPerWeek: null,
    startDate: "2026-04-01",
    finishDate: null,
    bankAccount: "03-1234-0123456-00",
  };

  const addEmployee = (idempotencyKey = key("employee")) =>
    asUser(bookkeeper, (tx) => createEmployee(tx, { idempotencyKey, ...employeeInput }));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    owner = await createTestUser("payroll-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    bookkeeper = await createTestUser("payroll-bookkeeper@example.com");
    viewer = await createTestUser("payroll-viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [
      ORG,
      bookkeeper.id,
      "bookkeeper",
    ]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [
      ORG,
      viewer.id,
      "viewer",
    ]);
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  it("PR1: saves a payroll profile with IRD and bank details encrypted, and no secret in list or audit output", async () => {
    const commandKey = key("employee");
    const created = await addEmployee(commandKey);
    expect(created.created).toBe(true);
    expect(created.employee).toMatchObject({
      firstName: "Aroha",
      lastName: "Ngata",
      taxCode: "M",
      irdNumber: "123456789",
      kiwiSaverStatus: "enrolled",
      kiwiSaverEmployeeRate: "4",
      kiwiSaverEmployerRate: "3.5",
      studentLoan: true,
      payFrequency: "fortnightly",
      payBasis: "salary",
      annualSalary: "70000",
      startDate: "2026-04-01",
      bankAccount: "03-1234-0123456-00",
    });

    const stored = await asUser(owner, (tx) =>
      tx.query<{ ird_number_ciphertext: string; bank_account_ciphertext: string; request_hash: string }>(
        "select ird_number_ciphertext, bank_account_ciphertext, request_hash from payroll_employees where id = $1",
        [created.employee.id],
      ),
    );
    expect(stored.rows[0].ird_number_ciphertext).not.toContain("123456789");
    expect(stored.rows[0].bank_account_ciphertext).not.toContain("03-1234-0123456-00");
    const unhashed = requestHash("payroll_employee", { idempotencyKey: commandKey, ...employeeInput });
    expect(stored.rows[0].request_hash).toBe(keyedSecretHash(unhashed));
    expect(stored.rows[0].request_hash).not.toBe(unhashed);

    const summary = (await asUser(viewer, (tx) => listEmployees(tx))).find((employee) => employee.id === created.employee.id);
    expect(summary).toMatchObject({ firstName: "Aroha", hasIrdNumber: true, hasBankAccount: true });
    expect(summary).not.toHaveProperty("irdNumber");
    expect(summary).not.toHaveProperty("bankAccount");

    const events = await asUser(owner, (tx) =>
      tx.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where entity_type = 'payroll_employee' and entity_id = $1",
        [created.employee.id],
      ),
    );
    expect(JSON.stringify(events.rows)).not.toContain("123456789");
    expect(JSON.stringify(events.rows)).not.toContain("03-1234-0123456-00");
  });

  it("PR1: hourly employees require a positive hourly rate and ordinary hours, and reject salary fields", async () => {
    await expect(
      asUser(bookkeeper, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          ...employeeInput,
          payBasis: "hourly",
          annualSalary: null,
          hourlyRate: "0",
          ordinaryHoursPerWeek: "30",
        }),
      ),
    ).rejects.toThrow(/hourly rate must not be zero/i);

    await expect(
      asUser(bookkeeper, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          ...employeeInput,
          payBasis: "hourly",
          annualSalary: null,
          hourlyRate: "25",
          ordinaryHoursPerWeek: null,
        }),
      ),
    ).rejects.toThrow(/ordinary hours per week is required/i);

    await expect(
      asUser(bookkeeper, (tx) =>
        createEmployee(tx, {
          idempotencyKey: key("employee"),
          ...employeeInput,
          payBasis: "hourly",
          annualSalary: "70000",
          hourlyRate: "25",
          ordinaryHoursPerWeek: "30",
        }),
      ),
    ).rejects.toThrow(/hourly employees can't also have an annual salary/i);

    await expect(
      asUser(bookkeeper, (tx) =>
        createEmployee(tx, { idempotencyKey: key("employee"), ...employeeInput, annualSalary: "70000.001" }),
      ),
    ).rejects.toThrow(/at most 2 decimal places/i);
  });

  it("PR1: retries are idempotent and updates retain secrets when secret fields are omitted", async () => {
    const commandKey = key("employee");
    const first = await asUser(bookkeeper, (tx) => createEmployee(tx, { idempotencyKey: commandKey, ...employeeInput }));
    const retry = await asUser(bookkeeper, (tx) => createEmployee(tx, { idempotencyKey: commandKey, ...employeeInput }));
    expect(retry).toMatchObject({ created: false, employee: { id: first.employee.id } });
    await expect(
      asUser(bookkeeper, (tx) =>
        createEmployee(tx, { idempotencyKey: commandKey, ...employeeInput, firstName: "Different" }),
      ),
    ).rejects.toThrow(/already used for a different employee/i);

    const edited = await asUser(bookkeeper, (tx) => updateEmployee(tx, first.employee.id, { phone: "021 555 9999" }));
    expect(edited).toMatchObject({ phone: "021 555 9999" });
    expect((await asUser(bookkeeper, (tx) => getEmployee(tx, first.employee.id))).irdNumber).toBe("123456789");
  });

  it("PR2: archives and restores an employee without deleting their record", async () => {
    const { employee } = await addEmployee();
    await asUser(bookkeeper, (tx) => updateEmployee(tx, employee.id, { finishDate: "2026-09-30" }));
    expect((await asUser(bookkeeper, (tx) => setEmployeeArchived(tx, employee.id, true))).isArchived).toBe(true);
    expect((await asUser(viewer, (tx) => listEmployees(tx))).map((row) => row.id)).not.toContain(employee.id);
    expect(
      (await asUser(viewer, (tx) => listEmployees(tx, { includeArchived: true }))).find((row) => row.id === employee.id),
    ).toMatchObject({ isArchived: true, finishDate: "2026-09-30" });
    expect((await asUser(bookkeeper, (tx) => setEmployeeArchived(tx, employee.id, false))).isArchived).toBe(false);
    await expect(
      asUser(owner, (tx) => tx.query("delete from payroll_employees where id = $1", [employee.id])),
    ).rejects.toThrow(/can't be deleted or truncated/i);
    await expect(asUser(owner, (tx) => tx.query("truncate payroll_employees"))).rejects.toThrow(/can't be deleted or truncated/i);
  });

  it("requires bookkeeper access even to list employee records", async () => {
    const viewerCookie = await sessionCookieFor(viewer);
    const response = await employeesRoute.GET(
      apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(response.status).toBe(403);
  });

  it("the employee routes use the signed-in user's access and return decrypted details only from the detail route", async () => {
    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const viewerCookie = await sessionCookieFor(viewer);
    const createdResponse = await employeesRoute.POST(
      apiRequest("/api/payroll/employees", {
        method: "POST",
        cookie: bookkeeperCookie,
        body: { organisationId: ORG, idempotencyKey: key("http-employee"), ...employeeInput },
      }),
      noContext,
    );
    expect(createdResponse.status).toBe(201);
    const employee = (await body(createdResponse)).employee as { id: string };

    const summaries = await employeesRoute.GET(
      apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: bookkeeperCookie }),
      noContext,
    );
    const summaryBody = JSON.stringify(await body(summaries));
    expect(summaryBody).not.toContain("123456789");
    expect(summaryBody).not.toContain("03-1234-0123456-00");

    const detail = await employeeRoute.GET(
      apiRequest(`/api/payroll/employees/${employee.id}?organisationId=${ORG}`, { cookie: bookkeeperCookie }),
      params({ employeeId: employee.id }),
    );
    expect((await body(detail)).employee).toMatchObject({ irdNumber: "123456789", bankAccount: "03-1234-0123456-00" });

    const denied = await employeeRoute.GET(
      apiRequest(`/api/payroll/employees/${employee.id}?organisationId=${ORG}`, { cookie: viewerCookie }),
      params({ employeeId: employee.id }),
    );
    expect(denied.status).toBe(403);
  });

  it("applies the tenant migration used by employee records", async () => {
    expect(tenantMigrations.map((migration) => migration.version)).toContain("0051");
    const table = await asUser(owner, (tx) => tx.query("select id from payroll_employees limit 1"));
    expect(table.rowCount).toBeGreaterThanOrEqual(0);
  });
});
