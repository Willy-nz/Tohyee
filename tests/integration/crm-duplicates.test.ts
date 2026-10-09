import { afterAll, beforeAll, expect, it } from "vitest";
import * as duplicatesRoute from "@/app/api/crm/duplicates/route";
import * as mergeRoute from "@/app/api/crm/duplicates/merge/route";
import * as similarRoute from "@/app/api/crm/duplicates/similar/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact, getContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { companyKey, companyLinks, listDuplicates, mergeCompanies, mergePeople, reviewDuplicate, similarRecords } from "@/lib/crm/duplicates";
import { createLead } from "@/lib/crm/leads";
import { createActivity, createOpportunity, createPerson, createTask, getOpportunity, listPeople } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createProject } from "@/lib/projects/service";
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

const ORG = "crm-duplicates";
const noContext = undefined as unknown;

/** Decision 494 (#216; Jess, 10 Oct 2026: "merge CRM-only; link if invoiced"). */
describeWithDatabase("CRM duplicates (decision 494)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const company = async (name: string, extra: Record<string, unknown> = {}) =>
    (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isProspect: true, ...extra }))).contact;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep')", [ORG, rep.id]);
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("names match ignoring case, accents, punctuation and endings like Ltd", () => {
    expect(companyKey("Kea Pets Ltd.")).toBe("keapets");
    expect(companyKey("KEA PETS LIMITED")).toBe("keapets");
    expect(companyKey("Mānuka Vets (NZ)")).toBe("manukavets");
    expect(companyKey("Kea Pets & Co")).toBe("keapets");
  });

  it("suggests companies with the same name, email or phone, and people with the same email; reviewed pairs drop off", async () => {
    const a = await company("Tūī Kennels Ltd", { email: "hello@tui.nz" });
    const b = await company("tui kennels");
    const c = await company("Bark Avenue", { phone: "+64 21 555 0101" });
    const d = await company("Woof Central", { phone: "021 555 0101" });
    const e = await company("Unrelated Co");
    const pairs = await as((tx) => listDuplicates(tx));
    const companyPairs = pairs.filter((pair) => pair.record === "company").map((pair) => [pair.first.id, pair.second.id, pair.reason]);
    expect(companyPairs).toContainEqual([a.id, b.id, "name"]);
    expect(companyPairs).toContainEqual([c.id, d.id, "phone"]);
    expect(companyPairs.some((pair) => pair.includes(e.id))).toBe(false);

    await as((tx) => reviewDuplicate(tx, { record: "company", firstId: d.id, secondId: c.id, decision: "not_duplicate" }));
    const after = await as((tx) => listDuplicates(tx));
    expect(after.some((pair) => pair.first.id === c.id && pair.second.id === d.id)).toBe(false);

    const p1 = await as((tx) => createPerson(tx, { contactId: a.id, firstName: "Hemi", lastName: "Walker", email: "hemi@tui.nz" }));
    const p2 = await as((tx) => createPerson(tx, { contactId: e.id, firstName: "H", lastName: "Walker", email: "HEMI@tui.nz" }));
    const people = (await as((tx) => listDuplicates(tx))).filter((pair) => pair.record === "person");
    // At two different companies: suggested, but only to link, not merge.
    expect(people).toContainEqual(expect.objectContaining({ reason: "email", canMerge: false, first: expect.objectContaining({ id: p1.id }), second: expect.objectContaining({ id: p2.id }) }));
  });

  it("merging a CRM-only company moves its people, deals, tasks, activities and leads, fills blanks, and archives it", async () => {
    const keep = await company("Paw Prints Ltd");
    const away = await company("Paw Prints Limited", { email: "orders@pawprints.nz", phone: "03 555 0000" });
    const keptPrimary = await as((tx) => createPerson(tx, { contactId: keep.id, firstName: "Ana", isPrimary: true }));
    const movedPrimary = await as((tx) => createPerson(tx, { contactId: away.id, firstName: "Ben", isPrimary: true }));
    const deal = await as((tx) => createOpportunity(tx, { name: "Tags", contactId: away.id, ownerUserId: owner.id, amount: "500.00", closeDate: "2026-11-30" }));
    const task = await as((tx) => createTask(tx, { title: "Call Ben", contactId: away.id }));
    await as((tx) => createActivity(tx, { kind: "note", subject: "Met at the show", contactId: away.id }));

    const merged = await as((tx) => mergeCompanies(tx, { keepId: keep.id, mergeId: away.id }));
    expect(merged).toEqual({ keptId: keep.id, mergedId: away.id });

    const kept = await as((tx) => getContact(tx, keep.id));
    expect(kept).toMatchObject({ email: "orders@pawprints.nz", phone: "03 555 0000" });
    expect(await as((tx) => getContact(tx, away.id))).toMatchObject({ isArchived: true });
    expect((await as((tx) => getOpportunity(tx, deal.id))).contactId).toBe(keep.id);
    const people = await as((tx) => listPeople(tx, { contactId: keep.id }));
    // Ana stays the primary person; Ben moves across without being primary.
    expect(people.map((person) => [person.id, person.isPrimary]).sort()).toEqual([[keptPrimary.id, true], [movedPrimary.id, false]].sort());
    const counts = await as(async (tx) =>
      (
        await tx.query<{ tasks: number; activities: number }>(
          "select (select count(*)::int from crm_tasks where contact_id = $1 and id = $2) as tasks, (select count(*)::int from crm_activities where contact_id = $1) as activities",
          [keep.id, task.id],
        )
      ).rows[0],
    );
    expect(counts).toEqual({ tasks: 1, activities: 1 });
    expect(await as((tx) => companyLinks(tx, away.id))).toEqual({ mergedInto: { id: keep.id, name: "Paw Prints Ltd" }, sameCustomer: [] });
    // Merged companies aren't suggested again.
    expect((await as((tx) => listDuplicates(tx))).some((pair) => [pair.first.id, pair.second.id].includes(away.id))).toBe(false);
    await expect(as((tx) => mergeCompanies(tx, { keepId: keep.id, mergeId: away.id }))).rejects.toThrow(/already been merged/);
  });

  it("a company with accounting records is never merged away; two that both have them are linked as the same customer", async () => {
    const booked = await company("Kākā Supplies Ltd", { isCustomer: true });
    await as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Fit-out", contactId: booked.id }));
    const crmOnly = await company("Kaka Supplies");
    await expect(as((tx) => mergeCompanies(tx, { keepId: crmOnly.id, mergeId: booked.id }))).rejects.toThrow(
      "Kākā Supplies Ltd has accounting records, so it can't be merged away. Keep Kākā Supplies Ltd and merge Kaka Supplies into it.",
    );
    const pair = (await as((tx) => listDuplicates(tx))).find((entry) => entry.first.id === booked.id && entry.second.id === crmOnly.id);
    expect(pair).toMatchObject({ canMerge: true, first: { hasBooks: true }, second: { hasBooks: false } });

    const other = await company("Kaka Supplies Limited", { isCustomer: true });
    await as((tx) => createProject(tx, { idempotencyKey: key("p"), name: "Repairs", contactId: other.id }));
    await expect(as((tx) => mergeCompanies(tx, { keepId: booked.id, mergeId: other.id }))).rejects.toThrow(/both have accounting records/);
    await as((tx) => reviewDuplicate(tx, { record: "company", firstId: other.id, secondId: booked.id, decision: "same_customer" }));
    expect((await as((tx) => companyLinks(tx, booked.id))).sameCustomer).toEqual([{ id: other.id, name: "Kaka Supplies Limited" }]);
    // The CRM-only one still merges into the one with records.
    await as((tx) => mergeCompanies(tx, { keepId: booked.id, mergeId: crmOnly.id }));
  });

  it("people merge within their company; deals pointing at them move across", async () => {
    const vets = await company("Harbour Vets");
    const first = await as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Mere", lastName: "Tahi", email: "mere@harbourvets.nz" }));
    const second = await as((tx) => createPerson(tx, { contactId: vets.id, firstName: "Mere", lastName: "Tahi", phone: "021 444 333", jobTitle: "Practice manager" }));
    const deal = await as((tx) => createOpportunity(tx, { name: "Collars", contactId: vets.id, pointOfContactId: second.id, ownerUserId: owner.id, amount: "200.00", closeDate: "2026-12-01" }));
    await as((tx) => mergePeople(tx, { keepId: first.id, mergeId: second.id }));
    const people = await as((tx) => listPeople(tx, { contactId: vets.id, includeArchived: true }));
    expect(people.find((person) => person.id === first.id)).toMatchObject({ phone: "021 444 333", jobTitle: "Practice manager", isArchived: false });
    expect(people.find((person) => person.id === second.id)).toMatchObject({ isArchived: true });
    expect((await as((tx) => getOpportunity(tx, deal.id))).pointOfContactId).toBe(first.id);

    const elsewhere = await company("Elsewhere Ltd");
    const third = await as((tx) => createPerson(tx, { contactId: elsewhere.id, firstName: "Mere" }));
    await expect(as((tx) => mergePeople(tx, { keepId: first.id, mergeId: third.id }))).rejects.toThrow(/different companies/);
  });

  it("warns while adding: similar companies, people and leads, only the leads this person can see", async () => {
    await company("Rua Retrievers", { email: "kia.ora@rua.nz" });
    const ruby = await inOrganisation(ORG, { userId: rep.id, email: rep.email }, async (tx) =>
      createLead(tx, { idempotencyKey: key("l"), lastName: "Rua", email: "kia.ora@rua.nz" }, await crmScope(tx, "sales_rep", rep.id)),
    );
    await as((tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Owner's", email: "owner-lead@rua.nz", ownerUserId: owner.id }));
    const found = await as((tx) => similarRecords(tx, { name: "RUA RETRIEVERS LTD", email: "kia.ora@rua.nz" }));
    expect(found.companies).toEqual([expect.objectContaining({ name: "Rua Retrievers", reason: "name" })]);
    expect(found.leads.map((lead) => lead.id)).toEqual([ruby.lead.id]);

    const response = await similarRoute.POST(
      apiRequest("/api/crm/duplicates/similar", { method: "POST", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, email: "owner-lead@rua.nz" } }),
      noContext,
    );
    // The rep can't see the owner's lead, so isn't told about it.
    expect(await response.json()).toEqual({ companies: [], people: [], leads: [] });
  });

  it("a sales rep can list and dismiss pairs but not merge", async () => {
    const cookie = await sessionCookieFor(rep);
    const listed = await duplicatesRoute.GET(apiRequest(`/api/crm/duplicates?organisationId=${ORG}`, { cookie }), noContext);
    expect(listed.status).toBe(200);
    expect((await listed.json()).canMerge).toBe(false);
    const a = await company("Spare Co One");
    const b = await company("Spare Co One Ltd");
    const merge = await mergeRoute.POST(
      apiRequest("/api/crm/duplicates/merge", { method: "POST", cookie, body: { organisationId: ORG, record: "company", keepId: a.id, mergeId: b.id } }),
      noContext,
    );
    expect(merge.status).toBe(403);
  });
});
