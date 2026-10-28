import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as demoFarmsRoute from "@/app/api/admin/demo-farms/route";
import * as demoFarmRoute from "@/app/api/admin/demo-farms/[userId]/route";
import * as emailSettingsRoute from "@/app/api/email/settings/route";
import { listDashboards, runTile } from "@/lib/analytics/dashboards";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { getAdminPool } from "@/lib/db/pools";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { createContact } from "@/lib/contacts/service";
import { queueDocumentEmail } from "@/lib/email/documents";
import { headCount } from "@/lib/livestock/movements";
import { add, dec, sub, toFixedString } from "@/lib/money/decimal";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation, listMembershipsForUser } from "@/lib/organisations/registry";
import { getIrdPeriod } from "@/lib/payroll/ird-payments";
import { listPayRuns } from "@/lib/payroll/pay-runs";
import { trialBalance } from "@/lib/reports/financial";
import { calculateGstReturn, listGstReturns } from "@/lib/reports/gst-return";
import { resumeOrganisationJobs } from "@/lib/backups/service";
import { addDemoFarm, deleteDemoFarm, getDemoFarm } from "@/lib/demo/service";
import { demoStart, gstPeriods } from "@/lib/demo/plan";
import { plain } from "@/lib/demo/build/books";
import * as weeklyCopySendRoute from "@/app/api/farming/safety/weekly-copy/send/route";
import { isoDateAt } from "@/lib/dates";
import { paddockBand } from "@/lib/farming/map-colours";
import { paddockStatuses } from "@/lib/farming/paddock-status";
import { getTractorJob, listTractorEquipment, listTractorJobs } from "@/lib/farming/tractor";
import { effluentLog } from "@/lib/effluent/log";
import { effluentSetup } from "@/lib/effluent/setup";
import { listEquipment } from "@/lib/safety/equipment";
import { readSafetyFile } from "@/lib/safety/files";
import { getEmergency, listHazards } from "@/lib/safety/hazards";
import { listInductions, listSignoffs, onSite } from "@/lib/safety/inductions";
import { checkSafetyHistory } from "@/lib/safety/records";
import { listChemicals, listTraining } from "@/lib/safety/register";
import { listReports, openActions } from "@/lib/safety/reports";
import { reviewOverdue, sdsState, trainingState } from "@/lib/safety/shared";
import { copySettings, sendSafetyCopy } from "@/lib/safety/weekly-copy";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

/*
 * The demo farm (#437, decisions 855-869): made through Tohyee's own
 * services, so the books, GST, payroll, herd and farm records must all hold
 * together like real data; and it never reaches outside Tohyee. A fixed
 * "today" keeps the figures the same each run.
 */
const TODAY = "2026-10-24";

describeWithDatabase("the demo farm (#437)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let mere: SessionUser;
  let ana: SessionUser;
  let org = "";
  const params = (userId: string) => ({ params: Promise.resolve({ userId }) });
  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: jess.id, email: jess.email }, work);
  const waitFor = async (userId: string) => {
    for (let tries = 0; tries < 600; tries += 1) {
      const demo = await getDemoFarm(userId);
      if (demo?.status !== "building") return demo;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("The demo farm took too long.");
  };
  let buildSeconds = 0;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "demo-farm-integration-test-secret-key-32chars";
    process.env.TOHYEE_DEMO_FARM_TODAY = TODAY;
    process.env.TOHYEE_ANALYTICS_DIR = `/tmp/tohyee-demo-analytics-${process.pid}`;
    server = await startTestServer();
    jess = await createTestUser("demo-jess@example.com");
    mere = await createTestUser("demo-mere@example.com");
    ana = await createTestUser("demo-ana@example.com", { serverAdmin: true });
    // A server admin adds it for Jess in the server settings (#445): the request returns at once, and the build runs in the background.
    const started = await demoFarmsRoute.POST(
      apiRequest("/api/admin/demo-farms", { method: "POST", cookie: await sessionCookieFor(ana), body: { ownerEmail: jess.email } }),
      undefined as never,
    );
    expect(started.status).toBe(202);
    const body = (await started.json()) as { demoFarm: { status: string; organisationId: string; email: string } };
    expect(body.demoFarm).toMatchObject({ status: "building", email: jess.email });
    org = body.demoFarm.organisationId;
    // Not in her organisation list until it's made.
    expect((await listMembershipsForUser(jess.id)).map((entry) => entry.organisation.id)).not.toContain(org);
    const demo = await waitFor(jess.id);
    expect(demo?.error ?? null).toBeNull();
    expect(demo?.status).toBe("ready");
    buildSeconds = demo!.buildSeconds!;
    console.log(`The demo farm took ${buildSeconds} s to make.`);
  }, 900_000);

  afterAll(async () => {
    await server?.teardown();
    await rm(process.env.TOHYEE_ANALYTICS_DIR!, { recursive: true, force: true });
  });

  it("is a ready, flagged organisation in her list, made in reasonable time", async () => {
    expect(buildSeconds).toBeGreaterThan(0);
    expect(buildSeconds).toBeLessThan(300);
    const organisation = await getOrganisation(org);
    expect(organisation).toMatchObject({ displayName: "Kōwhai Dairies Ltd", provisioningStatus: "ready", demo: { userId: jess.id, status: "ready" } });
    expect((await listMembershipsForUser(jess.id)).map((entry) => [entry.organisation.id, entry.role])).toEqual([[org, "owner"]]);
    const response = await demoFarmsRoute.GET(apiRequest("/api/admin/demo-farms", { cookie: await sessionCookieFor(ana) }), undefined as never);
    expect(await response.json()).toMatchObject({ enabled: true, demoFarms: [{ organisationId: org, status: "ready", userId: jess.id, email: jess.email }] });
    // Added by the server admin, for Jess: the audit log says both.
    const audit = await coreQuery<{ actor_email: string; details: { forEmail: string } }>(
      "select actor_email, details from admin_audit_events where event_type = 'demo_farm.added' and entity_id = $1",
      [org],
    );
    expect(audit.rows[0]).toMatchObject({ actor_email: ana.email, details: { forEmail: jess.email } });
  });

  it("is added, reset and deleted only by a server admin, on the server computer (#445)", async () => {
    const jessCookie = await sessionCookieFor(jess);
    const anaCookie = await sessionCookieFor(ana);
    // Not by someone who isn't a server admin, for themselves or anyone else.
    for (const response of [
      await demoFarmsRoute.GET(apiRequest("/api/admin/demo-farms", { cookie: jessCookie }), undefined as never),
      await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: await sessionCookieFor(mere), body: {} }), undefined as never),
      await demoFarmRoute.POST(apiRequest(`/api/admin/demo-farms/${jess.id}`, { method: "POST", cookie: jessCookie }), params(jess.id)),
      await demoFarmRoute.DELETE(apiRequest(`/api/admin/demo-farms/${jess.id}`, { method: "DELETE", cookie: jessCookie }), params(jess.id)),
    ]) {
      expect(response.status).toBe(403);
    }
    // Not from the network: only through the local server settings address.
    for (const response of [
      await demoFarmsRoute.GET(apiRequest("/api/admin/demo-farms", { cookie: anaCookie, local: false }), undefined as never),
      await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: anaCookie, local: false, body: {} }), undefined as never),
      await demoFarmRoute.DELETE(apiRequest(`/api/admin/demo-farms/${jess.id}`, { method: "DELETE", cookie: anaCookie, local: false }), params(jess.id)),
    ]) {
      expect(response.status).toBe(403);
    }
    expect(await getDemoFarm(mere.id)).toBeNull();
    expect((await getDemoFarm(jess.id))?.status).toBe("ready");
    // A login that doesn't exist.
    const nobody = await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: anaCookie, body: { ownerEmail: "nobody@example.com" } }), undefined as never);
    expect(nobody.status).toBe(400);
    const badId = await demoFarmRoute.DELETE(apiRequest("/api/admin/demo-farms/not-an-id", { method: "DELETE", cookie: anaCookie }), params("not-an-id"));
    expect(badId.status).toBe(404);
  });

  it("is for the signed-in server admin when no login is chosen, one each (#445)", async () => {
    const anaCookie = await sessionCookieFor(ana);
    const started = await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: anaCookie, body: {} }), undefined as never);
    expect(started.status).toBe(202);
    const own = ((await started.json()) as { demoFarm: { organisationId: string; userId: string } }).demoFarm;
    expect(own.userId).toBe(ana.id);
    expect(own.organisationId).not.toBe(org);
    // One each: a second for her is refused, even while the first is being made.
    const again = await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: anaCookie, body: { ownerEmail: ana.email } }), undefined as never);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/You already have the demo farm/);
    const made = await waitFor(ana.id);
    expect(made).toMatchObject({ status: "ready", error: null });
    // It's in her organisation list, not Jess's other one.
    expect((await listMembershipsForUser(ana.id)).map((entry) => [entry.organisation.id, entry.role])).toEqual([[own.organisationId, "owner"]]);
    const listed = (await (await demoFarmsRoute.GET(apiRequest("/api/admin/demo-farms", { cookie: anaCookie }), undefined as never)).json()) as { demoFarms: Array<{ userId: string }> };
    expect(listed.demoFarms.map((demo) => demo.userId).sort()).toEqual([ana.id, jess.id].sort());
    const deleted = await demoFarmRoute.DELETE(apiRequest(`/api/admin/demo-farms/${ana.id}`, { method: "DELETE", cookie: anaCookie }), params(ana.id));
    expect(deleted.status).toBe(200);
    expect(await getDemoFarm(ana.id)).toBeNull();
    expect((await getDemoFarm(jess.id))?.status).toBe("ready");
  }, 900_000);

  it("has books that balance, from 1 June at least a year back", async () => {
    const tb = await as((tx) => trialBalance(tx, { asAt: TODAY }));
    expect(tb.balanced).toBe(true);
    expect(demoStart(TODAY)).toBe("2025-06-01");
    const range = await as((tx) => tx.query<{ first: string; last: string; journals: number }>("select min(posting_date)::text as first, max(posting_date)::text as last, count(*)::int as journals from ledger_journals"));
    expect(range.rows[0].first).toBe("2025-05-31");
    expect(range.rows[0].last <= TODAY).toBe(true);
    expect(range.rows[0].journals).toBeGreaterThan(300);
    // Milk income for the last season is about 110,000 kg MS at the advance price.
    const milk = await as((tx) =>
      tx.query<{ kg: string; income: string }>(
        `select sum(l.quantity)::text as kg, sum(l.net_amount)::text as income from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
          where i.status = 'approved' and l.description like 'Milk solids%' and i.invoice_date between '2025-06-01' and '2026-05-31'`,
      ),
    );
    expect(Number(milk.rows[0].kg)).toBeGreaterThan(100_000);
    expect(Number(milk.rows[0].kg)).toBeLessThan(120_000);
  });

  it("has bank statements imported and reconciled, except the last few days", async () => {
    const bank = (await as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const reconciled = await as((tx) => listStatementLines(tx, bank.id, { status: "reconciled", limit: 500 }));
    const open = await as((tx) => listStatementLines(tx, bank.id, { status: "unreconciled", limit: 500 }));
    expect(reconciled.total).toBeGreaterThan(250);
    expect(open.lines.every((line) => line.date > "2026-10-18")).toBe(true);
    // The bank account in the books and the last statement balance agree up to the last line imported.
    const balances = await as((tx) =>
      tx.query<{ ledger: string; statement: string }>(
        `select (select coalesce(sum(l.debit_amount - l.credit_amount), 0) from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
                  where a.code = '1000' and j.posting_date < $1)::text as ledger,
                (select coalesce(sum(amount), 0) from bank_statement_lines where account_id = $2)::text as statement`,
        [TODAY, bank.id],
      ),
    );
    expect(toFixedString(sub(dec(balances.rows[0].ledger), dec(balances.rows[0].statement)), 2)).toBe("85000.00");
  });

  it("files every finished two-monthly GST return, and each still agrees with the books", async () => {
    const filed = (await as((tx) => listGstReturns(tx, { today: TODAY }))).gstReturns;
    expect(filed.map((entry) => [entry.periodStart, entry.periodEnd]).sort()).toEqual(gstPeriods("2025-06-01", TODAY));
    for (const entry of filed) {
      const again = await as((tx) => calculateGstReturn(tx, { periodStart: entry.periodStart, periodEnd: entry.periodEnd }));
      expect(again.boxes.box15).toBe(entry.boxes.box15);
      // The form works from totals (x 3/23), so it can be cents from the GST on the transactions.
      const onTransactions = sub(dec(plain(again.gstOnTransactions.sales)), dec(plain(again.gstOnTransactions.purchases)));
      expect(Math.abs(Number(toFixedString(sub(onTransactions, dec(plain(entry.boxes.box15))), 2)))).toBeLessThan(1);
    }
    // Every return due before today is paid (or refunded): the GST account holds only what's not yet due.
    const unpaid = filed.filter((entry) => entry.periodEnd >= "2026-09-01");
    const gstAccount = await as((tx) =>
      tx.query<{ balance: string }>(
        "select coalesce(sum(l.credit_amount - l.debit_amount), 0)::text as balance from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id where a.code = '2100' and j.posting_date <= '2026-09-30'",
      ),
    );
    const expected = unpaid.reduce((sum, entry) => add(sum, dec(plain(entry.boxes.box15))), dec("0"));
    expect(Math.abs(Number(toFixedString(sub(dec(gstAccount.rows[0].balance), expected), 2)))).toBeLessThan(1);
  });

  it("runs payroll: fortnightly pay runs approved and paid, and PAYE paid to IRD", async () => {
    const runs = await as((tx) => listPayRuns(tx, { status: "approved" }));
    expect(runs.length).toBeGreaterThan(25);
    const wages = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from payroll_wage_payments where status = 'active'"));
    expect(wages.rows[0].n).toBe(runs.length);
    const september = await as((tx) => getIrdPeriod(tx, "2026-09-01"));
    expect(Number(september.totalFromPayRuns)).toBeGreaterThan(0);
    expect(september.totalOwing).toBe("0.00");
  });

  it("keeps the herd: each season's movements reconcile and the count agrees", async () => {
    const season = await as((tx) => headCount(tx, { yearEnd: "2026-05-31" }));
    expect(season.ageingBalances).toBe(true);
    expect(season.unexplained).toEqual([]);
    const cows = season.rows.find((row) => row.classCode === "ma_cows")!;
    expect(cows.opening).toBe(232);
    expect(cows.closing).toBeGreaterThan(200);
    expect(season.totals.births).toBeGreaterThan(200);
    for (const row of season.rows) expect(row.closing).toBeGreaterThanOrEqual(0);
  });

  it("has farm records: paddocks, farm walks, grazings, supplements, fertiliser, soil tests, co-op shares, calendar and notebook", async () => {
    const counts = await as((tx) =>
      tx.query<Record<string, number>>(
        `select (select count(*)::int from farms) as farms,
                (select count(*)::int from paddocks) as paddocks,
                (select count(*)::int from paddock_boundaries) as boundaries,
                (select count(*)::int from pasture_readings) as readings,
                (select count(*)::int from grazings) as grazings,
                (select count(*)::int from supplements_fed) as supplements,
                (select count(*)::int from fertiliser_plans) as plans,
                (select count(*)::int from fertiliser_applications) as applications,
                (select count(*)::int from fertiliser_purchases) as purchases,
                (select count(*)::int from soil_tests) as soil,
                (select count(*)::int from coop_share_distributions) as dividends,
                (select count(*)::int from farm_calendar_items) as calendar,
                (select count(*)::int from farm_notebook) as notebook,
                (select count(*)::int from budgets where name = 'Season 2026-27') as budgets`,
      ),
    );
    expect(counts.rows[0]).toMatchObject({ farms: 2, paddocks: 32, boundaries: 32, notebook: 7 });
    const row = counts.rows[0];
    expect(row.readings).toBeGreaterThan(1000);
    expect(row.grazings).toBeGreaterThan(300);
    expect(row.supplements).toBeGreaterThan(40);
    expect(row.plans).toBeGreaterThanOrEqual(3);
    expect(row.applications).toBeGreaterThan(80);
    expect(row.purchases).toBeGreaterThanOrEqual(2);
    expect(row.soil).toBe(11);
    expect(row.dividends).toBe(3);
    // The demo farm's own calendar items, and this week's farm jobs (decision 1044).
    expect(row.calendar).toBe(15);
    expect(row.budgets).toBe(1);
  });

  it("has farm safety records: hazards, emergency details, an induction, equipment, training, chemicals and reports (decisions 1040-1042)", async () => {
    const home = await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Home farm'"));
    const farmId = home.rows[0].id;
    const hazards = await as((tx) => listHazards(tx, farmId));
    expect(hazards.length).toBe(4);
    expect(hazards.filter((hazard) => hazard.data.noGo).map((hazard) => hazard.data.title)).toEqual(["Effluent pond"]);
    expect(hazards.filter((hazard) => reviewOverdue(hazard.data, TODAY)).map((hazard) => hazard.data.title)).toEqual(["Steep face above the creek"]);
    const runoffId = (await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Runoff'"))).rows[0].id;
    expect((await as((tx) => listHazards(tx, runoffId))).map((hazard) => [hazard.data.title, hazard.data.noGo])).toEqual([["Tomo (sinkhole) in R3", true]]);
    const emergency = await as((tx) => getEmergency(tx, farmId));
    expect(emergency).toMatchObject({ version: 2, data: { assemblyPoint: expect.stringContaining("dairy shed") } });
    expect(emergency!.data.contacts).toHaveLength(4);
    // The induction has two versions; the gate sign-in is self-declared and still on site.
    const inductions = await as((tx) => listInductions(tx, farmId));
    expect(inductions.map((induction) => [induction.version, induction.signVersion])).toEqual([[2, 2]]);
    const signoffs = await as((tx) => listSignoffs(tx, farmId));
    expect(signoffs.map((signoff) => [signoff.data.person.userId ? "owner" : signoff.data.person.name, signoff.data.signedHow, signoff.current]).sort()).toEqual(
      [
        ["owner", "self", true],
        ["Rob Tane", "link", true],
        ["Tama Whitfield", "recorded", false],
      ].sort(),
    );
    const site = await as((tx) => onSite(tx, farmId));
    expect(site.here.map((visit) => [visit.data.person.name, visit.data.signedHow])).toEqual([["Rob Tane", "link"]]);
    // Equipment, linked to the fixed assets; Quad bike 2 out of use after a critical fault, with its action.
    const { equipment, checklists } = await as((tx) => listEquipment(tx, farmId));
    // Three more checklists and machines are the effluent systems' (#487).
    expect(checklists).toHaveLength(6);
    expect(equipment.map((item) => [item.data.name, item.available]).sort()).toEqual(
      [
        ["Pods (K-line)", true],
        ["Slurry tanker", true],
        ["Travelling irrigator", true],
        ["Boom sprayer", true],
        ["Fertiliser spreader", true],
        ["Quad bike 1", true],
        ["Quad bike 2", false],
        ["Tractor (110 hp)", true],
      ].sort(),
    );
    expect(equipment.filter((item) => item.data.fixedAssetId).length).toBe(3);
    const actions = await as((tx) => openActions(tx));
    expect(actions.map((action) => action.data.title)).toEqual(expect.arrayContaining(["Fix Quad bike 2: Brakes work (front and rear)", "Put gravel on the steep part of the track and a sign at the top"]));
    // Training: one expiring soon, one expired.
    const training = await as((tx) => listTraining(tx));
    expect(training.map((entry) => trainingState(entry, TODAY)).sort()).toEqual(["current", "current", "expired", "expiring", "no_expiry"]);
    // Chemicals with made-up data sheets (PDFs), one sheet over five years old, diesel without one.
    const chemicals = await as((tx) => listChemicals(tx, farmId));
    expect(chemicals).toHaveLength(4);
    expect(chemicals.map((chemical) => sdsState(chemical.data, TODAY)).sort()).toEqual(["check", "missing", "ok", "ok"]);
    const sheet = await as((tx) => readSafetyFile(tx, chemicals.find((chemical) => chemical.data.sds)!.data.sds!.id));
    expect(sheet.contentType).toBe("application/pdf");
    expect(sheet.content.subarray(0, 5).toString()).toBe("%PDF-");
    // A near miss and a minor incident with actions; the incident's details are restricted and generic.
    const reports = await as((tx) => listReports(tx, farmId));
    expect(reports.map((report) => [report.data.type, report.data.severity]).sort()).toEqual([["incident", "minor"], ["near_miss", "moderate"]]);
    const details = await as((tx) => tx.query<{ body: string }>("select body from safety_entries where kind = 'report_details'"));
    expect(details.rows).toHaveLength(1);
    expect(JSON.parse(details.rows[0].body).injury).toMatch(/made up/);
    // The whole safety history checks out.
    expect((await as((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
    // The weekly copy is on, to a made-up address, and never sends: Send a copy now is refused.
    expect((await as((tx) => copySettings(tx))).settings).toMatchObject({ on: true, toAddresses: ["safety-copy@example.com"] });
    const send = await weeklyCopySendRoute.POST(apiRequest("/api/farming/safety/weekly-copy/send", { method: "POST", cookie: await sessionCookieFor(jess), body: { organisationId: org } }), undefined as never);
    expect(send.status).toBe(403);
    await expect(sendSafetyCopy((await getOrganisation(org))!, { force: true })).resolves.toMatchObject({ sent: null, problem: expect.stringMatching(/demo farm/) });
    expect((await as((tx) => tx.query("select 1 from safety_copies"))).rowCount).toBe(0);
  });

  it("has this week's farm work: a mob in on the runoff, recent readings, and spreader jobs with tracks linked to fertiliser (decisions 1043-1045)", async () => {
    const homeId = (await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Home farm'"))).rows[0].id;
    const runoffId = (await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Runoff'"))).rows[0].id;
    // The map's colours vary on both farms: a mob in now on each, and paddocks grazed at different times.
    for (const farmId of [homeId, runoffId]) {
      const statuses = await as((tx) => paddockStatuses(tx, { farmId, onDate: TODAY }));
      const bands = new Set(statuses.map((status) => paddockBand({ inNow: status.inNow !== null, lastGrazedOn: status.lastGrazedOn, coverOn: status.cover?.measuredOn ?? null }, "grazed", TODAY).key));
      expect(bands.has("in"), farmId).toBe(true);
      expect(bands.size).toBeGreaterThanOrEqual(3);
    }
    const yesterday = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from pasture_readings where measured_on = $1", ["2026-10-23"]));
    expect(yesterday.rows[0].n).toBeGreaterThanOrEqual(4);
    const week = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from farm_calendar_items where item_date between $1 and $2", [TODAY, "2026-10-30"]));
    expect(week.rows[0].n).toBeGreaterThanOrEqual(5);
    // Three finished spreader jobs on the last day of spreading, each linked to its paddock's application.
    const jobs = await as((tx) => listTractorJobs(tx, { farmId: homeId }));
    expect(jobs).toHaveLength(3);
    for (const item of jobs) {
      const job = await as((tx) => getTractorJob(tx, item.id));
      expect(job.equipmentName).toBe("Fertiliser spreader");
      expect(job.fertiliserApplicationId).not.toBeNull();
      const application = await as((tx) => tx.query<{ paddock_id: string; applied_on: string }>("select paddock_id::text, applied_on::text from fertiliser_applications where id = $1", [job.fertiliserApplicationId]));
      expect(job.paddockIds).toEqual([application.rows[0].paddock_id]);
      // Started that morning in New Zealand.
      expect(isoDateAt(new Date(job.startedAt), "Pacific/Auckland")).toBe(application.rows[0].applied_on);
      expect(job.track.points.length).toBeGreaterThan(500);
      // Most of the paddock is covered (a phone GPS estimate), and little falls outside it.
      expect(job.summary.coveredPct).toBeGreaterThan(80);
      expect(job.track.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["start", "working_on", "working_off", "finish"]));
    }
    // One job went over a run twice and stopped to refill: more overlap than the others, and a paused off segment.
    const full = await Promise.all(jobs.map((item) => as((tx) => getTractorJob(tx, item.id))));
    const refilled = full.find((job) => job.notes?.includes("twice"))!;
    expect(refilled.track.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["pause", "resume"]));
    for (const other of full.filter((job) => job !== refilled)) expect(refilled.summary.overlapHa).toBeGreaterThan(other.summary.overlapHa);
    // The spreader is the safety record's machine too.
    const equipment = await as((tx) => listTractorEquipment(tx));
    expect(equipment.map((item) => [item.name, item.kind, item.current?.widthM, Boolean(item.safetyEquipmentId)])).toEqual([["Fertiliser spreader", "spreader", "18", true]]);
  });

  it("has the effluent setup: systems linked to Safety's machines, ponds, blocks, zones and an ORC consent to check (#487, decision 1079)", async () => {
    const homeId = (await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Home farm'"))).rows[0].id;
    const setup = await as((tx) => effluentSetup(tx, homeId));
    expect(setup.systems.map((system) => [system.data.name, system.data.type, system.available])).toEqual([
      ["Travelling irrigator", "travelling_irrigator", true],
      ["Pods (K-line)", "pods", true],
      ["Slurry tanker", "slurry_tanker", true],
    ]);
    expect(setup.systems.every((system) => system.checklistId !== null)).toBe(true);
    expect(setup.ponds.map((pond) => pond.data.name)).toEqual(["Main effluent pond", "Yard sump"]);
    expect(setup.blocks.map((block) => block.data.name)).toEqual(["Shed block", "Back block (tanker)"]);
    expect(setup.zones.map((zone) => zone.data.feature)).toEqual(["waterway", "bore", "dwelling"]);
    expect(setup.consents).toHaveLength(1);
    expect(setup.consents[0]).toMatchObject({ version: 2, data: { council: "orc", template: "orc", maxDepthMm: "25", fromTemplate: expect.arrayContaining(["buffers"]) } });
    expect((await as((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });

  it("has a fortnight's effluent log: runs, pond readings, wet days stored, one ponding, one too soon, the pods running now (decision 1089)", async () => {
    const homeId = (await as((tx) => tx.query<{ id: string }>("select id::text from farms where name = 'Home farm'"))).rows[0].id;
    const log = await as((tx) => effluentLog(tx, homeId, { from: "2026-10-01", to: TODAY }));
    expect(log.applications.filter((each) => each.running).map((each) => log.setup.systems.find((system) => system.recordId === each.data.systemId)?.data.name)).toEqual(["Pods (K-line)"]);
    expect(log.deferrals.map((each) => each.data.reason)).toEqual(["too_wet", "too_wet"]);
    expect(log.summary).toMatchObject({ overDepth: 0, ponding: 1, runoff: 0, tooSoon: 1, inBuffer: 0, whileOutOfUse: 0, noPondingCheck: 0 });
    expect(log.applications.every((each) => each.running || each.data.depthWorkedOut !== null)).toBe(true);
    expect(log.lastMoved.map((each) => each.systemName).sort()).toEqual(["Pods (K-line)", "Travelling irrigator"]);
  });

  it("has Analytics reports that all run", async () => {
    const dashboards = await as((tx) => listDashboards(tx));
    expect(dashboards.map((dashboard) => dashboard.name).sort()).toEqual(["Accounts: profit, cash and GST", "Business overview", "Farm", "Farm performance"]);
    for (const dashboard of dashboards) {
      for (const tile of dashboard.tiles) {
        if (!tile.query) continue;
        const result = await runTile(org, tile.query, { from: dashboard.settings.from, to: dashboard.settings.to, dates: { today: TODAY, yearEndMonth: 5 } });
        expect(result.rows.length, `${dashboard.name}: ${tile.title}`).toBeGreaterThan(0);
      }
    }
    const performance = dashboards.find((dashboard) => dashboard.name === "Farm performance")!;
    const perKg = performance.tiles.find((tile) => tile.title === "Working expenses per kg MS")!;
    const value = await runTile(org, perKg.query, { from: performance.settings.from, to: performance.settings.to });
    const dollars = Number(Object.values(value.rows[0])[0]);
    // A plausible farm working expenses figure, $/kg MS.
    expect(dollars).toBeGreaterThan(3);
    expect(dollars).toBeLessThan(9);
  });

  it("never reaches outside Tohyee: its jobs are off and stay off, and email and connections are refused", async () => {
    expect((await listOrganisationsForJobs()).map((organisation) => organisation.id)).not.toContain(org);
    await expect(resumeOrganisationJobs({ user: { id: jess.id, email: jess.email, isServerAdmin: true } }, org)).rejects.toThrow(/no paused jobs that can be turned on/);
    await expect(
      as((tx) => queueDocumentEmail(tx, { kind: "invoice", id: "1", to: "someone@example.com", subject: "Invoice", body: "Hello", idempotencyKey: key("email") })),
    ).rejects.toThrow(/demo farm/);
    const put = await emailSettingsRoute.PUT(
      apiRequest("/api/email/settings", { method: "PUT", cookie: await sessionCookieFor(jess), body: { organisationId: org, method: "smtp", host: "smtp.example.com" } }),
      undefined as never,
    );
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toMatch(/demo farm/);
    // Inviting people is refused too (#441): no login is made for them.
    const invited = await membersRoute.POST(
      apiRequest(`/api/organisations/${org}/members`, { method: "POST", cookie: await sessionCookieFor(jess), body: { email: "demo-invitee@example.com", displayName: "Demo Invitee", role: "viewer" } }),
      { params: Promise.resolve({ organisationId: org }) },
    );
    expect(invited.status).toBe(403);
    expect((await coreQuery("select 1 from users where email = 'demo-invitee@example.com'")).rowCount).toBe(0);
    // Reading still works.
    const get = await emailSettingsRoute.GET(apiRequest(`/api/email/settings?organisationId=${org}`, { cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(get.status).toBe(200);
  });

  it("leaves real organisations alone", async () => {
    const real = await createTestOrganisation(mere, "real-farm");
    expect(real.demo).toBeNull();
    expect((await listOrganisationsForJobs()).map((organisation) => organisation.id)).toContain("real-farm");
    const put = await emailSettingsRoute.PUT(
      apiRequest("/api/email/settings", { method: "PUT", cookie: await sessionCookieFor(mere), body: { organisationId: "real-farm", method: "smtp", host: "smtp.example.com" } }),
      undefined as never,
    );
    expect(put.status).not.toBe(403);
  });

  it("is one each: a second is refused, and someone else gets their own", async () => {
    await expect(addDemoFarm(jess, { today: TODAY })).rejects.toThrow(/already have the demo farm/);
    const again = await demoFarmsRoute.POST(apiRequest("/api/admin/demo-farms", { method: "POST", cookie: await sessionCookieFor(ana), body: { ownerEmail: jess.email } }), undefined as never);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/demo-jess@example.com already has the demo farm/);
    await expect(coreQuery("update organisations set demo_for_user_id = $1, demo_status = 'ready' where id = 'real-farm'", [jess.id])).rejects.toThrow(/organisations_one_demo_each/);
  });

  it("resets: the old one goes and a fresh one is made", async () => {
    const before = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from sales_invoices"));
    await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Tried something out", isCustomer: true }));
    const reset = await demoFarmRoute.POST(apiRequest(`/api/admin/demo-farms/${jess.id}`, { method: "POST", cookie: await sessionCookieFor(ana) }), params(jess.id));
    expect(reset.status).toBe(202);
    // Out of her list while it's made again.
    expect((await listMembershipsForUser(jess.id)).map((entry) => entry.organisation.id)).not.toContain(org);
    const demo = await waitFor(jess.id);
    expect(demo).toMatchObject({ organisationId: org, status: "ready", error: null });
    // Fresh: what she added is gone, and it's the same farm again (the same day gives the same figures).
    const after = await as((tx) => tx.query<{ n: number; tried: number }>("select (select count(*)::int from sales_invoices) as n, (select count(*)::int from contacts where name = 'Tried something out') as tried"));
    expect(after.rows[0]).toEqual({ n: before.rows[0].n, tried: 0 });
  }, 900_000);

  it("deletes: the database and the registry row go", async () => {
    const organisation = (await getOrganisation(org))!;
    const deleted = await demoFarmRoute.DELETE(apiRequest(`/api/admin/demo-farms/${jess.id}`, { method: "DELETE", cookie: await sessionCookieFor(ana) }), params(jess.id));
    expect(deleted.status).toBe(200);
    expect(await getDemoFarm(jess.id)).toBeNull();
    expect(await getOrganisation(org)).toBeNull();
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [organisation.databaseName])).rowCount).toBe(0);
    await expect(deleteDemoFarm(jess)).rejects.toThrow(/don't have the demo farm/);
  });
});
