import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as companyRoute from "@/app/api/crm/companies/[contactId]/route";
import * as opportunitiesRoute from "@/app/api/crm/opportunities/route";
import * as peopleRoute from "@/app/api/crm/people/route";
import * as personRoute from "@/app/api/crm/people/[personId]/route";
import * as fieldsRoute from "@/app/api/custom-fields/route";
import * as sectionsRoute from "@/app/api/custom-fields/sections/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, getContact, updateContact } from "@/lib/contacts/service";
import {
  createOpportunity,
  createPerson,
  getOpportunity,
  getPerson,
  listCompanies,
  listOpportunities,
  listPeople,
  makeInvoiceFromOpportunity,
  type Opportunity,
  type Person,
  updateOpportunity,
  updatePerson,
} from "@/lib/crm/service";
import {
  createCustomField,
  createCustomFieldSection,
  deleteCustomFieldSection,
  getCustomFieldSetup,
  updateCustomField,
  updateCustomFieldSection,
} from "@/lib/custom-fields/service";
import { type CustomFieldSetup, groupBySection } from "@/lib/custom-fields/values";
import { applyMigrations } from "@/lib/db/migrations/runner";
import { tenantMigrations } from "@/lib/db/migrations/tenant";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { getInvoice } from "@/lib/invoices/service";
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
 * Examples CRMF1-CRMF9 in docs/ACCOUNTING-EXAMPLES.md ("Custom fields on CRM
 * records", not yet approved). Each test gets its own organisation.
 */
describeWithDatabase("custom fields on CRM records", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@example.com", { serverAdmin: true, displayName: "Jess" });
    bookkeeper = await createTestUser("bookkeeper@example.com");
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `crmf-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      org,
      bookkeeper.id,
      viewer.id,
    ]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const section = async (record: string, name: string) => {
      const s = await as((tx) => createCustomFieldSection(tx, { record, name }));
      return s.sections.find((entry) => entry.record === record && entry.name === name)!;
    };
    const practiceDetails = await section("contact", "Practice details");
    const preferences = await section("person", "Preferences");
    const personal = await section("person", "Personal");
    const marketing = await section("opportunity", "Marketing");
    const field = async (input: Parameters<typeof createCustomField>[1]) => {
      const s = await as((tx) => createCustomField(tx, input));
      return s.fields.find((entry) => entry.label === input.label && entry.record === input.record)!;
    };
    const practiceSize = await field({
      record: "contact",
      label: "Practice size",
      type: "integer",
      usedOn: ["prospect"],
      showInList: true,
      sectionId: practiceDetails.id,
    });
    const species = await field({
      record: "contact",
      label: "Species seen",
      type: "multi_select",
      usedOn: ["prospect"],
      options: ["Dogs", "Cats", "Horses"],
      sectionId: practiceDetails.id,
    });
    const preferred = await field({
      record: "person",
      label: "Preferred contact",
      type: "list",
      options: ["Email", "Phone", "Text"],
      isRequired: true,
      defaultValue: "Email",
      showInList: true,
      sectionId: preferences.id,
    });
    const birthday = await field({ record: "person", label: "Birthday", type: "date", sectionId: personal.id });
    const leadSource = await field({
      record: "opportunity",
      label: "Lead source",
      type: "list",
      options: ["Referral", "Website", "Expo"],
      showInList: true,
      sectionId: marketing.id,
    });
    const discount = await field({ record: "opportunity", label: "Discount offered", type: "percent", sectionId: marketing.id });
    const sampleKit = await field({ record: "opportunity", label: "Sample kit sent", type: "checkbox" });
    const option = (f: { options: { id: string; name: string }[] }, name: string) => f.options.find((entry) => entry.name === name)!.id;
    const vets = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    const aroha = await as((tx) =>
      createPerson(tx, { contactId: vets.id, firstName: "Aroha", lastName: "Ngata", jobTitle: "Practice manager", email: "aroha@manukavets.nz" }),
    );
    const deal = await as((tx) =>
      createOpportunity(tx, {
        name: "Memorial paw prints 2027",
        contactId: vets.id,
        pointOfContactId: aroha.id,
        ownerUserId: owner.id,
        amount: "2400",
        closeDate: "2026-12-15",
      }),
    );
    return {
      org,
      as,
      field,
      section,
      option,
      sections: { practiceDetails, preferences, personal, marketing },
      fields: { practiceSize, species, preferred, birthday, leadSource, discount, sampleKit },
      vets,
      aroha,
      deal,
    };
  }

  it("CRMF1: CRM fields need the CRM; accounting fields still need Advanced reporting", async () => {
    const w = await setup();
    const s = await w.as((tx) => getCustomFieldSetup(tx));
    expect([s.advancedFeatures, s.crmEnabled]).toEqual([false, true]);
    expect(s.fields.map((f) => f.label)).toEqual([
      "Practice size",
      "Species seen",
      "Preferred contact",
      "Birthday",
      "Lead source",
      "Discount offered",
      "Sample kit sent",
    ]);
    expect(s.sections.map((entry) => entry.name)).toEqual(["Practice details", "Preferences", "Personal", "Marketing"]);
    await expect(w.field({ record: "contact", label: "Pet name", type: "text", usedOn: ["customer"] })).rejects.toThrow(
      "Advanced reporting is off, so a field can't be on customers.",
    );
    await expect(w.field({ record: "document", label: "Proof sent", type: "checkbox", usedOn: ["invoice"] })).rejects.toThrow(
      "Advanced reporting is off, so a field can't be on invoices.",
    );
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    await expect(w.field({ record: "person", label: "Nickname", type: "text" })).rejects.toThrow("The CRM is off, so a field can't be on people.");
    await expect(w.section("opportunity", "Admin only")).rejects.toThrow("The CRM is off, so a section can't be for opportunities.");
  });

  it("CRMF2: set-up rules for people and opportunity fields", async () => {
    const w = await setup();
    await w.field({ record: "person", label: "Lead source", type: "text" });
    await expect(w.field({ record: "opportunity", label: "lead source", type: "text" })).rejects.toThrow(
      "There's already an opportunity field called lead source.",
    );
    await expect(w.field({ record: "person", label: "Tier", type: "text", usedOn: ["customer"] })).rejects.toThrow(
      `A person field can't be used on "customer".`,
    );
    expect(w.fields.preferred.usedOn).toEqual(["person"]);
    expect(w.fields.leadSource.usedOn).toEqual(["opportunity"]);
    await expect(w.as((tx) => updateCustomField(tx, w.fields.leadSource.id, { type: "text" }))).rejects.toThrow("type and what it's on can't be changed");
    await expect(w.as((tx) => tx.query("update custom_fields set record = 'person' where id = $1", [w.fields.leadSource.id]))).rejects.toThrow(
      /type and what it's on can't change/,
    );
    await w.as(async (tx) => {
      for (let n = 4; n <= 100; n += 1) await createCustomField(tx, { record: "opportunity", label: `Extra ${n}`, type: "text" });
    });
    await expect(w.field({ record: "opportunity", label: "One too many", type: "text" })).rejects.toThrow("at most 100 opportunity fields");
    await w.field({ record: "person", label: "Still fine", type: "text" });
  });

  it("CRMF3: prospects carry contact fields; customer-only fields stay off them", async () => {
    const w = await setup();
    const { practiceSize, species } = w.fields;
    const saved = await w.as((tx) =>
      updateContact(tx, w.vets.id, {
        customFields: { [practiceSize.id]: "12", [species.id]: [w.option(species, "Dogs"), w.option(species, "Cats")] },
      }),
    );
    expect(saved.customFields).toEqual({ [practiceSize.id]: "12", [species.id]: [w.option(species, "Dogs"), w.option(species, "Cats")] });
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [practiceSize.id]: "12.5" } }))).rejects.toThrow(
      "Practice size: must be a whole number",
    );
    await w.as((tx) => updateContact(tx, w.vets.id, { customFields: { ...saved.customFields, [practiceSize.id]: "14" } }));
    const history = await w.as((tx) =>
      tx.query<{ details: { changes: Record<string, { from: Record<string, unknown>; to: Record<string, unknown> }> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id",
        [w.vets.id],
      ),
    );
    const change = history.rows.at(-1)!.details.changes.customFields;
    expect([change.from[practiceSize.id], change.to[practiceSize.id]]).toEqual(["12", "14"]);
    const customer = await w.as((tx) => updateContact(tx, w.vets.id, { isCustomer: true }));
    expect(customer.customFields[practiceSize.id]).toBe("14");

    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const petName = await w.field({ record: "contact", label: "Pet name", type: "text", usedOn: ["customer"] });
    const rata = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Clinic", isProspect: true }))).contact;
    await expect(w.as((tx) => updateContact(tx, rata.id, { customFields: { [petName.id]: "Rex" } }))).rejects.toThrow("Pet name isn't used on prospects.");
    const supplies = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Supplies Ltd", isSupplier: true }))).contact;
    await expect(w.as((tx) => updateContact(tx, supplies.id, { customFields: { [practiceSize.id]: "3" } }))).rejects.toThrow(
      "Practice size isn't used on suppliers.",
    );
  });

  it("CRMF3: the upgrade puts existing customer fields on prospects too", async () => {
    const database = `${server.coreDatabase}_org_upgrade`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${database}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, database) });
    await client.connect();
    try {
      const migration = tenantMigrations.find((entry) => entry.version === "0053")!;
      expect(migration.name).toBe("crm_custom_fields");
      await applyMigrations(client, tenantMigrations.filter((entry) => entry.version < "0053"), "crmf-upgrade");
      await client.query(
        `insert into custom_fields (record, label, field_type, used_on) values
           ('contact', 'Channel', 'text', array['customer']), ('contact', 'Account no', 'text', array['supplier']),
           ('contact', 'Region', 'text', array['customer', 'supplier'])`,
      );
      await applyMigrations(client, tenantMigrations, "crmf-upgrade");
      const fields = await client.query<{ label: string; used_on: string[] }>("select label, used_on from custom_fields order by id");
      expect(fields.rows).toEqual([
        { label: "Channel", used_on: ["customer", "prospect"] },
        { label: "Account no", used_on: ["supplier"] },
        { label: "Region", used_on: ["customer", "supplier", "prospect"] },
      ]);
    } finally {
      await client.end();
    }
  });

  it("CRMF4: people: default, required, types, history and keeping values", async () => {
    const w = await setup();
    const { preferred, birthday } = w.fields;
    expect(w.aroha.customFields).toEqual({ [preferred.id]: w.option(preferred, "Email") });
    await expect(w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: {} }))).rejects.toThrow("Preferred contact is required.");
    await expect(
      w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: { [preferred.id]: w.option(preferred, "Email"), [birthday.id]: "2026-02-30" } })),
    ).rejects.toThrow("Birthday is not a real date.");
    const changed = await w.as((tx) =>
      updatePerson(tx, w.aroha.id, { customFields: { [preferred.id]: w.option(preferred, "Phone"), [birthday.id]: "1990-04-02" } }),
    );
    expect(changed.customFields).toEqual({ [preferred.id]: w.option(preferred, "Phone"), [birthday.id]: "1990-04-02" });
    const history = await w.as((tx) =>
      tx.query<{ details: { customFields: Record<string, unknown>; customFieldsFrom?: Record<string, unknown> } }>(
        "select details from audit_events where event_type = 'crm.person_updated' and entity_id = $1 order by id",
        [w.aroha.id],
      ),
    );
    const last = history.rows.at(-1)!.details;
    expect(last.customFieldsFrom![preferred.id]).toBe(w.option(preferred, "Email"));
    expect(last.customFields[preferred.id]).toBe(w.option(preferred, "Phone"));
    const retitled = await w.as((tx) => updatePerson(tx, w.aroha.id, { jobTitle: "Director" }));
    expect(retitled.customFields).toEqual(changed.customFields);
    const quiet = await w.as((tx) =>
      tx.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where event_type = 'crm.person_updated' and entity_id = $1 order by id desc limit 1",
        [w.aroha.id],
      ),
    );
    expect(quiet.rows[0].details.customFieldsFrom).toBeUndefined();
    // Archived fields stay on people who have them.
    await w.as((tx) => updateCustomField(tx, birthday.id, { isActive: false }));
    expect((await w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: changed.customFields }))).customFields).toEqual(changed.customFields);
    await expect(
      w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: { ...changed.customFields, [birthday.id]: "1990-04-03" } })),
    ).rejects.toThrow("Birthday is archived.");
  });

  it("CRMF5: opportunity values never change the amount, the totals or the invoice", async () => {
    const w = await setup();
    const { leadSource, discount, sampleKit } = w.fields;
    const values = { [leadSource.id]: w.option(leadSource, "Referral"), [discount.id]: "10", [sampleKit.id]: true };
    const deal = await w.as((tx) => updateOpportunity(tx, w.deal.id, { customFields: values }));
    expect(deal.customFields).toEqual(values);
    expect(deal.amount).toBe("2400.00");
    const board = await w.as((tx) => listOpportunities(tx));
    expect(board.filter((o) => o.stage === "new").map((o) => o.amount)).toEqual(["2400.00"]);
    await expect(w.as((tx) => updateOpportunity(tx, w.deal.id, { customFields: { ...values, [discount.id]: "101" } }))).rejects.toThrow(
      "Discount offered: must be a percent from 0 to 100",
    );
    await w.as((tx) => updateOpportunity(tx, w.deal.id, { stage: "won" }));
    const { invoice } = await w.as((tx) => makeInvoiceFromOpportunity(tx, w.deal.id));
    const read = await w.as((tx) => getInvoice(tx, invoice.id));
    expect(read.total).toBe("2760.00");
    expect(read.lines.map((line) => [line.description, line.quantity, line.unitPrice, line.accountCode])).toEqual([
      ["Memorial paw prints 2027", "1", "2400", "4000"],
    ]);
    expect(read.customFields).toEqual({});
    expect(read.lines[0].customFields).toEqual({});
    const later = await w.as((tx) => updateOpportunity(tx, w.deal.id, { customFields: { ...values, [leadSource.id]: w.option(leadSource, "Expo") } }));
    expect(later.customFields[leadSource.id]).toBe(w.option(leadSource, "Expo"));
    const history = await w.as((tx) =>
      tx.query<{ details: { customFieldsFrom?: Record<string, unknown> } }>(
        "select details from audit_events where event_type = 'crm.opportunity_updated' and entity_id = $1 order by id desc limit 1",
        [w.deal.id],
      ),
    );
    expect(history.rows[0].details.customFieldsFrom![leadSource.id]).toBe(w.option(leadSource, "Referral"));
    await expect(w.as((tx) => updateOpportunity(tx, w.deal.id, { stage: "lost" }))).rejects.toThrow("its stage can't change");
  });

  it("CRMF6: sections: order, names, kinds, removing and grouping", async () => {
    const w = await setup();
    const { preferences, personal, marketing } = w.sections;
    let s = await w.as((tx) => updateCustomFieldSection(tx, personal.id, { move: "up" }));
    expect(s.sections.filter((entry) => entry.record === "person").map((entry) => entry.name)).toEqual(["Personal", "Preferences"]);
    await expect(w.section("person", "preferences")).rejects.toThrow("There's already a section called preferences for people.");
    await w.section("opportunity", "Preferences");
    await expect(w.section("line", "Costs")).rejects.toThrow("Lines don't have sections");
    await expect(w.as((tx) => updateCustomField(tx, w.fields.leadSource.id, { sectionId: preferences.id }))).rejects.toThrow(
      "Preferences is a section for people, not opportunities.",
    );
    await expect(w.as((tx) => deleteCustomFieldSection(tx, marketing.id))).rejects.toThrow("Move Marketing's fields out first.");
    const empty = await w.section("person", "Spare");
    s = await w.as((tx) => deleteCustomFieldSection(tx, empty.id));
    expect(s.sections.some((entry) => entry.id === empty.id)).toBe(false);
    await w.as(async (tx) => {
      for (let n = 3; n <= 20; n += 1) await createCustomFieldSection(tx, { record: "person", name: `Group ${n}` });
    });
    await expect(w.section("person", "Group 21")).rejects.toThrow("at most 20 sections");
    s = await w.as((tx) => updateCustomField(tx, w.fields.discount.id, { move: "up" }));
    const groups = groupBySection(
      s.fields.filter((f) => f.record === "opportunity" && f.isActive && !f.label.startsWith("Extra")),
      s.sections,
    );
    expect(groups.map((group) => [group.section?.name ?? null, group.fields.map((f) => f.label)])).toEqual([
      [null, ["Sample kit sent"]],
      ["Marketing", ["Discount offered", "Lead source"]],
    ]);
    // Renaming keeps the section's fields.
    s = await w.as((tx) => updateCustomFieldSection(tx, marketing.id, { name: "Sales and marketing" }));
    expect(s.fields.find((f) => f.id === w.fields.leadSource.id)!.sectionId).toBe(marketing.id);
    expect(s.sections.find((entry) => entry.id === marketing.id)!.name).toBe("Sales and marketing");
    await expect(w.as((tx) => tx.query("update custom_fields set section_id = $2 where id = $1", [w.fields.leadSource.id, preferences.id]))).rejects.toThrow(
      /section for its own kind/,
    );
  });

  it("CRMF7: lists carry the values for their columns", async () => {
    const w = await setup();
    const { practiceSize, species, preferred, leadSource } = w.fields;
    await w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [practiceSize.id]: "12", [species.id]: [w.option(species, "Dogs")] } }));
    await w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: { [preferred.id]: w.option(preferred, "Phone") } }));
    await w.as((tx) => updateOpportunity(tx, w.deal.id, { customFields: { [leadSource.id]: w.option(leadSource, "Website") } }));
    const companies = await w.as((tx) => listCompanies(tx));
    expect(companies.find((c) => c.contactId === w.vets.id)!.customFields).toEqual({ [practiceSize.id]: "12", [species.id]: [w.option(species, "Dogs")] });
    expect([practiceSize.showInList, species.showInList, preferred.showInList, leadSource.showInList]).toEqual([true, false, true, true]);
    const people = await w.as((tx) => listPeople(tx));
    expect(people.find((p) => p.id === w.aroha.id)!.customFields[preferred.id]).toBe(w.option(preferred, "Phone"));
    const board = await w.as((tx) => listOpportunities(tx));
    expect(board.find((o) => o.id === w.deal.id)!.customFields[leadSource.id]).toBe(w.option(leadSource, "Website"));
  });

  it("CRMF8: with a switch off, values are kept but new ones refused", async () => {
    const w = await setup();
    const { practiceSize, preferred, birthday } = w.fields;
    const values = { [preferred.id]: w.option(preferred, "Phone"), [birthday.id]: "1990-04-02" };
    await w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: values }));
    await w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [practiceSize.id]: "12" } }));
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false }));
    expect((await w.as((tx) => updatePerson(tx, w.aroha.id, { jobTitle: "Director" }))).customFields).toEqual(values);
    expect((await w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: values }))).customFields).toEqual(values);
    await expect(w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: { ...values, [birthday.id]: "1990-04-03" } }))).rejects.toThrow(
      "the CRM is off, so Birthday can't be set.",
    );
    // Not required while the CRM is off, and a new person gets no default.
    expect((await w.as((tx) => updatePerson(tx, w.aroha.id, { customFields: {} }))).customFields).toEqual({});
    expect((await w.as((tx) => createPerson(tx, { contactId: w.vets.id, firstName: "Ben" }))).customFields).toEqual({});
    expect((await w.as((tx) => updateContact(tx, w.vets.id, { phone: "03 477 0000" }))).customFields).toEqual({ [practiceSize.id]: "12" });
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [practiceSize.id]: "13" } }))).rejects.toThrow(
      "the CRM is off, so Practice size can't be set.",
    );

    // CRM on, Advanced reporting off: a customer and prospect gets prospect fields but not customer-only ones.
    const petName = await w.field({ record: "contact", label: "Pet name", type: "text", usedOn: ["customer"] });
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    const kobe = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Kobe Ltd", isCustomer: true, isProspect: true }))).contact;
    expect((await w.as((tx) => updateContact(tx, kobe.id, { customFields: { [practiceSize.id]: "4" } }))).customFields).toEqual({ [practiceSize.id]: "4" });
    await expect(w.as((tx) => updateContact(tx, kobe.id, { customFields: { [practiceSize.id]: "4", [petName.id]: "Rex" } }))).rejects.toThrow(
      "advanced reporting is off, so Pet name can't be set.",
    );
    expect((await w.as((tx) => getContact(tx, kobe.id))).customFields).toEqual({ [practiceSize.id]: "4" });
  });

  it("CRMF9: over HTTP: viewers read, bookkeepers change values, admins set up", async () => {
    const w = await setup();
    const { preferred, leadSource, practiceSize } = w.fields;
    await w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [practiceSize.id]: "12" } }));
    const viewerCookie = await sessionCookieFor(viewer);
    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const ownerCookie = await sessionCookieFor(owner);

    const setupRead = await fieldsRoute.GET(apiRequest(`/api/custom-fields?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(setupRead.status).toBe(200);
    const setupBody = (await setupRead.json()) as CustomFieldSetup;
    expect([setupBody.crmEnabled, setupBody.sections.length, setupBody.fields.length]).toEqual([true, 4, 7]);
    const company = await companyRoute.GET(
      apiRequest(`/api/crm/companies/${w.vets.id}?organisationId=${w.org}`, { cookie: viewerCookie }),
      params({ contactId: w.vets.id }),
    );
    expect(company.status).toBe(200);
    expect(((await company.json()) as { contact: { customFields: Record<string, unknown> } }).contact.customFields).toEqual({ [practiceSize.id]: "12" });
    const people = await peopleRoute.GET(apiRequest(`/api/crm/people?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await people.json()) as { people: Person[] }).people[0].customFields[preferred.id]).toBe(w.option(preferred, "Email"));
    const pipeline = await opportunitiesRoute.GET(apiRequest(`/api/crm/opportunities?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(((await pipeline.json()) as { opportunities: Opportunity[] }).opportunities[0].customFields).toEqual({});

    const phone = { organisationId: w.org, customFields: { [preferred.id]: w.option(preferred, "Phone") } };
    const path = `/api/crm/people/${w.aroha.id}`;
    expect((await personRoute.PATCH(apiRequest(path, { method: "PATCH", cookie: viewerCookie, body: phone }), params({ personId: w.aroha.id }))).status).toBe(403);
    const changed = await personRoute.PATCH(apiRequest(path, { method: "PATCH", cookie: bookkeeperCookie, body: phone }), params({ personId: w.aroha.id }));
    expect(changed.status).toBe(200);
    expect((await w.as((tx) => getPerson(tx, w.aroha.id))).customFields[preferred.id]).toBe(w.option(preferred, "Phone"));
    const opportunity = await opportunitiesRoute.POST(
      apiRequest("/api/crm/opportunities", {
        method: "POST",
        cookie: bookkeeperCookie,
        body: { organisationId: w.org, name: "Clinic signage", contactId: w.vets.id, customFields: { [leadSource.id]: w.option(leadSource, "Expo") } },
      }),
      noContext,
    );
    expect(opportunity.status).toBe(201);
    const made = ((await opportunity.json()) as { opportunity: Opportunity }).opportunity;
    expect((await w.as((tx) => getOpportunity(tx, made.id))).customFields).toEqual({ [leadSource.id]: w.option(leadSource, "Expo") });

    const fieldBody = { organisationId: w.org, record: "opportunity", label: "Budget holder", type: "text" };
    expect((await fieldsRoute.POST(apiRequest("/api/custom-fields", { method: "POST", cookie: bookkeeperCookie, body: fieldBody }), noContext)).status).toBe(403);
    expect((await fieldsRoute.POST(apiRequest("/api/custom-fields", { method: "POST", cookie: ownerCookie, body: fieldBody }), noContext)).status).toBe(201);
    const sectionBody = { organisationId: w.org, record: "person", name: "Admin only" };
    const sectionPath = "/api/custom-fields/sections";
    expect((await sectionsRoute.POST(apiRequest(sectionPath, { method: "POST", cookie: bookkeeperCookie, body: sectionBody }), noContext)).status).toBe(403);
    expect((await sectionsRoute.POST(apiRequest(sectionPath, { method: "POST", cookie: ownerCookie, body: sectionBody }), noContext)).status).toBe(201);
  });
});
