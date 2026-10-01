import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as companyRoute from "@/app/api/crm/companies/[contactId]/route";
import * as opportunityRoute from "@/app/api/crm/opportunities/[opportunityId]/route";
import * as personRoute from "@/app/api/crm/people/[personId]/route";
import * as recordTypeRoute from "@/app/api/crm/record-types/[recordTypeId]/route";
import * as recordTypesRoute from "@/app/api/crm/record-types/route";
import * as contactRoute from "@/app/api/contacts/[contactId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, getContact, updateContact } from "@/lib/contacts/service";
import {
  createActivity,
  createOpportunity,
  createPerson,
  createTask,
  listOpportunities,
  makeInvoiceFromOpportunity,
  updateOpportunity,
  updatePerson,
} from "@/lib/crm/service";
import { customKey, layoutFields, type PageLayout, type RecordType } from "@/lib/crm/record-types/layout";
import { createRecordType, listRecordTypes, updateRecordType } from "@/lib/crm/record-types/service";
import { createCustomField, createCustomFieldSection } from "@/lib/custom-fields/service";
import { todayIsoDate } from "@/lib/dates";
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

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Examples CRT1-CRT13 in docs/ACCOUNTING-EXAMPLES.md ("CRM record types and
 * page layouts", not yet approved). Each test gets its own organisation.
 */
describeWithDatabase("CRM record types and page layouts", () => {
  let server: TestServer;
  let owner: SessionUser;
  let bookkeeper: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("jess@example.com", { serverAdmin: true, displayName: "Jess" });
    bookkeeper = await createTestUser("bookkeeper@example.com", { displayName: "Hemi" });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `crt-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'viewer')", [
      org,
      bookkeeper.id,
      viewer.id,
    ]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const asBookkeeper = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: bookkeeper.id, email: bookkeeper.email }, work);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    const vets = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Mānuka Vets", isProspect: true }))).contact;
    const aroha = await as((tx) =>
      createPerson(tx, { contactId: vets.id, firstName: "Aroha", lastName: "Ngata", jobTitle: "Practice manager", email: "aroha@manukavets.nz" }),
    );
    const deal = await as((tx) =>
      createOpportunity(tx, { name: "Memorial paw prints 2027", contactId: vets.id, pointOfContactId: aroha.id, ownerUserId: owner.id, amount: "2400" }),
    );
    const field = async (input: Parameters<typeof createCustomField>[1]) => {
      const s = await as((tx) => createCustomField(tx, input));
      return s.fields.find((entry) => entry.label === input.label && entry.record === input.record)!;
    };
    const funderReference = await field({ record: "contact", label: "Funder reference", type: "text", usedOn: ["prospect"] });
    const grantRound = await field({ record: "contact", label: "Grant round", type: "list", usedOn: ["prospect"], options: ["2026 Round 1", "2026 Round 2"] });
    const option = (name: string) => grantRound.options.find((entry) => entry.name === name)!.id;
    const types = async (record: "contact" | "person" | "opportunity") => as((tx) => listRecordTypes(tx, { record }));
    const standard = (await types("contact"))[0];
    return { org, as, asBookkeeper, field, types, standard, vets, aroha, deal, fields: { funderReference, grantRound }, option };
  }

  type World = Awaited<ReturnType<typeof setup>>;

  /** "Funding body" for companies: Phone and Funder reference required, Grant round read-only (CRT4, CRT6). */
  async function fundingBody(w: World): Promise<RecordType> {
    const made = await w.as((tx) => createRecordType(tx, { record: "contact", name: "Funding body", description: "Grant makers" }));
    const layout: PageLayout = {
      sections: made.layout.sections.map((section) => ({
        ...section,
        fields: section.fields.map((f) =>
          f.key === "phone" || f.key === customKey(w.fields.funderReference.id)
            ? { ...f, required: true }
            : f.key === customKey(w.fields.grantRound.id)
              ? { ...f, readOnly: true }
              : f,
        ),
      })),
    };
    return w.as((tx) => updateRecordType(tx, made.id, { layout }));
  }

  async function newFunder(w: World, extra: Record<string, unknown> = {}) {
    return w.as((tx) =>
      createContact(tx, {
        idempotencyKey: key("c"),
        name: "Lottery Grants Board",
        isProspect: true,
        phone: "04 123 4567",
        customFields: { [w.fields.funderReference.id]: "LGB-2026", [w.fields.grantRound.id]: w.option("2026 Round 1") },
        ...extra,
      }, { role: "owner" }),
    );
  }

  it("CRT1: the upgrade gives every record the default Standard type and layout", async () => {
    const database = `${server.coreDatabase}_org_crt_upgrade`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl! });
    await admin.connect();
    await admin.query(`create database "${database}"`);
    await admin.end();
    const client = new pg.Client({ connectionString: withDb(testDatabaseUrl!, database) });
    await client.connect();
    try {
      const migration = tenantMigrations.find((entry) => entry.version === "0059")!;
      expect(migration.name).toBe("crm_record_types");
      expect(tenantMigrations.at(-1)?.version).toBe("0059");
      await applyMigrations(client, tenantMigrations.filter((entry) => entry.version < "0059"), "crt-upgrade");
      await client.query(
        `insert into contacts (command_source, idempotency_key, request_hash, name, is_customer) values ('api', 'k1', 'h', 'Old customer', true);
         insert into contacts (command_source, idempotency_key, request_hash, name, is_supplier) values ('api', 'k2', 'h', 'Old supplier', true);
         insert into custom_field_sections (record, name) values ('contact', 'Practice details'), ('contact', 'System information');
         insert into custom_fields (record, label, field_type, used_on) values ('contact', 'Channel', 'text', array['customer']);
         insert into custom_fields (record, label, field_type, used_on, section_id)
           values ('contact', 'Practice size', 'integer', array['prospect'], (select id from custom_field_sections where name = 'Practice details'));
         insert into crm_people (contact_id, first_name) values ((select id from contacts where name = 'Old customer'), 'Aroha');
         insert into crm_opportunities (name, contact_id, amount, currency_code) values ('Old deal', (select id from contacts where name = 'Old customer'), 100, 'NZD');`,
      );
      await applyMigrations(client, tenantMigrations, "crt-upgrade");
      const types = await client.query<{ id: string; record: string; name: string; is_default: boolean; layout: PageLayout }>(
        "select id::text, record, name, is_default, layout from crm_record_types order by id",
      );
      expect(types.rows.map((row) => [row.record, row.name, row.is_default])).toEqual([
        ["contact", "Standard", true],
        ["person", "Standard", true],
        ["opportunity", "Standard", true],
      ]);
      const fieldIds = await client.query<{ id: string; label: string }>("select id::text, label from custom_fields order by id");
      const channel = fieldIds.rows.find((row) => row.label === "Channel")!.id;
      const size = fieldIds.rows.find((row) => row.label === "Practice size")!.id;
      const company = types.rows[0].layout;
      expect(company.sections.map((section) => [section.name, section.fields.map((f) => f.key)])).toEqual([
        ["Company information", ["name", "ownerUserId", "email", "phone", "gstNumber", `custom:${channel}`]],
        ["Address information", ["postalAddress", "deliveryAddress"]],
        ["Practice details", [`custom:${size}`]],
        ["System information (2)", []],
        ["System information", ["createdAt", "updatedAt"]],
      ]);
      expect(company.sections[0].fields[0]).toEqual({ key: "name", required: true, readOnly: false });
      expect(company.sections.at(-1)!.fields).toEqual([
        { key: "createdAt", required: false, readOnly: true },
        { key: "updatedAt", required: false, readOnly: true },
      ]);
      expect(types.rows[1].layout.sections.map((section) => section.name)).toEqual(["Person information", "System information"]);
      expect(layoutFields(types.rows[2].layout).map((f) => f.key)).toEqual([
        "name",
        "contactId",
        "pointOfContactId",
        "ownerUserId",
        "amount",
        "closeDate",
        "stage",
        "createdAt",
        "updatedAt",
      ]);
      const counts = await client.query<{ kind: string; type: string }>(
        `select 'contact' as kind, record_type_id::text as type from contacts
         union all select 'person', record_type_id::text from crm_people
         union all select 'opportunity', record_type_id::text from crm_opportunities`,
      );
      expect(counts.rows).toEqual([
        { kind: "contact", type: types.rows[0].id },
        { kind: "contact", type: types.rows[0].id },
        { kind: "person", type: types.rows[1].id },
        { kind: "opportunity", type: types.rows[2].id },
      ]);
      await client.query("insert into contacts (command_source, idempotency_key, request_hash, name, is_customer) values ('api', 'k3', 'h', 'New one', true)");
      expect((await client.query("select record_type_id::text as id from contacts where name = 'New one'")).rows[0].id).toBe(types.rows[0].id);
      await expect(client.query("update contacts set record_type_id = $1 where name = 'New one'", [types.rows[1].id])).rejects.toThrow(
        /isn't for this kind of record/,
      );
      await expect(client.query("delete from crm_record_types where id = $1", [types.rows[0].id])).rejects.toThrow(/never deleted/);
      await expect(client.query("update crm_record_types set record = 'person' where id = $1", [types.rows[0].id])).rejects.toThrow(/can't change/);
    } finally {
      await client.end();
    }
  });

  it("CRT1: new records get the default type", async () => {
    const w = await setup();
    expect(w.standard).toMatchObject({ record: "contact", name: "Standard", isDefault: true, isActive: true });
    expect(w.vets.recordTypeId).toBe(w.standard.id);
    expect(w.vets.recordTypeName).toBe("Standard");
    expect(w.aroha.recordTypeId).toBe((await w.types("person"))[0].id);
    expect(w.deal.recordTypeId).toBe((await w.types("opportunity"))[0].id);
    // Fields made after the upgrade join the layout's first section (CRT9).
    expect(w.standard.layout.sections[0].fields.map((f) => f.key)).toEqual([
      "name",
      "ownerUserId",
      "email",
      "phone",
      "gstNumber",
      customKey(w.fields.funderReference.id),
      customKey(w.fields.grantRound.id),
    ]);
  });

  it("CRT2: set-up rules: names, one default, archiving, audit", async () => {
    const w = await setup();
    const funding = await w.as((tx) => createRecordType(tx, { record: "contact", name: "Funding body" }));
    expect(funding.layout).toEqual(w.standard.layout);
    expect(funding.isDefault).toBe(false);
    await expect(w.as((tx) => createRecordType(tx, { record: "contact", name: "funding body" }))).rejects.toThrow(
      "There's already a company record type called funding body.",
    );
    await w.as((tx) => createRecordType(tx, { record: "opportunity", name: "Funding body" }));
    await w.as((tx) => updateRecordType(tx, funding.id, { isDefault: true }));
    let companies = await w.types("contact");
    expect(companies.map((t) => [t.name, t.isDefault])).toEqual([
      ["Standard", false],
      ["Funding body", true],
    ]);
    await w.as((tx) => updateRecordType(tx, w.standard.id, { isDefault: true }));
    await expect(w.as((tx) => updateRecordType(tx, w.standard.id, { isActive: false }))).rejects.toThrow(
      "Standard is the default, so it can't be archived.",
    );
    const renamed = await w.as((tx) => updateRecordType(tx, funding.id, { name: "Funder", description: "Grant makers" }));
    expect([renamed.name, renamed.description]).toEqual(["Funder", "Grant makers"]);
    companies = await w.types("contact");
    expect(companies.map((t) => [t.name, t.isDefault])).toEqual([
      ["Standard", true],
      ["Funder", false],
    ]);
    const audit = await w.as((tx) =>
      tx.query<{ event_type: string; details: { changes?: Record<string, { from: unknown; to: unknown }> } }>(
        "select event_type, details from audit_events where entity_type = 'crm_record_type' and entity_id = $1 order by id",
        [funding.id],
      ),
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "crm.record_type_created",
      "crm.record_type_updated",
      "crm.record_type_updated",
    ]);
    expect(audit.rows.at(-1)!.details.changes!.name).toEqual({ from: "Funding body", to: "Funder" });
  });

  it("CRT3: layout rules", async () => {
    const w = await setup();
    let layout = w.standard.layout;
    const without = (key: string): PageLayout => ({ sections: layout.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => f.key !== key) })) });
    const change = (key: string, flags: { required?: boolean; readOnly?: boolean }): PageLayout => ({
      sections: layout.sections.map((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? { ...f, ...flags } : f)) })),
    });
    const update = (next: unknown) => w.as((tx) => updateRecordType(tx, w.standard.id, { layout: next }));
    await expect(update(without("name"))).rejects.toThrow("Company name must stay on the layout.");
    await expect(update(change("name", { readOnly: true }))).rejects.toThrow("Company name can't be read-only.");
    const twice = { sections: [...layout.sections, { name: "Again", fields: [{ key: "phone", required: false, readOnly: false }] }] };
    await expect(update(twice)).rejects.toThrow("Phone is on the layout more than once.");
    const preferred = await w.field({ record: "person", label: "Preferred contact", type: "text" });
    const personOnCompany = { sections: [...layout.sections, { name: "People", fields: [{ key: customKey(preferred.id), required: false, readOnly: false }] }] };
    await expect(update(personOnCompany)).rejects.toThrow("Preferred contact isn't a company field.");
    await expect(update(change("phone", { required: true, readOnly: true }))).rejects.toThrow("Phone can't be both required and read-only.");
    await expect(update(change("createdAt", { required: true }))).rejects.toThrow("Created is filled in by Tohyee, so it can't be required.");
    const kit = await w.field({ record: "contact", label: "Kit sent", type: "checkbox", usedOn: ["prospect"] });
    layout = (await w.types("contact"))[0].layout;
    await expect(update(change(customKey(kit.id), { required: true }))).rejects.toThrow("Kit sent is a check box, so it can't be required");
    const opportunityStandard = (await w.types("opportunity"))[0];
    const amountRequired = {
      sections: opportunityStandard.layout.sections.map((s) => ({ ...s, fields: s.fields.map((f) => (f.key === "amount" ? { ...f, required: true } : f)) })),
    };
    await expect(w.as((tx) => updateRecordType(tx, opportunityStandard.id, { layout: amountRequired }))).rejects.toThrow(
      "Amount (excl. GST) always has a value, so it can't be required.",
    );
    const twoGrants = { sections: [...layout.sections, { name: "Grants", fields: [] }, { name: "grants", fields: [] }] };
    await expect(update(twoGrants)).rejects.toThrow("There are two sections called grants.");
    const many = { sections: [...layout.sections, ...Array.from({ length: 21 - layout.sections.length }, (_, n) => ({ name: `Extra ${n}`, fields: [] }))] };
    await expect(update(many)).rejects.toThrow("at most 20 sections");
    // A system field stays read-only even if sent otherwise; a locked one stays required.
    const tidied = await update(change("createdAt", { readOnly: false }));
    expect(layoutFields(tidied.layout).find((f) => f.key === "createdAt")).toEqual({ key: "createdAt", required: false, readOnly: true });
  });

  it("CRT4: a field required on one type but not another", async () => {
    const w = await setup();
    const funding = await fundingBody(w);
    expect((await w.as((tx) => updateContact(tx, w.vets.id, { email: "hello@manukavets.nz" }))).email).toBe("hello@manukavets.nz");
    const base = { idempotencyKey: key("c"), name: "Lottery Grants Board", isProspect: true, recordTypeId: funding.id };
    await expect(w.as((tx) => createContact(tx, { ...base }))).rejects.toThrow("Phone is required on Funding body companies.");
    await expect(w.as((tx) => createContact(tx, { ...base, idempotencyKey: key("c"), phone: "04 123 4567" }))).rejects.toThrow(
      "Funder reference is required on Funding body companies.",
    );
    const { contact } = await w.as((tx) =>
      createContact(tx, { ...base, idempotencyKey: key("c"), phone: "04 123 4567", customFields: { [w.fields.funderReference.id]: "LGB-2026" } }),
    );
    expect([contact.recordTypeId, contact.recordTypeName, contact.phone]).toEqual([funding.id, "Funding body", "04 123 4567"]);
    await expect(w.as((tx) => updateContact(tx, contact.id, { phone: "" }))).rejects.toThrow("Phone is required on Funding body companies.");
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${contact.id}`, { method: "PATCH", cookie, body: { organisationId: w.org, phone: "" } }),
      params({ contactId: contact.id }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("Phone is required on Funding body companies.");
  });

  it("CRT5: changing a record's type", async () => {
    const w = await setup();
    const funding = await fundingBody(w);
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { recordTypeId: funding.id }))).rejects.toThrow("Phone is required on Funding body companies.");
    const changed = await w.as((tx) =>
      updateContact(tx, w.vets.id, { recordTypeId: funding.id, phone: "09 555 0101", customFields: { [w.fields.funderReference.id]: "MV-1" } }),
    );
    expect([changed.recordTypeId, changed.recordTypeName]).toEqual([funding.id, "Funding body"]);
    const history = await w.as((tx) =>
      tx.query<{ details: { changes: Record<string, { from: unknown; to: unknown }> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id desc limit 1",
        [w.vets.id],
      ),
    );
    const changes = history.rows[0].details.changes;
    expect(changes.recordType).toEqual({ from: "Standard", to: "Funding body" });
    expect(changes.phone).toEqual({ from: null, to: "09 555 0101" });
    const back = await w.as((tx) => updateContact(tx, w.vets.id, { recordTypeId: w.standard.id }));
    expect([back.recordTypeName, back.phone, back.customFields[w.fields.funderReference.id]]).toEqual(["Standard", "09 555 0101", "MV-1"]);
    const old = await w.as((tx) => createRecordType(tx, { record: "contact", name: "Old grants" }));
    const rata = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Rata Clinic", isProspect: true, recordTypeId: old.id }))).contact;
    await w.as((tx) => updateRecordType(tx, old.id, { isActive: false }));
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { recordTypeId: old.id }))).rejects.toThrow("Old grants is archived, so it can't be chosen.");
    expect((await w.as((tx) => updateContact(tx, rata.id, { email: "kia.ora@rata.nz" }))).recordTypeName).toBe("Old grants");
    const personType = (await w.types("person"))[0];
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { recordTypeId: personType.id }))).rejects.toThrow("That record type isn't for companies.");
    const viewerCookie = await sessionCookieFor(viewer);
    const refused = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${w.vets.id}`, { method: "PATCH", cookie: viewerCookie, body: { organisationId: w.org, recordTypeId: funding.id } }),
      params({ contactId: w.vets.id }),
    );
    expect(refused.status).toBe(403);
  });

  it("CRT6: a read-only field", async () => {
    const w = await setup();
    const funding = await fundingBody(w);
    const { contact: board } = await newFunder(w, { recordTypeId: funding.id });
    const round2 = { [w.fields.funderReference.id]: "LGB-2026", [w.fields.grantRound.id]: w.option("2026 Round 2") };
    await expect(w.asBookkeeper((tx) => updateContact(tx, board.id, { customFields: round2 }, { role: "bookkeeper" }))).rejects.toThrow(
      "Grant round is read-only on Funding body companies. Ask an admin to change it.",
    );
    await expect(
      w.asBookkeeper((tx) =>
        createContact(
          tx,
          {
            idempotencyKey: key("c"),
            name: "Rātā Foundation",
            isProspect: true,
            recordTypeId: funding.id,
            phone: "03 000 0000",
            customFields: { [w.fields.funderReference.id]: "RF-1", [w.fields.grantRound.id]: w.option("2026 Round 1") },
          },
          { role: "bookkeeper" },
        ),
      ),
    ).rejects.toThrow("Grant round is read-only on Funding body companies.");
    const byAdmin = await w.as((tx) => updateContact(tx, board.id, { customFields: round2 }, { role: "admin" }));
    expect(byAdmin.customFields[w.fields.grantRound.id]).toBe(w.option("2026 Round 2"));
    // Not read-only on Standard.
    const vets = await w.asBookkeeper((tx) =>
      updateContact(tx, w.vets.id, { customFields: { [w.fields.grantRound.id]: w.option("2026 Round 1") } }, { role: "bookkeeper" }),
    );
    expect(vets.customFields[w.fields.grantRound.id]).toBe(w.option("2026 Round 1"));
    // Changing the type and the field in one save is refused.
    await expect(
      w.asBookkeeper((tx) =>
        updateContact(
          tx,
          board.id,
          { recordTypeId: w.standard.id, customFields: { ...round2, [w.fields.grantRound.id]: w.option("2026 Round 1") } },
          { role: "bookkeeper" },
        ),
      ),
    ).rejects.toThrow("Grant round is read-only on Funding body companies.");
    // Over HTTP the refusal is a 403.
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${board.id}`, {
        method: "PATCH",
        cookie,
        body: { organisationId: w.org, customFields: { ...round2, [w.fields.grantRound.id]: w.option("2026 Round 1") } },
      }),
      params({ contactId: board.id }),
    );
    expect(response.status).toBe(403);
  });

  it("CRT7: a viewer can't edit inline", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(viewer);
    const page = await companyRoute.GET(apiRequest(`/api/crm/companies/${w.vets.id}?organisationId=${w.org}`, { cookie }), params({ contactId: w.vets.id }));
    expect(page.status).toBe(200);
    const body = (await page.json()) as { recordType: RecordType; contact: { name: string } };
    expect([body.contact.name, body.recordType.name]).toEqual(["Mānuka Vets", "Standard"]);
    for (const change of [{ phone: "09 555 0101" }, { recordTypeId: w.standard.id }, { ownerUserId: owner.id }]) {
      const response = await contactRoute.PATCH(
        apiRequest(`/api/contacts/${w.vets.id}`, { method: "PATCH", cookie, body: { organisationId: w.org, ...change } }),
        params({ contactId: w.vets.id }),
      );
      expect(response.status).toBe(403);
    }
    const personResponse = await personRoute.PATCH(
      apiRequest(`/api/crm/people/${w.aroha.id}`, { method: "PATCH", cookie, body: { organisationId: w.org, jobTitle: "Director" } }),
      params({ personId: w.aroha.id }),
    );
    expect(personResponse.status).toBe(403);
  });

  it("CRT8: inline edit of one field, and the owner", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(bookkeeper);
    const response = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${w.vets.id}`, { method: "PATCH", cookie, body: { organisationId: w.org, phone: "09 555 0101" } }),
      params({ contactId: w.vets.id }),
    );
    expect(response.status).toBe(200);
    const after = await w.as((tx) => getContact(tx, w.vets.id));
    expect({ ...after, phone: null, updatedAt: null }).toEqual({ ...w.vets, updatedAt: null });
    const owned = await w.as((tx) => updateContact(tx, w.vets.id, { ownerUserId: bookkeeper.id }));
    expect(owned.ownerUserId).toBe(bookkeeper.id);
    await expect(w.as((tx) => updateContact(tx, w.vets.id, { ownerUserId: "someone-else" }))).rejects.toThrow("The owner must be a member of the organisation.");
    const history = await w.as((tx) =>
      tx.query<{ details: { changes: Record<string, { from: unknown; to: unknown }> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id",
        [w.vets.id],
      ),
    );
    expect(history.rows.map((row) => Object.keys(row.details.changes))).toEqual([["phone"], ["ownerUserId"]]);
  });

  it("CRT9: new custom fields join every layout of their kind", async () => {
    const w = await setup();
    const funding = await fundingBody(w);
    const section = (await w.as((tx) => createCustomFieldSection(tx, { record: "contact", name: "Practice details" }))).sections.find(
      (s) => s.name === "Practice details",
    )!;
    await w.as((tx) => updateRecordType(tx, funding.id, { layout: { sections: [...funding.layout.sections, { name: "Practice details", fields: [] }] } }));
    const board = await w.field({ record: "contact", label: "Board meeting", type: "date", usedOn: ["prospect"], sectionId: section.id });
    const website = await w.field({ record: "contact", label: "Website", type: "url", usedOn: ["prospect"] });
    const [standard, funder] = await w.types("contact");
    expect(standard.layout.sections[0].fields.slice(-2).map((f) => f.key)).toEqual([customKey(board.id), customKey(website.id)]);
    expect(funder.layout.sections[0].fields.at(-1)!.key).toBe(customKey(website.id));
    expect(funder.layout.sections.find((s) => s.name === "Practice details")!.fields.map((f) => f.key)).toEqual([customKey(board.id)]);
    // Other kinds' layouts don't change.
    const [personStandard] = await w.types("person");
    expect(layoutFields(personStandard.layout).some((f) => f.key === customKey(website.id))).toBe(false);
    // Taking a field off a layout keeps the values.
    await w.as((tx) => updateContact(tx, w.vets.id, { customFields: { [website.id]: "https://manukavets.nz" } }));
    const noWebsite = { sections: standard.layout.sections.map((s) => ({ ...s, fields: s.fields.filter((f) => f.key !== customKey(website.id)) })) };
    await w.as((tx) => updateRecordType(tx, standard.id, { layout: noWebsite }));
    expect((await w.as((tx) => getContact(tx, w.vets.id))).customFields[website.id]).toBe("https://manukavets.nz");
  });

  it("CRT10: opportunity types never change amounts, stages or the invoice", async () => {
    const w = await setup();
    const grantType = await w.as((tx) => createRecordType(tx, { record: "opportunity", name: "Grant application" }));
    const grantLayout = {
      sections: grantType.layout.sections.map((s) => ({ ...s, fields: s.fields.map((f) => (f.key === "closeDate" ? { ...f, required: true } : f)) })),
    };
    await w.as((tx) => updateRecordType(tx, grantType.id, { layout: grantLayout }));
    const funding = await fundingBody(w);
    const { contact: board } = await newFunder(w, { recordTypeId: funding.id });
    const input = { name: "Community grant 2027", contactId: board.id, amount: "5000", recordTypeId: grantType.id };
    await expect(w.as((tx) => createOpportunity(tx, input))).rejects.toThrow("Expected close date is required on Grant application opportunities.");
    const grant = await w.as((tx) => createOpportunity(tx, { ...input, closeDate: "2027-03-31" }));
    expect([grant.recordTypeName, grant.amount, grant.stage]).toEqual(["Grant application", "5000.00", "new"]);
    expect((await w.as((tx) => updateOpportunity(tx, w.deal.id, { name: "Memorial paw prints 2027" }))).closeDate).toBeNull();
    const board1 = await w.as((tx) => listOpportunities(tx));
    const total = board1.filter((o) => o.stage === "new").reduce((sum, o) => sum + Number(o.amount) * 100, 0) / 100;
    expect(total.toFixed(2)).toBe("7400.00");
    const standardType = (await w.types("opportunity"))[0];
    const moved = await w.as((tx) => updateOpportunity(tx, grant.id, { recordTypeId: standardType.id }));
    expect([moved.recordTypeName, moved.amount, moved.stage]).toEqual(["Standard", "5000.00", "new"]);
    const history = await w.as((tx) =>
      tx.query<{ details: Record<string, unknown> }>(
        "select details from audit_events where event_type = 'crm.opportunity_updated' and entity_id = $1 order by id desc limit 1",
        [grant.id],
      ),
    );
    expect([history.rows[0].details.recordType, history.rows[0].details.recordTypeFrom]).toEqual(["Standard", "Grant application"]);
    await w.as((tx) => updateOpportunity(tx, w.deal.id, { stage: "won" }));
    const { invoice } = await w.as((tx) => makeInvoiceFromOpportunity(tx, w.deal.id));
    expect((await w.as((tx) => getInvoice(tx, invoice.id))).total).toBe("2760.00");
  });

  it("CRT11: the record pages' related lists and activity", async () => {
    const w = await setup();
    await w.as((tx) => updateOpportunity(tx, w.deal.id, { stage: "won" }));
    const { invoice } = await w.as((tx) => makeInvoiceFromOpportunity(tx, w.deal.id));
    await w.as((tx) => createActivity(tx, { kind: "call", happenedAt: "2026-09-15T02:00:00Z", subject: "Intro call", contactId: w.vets.id }));
    const today = todayIsoDate();
    await w.as((tx) => createTask(tx, { title: "Send sample", dueDate: addDaysIso(today, -1), contactId: w.vets.id }));
    await w.as((tx) => createTask(tx, { title: "Follow up", dueDate: addDaysIso(today, 7), contactId: w.vets.id, personId: w.aroha.id }));
    const cookie = await sessionCookieFor(viewer);
    const response = await companyRoute.GET(apiRequest(`/api/crm/companies/${w.vets.id}?organisationId=${w.org}`, { cookie }), params({ contactId: w.vets.id }));
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      recordType: RecordType;
      people: unknown[];
      opportunities: unknown[];
      tasks: { title: string }[];
      invoices: { id: string; total: string }[];
      creditNotes: unknown[];
      notesCount: number;
      filesCount: number;
      timeline: { kind: string; amount: string | null }[];
    };
    expect(page.recordType.name).toBe("Standard");
    expect([page.people.length, page.opportunities.length, page.tasks.length, page.invoices.length, page.creditNotes.length]).toEqual([1, 1, 2, 1, 0]);
    expect(page.invoices[0]).toMatchObject({ id: invoice.id, total: "2760.00" });
    expect([page.notesCount, page.filesCount]).toEqual([0, 0]);
    expect(page.timeline.some((entry) => entry.kind === "activity")).toBe(true);

    const personResponse = await personRoute.GET(apiRequest(`/api/crm/people/${w.aroha.id}?organisationId=${w.org}`, { cookie }), params({ personId: w.aroha.id }));
    expect(personResponse.status).toBe(200);
    const person = (await personResponse.json()) as { person: { fullName: string }; recordType: RecordType; opportunities: unknown[]; tasks: { title: string }[] };
    expect([person.person.fullName, person.recordType.name, person.opportunities.length, person.tasks.map((t) => t.title)]).toEqual([
      "Aroha Ngata",
      "Standard",
      1,
      ["Follow up"],
    ]);
    const dealResponse = await opportunityRoute.GET(
      apiRequest(`/api/crm/opportunities/${w.deal.id}?organisationId=${w.org}`, { cookie }),
      params({ opportunityId: w.deal.id }),
    );
    expect(dealResponse.status).toBe(200);
    const deal = (await dealResponse.json()) as { opportunity: { name: string }; recordType: RecordType; invoice: { total: string } | null; timeline: { kind: string }[] };
    expect([deal.opportunity.name, deal.recordType.name, deal.invoice?.total]).toEqual(["Memorial paw prints 2027", "Standard", "2760.00"]);
    expect(deal.timeline.some((entry) => entry.kind === "opportunity_stage")).toBe(true);
  });

  it("CRT12: with the CRM off record types don't apply and can't change", async () => {
    const w = await setup();
    const funding = await fundingBody(w);
    const { contact: board } = await newFunder(w, { recordTypeId: funding.id });
    await w.as((tx) => updateOrganisationSettings(tx, { crmEnabled: false, advancedFeatures: true }));
    const saved = await w.as((tx) => updateContact(tx, board.id, { phone: "", isCustomer: true }));
    expect([saved.phone, saved.recordTypeName]).toEqual([null, "Funding body"]);
    await expect(w.as((tx) => createRecordType(tx, { record: "contact", name: "Later" }))).rejects.toThrow("The CRM is off.");
    await expect(w.as((tx) => updateRecordType(tx, funding.id, { name: "Funder" }))).rejects.toThrow("The CRM is off.");
    await expect(w.as((tx) => updateContact(tx, board.id, { recordTypeId: w.standard.id }))).rejects.toThrow("The CRM is off");
  });

  it("CRT13: over HTTP: viewers read, bookkeepers change records, admins set up", async () => {
    const w = await setup();
    const viewerCookie = await sessionCookieFor(viewer);
    const bookkeeperCookie = await sessionCookieFor(bookkeeper);
    const ownerCookie = await sessionCookieFor(owner);
    const read = await recordTypesRoute.GET(apiRequest(`/api/crm/record-types?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { recordTypes: RecordType[] }).recordTypes.map((t) => [t.record, t.name])).toEqual([
      ["contact", "Standard"],
      ["person", "Standard"],
      ["opportunity", "Standard"],
    ]);
    expect((await recordTypesRoute.GET(apiRequest(`/api/crm/record-types?organisationId=${w.org}`), noContext)).status).toBe(401);
    const body = { organisationId: w.org, record: "contact", name: "Funding body" };
    expect((await recordTypesRoute.POST(apiRequest("/api/crm/record-types", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await recordTypesRoute.POST(apiRequest("/api/crm/record-types", { method: "POST", cookie: bookkeeperCookie, body }), noContext)).status).toBe(403);
    const created = await recordTypesRoute.POST(apiRequest("/api/crm/record-types", { method: "POST", cookie: ownerCookie, body }), noContext);
    expect(created.status).toBe(201);
    const { recordType } = (await created.json()) as { recordType: RecordType };
    const path = `/api/crm/record-types/${recordType.id}`;
    const rename = { organisationId: w.org, name: "Funder" };
    expect((await recordTypeRoute.PATCH(apiRequest(path, { method: "PATCH", cookie: bookkeeperCookie, body: rename }), params({ recordTypeId: recordType.id }))).status).toBe(
      403,
    );
    expect((await recordTypeRoute.PATCH(apiRequest(path, { method: "PATCH", cookie: ownerCookie, body: rename }), params({ recordTypeId: recordType.id }))).status).toBe(200);
    const typed = await contactRoute.PATCH(
      apiRequest(`/api/contacts/${w.vets.id}`, { method: "PATCH", cookie: bookkeeperCookie, body: { organisationId: w.org, recordTypeId: recordType.id } }),
      params({ contactId: w.vets.id }),
    );
    expect(typed.status).toBe(200);
    expect(((await typed.json()) as { contact: { recordTypeName: string } }).contact.recordTypeName).toBe("Funder");
    const personType = (await w.types("person"))[0];
    const person = await personRoute.PATCH(
      apiRequest(`/api/crm/people/${w.aroha.id}`, { method: "PATCH", cookie: bookkeeperCookie, body: { organisationId: w.org, recordTypeId: personType.id, jobTitle: "Director" } }),
      params({ personId: w.aroha.id }),
    );
    expect(person.status).toBe(200);
    const deal = await opportunityRoute.GET(apiRequest(`/api/crm/opportunities/${w.deal.id}?organisationId=${w.org}`), params({ opportunityId: w.deal.id }));
    expect(deal.status).toBe(401);
    const aroha = await w.as((tx) => updatePerson(tx, w.aroha.id, { jobTitle: "Owner" }));
    expect(aroha.recordTypeName).toBe("Standard");
  });
});
