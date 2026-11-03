import { afterAll, beforeAll, expect, it } from "vitest";
import * as adminOrganisationsRoute from "@/app/api/admin/organisations/route";
import * as impactRoute from "@/app/api/organisations/[organisationId]/settings/gst-impact/route";
import { assertAiGstTreatment } from "@/lib/ai/gst-evidence";
import { READ_TOOLS } from "@/lib/ai/tools";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts, listStatementLines } from "@/lib/bank/accounts";
import { importStatementFile } from "@/lib/bank/imports";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import { getGstRegistration, gstStatusOn } from "@/lib/tax/registration";
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

/**
 * Issue #546, examples GSR1-GSR10 in docs/ACCOUNTING-EXAMPLES.md ("GST
 * registration a person has confirmed", as Xero does, not yet reviewed).
 * The pure rules are in tests/unit/gst-registration-status.test.ts.
 */
describeWithDatabase("GST registration a person has confirmed (#546, GSR1-GSR10)", () => {
  let server: TestServer;
  let owner: SessionUser;
  const noContext = { params: Promise.resolve({}) };
  const as = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("gsr-owner@example.com", { serverAdmin: true });
  });
  afterAll(async () => {
    await server?.teardown();
  });

  const create = async (id: string, gstRegistered: unknown) =>
    adminOrganisationsRoute.POST(
      apiRequest("/api/admin/organisations", { method: "POST", cookie: await sessionCookieFor(owner), body: { id, displayName: id, modules: { gstRegistered } } }),
      noContext,
    );
  const registration = (org: string) => as(org, (tx) => getGstRegistration(tx));

  it("GSR1-GSR2: the answer given when the organisation is created", async () => {
    expect((await create("gsr-yes", true)).status).toBe(201);
    expect(await registration("gsr-yes")).toMatchObject({ registered: true, confirmed: true });
    expect(await as("gsr-yes", (tx) => getOrganisationSettings(tx))).toMatchObject({ gstRegistrationConfirmedBy: "gsr-owner@example.com" });
    expect((await create("gsr-no", false)).status).toBe(201);
    expect(await registration("gsr-no")).toMatchObject({ registered: false, confirmed: true });
    expect((await create("gsr-unsure", "unsure")).status).toBe(201);
    expect(await registration("gsr-unsure")).toMatchObject({ registered: false, confirmed: false });
    const bad = await create("gsr-bad", "maybe");
    expect(bad.status).toBe(400);
    // Left out (older callers): Tohyee's unconfirmed starting guess, as NR8.
    await createTestOrganisation(owner, "gsr-default");
    expect(await registration("gsr-default")).toMatchObject({ registered: true, confirmed: false });
  }, 180_000);

  it("GSR4-GSR5: saving other settings doesn't confirm; choosing, changing or typing a GST number does, and is audited", async () => {
    const org = "gsr-confirm";
    await createTestOrganisation(owner, org);
    await as(org, (tx) => updateOrganisationSettings(tx, { displayName: "Kowhai Crafts", gstRegistered: true }));
    expect(await registration(org)).toMatchObject({ confirmed: false });
    await as(org, (tx) => updateOrganisationSettings(tx, { gstRegistrationConfirmed: true }));
    expect(await registration(org)).toMatchObject({ registered: true, confirmed: true });
    const audit = await as(org, (tx) =>
      tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'organisation.settings_updated' order by id desc limit 1"),
    );
    expect(audit.rows[0].details).toMatchObject({ gstRegistrationConfirmed: true });

    const numbered = "gsr-number";
    await createTestOrganisation(owner, numbered);
    await as(numbered, (tx) => updateOrganisationSettings(tx, { gstNumber: "123-456-789" }));
    expect(await registration(numbered)).toMatchObject({ registered: true, confirmed: true });
  });

  it("GSR8: a change reaching months with entries lists them, needs the person's acknowledgement, and rewrites nothing", async () => {
    const org = "gsr-impact";
    await createTestOrganisation(owner, org);
    await as(org, (tx) => updateOrganisationSettings(tx, { displayName: "Kowhai Crafts", gstRegistered: false }));
    const kobe = (await as(org, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Cafe", isCustomer: true }))).contact;
    for (const date of ["2026-09-10", "2026-10-15", "2026-10-20"]) {
      await as(org, async (tx) => {
        const { invoice } = await createInvoice(tx, {
          idempotencyKey: key("i"),
          contactId: kobe.id,
          invoiceDate: date,
          dueDate: date,
          amountsMode: "no_tax",
          lines: [{ description: "Cards", quantity: "1", unitPrice: "115", accountCode: "4000" }],
        });
        await approveInvoice(tx, invoice.id, { idempotencyKey: key("a") });
      });
    }
    const impact = await impactRoute.GET(
      apiRequest(`/api/organisations/${org}/settings/gst-impact?registered=true&from=2026-10-01`, { cookie: await sessionCookieFor(owner) }),
      { params: Promise.resolve({ organisationId: org }) },
    );
    expect(await impact.json()).toEqual({ periods: [{ month: "2026-10", label: "Oct 2026", entries: 2, withGst: 0 }] });

    const register = { gstNumber: "123-456-789", gstRegistered: true, gstRegisteredFrom: "2026-10-01" };
    await expect(as(org, (tx) => updateOrganisationSettings(tx, register))).rejects.toThrow(
      /months that already have entries \(Oct 2026\)\. Nothing already posted is changed/,
    );
    await as(org, (tx) => updateOrganisationSettings(tx, { ...register, acknowledgeAffectedPeriods: true }));
    expect(await registration(org)).toMatchObject({ registered: true, from: "2026-10-01", confirmed: true });
    // GSR8: the October invoices keep their 115.00 sales with no GST.
    const gst = await as(org, (tx) =>
      tx.query<{ count: string }>("select count(*)::text as count from ledger_journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'gst'"),
    );
    expect(gst.rows[0].count).toBe("0");
    // A change that reaches no entries needs nothing extra.
    await as(org, (tx) => updateOrganisationSettings(tx, { gstRegisteredUntil: "2027-03-31" }));
  });

  it("GSR9: get_organisation reports the same registration as Settings", async () => {
    const org = "gsr-mcp";
    await createTestOrganisation(owner, org);
    const tool = READ_TOOLS.find((entry) => entry.name === "get_organisation")!;
    const context = { role: "owner", source: "ai" } as unknown as Parameters<typeof tool.run>[2];
    const before = (await as(org, (tx) => tool.run(tx, {}, context))) as { gstRegistration: { statusToday: string; confirmed: boolean } };
    expect(before.gstRegistration).toMatchObject({ statusToday: "unconfirmed", confirmed: false, registered: true });
    await as(org, (tx) => updateOrganisationSettings(tx, { gstRegistered: false }));
    const after = (await as(org, (tx) => tool.run(tx, {}, context))) as { gstRegistration: { statusToday: string; confirmed: boolean } };
    expect(after.gstRegistration).toMatchObject({ statusToday: "not_registered", confirmed: true, registered: false });
  });

  it("GSR10: an AI coding a bank line needs evidence for GST, and picks none while unconfirmed", async () => {
    const org = "gsr-ai";
    await createTestOrganisation(owner, org);
    const bank = (await as(org, (tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const csv = "Date,Amount,Payee\n21/05/2026,-46.00,Z ENERGY\n";
    await as(org, (tx) => importStatementFile(tx, bank.id, { idempotencyKey: key("import"), fileName: "s.csv", fileBase64: Buffer.from(csv).toString("base64") }));
    const line = (await as(org, (tx) => listStatementLines(tx, bank.id, { status: "all", limit: 10 }))).lines[0];
    const petrol = { lineId: line.id, lines: [{ description: "Petrol", accountCode: "6120", taxCode: "GST", amount: "46.00" }] };
    const fee = { lineId: line.id, lines: [{ description: "Fee", accountCode: "6120", amount: "46.00" }], gstEvidence: "no_gst_supply" };
    // Unconfirmed: no GST chosen, whatever the evidence; a no-GST line is fine.
    await expect(as(org, (tx) => assertAiGstTreatment(tx, { ...petrol, gstEvidence: "tax_document" }))).rejects.toThrow(/hasn't been confirmed/);
    await as(org, (tx) => assertAiGstTreatment(tx, fee));
    // Registered and confirmed: evidence needed.
    await as(org, (tx) => updateOrganisationSettings(tx, { gstRegistrationConfirmed: true }));
    await expect(as(org, (tx) => assertAiGstTreatment(tx, petrol))).rejects.toThrow(/gstEvidence/);
    await as(org, (tx) => assertAiGstTreatment(tx, { ...petrol, gstEvidence: "tax_document" }));
  });

  it("migration 0216: confirmed from the audit trail or a GST number; NR8's guesses wait for a person", async () => {
    const sql = tenantMigrations.find((migration) => migration.version === "0216")!.sql;
    const backfill = sql.slice(sql.indexOf("update organisation_settings s"));
    const reset = (org: string, gstNumber: string | null, registered: boolean) =>
      as(org, async (tx) => {
        await tx.query("delete from audit_events where event_type = 'organisation.settings_updated'");
        await tx.query(
          "update organisation_settings set gst_registration_confirmed_at = null, gst_registration_confirmed_by = null, gst_number = $1, gst_registered = $2",
          [gstNumber, registered],
        );
      });
    const org = "gsr-migrate";
    await createTestOrganisation(owner, org);
    const run = () => as(org, (tx) => tx.query(backfill));
    await reset(org, null, true);
    await run();
    expect(await registration(org)).toMatchObject({ confirmed: false });
    await reset(org, null, false);
    await run();
    expect(await registration(org)).toMatchObject({ confirmed: false });
    await reset(org, "123456789", true);
    await run();
    expect(await as(org, (tx) => getOrganisationSettings(tx))).toMatchObject({ gstRegistrationConfirmedBy: "GST number in Settings" });
    await reset(org, null, false);
    await as(org, (tx) =>
      tx.query("insert into audit_events (event_type, entity_type, entity_id, actor_email, details) values ('organisation.settings_updated', 'organisation_settings', $1, 'jess@example.com', '{\"gstRegistered\": false}')", [org]),
    );
    await run();
    expect(await as(org, (tx) => getOrganisationSettings(tx))).toMatchObject({ gstRegistrationConfirmedBy: "jess@example.com" });
    expect(gstStatusOn(await registration(org), "2026-11-03")).toBe("not_registered");
  });
});
