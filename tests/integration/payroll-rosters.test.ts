import type { AddressInfo } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createEmployee } from "@/lib/payroll/employees";
import { addClockDevice, clockBoard, clockPunch, deviceActor, enterClockOut, listClockRecords, setClockPin } from "@/lib/payroll/clock";
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
import { COMMAND_LINE_ADMIN } from "@/lib/audit";
import { updateLocalMailRelay } from "@/lib/email/local-relay";
import { processOrganisationOutbox } from "@/lib/email/outbox";
import { prepareSmtpServer, updateOrganisationEmailSettings } from "@/lib/email/settings";
import { setSmtpPortForTests } from "@/lib/email/smtp";
import { getOrganisation } from "@/lib/organisations/registry";
import { approveTimesheet, getTimesheet, listTimesheetWeek, submitTimesheet, setTimesheetPeople } from "@/lib/payroll/timesheets";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Examples RS1-RS4 in docs/ACCOUNTING-EXAMPLES.md ("Rosters and clocking in
 * inside Payroll"). Glimmers' shop, Saturdays 9:00-17:00; Aroha (hourly
 * 25.00, KiwiSaver 3% employer) and Tama (hourly 24.00); a weekly roster
 * budget of 800.00. Each test gets its own organisation.
 */
describeWithDatabase("rosters and clocking in (RS1-RS8)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let aroha: SessionUser;
  let noah: SessionUser;
  let organisations = 0;
  const previousSecret = process.env.TOHYEE_SECRET_KEY;
  const previousOutbox = process.env.TOHYEE_EMAIL_OUTBOX;
  let smtp: SMTPServer;
  const received: Array<{ recipients: string[]; mail: ParsedMail }> = [];

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "payroll-integration-test-secret-key-32-characters";
    process.env.TOHYEE_EMAIL_OUTBOX = "off";
    server = await startTestServer();
    smtp = new SMTPServer({
      secure: false,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === "shop@glimmers.test" && auth.password === "app-password") return callback(null, { user: auth.username });
        return callback(Object.assign(new Error("Invalid username or password"), { responseCode: 535 }));
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          simpleParser(Buffer.concat(chunks)).then(
            (mail) => {
              received.push({ recipients: session.envelope.rcptTo.map((rcpt) => rcpt.address), mail });
              callback(null, "Queued as ROSTER1");
            },
            (error: Error) => callback(error),
          );
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    setSmtpPortForTests((smtp.server.address() as AddressInfo).port);
    await updateLocalMailRelay(COMMAND_LINE_ADMIN, { allowed: true });
    jess = await createTestUser("rs-jess@example.com");
    aroha = await createTestUser("rs-aroha@example.com");
    noah = await createTestUser("rs-noah@example.com");
  });

  afterAll(async () => {
    setSmtpPortForTests(null);
    await new Promise<void>((resolve) => smtp?.close(() => resolve()));
    await server?.teardown();
    if (previousOutbox === undefined) delete process.env.TOHYEE_EMAIL_OUTBOX;
    else process.env.TOHYEE_EMAIL_OUTBOX = previousOutbox;
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
    // The shop's device (RS5), and PINs for both.
    const { device } = await as((tx) => addClockDevice(tx, { name: "Shop iPad" }));
    await as((tx) => setClockPin(tx, { employeeId: arohaId, pin: "1234" }));
    await as((tx) => setClockPin(tx, { employeeId: tamaId, pin: "5678" }));
    const onDevice = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, deviceActor(device.name), work);
    const punch = (employeeId: string, pin: string, action: string, at: string) => onDevice((tx) => clockPunch(tx, device, { employeeId, pin, action, at }));
    const sheetFor = async (employeeId: string, weekStart: string) => {
      const week = await as((tx) => listTimesheetWeek(tx, "owner", weekStart));
      const summary = week.employees.find((entry) => entry.employeeId === employeeId)?.timesheet;
      return summary ? as((tx) => getTimesheet(tx, "owner", summary.id)) : null;
    };
    return { org, as, asAroha: asUser(aroha), asNoah: asUser(noah), arohaId, tamaId, shop, shift, week, journals, onDevice, punch, sheetFor, device };
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

  it("RS4: publishing can email staff their own shifts; a later publish emails only those whose shifts changed", async () => {
    const w = await setup();
    await w.shift(w.arohaId, "2026-10-24");
    await w.shift(w.tamaId, "2026-10-25");
    // Without the organisation's email set up, nobody is emailed and the page says why.
    const unset = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19", emailStaff: true }));
    expect(unset.emails).toEqual({
      emailed: [],
      notEmailed: [
        { name: "Aroha Shop", reason: "Email isn't set up for this organisation (Settings > Email)." },
        { name: "Tama Shop", reason: "Email isn't set up for this organisation (Settings > Email)." },
      ],
    });

    const smtpServer = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await w.as((tx) => updateOrganisationEmailSettings(tx, { fromName: "Glimmers", fromAddress: "shop@glimmers.test", username: "shop@glimmers.test", password: "app-password" }, smtpServer));
    await w.as((tx) => tx.query("update payroll_employees set email = 'aroha@glimmers.test' where id = $1", [w.arohaId]));
    // Aroha's shift moves to 10:00: she's emailed; Tama has no email address, and his shift didn't change, so he isn't listed.
    const first = (await w.week()).shifts.find((shift) => shift.employeeId === w.arohaId)!;
    await w.as((tx) => updateShift(tx, first.id, { employeeId: w.arohaId, startsAt: "2026-10-24T10:00:00+13:00", endsAt: "2026-10-24T17:00:00+13:00", breakMinutes: 30 }));
    const changed = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19", emailStaff: true }));
    expect(changed.emails).toEqual({ emailed: ["Aroha Shop"], notEmailed: [] });
    received.length = 0;
    const organisation = (await getOrganisation(w.org))!;
    expect(await processOrganisationOutbox(organisation)).toMatchObject({ waiting: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].recipients).toEqual(["aroha@glimmers.test"]);
    expect(received[0].mail.subject).toBe("Your shifts have changed: Shop, week starting Monday, 19 October 2026");
    const orgName = (await w.as((tx) => tx.query<{ display_name: string }>("select display_name from organisation_settings where id = true"))).rows[0].display_name;
    expect(received[0].mail.text?.trim()).toBe(
      [
        "Kia ora Aroha,",
        "",
        "Your shifts have changed. They are now at Shop for the week starting Monday, 19 October 2026:",
        "",
        "- Saturday, 24 October, 10:00am to 5:00pm (30 min unpaid break)",
        "",
        "You can also see them in Tohyee under Payroll > My shifts.",
        "",
        orgName,
      ].join("\n"),
    );
    // No pay figures in the email.
    expect(received[0].mail.text).not.toContain("25.00");

    // Publishing without asking for emails queues none.
    await w.as((tx) => removeShift(tx, first.id));
    const quiet = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19" }));
    expect(quiet.emails).toBeNull();
    // Publishing again with nothing changed emails nobody.
    expect((await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19", emailStaff: true }))).emails).toEqual({ emailed: [], notEmailed: [] });
  });

  it("RS4: someone taken off a published roster is told they no longer have shifts that week", async () => {
    const w = await setup();
    const smtpServer = await prepareSmtpServer({ host: "127.0.0.1", port: 2525, security: "none" });
    await w.as((tx) => updateOrganisationEmailSettings(tx, { fromName: "Glimmers", fromAddress: "shop@glimmers.test", username: "shop@glimmers.test", password: "app-password" }, smtpServer));
    await w.as((tx) => tx.query("update payroll_employees set email = 'tama@glimmers.test' where id = $1", [w.tamaId]));
    const roster = await w.shift(w.tamaId, "2026-10-25");
    const published = await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19", emailStaff: true }));
    expect(published.emails).toEqual({ emailed: ["Tama Shop"], notEmailed: [] });
    await w.as((tx) => removeShift(tx, roster.shifts[0].id));
    expect((await w.as((tx) => publishRoster(tx, { areaId: w.shop, weekStart: "2026-10-19", emailStaff: true }))).emails).toEqual({ emailed: ["Tama Shop"], notEmailed: [] });
    received.length = 0;
    await processOrganisationOutbox((await getOrganisation(w.org))!);
    expect(received.map((entry) => entry.mail.subject)).toEqual([
      "Your shifts: Shop, week starting Monday, 19 October 2026",
      "Your shifts have changed: Shop, week starting Monday, 19 October 2026",
    ]);
    expect(received[0].mail.text).toContain("- Sunday, 25 October, 9:00am to 5:00pm (30 min unpaid break)");
    expect(received[0].mail.text).not.toContain("My shifts");
    expect(received[1].mail.text).toContain("You no longer have any shifts at Shop in the week starting Monday, 19 October 2026.");
  });

  it("RS5, RS6: Aroha clocks 8:57-17:06 with a 30-minute break: 7.65 hours on her timesheet, from clock-in", async () => {
    const w = await setup();
    const before = await w.journals();
    expect(await w.punch(w.arohaId, "1234", "in", "2026-10-24T08:57:00+13:00")).toEqual({ ok: true, status: "in", message: "Aroha clocked in at 08:57." });
    expect((await w.onDevice((tx) => clockBoard(tx, { now: new Date("2026-10-24T09:00:00+13:00") }))).map((each) => [each.name, each.status])).toEqual([
      ["Aroha Shop", "in"],
      ["Tama Shop", "out"],
    ]);
    await w.punch(w.arohaId, "1234", "break_start", "2026-10-24T12:00:00+13:00");
    expect((await w.punch(w.arohaId, "1234", "break_end", "2026-10-24T12:30:00+13:00")).message).toBe("Aroha's break ended at 12:30 (30 min).");
    expect((await w.punch(w.arohaId, "1234", "out", "2026-10-24T17:06:00+13:00")).message).toBe("Aroha clocked out at 17:06: 7.65 hours.");
    const { records } = await w.as((tx) => listClockRecords(tx, { from: "2026-10-24", to: "2026-10-24", now: new Date("2026-10-24T18:00:00+13:00") }));
    expect(records[0]).toMatchObject({ employeeName: "Aroha Shop", breakMinutes: 30, minutes: 459, hours: "7.65", status: "closed", onTimesheet: true, deviceName: "Shop iPad" });
    const sheet = (await w.sheetFor(w.arohaId, "2026-10-19"))!;
    expect(sheet.status).toBe("draft");
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].hours).toEqual({ "2026-10-24": "7.65" });
    expect(sheet.rows[0].entries["2026-10-24"]).toMatchObject({ fromClockIn: true, enteredByEmail: 'Clock device "Shop iPad"' });
    // Her approver approves it as any timesheet.
    await w.as((tx) => submitTimesheet(tx, "owner", sheet.id));
    expect((await w.as((tx) => approveTimesheet(tx, "owner", sheet.id))).timesheet.status).toBe("approved");
    // A second shift that week can't change an approved timesheet: it waits, saying why.
    await w.punch(w.arohaId, "1234", "in", "2026-10-25T09:00:00+13:00");
    await w.punch(w.arohaId, "1234", "out", "2026-10-25T12:00:00+13:00");
    const later = await w.as((tx) => listClockRecords(tx, { from: "2026-10-25", to: "2026-10-25", now: new Date("2026-10-25T18:00:00+13:00") }));
    expect(later.records[0].timesheetProblem).toBe("The timesheet for the week starting 2026-10-19 is approved: add 3.00 hours on 2026-10-25 once it's back to draft.");
    expect(later.needsAttention.map((record) => record.id)).toEqual([later.records[0].id]);
    expect(await w.journals()).toBe(before);
  });

  it("RS5: a wrong PIN is refused, and five lock clocking in for 15 minutes", async () => {
    const w = await setup();
    expect(await w.punch(w.arohaId, "0000", "in", "2026-10-24T08:57:00+13:00")).toEqual({ ok: false, message: "That PIN isn't right." });
    for (let attempt = 2; attempt <= 4; attempt += 1) await w.punch(w.arohaId, "0000", "in", "2026-10-24T08:57:00+13:00");
    expect(await w.punch(w.arohaId, "0000", "in", "2026-10-24T08:57:00+13:00")).toEqual({ ok: false, message: "Too many wrong PINs. Aroha can try again in 15 minutes." });
    await expect(w.punch(w.arohaId, "1234", "in", "2026-10-24T08:58:00+13:00")).rejects.toThrow("Too many wrong PINs");
    // Resetting her PIN unlocks it.
    await w.as((tx) => setClockPin(tx, { employeeId: w.arohaId, pin: "4321" }));
    expect((await w.punch(w.arohaId, "4321", "in", "2026-10-24T08:59:00+13:00")).ok).toBe(true);
    // A stopped device can't be used.
    await expect(w.onDevice((tx) => import("@/lib/payroll/clock").then((clock) => clock.deviceFromToken(tx, { deviceId: w.device.id, secret: "x".repeat(43) })))).rejects.toThrow(
      "isn't set up for clocking in",
    );
  });

  it("RS7: the week shows rostered 7.50 h, clocked 7.65 h, a difference of 0.15 h (3.75)", async () => {
    const w = await setup();
    await w.shift(w.arohaId, "2026-10-24");
    await w.punch(w.arohaId, "1234", "in", "2026-10-24T08:57:00+13:00");
    await w.punch(w.arohaId, "1234", "break_start", "2026-10-24T12:00:00+13:00");
    await w.punch(w.arohaId, "1234", "break_end", "2026-10-24T12:30:00+13:00");
    await w.punch(w.arohaId, "1234", "out", "2026-10-24T17:06:00+13:00");
    const roster = await w.week();
    expect(roster.actuals).toEqual([
      { employeeId: w.arohaId, employeeName: "Aroha Shop", rosteredHours: "7.50", clockedHours: "7.65", differenceHours: "0.15", differenceCost: "3.75", stillOpen: 0 },
    ]);
  });

  it("RS8: Tama never clocks out: it needs attention, and nothing reaches his timesheet until a manager enters the out time", async () => {
    const w = await setup();
    // A Saturday already past, so the out time isn't in the future.
    await w.punch(w.tamaId, "5678", "in", "2026-10-03T09:00:00+13:00");
    const nextDay = new Date("2026-10-04T08:00:00+13:00");
    const { needsAttention } = await w.as((tx) => listClockRecords(tx, { from: "2026-10-03", to: "2026-10-03", now: nextDay }));
    expect(needsAttention).toHaveLength(1);
    expect(needsAttention[0]).toMatchObject({ employeeName: "Tama Shop", status: "needs_attention", clockOutAt: null, onTimesheet: false });
    expect(await w.sheetFor(w.tamaId, "2026-09-28")).toBeNull();
    // On the device he shows as out; clocking in again is refused until it's sorted.
    expect((await w.onDevice((tx) => clockBoard(tx, { now: nextDay }))).find((each) => each.name === "Tama Shop")!.status).toBe("out");
    await expect(w.punch(w.tamaId, "5678", "in", "2026-10-04T09:00:00+13:00")).rejects.toThrow("A manager needs to enter the out time first.");
    await expect(w.as((tx) => enterClockOut(tx, needsAttention[0].id, { clockOutAt: "2026-10-03T17:00:00+13:00" }))).rejects.toThrow("Reason");
    const fixed = await w.as((tx) => enterClockOut(tx, needsAttention[0].id, { clockOutAt: "2026-10-03T17:00:00+13:00", breakMinutes: 30, reason: "Forgot to clock out; left at 5" }));
    expect(fixed).toMatchObject({ status: "closed", hours: "7.50", outEnteredByEmail: "rs-jess@example.com", outReason: "Forgot to clock out; left at 5", onTimesheet: true });
    expect((await w.sheetFor(w.tamaId, "2026-09-28"))!.rows[0].hours).toEqual({ "2026-10-03": "7.50" });
    expect((await w.punch(w.tamaId, "5678", "in", "2026-10-04T09:00:00+13:00")).ok).toBe(true);
  });
});
