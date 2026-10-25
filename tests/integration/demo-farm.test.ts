import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as demoRoute from "@/app/api/demo-farm/route";
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
  let org = "";
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
    // Anyone signed in adds it from the organisation menu: the request returns at once, and the build runs in the background.
    const started = await demoRoute.POST(apiRequest("/api/demo-farm", { method: "POST", cookie: await sessionCookieFor(jess), body: { action: "add" } }), undefined as never);
    expect(started.status).toBe(202);
    const body = (await started.json()) as { demo: { status: string; organisationId: string } };
    expect(body.demo.status).toBe("building");
    org = body.demo.organisationId;
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
    const response = await demoRoute.GET(apiRequest("/api/demo-farm", { cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(await response.json()).toMatchObject({ enabled: true, demo: { organisationId: org, status: "ready" } });
  });

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
    expect(row.calendar).toBe(11);
    expect(row.budgets).toBe(1);
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
    const again = await demoRoute.POST(apiRequest("/api/demo-farm", { method: "POST", cookie: await sessionCookieFor(jess), body: { action: "add" } }), undefined as never);
    expect(again.status).toBe(409);
    await expect(coreQuery("update organisations set demo_for_user_id = $1, demo_status = 'ready' where id = 'real-farm'", [jess.id])).rejects.toThrow(/organisations_one_demo_each/);
  });

  it("resets: the old one goes and a fresh one is made", async () => {
    const before = await as((tx) => tx.query<{ n: number }>("select count(*)::int as n from sales_invoices"));
    await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Tried something out", isCustomer: true }));
    const reset = await demoRoute.POST(apiRequest("/api/demo-farm", { method: "POST", cookie: await sessionCookieFor(jess), body: { action: "reset" } }), undefined as never);
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
    const deleted = await demoRoute.DELETE(apiRequest("/api/demo-farm", { method: "DELETE", cookie: await sessionCookieFor(jess) }), undefined as never);
    expect(deleted.status).toBe(200);
    expect(await getDemoFarm(jess.id)).toBeNull();
    expect(await getOrganisation(org)).toBeNull();
    expect((await getAdminPool().query("select 1 from pg_database where datname = $1", [organisation.databaseName])).rowCount).toBe(0);
    await expect(deleteDemoFarm(jess)).rejects.toThrow(/don't have the demo farm/);
  });
});
