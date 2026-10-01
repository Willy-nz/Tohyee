import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as quotasRoute from "@/app/api/crm/forecasts/quotas/route";
import * as forecastsRoute from "@/app/api/crm/forecasts/route";
import * as opportunityRoute from "@/app/api/crm/opportunities/[opportunityId]/route";
import * as salesProcessRoute from "@/app/api/crm/sales-processes/[recordTypeId]/route";
import * as stageRoute from "@/app/api/crm/stages/[stageId]/route";
import * as stagesRoute from "@/app/api/crm/stages/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { type Forecast, forecast, setQuota } from "@/lib/crm/forecast";
import type { OpportunityStageSetup } from "@/lib/crm/forecast-figures";
import { createRecordType } from "@/lib/crm/record-types/service";
import {
  createOpportunity,
  getOpportunity,
  listCompanies,
  listOpportunities,
  makeInvoiceFromOpportunity,
  type Opportunity,
  opportunityStageHistory,
  updateOpportunity,
} from "@/lib/crm/service";
import { createStage, listSalesProcesses, listStages, setSalesProcess, updateStage } from "@/lib/crm/stages";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
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
  testDatabaseUrl,
  type TestServer,
  withDb,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/**
 * Examples CRMS1-CRMS11 in docs/ACCOUNTING-EXAMPLES.md ("Opportunity stages,
 * probability and forecasts", not yet approved). Each test gets its own
 * organisation.
 */
describeWithDatabase("CRM opportunity stages and forecasts", () => {
  let server: TestServer;
  let owner: SessionUser;
  let ben: SessionUser;
  let viewer: SessionUser;
  let outsider: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@example.com", { serverAdmin: true, displayName: "Jess" });
    ben = await createTestUser("ben@example.com", { displayName: "Ben" });
    viewer = await createTestUser("viewer@example.com");
    outsider = await createTestUser("outsider@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `crms-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [org, ben.id, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const vets = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    const deal = await as((tx) =>
      createOpportunity(tx, { name: "Memorial paw prints 2027", contactId: vets.id, ownerUserId: owner.id, amount: "2400", closeDate: "2026-12-15" }),
    );
    const stages = () => as((tx) => listStages(tx));
    const stage = async (stageKey: string): Promise<OpportunityStageSetup> => (await stages()).find((s) => s.key === stageKey)!;
    const move = (id: string, input: Record<string, unknown>) => as((tx) => updateOpportunity(tx, id, input));
    const deal2 = (name: string, amount: string, extra: Record<string, unknown> = {}) =>
      as((tx) => createOpportunity(tx, { name, contactId: vets.id, ownerUserId: owner.id, amount, ...extra }));
    return { org, as, vets, deal, stages, stage, move, opportunity: deal2 };
  }

  const figures = (o: Opportunity) => [o.stage, o.probability, o.forecastCategory, o.weightedAmount];

  it("CRMS1: the upgrade turns the fixed stages into the organisation's own, with probabilities from them", async () => {
    const database = `${server.coreDatabase}_org_crms_upgrade`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${database}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, database) });
    await client.connect();
    try {
      const migration = tenantMigrations.filter((entry) => entry.version === "0066");
      expect(migration).toHaveLength(1);
      expect(migration[0].name).toBe("crm_opportunity_stages");
      await applyMigrations(client, tenantMigrations.filter((entry) => entry.version < "0066"), "crms-upgrade");
      await client.query(
        `insert into contacts (command_source, idempotency_key, request_hash, name, is_customer) values ('api', 'k1', 'h', 'Old customer', true);
         insert into crm_opportunities (name, contact_id, amount, currency_code, stage) values
           ('Clinic display', (select id from contacts where name = 'Old customer'), 600, 'NZD', 'proposal'),
           ('Menu reprint', (select id from contacts where name = 'Old customer'), 500, 'NZD', 'won'),
           ('Old prints', (select id from contacts where name = 'Old customer'), 200, 'NZD', 'lost');
         insert into audit_events (event_type, entity_type, entity_id, actor_email, details)
           select 'crm.opportunity_created', 'crm_opportunity', id::text, 'jess@example.com', '{"stage": "new", "amount": "600.00", "closeDate": null}'::jsonb
             from crm_opportunities where name = 'Clinic display';
         insert into audit_events (event_type, entity_type, entity_id, actor_email, details)
           select 'crm.opportunity_updated', 'crm_opportunity', id::text, 'jess@example.com',
                  '{"stage": "proposal", "stageFrom": "new", "amount": "600.00", "closeDate": null}'::jsonb
             from crm_opportunities where name = 'Clinic display';`,
      );
      await applyMigrations(client, tenantMigrations, "crms-upgrade");
      const stages = await client.query("select key, name, sort_order, stage_type, probability, forecast_category, is_active from crm_opportunity_stages order by sort_order");
      expect(stages.rows.map((row) => [row.key, row.name, row.stage_type, row.probability, row.forecast_category, row.is_active])).toEqual([
        ["new", "New", "open", 10, "pipeline", true],
        ["screening", "Screening", "open", 20, "pipeline", true],
        ["meeting", "Meeting", "open", 50, "pipeline", true],
        ["proposal", "Proposal", "open", 75, "pipeline", true],
        ["won", "Won", "won", 100, "closed", true],
        ["lost", "Lost", "lost", 0, "omitted", true],
      ]);
      const tx = { query: (sql: string, values?: unknown[]) => client.query(sql, values), baseCurrency: "NZD" } as unknown as OrgTx;
      const opportunities = await listOpportunities(tx);
      expect(opportunities.map((o) => [o.name, ...figures(o)])).toEqual([
        ["Clinic display", "proposal", 75, "pipeline", "450.00"],
        ["Menu reprint", "won", 100, "closed", "500.00"],
        ["Old prints", "lost", 0, "omitted", "0.00"],
      ]);
      const history = await opportunityStageHistory(tx, opportunities[0].id);
      expect(history.map((row) => [row.stageName, row.amount, row.probability, row.forecastCategory, row.by])).toEqual([
        ["Proposal", "600.00", null, null, "jess@example.com"],
        ["New", "600.00", null, null, "jess@example.com"],
      ]);
      await expect(
        client.query("insert into crm_opportunities (name, contact_id, amount, currency_code, stage) values ('Bad', (select id from contacts limit 1), 1, 'NZD', 'nonsense')"),
      ).rejects.toThrow(/no stage called nonsense/);
      await client.query("insert into crm_opportunities (name, contact_id, amount, currency_code) values ('Raw deal', (select id from contacts limit 1), 1, 'NZD')");
      expect((await client.query("select stage, probability, forecast_category from crm_opportunities where name = 'Raw deal'")).rows[0]).toEqual({
        stage: "new",
        probability: 10,
        forecast_category: "pipeline",
      });
      await expect(client.query("update crm_opportunities set probability = 90 where name = 'Menu reprint'")).rejects.toThrow(/won opportunity is 100%/);
    } finally {
      await client.end();
    }
    const w = await setup();
    expect(figures(w.deal)).toEqual(["new", 10, "pipeline", "240.00"]);
  });

  it("CRMS2: admins set up stages: a fixed key, unique names and the type's rules", async () => {
    const w = await setup();
    const negotiation = await w.as((tx) => createStage(tx, { name: "Negotiation", type: "open", probability: 90, forecastCategory: "commit" }));
    expect(negotiation).toMatchObject({ key: "negotiation", name: "Negotiation", type: "open", probability: 90, forecastCategory: "commit", isActive: true, sortOrder: 7 });
    await w.as((tx) => updateStage(tx, negotiation.id, { move: "up" }));
    await w.as((tx) => updateStage(tx, negotiation.id, { move: "up" }));
    expect((await w.stages()).map((s) => s.key)).toEqual(["new", "screening", "meeting", "proposal", "negotiation", "won", "lost"]);
    await expect(w.as((tx) => createStage(tx, { name: "proposal", type: "open" }))).rejects.toThrow("There's already a stage called proposal.");
    await expect(w.as((tx) => createStage(tx, { name: "Hot", type: "open", probability: 101 }))).rejects.toThrow("The probability must be a whole number from 0 to 100.");
    await expect(w.as((tx) => createStage(tx, { name: "Hot", type: "open", probability: "12.5" }))).rejects.toThrow("The probability must be a whole number from 0 to 100.");
    await expect(w.as((tx) => createStage(tx, { name: "Hot", type: "open", forecastCategory: "closed" }))).rejects.toThrow(
      "Only a Closed won stage can be in the Closed forecast category.",
    );
    await expect(w.as((tx) => createStage(tx, { name: "Signed", type: "won", probability: 90 }))).rejects.toThrow(
      "A Closed won stage is 100% and in the Closed forecast category.",
    );
    await expect(w.as((tx) => createStage(tx, { name: "Dead", type: "lost", forecastCategory: "pipeline" }))).rejects.toThrow(
      "A Closed lost stage is 0% and in the Omitted forecast category.",
    );
    const renamed = await w.as((tx) => updateStage(tx, negotiation.id, { name: "Negotiation/review" }));
    expect(renamed).toMatchObject({ key: "negotiation", name: "Negotiation/review" });
    await expect(w.as((tx) => updateStage(tx, negotiation.id, { name: "MEETING" }))).rejects.toThrow("There's already a stage called meeting.");
    const history = await w.as((tx) =>
      tx.query<{ event_type: string; details: Record<string, unknown> }>("select event_type, details from audit_events where entity_type = 'crm_opportunity_stage' order by id"),
    );
    expect(history.rows.map((row) => row.event_type)).toEqual(["crm.stage_created", "crm.stage_updated", "crm.stage_updated", "crm.stage_updated"]);
    expect(history.rows[3].details.changes).toEqual({ name: { from: "Negotiation", to: "Negotiation/review" } });
    await expect(w.as((tx) => tx.query("update crm_opportunity_stages set key = 'nego' where id = $1", [negotiation.id]))).rejects.toThrow(/key can't change/);
  });

  it("CRMS3: archived stages keep their opportunities; one active stage of each type stays; types don't change under opportunities", async () => {
    const w = await setup();
    await w.move(w.deal.id, { stage: "screening" });
    const screening = await w.stage("screening");
    await w.as((tx) => updateStage(tx, screening.id, { isActive: false }));
    const saved = await w.move(w.deal.id, { amount: "2500" });
    expect([saved.stage, saved.amount]).toEqual(["screening", "2500.00"]);
    const other = await w.opportunity("Kennel cards", "900");
    await expect(w.move(other.id, { stage: "screening" })).rejects.toThrow("Screening is archived, so it can't be chosen.");
    await expect(w.opportunity("Brochure", "100", { stage: "screening" })).rejects.toThrow("Screening is archived, so it can't be chosen.");
    const lost = await w.stage("lost");
    await expect(w.as((tx) => updateStage(tx, lost.id, { isActive: false }))).rejects.toThrow("Lost is the only active Closed lost stage. Add or restore another first.");
    const won = await w.stage("won");
    await expect(w.as((tx) => updateStage(tx, won.id, { type: "open" }))).rejects.toThrow("Won is the only active Closed won stage. Add or restore another first.");
    await expect(w.as((tx) => updateStage(tx, screening.id, { type: "lost" }))).rejects.toThrow("Screening has opportunities, so its type can't change.");
    const proposal = await w.stage("proposal");
    expect(await w.as((tx) => updateStage(tx, proposal.id, { type: "lost" }))).toMatchObject({ type: "lost", probability: 0, forecastCategory: "omitted" });
    expect(await w.as((tx) => updateStage(tx, proposal.id, { type: "open", probability: 75, forecastCategory: "pipeline" }))).toMatchObject({ type: "open", probability: 75 });
    expect(await w.as((tx) => updateStage(tx, screening.id, { isActive: true }))).toMatchObject({ isActive: true });
    await expect(w.as((tx) => tx.query("delete from crm_opportunity_stages where key = 'meeting'"))).rejects.toThrow(/never deleted/);
    // The database keeps one active stage of each type too.
    await expect(w.as((tx) => tx.query("update crm_opportunity_stages set is_active = false where key = 'lost'"))).rejects.toThrow(/At least one active Closed lost stage/);
    await expect(w.as((tx) => tx.query("update crm_opportunity_stages set stage_type = 'lost', probability = 0, forecast_category = 'omitted' where key = 'screening'"))).rejects.toThrow(
      /Screening has opportunities/,
    );
  });

  it("CRMS4: the invoice follows the stage's type, not its name", async () => {
    const w = await setup();
    const won = await w.stage("won");
    await w.as((tx) => updateStage(tx, won.id, { name: "Closed won" }));
    await w.move(w.deal.id, { stage: "won" });
    const { invoice } = await w.as((tx) => makeInvoiceFromOpportunity(tx, w.deal.id));
    expect(invoice.total).toBe("2760.00");
    const renewal = await w.as((tx) => createStage(tx, { name: "Won – renewal", type: "won" }));
    expect(renewal).toMatchObject({ key: "won_renewal", probability: 100, forecastCategory: "closed" });
    const second = await w.opportunity("Renewal 2027", "1000", { stage: "won_renewal" });
    expect(figures(second)).toEqual(["won_renewal", 100, "closed", "1000.00"]);
    const made = await w.as((tx) => makeInvoiceFromOpportunity(tx, second.id));
    expect(made.invoice.total).toBe("1150.00");
    const gone = await w.opportunity("Gone", "100", { stage: "lost" });
    await expect(w.as((tx) => makeInvoiceFromOpportunity(tx, gone.id))).rejects.toThrow("Only a won opportunity can make an invoice.");
    const open = await w.opportunity("Open", "100", { stage: "proposal" });
    await expect(w.as((tx) => makeInvoiceFromOpportunity(tx, open.id))).rejects.toThrow("Only a won opportunity can make an invoice.");
    await expect(w.move(second.id, { stage: "won" })).rejects.toThrow("has made an invoice");
    expect((await w.move(second.id, { name: "Renewal 2027/28" })).stage).toBe("won_renewal");
    await expect(w.as((tx) => tx.query("update crm_opportunities set stage = 'proposal' where id = $1", [second.id]))).rejects.toThrow(/has made an invoice/);
    await expect(w.as((tx) => tx.query("update crm_opportunities set invoice_id = $2 where id = $1", [open.id, made.invoice.id]))).rejects.toThrow();
    await expect(w.as((tx) => updateStage(tx, renewal.id, { type: "open" }))).rejects.toThrow("Won – renewal has opportunities, so its type can't change.");
  });

  it("CRMS5: probability and forecast category start as the stage's and can be changed within its type's rules", async () => {
    const w = await setup();
    expect(figures(w.deal)).toEqual(["new", 10, "pipeline", "240.00"]);
    expect(figures(await w.move(w.deal.id, { stage: "proposal" }))).toEqual(["proposal", 75, "pipeline", "1800.00"]);
    expect(figures(await w.move(w.deal.id, { probability: 80, forecastCategory: "commit" }))).toEqual(["proposal", 80, "commit", "1920.00"]);
    await w.as((tx) => createStage(tx, { name: "Negotiation", type: "open", probability: 90, forecastCategory: "commit" }));
    expect(figures(await w.move(w.deal.id, { stage: "negotiation" }))).toEqual(["negotiation", 90, "commit", "2160.00"]);
    expect(figures(await w.move(w.deal.id, { stage: "proposal", probability: "70" }))).toEqual(["proposal", 70, "pipeline", "1680.00"]);
    expect(figures(await w.move(w.deal.id, { forecastCategory: "omitted" }))).toEqual(["proposal", 70, "omitted", "1680.00"]);
    await expect(w.move(w.deal.id, { forecastCategory: "closed" })).rejects.toThrow("Only a won opportunity can be in the Closed forecast category.");
    await expect(w.move(w.deal.id, { probability: 101 })).rejects.toThrow("The probability must be a whole number from 0 to 100.");
    await expect(w.move(w.deal.id, { forecastCategory: "likely" })).rejects.toThrow("The forecast category must be");
    expect(figures(await w.move(w.deal.id, { stage: "won" }))).toEqual(["won", 100, "closed", "2400.00"]);
    await expect(w.move(w.deal.id, { probability: 90 })).rejects.toThrow("A won opportunity is 100% and in the Closed forecast category.");
    await expect(w.move(w.deal.id, { forecastCategory: "commit" })).rejects.toThrow("A won opportunity is 100% and in the Closed forecast category.");
    expect(figures(await w.move(w.deal.id, { stage: "lost" }))).toEqual(["lost", 0, "omitted", "0.00"]);
    const decals = await w.opportunity("Window decals", "333.33", { probability: 15 });
    expect(figures(decals)).toEqual(["new", 15, "pipeline", "50.00"]);
    const history = await w.as((tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where entity_type = 'crm_opportunity' and entity_id = $1 order by id desc limit 1", [w.deal.id]),
    );
    expect(history.rows[0].details).toMatchObject({ stage: "lost", stageFrom: "won", probability: 0, forecastCategory: "omitted" });
    // The open pipeline and Home follow the stage type.
    expect((await w.as((tx) => listCompanies(tx))).find((c) => c.name === "Mānuka Vets")!.openPipeline).toBe("333.33");
  });

  it("CRMS6: stage history records each change of stage, amount, probability, category or close date", async () => {
    const w = await setup();
    await w.move(w.deal.id, { stage: "proposal" });
    await w.move(w.deal.id, { probability: 80, forecastCategory: "commit" });
    await w.move(w.deal.id, { name: "Memorial paw prints 2027/28" });
    await w.move(w.deal.id, { amount: "2600" });
    await w.move(w.deal.id, { closeDate: "2027-01-15" });
    const history = await w.as((tx) => opportunityStageHistory(tx, w.deal.id));
    expect(history.map((row) => [row.closeDate, row.amount, row.probability, row.forecastCategory, row.stageName, row.weightedAmount, row.by])).toEqual([
      ["2027-01-15", "2600.00", 80, "commit", "Proposal", "2080.00", "jess@example.com"],
      ["2026-12-15", "2600.00", 80, "commit", "Proposal", "2080.00", "jess@example.com"],
      ["2026-12-15", "2400.00", 80, "commit", "Proposal", "1920.00", "jess@example.com"],
      ["2026-12-15", "2400.00", 75, "pipeline", "Proposal", "1800.00", "jess@example.com"],
      ["2026-12-15", "2400.00", 10, "pipeline", "New", "240.00", "jess@example.com"],
    ]);
    expect(history.every((row) => /^\d{4}-\d{2}-\d{2}T/.test(row.at))).toBe(true);
    const page = await opportunityRoute.GET(
      apiRequest(`/api/crm/opportunities/${w.deal.id}?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }),
      params({ opportunityId: w.deal.id }),
    );
    expect(page.status).toBe(200);
    expect(((await page.json()) as { stageHistory: unknown[] }).stageHistory).toHaveLength(5);
  });

  it("CRMS7: sales processes choose the stages an opportunity record type uses", async () => {
    const w = await setup();
    const grant = await w.as((tx) => createRecordType(tx, { record: "opportunity", name: "Grant application" }));
    const process = await w.as((tx) => setSalesProcess(tx, grant.id, ["lost", "new", "won", "proposal"]));
    expect(process).toMatchObject({ recordTypeName: "Grant application", stageKeys: ["new", "proposal", "won", "lost"] });
    const application = await w.opportunity("Community grant 2027", "5000", { recordTypeId: grant.id });
    expect(application.stage).toBe("new");
    await expect(w.move(application.id, { stage: "meeting" })).rejects.toThrow("Meeting isn't in the Grant application sales process.");
    expect((await w.move(application.id, { stage: "proposal" })).stage).toBe("proposal");
    await expect(w.as((tx) => setSalesProcess(tx, grant.id, ["new", "won"]))).rejects.toThrow(
      "A sales process needs at least one Open, one Closed won and one Closed lost stage.",
    );
    await expect(w.as((tx) => setSalesProcess(tx, grant.id, ["new", "won", "lost", "nope"]))).rejects.toThrow("There's no stage called nope.");
    await w.move(w.deal.id, { stage: "meeting" });
    await expect(w.move(w.deal.id, { recordTypeId: grant.id })).rejects.toThrow("Meeting isn't in the Grant application sales process.");
    const changed = await w.move(w.deal.id, { recordTypeId: grant.id, stage: "proposal" });
    expect([changed.recordTypeName, changed.stage]).toEqual(["Grant application", "proposal"]);
    // A stage first in the process is where a new one starts.
    const late = await w.as((tx) => createStage(tx, { name: "Enquiry", type: "open", probability: 5 }));
    for (let n = 0; n < 7; n += 1) await w.as((tx) => updateStage(tx, late.id, { move: "up" }));
    expect((await w.stages())[0].key).toBe("enquiry");
    expect((await w.opportunity("Standard one", "1")).stage).toBe("enquiry");
    expect((await w.opportunity("Grant one", "1", { recordTypeId: grant.id })).stage).toBe("new");
    expect((await w.as((tx) => setSalesProcess(tx, grant.id, null))).stageKeys).toBeNull();
    expect((await w.as((tx) => listSalesProcesses(tx))).map((p) => [p.recordTypeName, p.stageKeys])).toEqual([
      ["Standard", null],
      ["Grant application", null],
    ]);
    const events = await w.as((tx) => tx.query("select 1 from audit_events where event_type = 'crm.sales_process_updated'"));
    expect(events.rows).toHaveLength(2);
    // The pipeline lists opportunities in the stages' order.
    expect((await w.as((tx) => listOpportunities(tx))).map((o) => o.stage)).toEqual(["enquiry", "new", "proposal", "proposal"]);
  });

  /** CRMS8's opportunities. */
  async function forecastWorld() {
    const w = await setup();
    const acme = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Acme Inc", isCustomer: true, currencyCode: "USD" }))).contact;
    await w.as((tx) => createStage(tx, { name: "Negotiation", type: "open", probability: 90, forecastCategory: "commit" }));
    const make = (name: string, amount: string, closeDate: string | null, stage: string, extra: Record<string, unknown> = {}) =>
      w.as((tx) => createOpportunity(tx, { name, contactId: w.vets.id, ownerUserId: owner.id, amount, closeDate, stage, ...extra }));
    await w.move(w.deal.id, { stage: "negotiation", closeDate: "2026-10-20" });
    const clinic = await make("Clinic display", "600", "2026-10-05", "won");
    const kennel = await make("Kennel cards", "900", "2026-10-28", "proposal", { forecastCategory: "best_case" });
    const brochure = await make("Brochure", "1000", "2026-10-30", "meeting");
    await make("Old prints", "500", "2026-10-10", "lost");
    await make("Sponsorship", "300", "2026-10-12", "screening", { forecastCategory: "omitted" });
    await make("Logo licence", "100", "2026-10-25", "proposal", { contactId: acme.id, forecastCategory: "commit" });
    await make("Christmas cards", "1500", "2026-11-20", "proposal");
    await make("Website", "700", null, "new");
    await make("Menu reprint", "1250", "2026-10-03", "won", { ownerUserId: ben.id });
    await make("Window decals", "333.33", "2026-10-31", "new", { ownerUserId: ben.id, probability: 15 });
    await make("September deal", "999", "2026-09-30", "proposal");
    return { ...w, clinic, kennel, brochure };
  }

  const row = (f: Forecast, periodStart: string, owner: string, currency: string) =>
    f.rows.find((r) => r.periodStart === periodStart && r.ownerName === owner && r.currencyCode === currency);
  const numbers = (r: { closed: string; commit: string; bestCase: string; pipeline: string; weighted: string } | undefined) =>
    r ? [r.closed, r.commit, r.bestCase, r.pipeline, r.weighted] : null;

  it("CRMS8: the forecast by month and owner, each currency on its own, with cumulative totals", async () => {
    const w = await forecastWorld();
    const f = await w.as((tx) => forecast(tx, { period: "month", from: "2026-10-01", periods: 3 }));
    expect(f.periods.map((p) => p.label)).toEqual(["Oct 2026", "Nov 2026", "Dec 2026"]);
    expect(f.rows.map((r) => [r.periodStart, r.ownerName, r.currencyCode])).toEqual([
      ["2026-10-01", "Ben", "NZD"],
      ["2026-10-01", "Jess", "NZD"],
      ["2026-10-01", "Jess", "USD"],
      ["2026-11-01", "Jess", "NZD"],
    ]);
    expect(numbers(row(f, "2026-10-01", "Ben", "NZD"))).toEqual(["1250.00", "1250.00", "1250.00", "333.33", "50.00"]);
    expect(numbers(row(f, "2026-10-01", "Jess", "NZD"))).toEqual(["600.00", "3000.00", "3900.00", "4300.00", "3335.00"]);
    expect(numbers(row(f, "2026-10-01", "Jess", "USD"))).toEqual(["0.00", "100.00", "100.00", "100.00", "75.00"]);
    expect(numbers(row(f, "2026-11-01", "Jess", "NZD"))).toEqual(["0.00", "0.00", "0.00", "1500.00", "1125.00"]);
    expect(f.totals.map((t) => [t.periodStart, t.currencyCode, ...numbers(t)!])).toEqual([
      ["2026-10-01", "NZD", "1850.00", "4250.00", "5150.00", "4633.33", "3385.00"],
      ["2026-10-01", "USD", "0.00", "100.00", "100.00", "100.00", "75.00"],
      ["2026-11-01", "NZD", "0.00", "0.00", "0.00", "1500.00", "1125.00"],
    ]);
    expect(f.noCloseDate).toBe(1);
    expect(f.opportunities.some((o) => o.name === "September deal" || o.name === "Website")).toBe(false);
    const bens = await w.as((tx) => forecast(tx, { from: "2026-10-01", ownerUserId: ben.id }));
    expect(bens.rows.map((r) => r.ownerName)).toEqual(["Ben"]);
    expect(bens.noCloseDate).toBe(0);
  });

  it("CRMS9: by quarter of the financial year, and drilling down", async () => {
    const w = await forecastWorld();
    const q = await w.as((tx) => forecast(tx, { period: "quarter", from: "2026-10-02", periods: 1 }));
    expect(q.periods).toEqual([{ start: "2026-10-01", end: "2026-12-31", label: "Oct-Dec 2026" }]);
    expect(numbers(row(q, "2026-10-01", "Jess", "NZD"))).toEqual(["600.00", "3000.00", "3900.00", "5800.00", "4460.00"]);
    const f = await w.as((tx) => forecast(tx, { from: "2026-10-01", periods: 1 }));
    const { inMeasure } = await import("@/lib/crm/forecast-figures");
    const drill = (measure: "closed" | "bestCase" | "pipeline" | "weighted") =>
      f.opportunities
        .filter((o) => o.ownerUserId === owner.id && o.currencyCode === "NZD" && inMeasure(o, measure))
        .map((o) => (measure === "weighted" ? `${o.name} ${o.weightedAmount}` : o.name))
        .sort();
    expect(drill("bestCase")).toEqual(["Clinic display", "Kennel cards", "Memorial paw prints 2027"]);
    expect(drill("pipeline")).toEqual(["Brochure", "Kennel cards", "Memorial paw prints 2027"]);
    expect(drill("closed")).toEqual(["Clinic display"]);
    expect(drill("weighted")).toEqual(["Brochure 500.00", "Kennel cards 675.00", "Memorial paw prints 2027 2160.00"]);
    await w.as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    const may = await w.as((tx) => forecast(tx, { period: "quarter", from: "2026-10-02", periods: 1 }));
    expect(may.periods[0]).toMatchObject({ start: "2026-09-01", end: "2026-11-30" });
  });

  it("CRMS10: quotas per owner per month and attainment", async () => {
    const w = await forecastWorld();
    await w.as((tx) => setQuota(tx, { ownerUserId: owner.id, month: "2026-10-01", amount: "5000" }));
    await w.as((tx) => setQuota(tx, { ownerUserId: owner.id, month: "2026-11-01", amount: "5000.00" }));
    await w.as((tx) => setQuota(tx, { ownerUserId: ben.id, month: "2026-10-01", amount: "1000" }));
    const f = await w.as((tx) => forecast(tx, { from: "2026-10-01", periods: 3 }));
    expect([row(f, "2026-10-01", "Jess", "NZD")!.quota, row(f, "2026-10-01", "Jess", "NZD")!.attainment]).toEqual(["5000.00", "12.00"]);
    expect([row(f, "2026-11-01", "Jess", "NZD")!.quota, row(f, "2026-11-01", "Jess", "NZD")!.attainment]).toEqual(["5000.00", "0.00"]);
    expect([row(f, "2026-10-01", "Ben", "NZD")!.quota, row(f, "2026-10-01", "Ben", "NZD")!.attainment]).toEqual(["1000.00", "125.00"]);
    expect(row(f, "2026-10-01", "Jess", "USD")!.quota).toBeNull();
    expect(f.rows.some((r) => r.periodStart === "2026-12-01")).toBe(false);
    const q = await w.as((tx) => forecast(tx, { period: "quarter", from: "2026-10-01", periods: 1 }));
    expect([row(q, "2026-10-01", "Jess", "NZD")!.quota, row(q, "2026-10-01", "Jess", "NZD")!.attainment]).toEqual(["10000.00", "6.00"]);
    expect([row(q, "2026-10-01", "Ben", "NZD")!.quota, row(q, "2026-10-01", "Ben", "NZD")!.attainment]).toEqual(["1000.00", "125.00"]);
    await expect(w.as((tx) => setQuota(tx, { ownerUserId: owner.id, month: "2026-10-01", amount: "-1" }))).rejects.toThrow("A quota can't be negative.");
    await expect(w.as((tx) => setQuota(tx, { ownerUserId: outsider.id, month: "2026-10-01", amount: "1" }))).rejects.toThrow(
      "A quota's owner must be a member of the organisation.",
    );
    await expect(w.as((tx) => setQuota(tx, { ownerUserId: owner.id, month: "2026-10-15", amount: "1" }))).rejects.toThrow("A quota is for a month");
    await w.as((tx) => setQuota(tx, { ownerUserId: owner.id, month: "2026-11-01", amount: null }));
    const after = await w.as((tx) => forecast(tx, { from: "2026-11-01", periods: 1 }));
    expect(row(after, "2026-11-01", "Jess", "NZD")!.quota).toBeNull();
    const events = await w.as((tx) => tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'crm.quota_set' order by id"));
    expect(events.rows.map((e) => [e.details.month, e.details.amount, e.details.amountFrom])).toEqual([
      ["2026-10-01", "5000.00", null],
      ["2026-11-01", "5000.00", null],
      ["2026-10-01", "1000.00", null],
      ["2026-11-01", null, "5000.00"],
    ]);
  });

  it("CRMS11: over HTTP every route checks the member and role; with the CRM off set-up is refused", async () => {
    const w = await setup();
    const cookie = async (user: SessionUser) => sessionCookieFor(user);
    const [viewerCookie, benCookie, ownerCookie, outsiderCookie] = [await cookie(viewer), await cookie(ben), await cookie(owner), await cookie(outsider)];
    const read = (c?: string) => stagesRoute.GET(apiRequest(`/api/crm/stages?organisationId=${w.org}`, { cookie: c }), noContext);
    expect((await read()).status).toBe(401);
    expect((await read(outsiderCookie)).status).toBe(404);
    const listed = await read(viewerCookie);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { stages: OpportunityStageSetup[] }).stages).toHaveLength(6);
    const forecastRead = (c?: string) => forecastsRoute.GET(apiRequest(`/api/crm/forecasts?organisationId=${w.org}&period=quarter&from=2026-10-01`, { cookie: c }), noContext);
    expect((await forecastRead()).status).toBe(401);
    expect((await forecastRead(outsiderCookie)).status).toBe(404);
    expect((await forecastRead(viewerCookie)).status).toBe(200);
    const body = { organisationId: w.org, name: "Negotiation", type: "open", probability: 90, forecastCategory: "commit" };
    const post = (c: string) => stagesRoute.POST(apiRequest("/api/crm/stages", { method: "POST", cookie: c, body }), noContext);
    expect((await post(viewerCookie)).status).toBe(403);
    expect((await post(benCookie)).status).toBe(403);
    const created = await post(ownerCookie);
    expect(created.status).toBe(201);
    const stage = ((await created.json()) as { stage: OpportunityStageSetup }).stage;
    const patch = (c: string) =>
      stageRoute.PATCH(apiRequest(`/api/crm/stages/${stage.id}`, { method: "PATCH", cookie: c, body: { organisationId: w.org, probability: 85 } }), params({ stageId: stage.id }));
    expect((await patch(benCookie)).status).toBe(403);
    expect((await patch(ownerCookie)).status).toBe(200);
    const standard = (await w.as((tx) => listSalesProcesses(tx)))[0];
    const process = (c: string) =>
      salesProcessRoute.PUT(
        apiRequest(`/api/crm/sales-processes/${standard.recordTypeId}`, { method: "PUT", cookie: c, body: { organisationId: w.org, stageKeys: ["new", "won", "lost"] } }),
        params({ recordTypeId: standard.recordTypeId }),
      );
    expect((await process(benCookie)).status).toBe(403);
    expect((await process(ownerCookie)).status).toBe(200);
    const quota = (c: string) =>
      quotasRoute.PUT(apiRequest("/api/crm/forecasts/quotas", { method: "PUT", cookie: c, body: { organisationId: w.org, ownerUserId: ben.id, month: "2026-10-01", amount: "1000" } }), noContext);
    expect((await quota(benCookie)).status).toBe(403);
    expect((await quota(ownerCookie)).status).toBe(200);
    const change = (c: string) =>
      opportunityRoute.PATCH(
        apiRequest(`/api/crm/opportunities/${w.deal.id}`, { method: "PATCH", cookie: c, body: { organisationId: w.org, probability: 30 } }),
        params({ opportunityId: w.deal.id }),
      );
    expect((await change(viewerCookie)).status).toBe(403);
    const changed = await change(benCookie);
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { opportunity: Opportunity }).opportunity).toMatchObject({ probability: 30, weightedAmount: "720.00" });
    expect((await w.as((tx) => getOpportunity(tx, w.deal.id))).probability).toBe(30);

    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    const off = "The CRM is off. An admin can turn it on in Settings.";
    await expect(w.as((tx) => createStage(tx, { name: "Later", type: "open" }))).rejects.toThrow(off);
    await expect(w.as((tx) => updateStage(tx, stage.id, { probability: 80 }))).rejects.toThrow(off);
    await expect(w.as((tx) => setSalesProcess(tx, standard.recordTypeId, null))).rejects.toThrow(off);
    await expect(w.as((tx) => setQuota(tx, { ownerUserId: ben.id, month: "2026-10-01", amount: "1" }))).rejects.toThrow(off);
  });
});
