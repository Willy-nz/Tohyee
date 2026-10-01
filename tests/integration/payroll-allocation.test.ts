import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as allocationsRoute from "@/app/api/payroll/employees/[employeeId]/allocations/route";
import * as payRatesRoute from "@/app/api/payroll/employees/[employeeId]/pay-rates/route";
import * as employeeRoute from "@/app/api/payroll/employees/[employeeId]/route";
import * as employeesRoute from "@/app/api/payroll/employees/route";
import * as accessMeRoute from "@/app/api/payroll/access/me/route";
import * as accessRoute from "@/app/api/payroll/access/route";
import * as groupsRoute from "@/app/api/payroll/groups/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { migrateOrganisation } from "@/lib/db/migrations";
import { getOrganisation } from "@/lib/organisations/registry";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { addAllocation, allocationOn, listAllocations } from "@/lib/payroll/allocations";
import { createEmployee, getEmployee, listEmployees, updateEmployee } from "@/lib/payroll/employees";
import {
  createEmployeeGroup,
  createPayGroup,
  listPayrollGroups,
  updatePayGroup,
} from "@/lib/payroll/groups";
import { hasPayrollAccess, requirePayrollAccess } from "@/lib/payroll/access";
import { addPayRate, listPayRates, payRateOn } from "@/lib/payroll/pay-rates";
import { createProject } from "@/lib/projects/service";
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

const ORG = "payroll-allocation-co";
const noContext = undefined as unknown;

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Examples PE3 and PE5-PE13 in docs/ACCOUNTING-EXAMPLES.md ("NZ payroll —
 * cost allocation, pay rates, job details and payroll access").
 */
describeWithDatabase("payroll cost allocation, pay rates and payroll access (PE3, PE5-PE13)", () => {
  let server: TestServer;
  let jess: SessionUser; // first owner
  let mere: SessionUser; // admin
  let ben: SessionUser; // bookkeeper
  let vic: SessionUser; // viewer
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const v: Record<string, string> = {};
  let projectId = "";

  const asUser = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  const employeeInput = {
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
    annualSalary: "70000.00",
    startDate: "2026-04-01",
    bankAccount: "03-1234-0123456-00",
  };

  const addEmployee = (overrides: Record<string, unknown> = {}) =>
    asUser(jess, (tx) => createEmployee(tx, { idempotencyKey: key("employee"), ...employeeInput, ...overrides }));

  const giveAccess = async (to: SessionUser, by: SessionUser, hasAccess = true) => {
    const response = await accessRoute.PUT(
      apiRequest("/api/payroll/access", {
        method: "PUT",
        cookie: await sessionCookieFor(by),
        body: { organisationId: ORG, userId: to.id, hasPayrollAccess: hasAccess },
      }),
      noContext,
    );
    return response;
  };

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("jess@payroll.test");
    await createTestOrganisation(jess, ORG);
    mere = await createTestUser("mere@payroll.test");
    ben = await createTestUser("ben@payroll.test");
    vic = await createTestUser("vic@payroll.test");
    for (const [user, role] of [
      [mere, "admin"],
      [ben, "bookkeeper"],
      [vic, "viewer"],
    ] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    await asUser(jess, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const categories = (await asUser(jess, (tx) => getTrackingSetup(tx))).categories;
    const category = (kind: string) => categories.find((c) => c.kind === kind)!.id;
    for (const [kind, name] of [
      ["department", "Sales"],
      ["department", "Operations"],
      ["location", "Wellington"],
      ["location", "Auckland"],
      ["class", "Retail"],
    ] as const) {
      const setup = await asUser(jess, (tx) => createTrackingValue(tx, { categoryId: category(kind), name }));
      v[name] = setup.categories.find((c) => c.id === category(kind))!.values.find((value) => value.name === name)!.id;
    }
    const contact = (await asUser(jess, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Cafe", isCustomer: true }))).contact;
    projectId = (await asUser(jess, (tx) => createProject(tx, { idempotencyKey: key("p"), name: "Cafe rebrand", contactId: contact.id }))).project.id;
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  describe("payroll access", () => {
    it("PE9: the first owner has payroll access from the start, given by system; admins and bookkeepers don't", async () => {
      expect(await asUser(jess, (tx) => hasPayrollAccess(tx))).toBe(true);
      expect(await asUser(mere, (tx) => hasPayrollAccess(tx))).toBe(false);
      expect(await asUser(ben, (tx) => hasPayrollAccess(tx))).toBe(false);
      const events = await asUser(jess, (tx) =>
        tx.query<{ event_type: string; entity_id: string; actor_email: string }>(
          "select event_type, entity_id, actor_email from audit_events where entity_type = 'payroll_access'",
        ),
      );
      expect(events.rows).toEqual([{ event_type: "payroll_access.granted", entity_id: jess.id, actor_email: "system" }]);
    });

    it("PE9: an organisation upgraded to this version gives the first owner payroll access once", async () => {
      // Simulate a database from before payroll access: nobody has it and it hasn't started.
      await asUser(jess, async (tx) => {
        await tx.query("delete from payroll_access");
        await tx.query("update organisation_settings set payroll_access_started_at = null");
      });
      const organisation = (await getOrganisation(ORG))!;
      expect((await migrateOrganisation({ id: ORG, database_name: organisation.databaseName })).ok).toBe(true);
      expect(await asUser(jess, (tx) => hasPayrollAccess(tx))).toBe(true);
      // Running again (every start-up) doesn't give it again once started.
      await asUser(jess, (tx) => tx.query("delete from payroll_access"));
      await migrateOrganisation({ id: ORG, database_name: organisation.databaseName });
      expect(await asUser(jess, (tx) => hasPayrollAccess(tx))).toBe(false);
      await asUser(jess, (tx) => tx.query("insert into payroll_access (user_id, granted_by_email) values ($1, 'system')", [jess.id]));
    });

    it("PE10: a bookkeeper without payroll access is refused every payroll API, reading and changing", async () => {
      const { employee } = await addEmployee();
      const cookie = await sessionCookieFor(ben);
      const responses = [
        await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie }), noContext),
        await employeesRoute.POST(
          apiRequest("/api/payroll/employees", { method: "POST", cookie, body: { organisationId: ORG, idempotencyKey: key("e"), ...employeeInput } }),
          noContext,
        ),
        await employeeRoute.GET(apiRequest(`/api/payroll/employees/${employee.id}?organisationId=${ORG}`, { cookie }), params({ employeeId: employee.id })),
        await employeeRoute.PATCH(
          apiRequest(`/api/payroll/employees/${employee.id}`, { method: "PATCH", cookie, body: { organisationId: ORG, phone: "021" } }),
          params({ employeeId: employee.id }),
        ),
        await payRatesRoute.GET(apiRequest(`/api/payroll/employees/${employee.id}/pay-rates?organisationId=${ORG}`, { cookie }), params({ employeeId: employee.id })),
        await payRatesRoute.POST(
          apiRequest(`/api/payroll/employees/${employee.id}/pay-rates`, {
            method: "POST",
            cookie,
            body: { organisationId: ORG, idempotencyKey: key("r"), effectiveFrom: "2026-10-01", payBasis: "salary", annualSalary: "74000" },
          }),
          params({ employeeId: employee.id }),
        ),
        await allocationsRoute.GET(apiRequest(`/api/payroll/employees/${employee.id}/allocations?organisationId=${ORG}`, { cookie }), params({ employeeId: employee.id })),
        await allocationsRoute.POST(
          apiRequest(`/api/payroll/employees/${employee.id}/allocations`, {
            method: "POST",
            cookie,
            body: { organisationId: ORG, idempotencyKey: key("a"), effectiveFrom: "2026-04-01", lines: [{ percentage: "100" }] },
          }),
          params({ employeeId: employee.id }),
        ),
        await groupsRoute.GET(apiRequest(`/api/payroll/groups?organisationId=${ORG}`, { cookie }), noContext),
      ];
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect((await body(response)).error).toMatch(/You need payroll access/);
      }
      const me = await accessMeRoute.GET(apiRequest(`/api/payroll/access/me?organisationId=${ORG}`, { cookie }), noContext);
      expect(await body(me)).toMatchObject({ hasPayrollAccess: false });
      await expect(asUser(ben, (tx) => listEmployees(tx))).rejects.toThrow(/You need payroll access/);
      await expect(asUser(ben, (tx) => requirePayrollAccess(tx))).rejects.toThrow(/You need payroll access/);
    });

    it("PE11: an admin gives payroll access to herself and others, removes it, and it's audited", async () => {
      const mereCookie = await sessionCookieFor(mere);
      const benCookie = await sessionCookieFor(ben);
      // Mere is an admin but can't see payroll yet.
      const before = await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: mereCookie }), noContext);
      expect(before.status).toBe(403);

      expect((await giveAccess(mere, mere)).status).toBe(200);
      expect((await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: mereCookie }), noContext)).status).toBe(200);

      // A bookkeeper can't give access, even to themselves.
      expect((await giveAccess(ben, ben)).status).toBe(403);
      // A viewer can't be given it.
      const viewer = await giveAccess(vic, mere);
      expect(viewer.status).toBe(400);
      expect((await body(viewer)).error).toMatch(/bookkeeper role or higher/);

      const given = await giveAccess(ben, mere);
      expect(given.status).toBe(200);
      const people = (await body(given)).people as Array<{ userId: string; hasPayrollAccess: boolean; grantedByEmail: string | null }>;
      expect(people.find((person) => person.userId === ben.id)).toMatchObject({ hasPayrollAccess: true, grantedByEmail: "mere@payroll.test" });
      expect((await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: benCookie }), noContext)).status).toBe(200);
      const me = await accessMeRoute.GET(apiRequest(`/api/payroll/access/me?organisationId=${ORG}`, { cookie: benCookie }), noContext);
      expect(await body(me)).toMatchObject({ hasPayrollAccess: true });

      // Listing who has it is for admins only.
      expect((await accessRoute.GET(apiRequest(`/api/payroll/access?organisationId=${ORG}`, { cookie: benCookie }), noContext)).status).toBe(403);

      expect((await giveAccess(ben, mere, false)).status).toBe(200);
      expect((await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: benCookie }), noContext)).status).toBe(403);

      const events = await asUser(jess, (tx) =>
        tx.query<{ event_type: string; entity_id: string; actor_email: string; created_at: string }>(
          "select event_type, entity_id, actor_email, created_at from audit_events where entity_type = 'payroll_access' and entity_id = $1 order by id",
          [ben.id],
        ),
      );
      expect(events.rows.map((row) => [row.event_type, row.actor_email])).toEqual([
        ["payroll_access.granted", "mere@payroll.test"],
        ["payroll_access.removed", "mere@payroll.test"],
      ]);
      expect(events.rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("PE11: the last member with payroll access can't have it removed", async () => {
      expect((await giveAccess(mere, mere, false)).status).toBe(200);
      const refused = await giveAccess(jess, mere, false);
      expect(refused.status).toBe(400);
      expect((await body(refused)).error).toMatch(/At least one person must keep payroll access/);
      expect(await asUser(jess, (tx) => hasPayrollAccess(tx))).toBe(true);

      // Someone moved down to viewer keeps their grant but can't open payroll, so they don't count.
      const jessCookie = await sessionCookieFor(jess);
      const changeBen = (role: string) =>
        memberRoute.PATCH(
          apiRequest(`/api/organisations/${ORG}/members/${ben.id}`, { method: "PATCH", cookie: jessCookie, body: { role } }),
          params({ organisationId: ORG, userId: ben.id }),
        );
      expect((await giveAccess(ben, jess)).status).toBe(200);
      expect((await changeBen("viewer")).status).toBe(200);
      const stillRefused = await giveAccess(jess, jess, false);
      expect(stillRefused.status).toBe(400);
      expect((await body(stillRefused)).error).toMatch(/At least one person must keep payroll access/);
      expect((await changeBen("bookkeeper")).status).toBe(200);
      expect((await giveAccess(ben, jess, false)).status).toBe(200);
    });

    it("PE12: someone removed from the organisation and added again starts without payroll access", async () => {
      expect((await giveAccess(ben, jess)).status).toBe(200);
      expect(await asUser(ben, (tx) => hasPayrollAccess(tx))).toBe(true);
      const jessCookie = await sessionCookieFor(jess);
      const removed = await memberRoute.DELETE(
        apiRequest(`/api/organisations/${ORG}/members/${ben.id}`, { method: "DELETE", cookie: jessCookie }),
        params({ organisationId: ORG, userId: ben.id }),
      );
      expect(removed.status).toBe(200);
      const added = await membersRoute.POST(
        apiRequest(`/api/organisations/${ORG}/members`, { method: "POST", cookie: jessCookie, body: { email: ben.email, role: "bookkeeper" } }),
        params({ organisationId: ORG }),
      );
      expect(added.status).toBe(201);
      expect(await asUser(ben, (tx) => hasPayrollAccess(tx))).toBe(false);
      const benCookie = await sessionCookieFor(ben);
      expect((await employeesRoute.GET(apiRequest(`/api/payroll/employees?organisationId=${ORG}`, { cookie: benCookie }), noContext)).status).toBe(403);
    });

    it("PE13: moving someone below bookkeeper takes payroll access away, so moving them back doesn't restore it", async () => {
      expect((await giveAccess(ben, jess)).status).toBe(200);
      const jessCookie = await sessionCookieFor(jess);
      const setRole = (role: string) =>
        memberRoute.PATCH(
          apiRequest(`/api/organisations/${ORG}/members/${ben.id}`, { method: "PATCH", cookie: jessCookie, body: { role } }),
          params({ organisationId: ORG, userId: ben.id }),
        );
      expect((await setRole("viewer")).status).toBe(200);
      expect((await setRole("bookkeeper")).status).toBe(200);
      expect(await asUser(ben, (tx) => hasPayrollAccess(tx))).toBe(false);
      const audit = await asUser(jess, (tx) =>
        tx.query<{ details: { reason: string } }>(
          "select details from audit_events where event_type = 'payroll_access.removed' and entity_id = $1 order by id desc limit 1",
          [ben.id],
        ),
      );
      expect(audit.rows[0]?.details.reason).toBe("Role changed below bookkeeper");
    });

    it("PE13: removing someone takes payroll access away at once; an admin can't strip an owner's access by trying to remove them", async () => {
      expect((await giveAccess(ben, jess)).status).toBe(200);
      const jessCookie = await sessionCookieFor(jess);
      const removed = await memberRoute.DELETE(
        apiRequest(`/api/organisations/${ORG}/members/${ben.id}`, { method: "DELETE", cookie: jessCookie }),
        params({ organisationId: ORG, userId: ben.id }),
      );
      expect(removed.status).toBe(200);
      const left = await asUser(jess, (tx) => tx.query("select 1 from payroll_access where user_id = $1", [ben.id]));
      expect(left.rowCount).toBe(0);
      await membersRoute.POST(
        apiRequest(`/api/organisations/${ORG}/members`, { method: "POST", cookie: jessCookie, body: { email: ben.email, role: "bookkeeper" } }),
        params({ organisationId: ORG }),
      );

      // Mere (an admin) can't remove Jess (an owner), and Jess keeps payroll access.
      const refused = await memberRoute.DELETE(
        apiRequest(`/api/organisations/${ORG}/members/${jess.id}`, { method: "DELETE", cookie: await sessionCookieFor(mere) }),
        params({ organisationId: ORG, userId: jess.id }),
      );
      expect(refused.status).toBe(403);
      expect(await asUser(jess, (tx) => hasPayrollAccess(tx))).toBe(true);
    });
  });

  describe("cost allocation", () => {
    it("PE3: saves a 60/40 allocation by department and location; the audit has percentages, not pay", async () => {
      const { employee } = await addEmployee();
      const saved = await asUser(jess, (tx) =>
        addAllocation(tx, employee.id, {
          idempotencyKey: key("allocation"),
          effectiveFrom: "2026-04-01",
          lines: [
            { percentage: "60", departmentId: v.Sales, locationId: v.Wellington },
            { percentage: "40.00", departmentId: v.Operations, locationId: v.Auckland, classId: v.Retail, projectId },
          ],
        }),
      );
      expect(saved.created).toBe(true);
      expect(saved.allocation).toMatchObject({
        effectiveFrom: "2026-04-01",
        lines: [
          { lineNumber: 1, percentage: "60", departmentId: v.Sales, departmentName: "Sales", locationName: "Wellington", projectId: null, rdActivityId: null },
          { lineNumber: 2, percentage: "40", departmentName: "Operations", locationName: "Auckland", className: "Retail", projectId, projectName: "Cafe rebrand" },
        ],
      });
      const events = await asUser(jess, (tx) =>
        tx.query<{ details: Record<string, unknown> }>(
          "select details from audit_events where entity_type = 'payroll_employee' and entity_id = $1 and event_type = 'payroll_allocation.added'",
          [employee.id],
        ),
      );
      expect(events.rows[0].details).toMatchObject({ effectiveFrom: "2026-04-01", percentages: ["60", "40"] });
      expect(JSON.stringify(events.rows)).not.toMatch(/70000|123456789|0123456/);

      // Retrying with the same key returns the same allocation; a different request with it is refused.
      const retryInput = {
        idempotencyKey: "allocation-retry-1",
        effectiveFrom: "2026-04-01",
        lines: [{ percentage: "100", departmentId: v.Sales }],
      };
      const first = await asUser(jess, (tx) => addAllocation(tx, employee.id, retryInput));
      const retry = await asUser(jess, (tx) => addAllocation(tx, employee.id, retryInput));
      expect(retry).toMatchObject({ created: false, allocation: { id: first.allocation.id } });
      await expect(
        asUser(jess, (tx) => addAllocation(tx, employee.id, { ...retryInput, effectiveFrom: "2026-04-02" })),
      ).rejects.toThrow(/already used/i);
    });

    it("PE5: refuses lines that don't total 100.00%, zero lines, duplicate lines and R&D activities not in the register; the database refuses too", async () => {
      const { employee } = await addEmployee();
      const add = (lines: unknown[]) =>
        asUser(jess, (tx) => addAllocation(tx, employee.id, { idempotencyKey: key("allocation"), effectiveFrom: "2026-04-01", lines }));
      await expect(add([{ percentage: "60", departmentId: v.Sales }, { percentage: "30", departmentId: v.Operations }])).rejects.toThrow(
        "The allocation lines total 90.00%. They must total exactly 100.00%.",
      );
      await expect(add([{ percentage: "60", departmentId: v.Sales }, { percentage: "50", departmentId: v.Operations }])).rejects.toThrow(
        /total 110.00%/,
      );
      await expect(add([{ percentage: "0", departmentId: v.Sales }, { percentage: "100", departmentId: v.Operations }])).rejects.toThrow(/must not be zero/);
      await expect(add([{ percentage: "33.333", departmentId: v.Sales }])).rejects.toThrow(/at most 2 decimal places/);
      await expect(add([{ percentage: "50", departmentId: v.Sales }, { percentage: "50", departmentId: v.Sales }])).rejects.toThrow(/same as line 1/);
      await expect(add([{ percentage: "100", departmentId: v.Wellington }])).rejects.toThrow(/isn't a Department value/);
      await expect(add([{ percentage: "100" }])).rejects.toThrow("Line 1 needs a Department, Class, Location, project or R&D activity.");
      await expect(add([{ percentage: "100", rdActivityId: "00000000-0000-0000-0000-000000000001" }])).rejects.toThrow(/that R&D activity wasn't found/);
      await expect(add([{ percentage: "100", rdActivityId: "C1" }])).rejects.toThrow(/isn't an R&D activity/);
      expect(await asUser(jess, (tx) => listAllocations(tx, employee.id))).toEqual([]);

      // The database refuses an allocation that doesn't total 100.00%, and changing a saved one.
      await expect(
        asUser(jess, async (tx) => {
          const inserted = await tx.query<{ id: string }>(
            `insert into payroll_cost_allocations (employee_id, effective_from, idempotency_key, request_hash, created_by_email)
             values ($1, '2026-04-01', $2, 'x', 'test') returning id`,
            [employee.id, key("raw")],
          );
          await tx.query("insert into payroll_cost_allocation_lines (allocation_id, line_number, percentage) values ($1, 1, 90)", [inserted.rows[0].id]);
        }),
      ).rejects.toThrow(/must total exactly 100.00%/);
      const { allocation } = await add([{ percentage: "100", departmentId: v.Sales }]);
      await expect(
        asUser(jess, (tx) => tx.query("update payroll_cost_allocation_lines set percentage = 50 where allocation_id = $1", [allocation.id])),
      ).rejects.toThrow(/can't be changed or deleted/);
      await expect(
        asUser(jess, (tx) => tx.query("delete from payroll_cost_allocations where id = $1", [allocation.id])),
      ).rejects.toThrow(/can't be changed or deleted/);
    });

    it("PE6: a mid-month department move keeps the earlier allocation for earlier dates", async () => {
      const { employee } = await addEmployee();
      const save = (effectiveFrom: string, departmentId: string) =>
        asUser(jess, (tx) =>
          addAllocation(tx, employee.id, { idempotencyKey: key("allocation"), effectiveFrom, lines: [{ percentage: "100", departmentId }] }),
        );
      await save("2026-04-01", v.Sales);
      await save("2026-09-15", v.Operations);
      const on = async (date: string) => (await asUser(jess, (tx) => allocationOn(tx, employee.id, date)))?.lines[0].departmentName ?? null;
      expect(await on("2026-03-31")).toBeNull();
      expect(await on("2026-05-01")).toBe("Sales");
      expect(await on("2026-09-14")).toBe("Sales");
      expect(await on("2026-09-15")).toBe("Operations");
      expect(await on("2027-01-01")).toBe("Operations");
      const history = await asUser(jess, (tx) => listAllocations(tx, employee.id));
      expect(history.map((allocation) => [allocation.effectiveFrom, allocation.lines[0].departmentName])).toEqual([
        ["2026-04-01", "Sales"],
        ["2026-09-15", "Operations"],
      ]);
      // Saving again for the same date replaces it from that date; both stay in the history.
      await save("2026-09-15", v.Sales);
      expect(await on("2026-09-20")).toBe("Sales");
      expect(await asUser(jess, (tx) => listAllocations(tx, employee.id))).toHaveLength(3);

      const summary = (await asUser(jess, (tx) => listEmployees(tx))).find((row) => row.id === employee.id);
      expect(summary?.primaryDepartment).toMatchObject({ id: v.Sales, name: "Sales" });

      await expect(save("2026-03-01", v.Sales)).rejects.toThrow(/can't be before .* start date/);
    });

    it("PE6: the allocation route answers with the history for someone with payroll access", async () => {
      const { employee } = await addEmployee();
      const cookie = await sessionCookieFor(jess);
      const created = await allocationsRoute.POST(
        apiRequest(`/api/payroll/employees/${employee.id}/allocations`, {
          method: "POST",
          cookie,
          body: {
            organisationId: ORG,
            idempotencyKey: key("a"),
            effectiveFrom: "2026-04-01",
            lines: [
              { percentage: "60", departmentId: v.Sales },
              { percentage: "40", departmentId: v.Operations },
            ],
          },
        }),
        params({ employeeId: employee.id }),
      );
      expect(created.status).toBe(201);
      const listed = await allocationsRoute.GET(
        apiRequest(`/api/payroll/employees/${employee.id}/allocations?organisationId=${ORG}`, { cookie }),
        params({ employeeId: employee.id }),
      );
      expect(((await body(listed)).allocations as unknown[]).length).toBe(1);
    });
  });

  describe("pay rates", () => {
    it("PE7: keeps the rate history and finds the rate in effect on each date", async () => {
      const { employee } = await addEmployee();
      const first = await asUser(jess, (tx) => listPayRates(tx, employee.id));
      expect(first).toMatchObject([{ effectiveFrom: "2026-04-01", payBasis: "salary", annualSalary: "70000" }]);

      const add = (input: Record<string, unknown>) =>
        asUser(jess, (tx) => addPayRate(tx, employee.id, { idempotencyKey: key("rate"), ...input }));
      await add({ effectiveFrom: "2026-10-01", payBasis: "salary", annualSalary: "74000.00", reason: "Annual review" });
      await add({ effectiveFrom: "2027-01-01", payBasis: "hourly", hourlyRate: "38.50", ordinaryHoursPerWeek: "37.5" });

      const on = (date: string) => asUser(jess, (tx) => payRateOn(tx, employee.id, date));
      expect(await on("2026-03-31")).toBeNull();
      expect(await on("2026-09-20")).toMatchObject({ annualSalary: "70000" });
      expect(await on("2026-09-30")).toMatchObject({ annualSalary: "70000" });
      expect(await on("2026-10-01")).toMatchObject({ annualSalary: "74000", reason: "Annual review" });
      expect(await on("2027-01-01")).toMatchObject({ payBasis: "hourly", hourlyRate: "38.5", ordinaryHoursPerWeek: "37.5", annualSalary: null });

      // A correction for the same date replaces it from that date; both stay in the history.
      await add({ effectiveFrom: "2026-10-01", payBasis: "salary", annualSalary: "74500" });
      expect(await on("2026-10-01")).toMatchObject({ annualSalary: "74500" });
      expect(await asUser(jess, (tx) => listPayRates(tx, employee.id))).toHaveLength(4);

      await expect(add({ effectiveFrom: "2026-03-01", payBasis: "salary", annualSalary: "1" })).rejects.toThrow(/can't be before .* start date/);
      await expect(add({ effectiveFrom: "2026-11-01", payBasis: "salary", annualSalary: "0" })).rejects.toThrow(/must not be zero/);
      await expect(add({ effectiveFrom: "2026-11-01", payBasis: "salary", annualSalary: "1", hourlyRate: "2" })).rejects.toThrow(
        /can't also have an hourly rate/,
      );

      // Pay changes go through pay rates, not the employee's details.
      await expect(asUser(jess, (tx) => updateEmployee(tx, employee.id, { annualSalary: "80000" }))).rejects.toThrow(/Pay rates/);

      const events = await asUser(jess, (tx) =>
        tx.query<{ details: Record<string, unknown> }>(
          "select details from audit_events where entity_id = $1 and event_type = 'payroll_pay_rate.added'",
          [employee.id],
        ),
      );
      expect(events.rows.length).toBe(4);
      expect(JSON.stringify(events.rows)).not.toMatch(/70000|74000|74500|38\.5/);
      await expect(
        asUser(jess, (tx) => tx.query("update payroll_pay_rates set annual_salary = 1 where employee_id = $1", [employee.id])),
      ).rejects.toThrow(/can't be changed or deleted/);
    });

    it("PE7: the employee shows the rate in effect today", async () => {
      const { employee } = await addEmployee({ startDate: "2020-01-01" });
      await asUser(jess, (tx) =>
        addPayRate(tx, employee.id, { idempotencyKey: key("rate"), effectiveFrom: "2021-01-01", payBasis: "hourly", hourlyRate: "30", ordinaryHoursPerWeek: "40" }),
      );
      await asUser(jess, (tx) =>
        addPayRate(tx, employee.id, { idempotencyKey: key("rate"), effectiveFrom: "2999-01-01", payBasis: "salary", annualSalary: "90000" }),
      );
      expect(await asUser(jess, (tx) => getEmployee(tx, employee.id))).toMatchObject({
        payBasis: "hourly",
        hourlyRate: "30",
        ordinaryHoursPerWeek: "40",
        annualSalary: null,
      });
      expect((await asUser(jess, (tx) => listEmployees(tx))).find((row) => row.id === employee.id)).toMatchObject({ payBasis: "hourly", hourlyRate: "30" });
    });
  });

  describe("job details and groups", () => {
    it("PE8: job title, reports-to, pay group and employee group", async () => {
      const mereEmployee = (await addEmployee({ firstName: "Mere", lastName: "Tane" })).employee;
      const { employee } = await addEmployee();
      const monthly = await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("g"), name: "Monthly salaries", payFrequency: "monthly" }));
      await asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("g"), name: "Weekly wages", payFrequency: "weekly" }));
      const office = await asUser(jess, (tx) => createEmployeeGroup(tx, { idempotencyKey: key("g"), name: "Wellington office" }));
      await asUser(jess, (tx) => createEmployeeGroup(tx, { idempotencyKey: key("g"), name: "Field staff" }));
      await expect(
        asUser(jess, (tx) => createPayGroup(tx, { idempotencyKey: key("g"), name: "monthly salaries", payFrequency: "monthly" })),
      ).rejects.toThrow(/already a pay group called/);

      const updated = await asUser(jess, (tx) =>
        updateEmployee(tx, employee.id, { jobTitle: "Payroll officer", reportsToId: mereEmployee.id, employeeGroupId: office.group.id }),
      );
      expect(updated).toMatchObject({ jobTitle: "Payroll officer", reportsToId: mereEmployee.id, employeeGroupId: office.group.id });

      await expect(asUser(jess, (tx) => updateEmployee(tx, employee.id, { payGroupId: monthly.group.id }))).rejects.toThrow(
        "Aroha is paid fortnightly but Monthly salaries is monthly.",
      );
      expect(
        await asUser(jess, (tx) => updateEmployee(tx, employee.id, { payGroupId: monthly.group.id, payFrequency: "monthly" })),
      ).toMatchObject({ payGroupId: monthly.group.id, payFrequency: "monthly" });

      await expect(asUser(jess, (tx) => updateEmployee(tx, employee.id, { reportsToId: employee.id }))).rejects.toThrow(/can't report to themselves/);
      await expect(asUser(jess, (tx) => updateEmployee(tx, mereEmployee.id, { reportsToId: employee.id }))).rejects.toThrow(
        /reports to them/,
      );
      await expect(
        asUser(jess, (tx) => updatePayGroup(tx, monthly.group.id, { payFrequency: "weekly" })),
      ).rejects.toThrow(/frequency can't change while employees are in it/);
      expect((await asUser(jess, (tx) => updatePayGroup(tx, monthly.group.id, { name: "Monthly staff" }))).group.name).toBe("Monthly staff");

      const summary = (await asUser(jess, (tx) => listEmployees(tx))).find((row) => row.id === employee.id);
      expect(summary).toMatchObject({
        jobTitle: "Payroll officer",
        reportsToName: "Mere Tane",
        payGroupName: "Monthly staff",
        employeeGroupName: "Wellington office",
      });
      const groups = await asUser(jess, (tx) => listPayrollGroups(tx));
      expect(groups.payGroups.map((group) => group.name)).toEqual(["Monthly staff", "Weekly wages"]);
      expect(groups.employeeGroups.map((group) => group.name)).toEqual(["Field staff", "Wellington office"]);
      await expect(asUser(jess, (tx) => tx.query("delete from payroll_pay_groups where id = $1", [monthly.group.id]))).rejects.toThrow(
        /can't be deleted/,
      );
    });
  });

  it("applies tenant migration 0057 after the payroll tables it changes (0051)", async () => {
    // Other branches' migrations (e.g. 0056) may be listed after it; the runner applies any that are missing.
    const { tenantMigrations } = await import("@/lib/db/migrations/tenant");
    const versions = tenantMigrations.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.indexOf("0057")).toBeGreaterThan(versions.indexOf("0051"));
    expect(versions.indexOf("0051")).toBeGreaterThanOrEqual(0);
  });
});
