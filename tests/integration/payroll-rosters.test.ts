import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createEmployee } from "@/lib/payroll/employees";
import { createPayGroup } from "@/lib/payroll/groups";
import {
  addShift,
  addUnavailability,
  getRosterWeek,
  listRosterAreas,
  myShifts,
  publishRoster,
  removeShift,
  saveRosterArea,
  updateShift,
} from "@/lib/payroll/rosters";
import { setTimesheetPeople } from "@/lib/payroll/timesheets";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples RS1-RS4 in docs/ACCOUNTING-EXAMPLES.md ("Rosters and clocking in
 * inside Payroll"). Glimmers' shop, Saturdays 9:00-17:00; Aroha (hourly
 * 25.00, KiwiSaver 3% employer) and Tama (hourly 24.00); a weekly roster
 * budget of 800.00. Each test gets its own organisation.
 */
describeWithDatabase("rosters (RS1-RS4)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let aroha: SessionUser;
  let noah: SessionUser;
  let organisations = 0;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    server = await startTestServer();
    jess = await createTestUser("rs-jess@example.com");
    aroha = await createTestUser("rs-aroha@example.com");
    noah = await createTestUser("rs-noah@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
    if (previousSecret === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previousSecret;
  });

  async function setup() {
    organisations += 1;
    const org = `rs-${organisations}-co`;
    await createTestOrganisation(jess, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer'), ($1, $3, 'bookkeeper')", [org, aroha.id, noah.id]);
    const asUser = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: user.id, email: user.email }, work);
    const as = asUser(jess);
    const group = (await as((tx) => createPayGroup(tx, { idempotencyKey: key("group"), name: "Weekly", payFrequency: "weekly" }))).group.id;
    const employee = async (firstName: string, hourlyRate: string, kiwiSaver: boolean) =>
      (
        await as((tx) =>
          createEmployee(tx, {
            idempotencyKey: key("employee"),
            firstName,
            lastName: "Shop",
            taxCode: "M",
            irdNumber: "123456789",
            kiwiSaverStatus: kiwiSaver ? "enrolled" : "not_enrolled",
            kiwiSaverEmployeeRate: "3",
            kiwiSaverEmployerRate: "3",
            studentLoan: false,
            payBasis: "hourly",
            hourlyRate,
            ordinaryHoursPerWeek: "30",
            payFrequency: "weekly",
            bankAccount: "03-1234-0123456-00",
            startDate: "2026-01-05",
            payGroupId: group,
          }),
        )
      ).employee.id;
    const arohaId = await employee("Aroha", "25.00", true);
    const tamaId = await employee("Tama", "24.00", false);
    await as((tx) => setTimesheetPeople(tx, arohaId, { userId: aroha.id, approverUserId: jess.id }));
    const areas = await as((tx) => saveRosterArea(tx, { name: "Shop", weeklyBudget: "800.00" }));
    const shop = areas[0].id;
    const shift = (employeeId: string, date: string, extra: Record<string, unknown> = {}) =>
      as((tx) => addShift(tx, { areaId: shop, employeeId, startsAt: `${date}T09:00:00+13:00`, endsAt: `${date}T17:00:00+13:00`, breakMinutes: 30, ...extra }));
    const week = () => as((tx) => getRosterWeek(tx, { areaId: shop, weekStart: "2026-10-19" }));
    const journals = async () => Number((await as((tx) => tx.query<{ n: string }>("select count(*)::text as n from ledger_journals"))).rows[0].n);
    return { org, as, asAroha: asUser(aroha), asNoah: asUser(noah), arohaId, tamaId, shop, shift, week, journals };
  }

  it("RS1: Aroha's Saturday shift costs 187.50 + 5.63 KiwiSaver = 193.13 against the 800.00 budget; nothing is posted", async () => {
    const w = await setup();
    const before = await w.journals();
    const roster = await w.shift(w.arohaId, "2026-10-24");
    expect(roster.weekStart).toBe("2026-10-19");
    expect(roster.shifts).toHaveLength(1);
    expect(roster.shifts[0]).toMatchObject({ employeeName: "Aroha Shop", date: "2026-10-24", breakMinutes: 30, minutes: 450, hours: "7.50", hourlyRate: "25.00", wages: "187.50", kiwiSaver: "5.63", cost: "193.13", warnings: [] });
    expect(roster.totals).toEqual({ hours: "7.50", wages: "187.50", kiwiSaver: "5.63", cost: "193.13" });
    expect([roster.budget, roster.remaining]).toEqual(["800.00", "606.87"]);
    // Tama isn't in KiwiSaver: 7.5 x 24.00 = 180.00 and no KiwiSaver.
    const both = await w.shift(w.tamaId, "2026-10-25");
    expect(both.shifts[1]).toMatchObject({ wages: "180.00", kiwiSaver: "0.00", cost: "180.00" });
    expect(both.totals.cost).toBe("373.13");
    expect(await w.journals()).toBe(before);
    // Rosters show pay, so they need payroll access.
    await expect(w.asNoah((tx) => listRosterAreas(tx))).rejects.toThrow();
  });

  it("RS2: Tama is unavailable on Saturdays: rostering him needs a reason, which is kept with a warning", async () => {
    const w = await setup();
    await w.as((tx) => addUnavailability(tx, { employeeId: w.tamaId, weekday: 6, note: "Sport" }));
    await expect(w.shift(w.tamaId, "2026-10-24")).rejects.toThrow("Tama is unavailable. Give a reason to roster them anyway.");
    const roster = await w.shift(w.tamaId, "2026-10-24", { unavailableReason: "Agreed to swap this week" });
    expect(roster.shifts[0]).toMatchObject({ unavailable: true, unavailableReason: "Agreed to swap this week" });
    expect(roster.shifts[0].warnings).toEqual(["Tama is unavailable (rostered anyway: Agreed to swap this week)"]);
    // Friday is fine.
    await w.shift(w.tamaId, "2026-10-23");
  });

  it("RS3: Aroha's Saturday shift in her booked leave warns and isn't counted", async () => {
    const w = await setup();
    // Approved leave is a booking (HL49); booked directly here for brevity.
    await w.as((tx) =>
      tx.query(
        `insert into payroll_leave_bookings (idempotency_key, request_hash, employee_id, leave_type, start_date, end_date, created_by_user_id, created_by_email)
         values ($1, 'x', $2, 'annual', '2026-10-22', '2026-10-26', $3, $4)`,
        [key("leave"), w.arohaId, jess.id, jess.email],
      ),
    );
    const roster = await w.shift(w.arohaId, "2026-10-24");
    expect(roster.shifts[0]).toMatchObject({ onLeave: true, warnings: ["Aroha is on leave"] });
    expect(roster.totals).toEqual({ hours: "0.00", wages: "0.00", kiwiSaver: "0.00", cost: "0.00" });
  });

  it("RS4: published shifts are what Aroha sees; later changes are listed until published again", async () => {
    const w = await setup();
    const first = await w.shift(w.arohaId, "2026-10-24");
    await w.shift(w.tamaId, "2026-10-25");
    expect(await w.asAroha((tx) => myShifts(tx, { from: "2026-10-19", to: "2026-10-25" }))).toEqual([]);
    const published = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-21" }));
    expect(published.publishedAt).not.toBeNull();
    expect(published.changes).toEqual([]);
    const mine = await w.asAroha((tx) => myShifts(tx, { from: "2026-10-19", to: "2026-10-25" }));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ areaName: "Shop", date: "2026-10-24", hours: "7.50", breakMinutes: 30 });
    // Changes after publishing.
    const tamaShift = published.shifts.find((shift) => shift.employeeId === w.tamaId)!;
    await w.as((tx) => removeShift(tx, tamaShift.id));
    const changed = await w.as((tx) =>
      updateShift(tx, first.shifts[0].id, { employeeId: w.arohaId, startsAt: "2026-10-24T10:00:00+13:00", endsAt: "2026-10-24T17:00:00+13:00", breakMinutes: 30 }),
    );
    expect(changed.changes.map((change) => [change.kind, change.employeeName, change.text])).toEqual([
      ["changed", "Aroha Shop", "Sat 24/10 09:00-17:00, 30 min break is now Sat 24/10 10:00-17:00, 30 min break"],
      ["removed", "Tama Shop", "Removed Sun 25/10 09:00-17:00, 30 min break"],
    ]);
    // Aroha still sees the published time until it's published again.
    expect((await w.asAroha((tx) => myShifts(tx, { from: "2026-10-19", to: "2026-10-25" })))[0].startsAt).toBe("2026-10-23T20:00:00.000Z");
    const again = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19" }));
    expect(again.changes).toEqual([]);
    expect((await w.asAroha((tx) => myShifts(tx, { from: "2026-10-19", to: "2026-10-25" })))[0].startsAt).toBe("2026-10-23T21:00:00.000Z");
    // Moving a shift to another week is refused.
    await expect(
      w.as((tx) => updateShift(tx, first.shifts[0].id, { employeeId: w.arohaId, startsAt: "2026-10-31T10:00:00+13:00", endsAt: "2026-10-31T17:00:00+13:00" })),
    ).rejects.toThrow("removing it and adding it there");
  });
});
