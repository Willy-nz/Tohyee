import { afterAll, beforeAll, expect, it } from "vitest";
import * as sequencesRoute from "@/app/api/crm/sequences/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { createLead, updateLead } from "@/lib/crm/leads";
import { createEmailTemplate, setEmailOptOut } from "@/lib/crm/sales-email";
import { advanceSequences, createSequence, enrol, listEnrolments, stopEnrolment, updateSequence } from "@/lib/crm/sequences";
import { createOpportunity, createPerson, listTasks, updateOpportunity } from "@/lib/crm/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addDays } from "@/lib/financial-year";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { encryptSecret } from "@/lib/secrets";
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

const ORG = "crm-sequences";
const noContext = undefined as unknown;

/** Decision 497 (#216 stage 2; Jess 10 Oct 2026): sequences make tasks; the rep sends. */
describeWithDatabase("CRM sequences (decision 497)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let otherRep: SessionUser;
  let sequenceId = "";
  let contactId = "";
  const today = todayIsoDate();
  const savedKey = process.env.TOHYEE_SECRET_KEY;

  const as = <T>(user: SessionUser, work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const asRep = <T>(work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) => as(rep, async (tx) => work(tx, await crmScope(tx, "sales_rep", rep.id)));
  const advance = (day: string) => as(owner, (tx) => advanceSequences(tx, day));
  const tasksOn = (target: { leadId?: string; personId?: string; opportunityId?: string }) => as(owner, (tx) => listTasks(tx, target));

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "a-test-secret-key-that-is-long-enough-123";
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    otherRep = await createTestUser("other@example.com", { displayName: "Otto Rep" });
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep')", [ORG, rep.id, otherRep.id]);
    await as(owner, (tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    contactId = (await as(owner, (tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
  });

  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = savedKey;
    await server?.teardown();
  });

  it("admins set out the steps in day order; an email step needs its template", async () => {
    const template = await as(owner, (tx) => createEmailTemplate(tx, { name: "Intro", subject: "Hi {{first_name}}", body: "Kia ora" }));
    const steps = [
      { dayOffset: 0, kind: "email", title: "Intro email", templateId: template.id },
      { dayOffset: 2, kind: "call", title: "Call" },
      { dayOffset: 5, kind: "task", title: "Send samples" },
    ];
    const response = await sequencesRoute.POST(
      apiRequest("/api/crm/sequences", { method: "POST", cookie: await sessionCookieFor(rep), body: { organisationId: ORG, name: "New enquiries", steps } }),
      noContext,
    );
    expect(response.status).toBe(403);
    await expect(as(owner, (tx) => createSequence(tx, { name: "Bad", steps: [{ dayOffset: 0, kind: "email", title: "Email" }] }))).rejects.toThrow(/choose the email template/);
    await expect(
      as(owner, (tx) => createSequence(tx, { name: "Bad", steps: [{ dayOffset: 3, kind: "call", title: "A" }, { dayOffset: 1, kind: "call", title: "B" }] })),
    ).rejects.toThrow(/day order/);
    await expect(as(owner, (tx) => createSequence(tx, { name: "Bad", steps: [] }))).rejects.toThrow(/at least one step/);
    const sequence = await as(owner, (tx) => createSequence(tx, { name: "New enquiries", steps }));
    expect(sequence.steps.map((step) => [step.position, step.dayOffset, step.kind, step.templateName])).toEqual([
      [1, 0, "email", "Intro"],
      [2, 2, "call", null],
      [3, 5, "task", null],
    ]);
    sequenceId = sequence.id;
  });

  it("each step becomes a task on its day for the record's owner, once; then it's finished", async () => {
    const lead = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", email: "aroha@example.nz" }, scope))).lead;
    const enrolment = await asRep((tx, scope) => enrol(tx, { sequenceId, leadId: lead.id }, scope));
    expect(enrolment).toMatchObject({ status: "active", stepsDone: 1, stepsTotal: 3, assigneeUserId: rep.id });
    expect(await tasksOn({ leadId: lead.id })).toEqual([
      expect.objectContaining({ title: "Intro email: Aroha", dueDate: today, assigneeUserId: rep.id, body: expect.stringContaining('"Intro" email') }),
    ]);
    await expect(asRep((tx, scope) => enrol(tx, { sequenceId, leadId: lead.id }, scope))).rejects.toThrow(/Already part-way/);

    expect((await advance(addDays(today, 1))).tasksCreated).toBe(0);
    expect((await advance(addDays(today, 2))).tasksCreated).toBe(1);
    expect((await advance(addDays(today, 2))).tasksCreated).toBe(0);
    expect((await advance(addDays(today, 9))).tasksCreated).toBe(1);
    const tasks = await tasksOn({ leadId: lead.id });
    expect(tasks.map((task) => [task.title, task.dueDate])).toEqual([
      ["Intro email: Aroha", today],
      ["Call: Aroha", addDays(today, 2)],
      ["Send samples: Aroha", addDays(today, 5)],
    ]);
    const [done] = await asRep((tx, scope) => listEnrolments(tx, { leadId: lead.id }, scope));
    expect(done).toMatchObject({ status: "finished", stepsDone: 3 });
    // The steps can't change while someone is part-way through; once nobody is, they can.
    const changed = await as(owner, (tx) =>
      updateSequence(tx, sequenceId, {
        steps: [
          { dayOffset: 0, kind: "call", title: "Call" },
          { dayOffset: 3, kind: "task", title: "Check in" },
        ],
      }),
    );
    expect(changed.steps.map((step) => step.title)).toEqual(["Call", "Check in"]);
    const person = await as(owner, (tx) => createPerson(tx, { contactId, firstName: "Mere", email: "mere@harbourvets.nz" }));
    await as(owner, (tx) => enrol(tx, { sequenceId, personId: person.id }));
    await expect(as(owner, (tx) => updateSequence(tx, sequenceId, { steps: [{ dayOffset: 0, kind: "call", title: "Call" }] }))).rejects.toThrow(/part-way through/);
    await as(owner, async (tx) => {
      const [active] = await listEnrolments(tx, { personId: person.id });
      await stopEnrolment(tx, active.id);
    });
  });

  it("stops by itself on a reply, a won deal or an unqualified lead, and when someone stops it", async () => {
    // A reply synced from a mailbox after they were added.
    const person = await as(owner, (tx) => createPerson(tx, { contactId, firstName: "Hemi", email: "hemi@harbourvets.nz" }));
    await as(owner, (tx) => enrol(tx, { sequenceId, personId: person.id }));
    await as(owner, async (tx) => {
      const account = await tx.query<{ id: string }>(
        `insert into crm_connected_accounts (user_id, provider, email, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at)
         values ($1, 'google', 'jess@example.com', $2, $2, now()) returning id::text`,
        [owner.id, encryptSecret("x")],
      );
      await tx.query(
        `insert into crm_messages (account_id, external_id, direction, sent_at, from_email, subject) values ($1, 'm1', 'received', now() + interval '1 minute', 'Hemi@HarbourVets.nz', 'Re: hello')`,
        [account.rows[0].id],
      );
    });
    await advance(addDays(today, 3));
    expect((await as(owner, (tx) => listEnrolments(tx, { personId: person.id })))[0]).toMatchObject({ status: "stopped", stopReason: "They replied." });
    expect((await tasksOn({ personId: person.id })).map((task) => task.title)).toEqual(["Call: Hemi"]);

    const deal = await as(owner, (tx) => createOpportunity(tx, { name: "Collars", contactId, ownerUserId: rep.id, amount: "10.00", closeDate: "2026-12-31" }));
    const onDeal = await as(owner, (tx) => enrol(tx, { sequenceId, opportunityId: deal.id }));
    expect(onDeal.assigneeUserId).toBe(rep.id);
    await as(owner, (tx) => updateOpportunity(tx, deal.id, { stage: "won" }));
    await advance(addDays(today, 3));
    expect((await as(owner, (tx) => listEnrolments(tx, { opportunityId: deal.id })))[0]).toMatchObject({ status: "stopped", stopReason: "The deal was won." });

    const lead = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Maybe" }, scope))).lead;
    await asRep((tx, scope) => enrol(tx, { sequenceId, leadId: lead.id }, scope));
    await asRep((tx, scope) => updateLead(tx, lead.id, { status: "unqualified", unqualifiedReason: "Not interested" }, scope));
    await advance(addDays(today, 3));
    expect((await asRep((tx, scope) => listEnrolments(tx, { leadId: lead.id }, scope)))[0]).toMatchObject({ status: "stopped", stopReason: "The lead was marked unqualified." });

    const stopped = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Stop me" }, scope))).lead;
    const enrolment = await asRep((tx, scope) => enrol(tx, { sequenceId, leadId: stopped.id }, scope));
    await asRep((tx, scope) => stopEnrolment(tx, enrolment.id, scope));
    expect((await advance(addDays(today, 30))).tasksCreated).toBe(0);
    expect((await tasksOn({ leadId: stopped.id })).map((task) => task.title)).toEqual(["Call: Stop me"]);
  });

  it("email steps are skipped for someone marked Don't email; a rep can't add another rep's lead", async () => {
    const template = (await as(owner, (tx) => tx.query<{ id: string }>("select id::text from crm_email_templates where name = 'Intro'"))).rows[0].id;
    const emailFirst = await as(owner, (tx) =>
      createSequence(tx, {
        name: "Email first",
        steps: [
          { dayOffset: 0, kind: "email", title: "Email", templateId: template },
          { dayOffset: 1, kind: "call", title: "Call" },
        ],
      }),
    );
    const lead = (await asRep((tx, scope) => createLead(tx, { idempotencyKey: key("l"), lastName: "Quiet", email: "quiet@example.nz" }, scope))).lead;
    await asRep((tx, scope) => setEmailOptOut(tx, { leadId: lead.id, optOut: true }, scope));
    await asRep((tx, scope) => enrol(tx, { sequenceId: emailFirst.id, leadId: lead.id }, scope));
    await advance(addDays(today, 1));
    expect((await tasksOn({ leadId: lead.id })).map((task) => task.title)).toEqual(["Call: Quiet"]);
    const runs = await as(owner, (tx) =>
      tx.query<{ position: number; outcome: string; detail: string | null }>(
        "select r.position, r.outcome, r.detail from crm_sequence_step_runs r join crm_sequence_enrolments e on e.id = r.enrolment_id where e.lead_id = $1 order by r.position",
        [lead.id],
      ),
    );
    expect(runs.rows).toEqual([
      { position: 1, outcome: "skipped", detail: "They asked not to be emailed." },
      { position: 2, outcome: "task_created", detail: null },
    ]);

    const ottos = (await as(otherRep, async (tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Otto's" }, await crmScope(tx, "sales_rep", otherRep.id)))).lead;
    await expect(asRep((tx, scope) => enrol(tx, { sequenceId: emailFirst.id, leadId: ottos.id }, scope))).rejects.toThrow(/not found/i);
  });
});
