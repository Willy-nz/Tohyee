import { afterAll, beforeAll, expect, it } from "vitest";
import * as rulesRoute from "@/app/api/crm/follow-up-rules/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { createFollowUpRule, FOLLOW_UP_ACTOR, listFollowUpRuns, runFollowUpRules, updateFollowUpRule } from "@/lib/crm/follow-ups";
import { createLead } from "@/lib/crm/leads";
import { createActivity, createOpportunity, createTask, listTasks, updateOpportunity } from "@/lib/crm/service";
import { createSalesTeam } from "@/lib/crm/teams";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addDays } from "@/lib/financial-year";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
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

const ORG = "crm-follow-ups";
const noContext = undefined as unknown;

/** Decision 495 (#216 stage 2; Jess 10 Oct 2026): follow-up rules make tasks, once each. */
describeWithDatabase("CRM follow-up rules (decision 495)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let rep: SessionUser;
  let loner: SessionUser;
  let manager: SessionUser;
  let contactId = "";
  const today = todayIsoDate();

  const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const sweep = (options: { ruleId?: string; today?: string } = {}) =>
    inOrganisation(ORG, FOLLOW_UP_ACTOR, (tx) => runFollowUpRules(tx, options));
  const tasksFor = (userId: string) => as((tx) => listTasks(tx, { assigneeUserId: userId }));
  const switchOffAll = () => as(async (tx) => tx.query("update crm_follow_up_rules set is_active = false"));

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    loner = await createTestUser("loner@example.com", { displayName: "Lou Loner" });
    manager = await createTestUser("manager@example.com", { displayName: "Mere Manager" });
    await coreQuery(
      "insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_rep'), ($1, $3, 'sales_rep'), ($1, $4, 'sales_manager')",
      [ORG, rep.id, loner.id, manager.id],
    );
    await as((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    await as((tx) => createSalesTeam(tx, { name: "South", managerUserId: manager.id, memberUserIds: [rep.id] }));
    contactId = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("only admins and owners see and set up rules; rules are checked when saved", async () => {
    const asRep = await rulesRoute.GET(apiRequest(`/api/crm/follow-up-rules?organisationId=${ORG}`, { cookie: await sessionCookieFor(manager) }), noContext);
    expect(asRep.status).toBe(403);
    await expect(as((tx) => createFollowUpRule(tx, { kind: "deal_stage", name: "Won", stageKey: "won", days: 1 }))).rejects.toThrow(/open stage/);
    await expect(as((tx) => createFollowUpRule(tx, { kind: "deal_stage", name: "Nope", stageKey: "nope", days: 1 }))).rejects.toThrow(/deal stages/);
    await expect(as((tx) => createFollowUpRule(tx, { kind: "deal_quiet", name: "Quiet", days: 0 }))).rejects.toThrow(/at least 1/);
    await expect(as((tx) => createFollowUpRule(tx, { kind: "lead_arrives", name: "Lead", days: 1.5 }))).rejects.toThrow(/whole number/);
    const rule = await as((tx) => createFollowUpRule(tx, { kind: "lead_arrives", name: "Lead", days: 0 }));
    await expect(as((tx) => updateFollowUpRule(tx, rule.id, { kind: "deal_quiet" }))).rejects.toThrow(/can't be changed/);
    await switchOffAll();
  });

  it("a new lead: a task for its owner; an unassigned one, for each team manager; once only", async () => {
    // A lead from before the rule existed is left alone.
    await as((tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Before", ownerUserId: rep.id }));
    await as(async (tx) => tx.query("update crm_leads set created_at = now() - interval '1 minute'"));
    const rule = await as((tx) => createFollowUpRule(tx, { kind: "lead_arrives", name: "Call new leads", days: 2, taskTitle: "Call" }));
    const ruby = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), firstName: "Aroha", lastName: "Ngata", ownerUserId: rep.id }))).lead;
    const nobody = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), companyName: "Walk-in Ltd", ownerUserId: null }))).lead;

    expect(await sweep()).toEqual({ tasksCreated: 2, skipped: 0 });
    const rubys = (await tasksFor(rep.id)).filter((task) => task.leadId === ruby.id);
    expect(rubys).toEqual([expect.objectContaining({ title: "Call: Aroha Ngata", dueDate: addDays(today, 2), status: "todo" })]);
    const managers = (await tasksFor(manager.id)).filter((task) => task.leadId === nobody.id);
    expect(managers).toEqual([expect.objectContaining({ title: "Call: Walk-in Ltd", body: "Nobody owns this lead yet: take it, or give it to someone." })]);
    expect((await tasksFor(rep.id)).some((task) => task.title.includes("Before"))).toBe(false);

    // Checked again, or twice at once: nothing more.
    expect(await sweep()).toEqual({ tasksCreated: 0, skipped: 0 });
    const both = await Promise.all([sweep(), sweep()]);
    expect(both.map((entry) => entry.tasksCreated)).toEqual([0, 0]);
    const runs = await as((tx) => listFollowUpRuns(tx, { ruleId: rule.id }));
    expect(runs.map((entry) => [entry.leadId, entry.outcome]).sort()).toEqual([[nobody.id, "task_created"], [ruby.id, "task_created"]].sort());
    await switchOffAll();
  });

  it("a lead arriving while two checks run at once still gets one task", async () => {
    await as((tx) => createFollowUpRule(tx, { kind: "lead_arrives", name: "Race", days: 0 }));
    const lead = (await as((tx) => createLead(tx, { idempotencyKey: key("l"), lastName: "Racer", ownerUserId: rep.id }))).lead;
    const both = await Promise.all([sweep(), sweep()]);
    expect(both.reduce((sum, entry) => sum + entry.tasksCreated, 0)).toBe(1);
    expect((await tasksFor(rep.id)).filter((task) => task.leadId === lead.id)).toHaveLength(1);
    await switchOffAll();
  });

  it("a deal reaching a stage: a follow-up for its owner, due days after; again only if it comes back", async () => {
    const deal = await as((tx) => createOpportunity(tx, { name: "Keyrings", contactId, ownerUserId: rep.id, amount: "500.00", closeDate: "2026-12-31", stage: "proposal" }));
    // It reached Proposal before the rule: no task.
    const rule = await as((tx) => createFollowUpRule(tx, { kind: "deal_stage", name: "Chase proposals", stageKey: "proposal", days: 3 }));
    expect((await sweep()).tasksCreated).toBe(0);

    const other = await as((tx) => createOpportunity(tx, { name: "Collars", contactId, ownerUserId: rep.id, amount: "200.00", closeDate: "2026-12-31", stage: "meeting" }));
    await as((tx) => updateOpportunity(tx, other.id, { stage: "proposal" }));
    expect(await sweep()).toEqual({ tasksCreated: 1, skipped: 0 });
    expect((await tasksFor(rep.id)).filter((task) => task.opportunityId === other.id)).toEqual([
      expect.objectContaining({ title: "Follow up: Collars", dueDate: addDays(today, 3), contactId }),
    ]);
    // A change that keeps it in Proposal isn't reaching it again.
    await as((tx) => updateOpportunity(tx, other.id, { amount: "250.00" }));
    expect((await sweep()).tasksCreated).toBe(0);
    // Back a stage and in again: a new follow-up.
    await as((tx) => updateOpportunity(tx, other.id, { stage: "meeting" }));
    await as((tx) => updateOpportunity(tx, other.id, { stage: "proposal" }));
    expect((await sweep()).tasksCreated).toBe(1);
    // A deal with no owner is skipped, and says why.
    const unowned = await as((tx) => createOpportunity(tx, { name: "Tags", contactId, ownerUserId: null, amount: "50.00", closeDate: "2026-12-31", stage: "new" }));
    await as((tx) => updateOpportunity(tx, unowned.id, { stage: "proposal" }));
    expect(await sweep()).toEqual({ tasksCreated: 0, skipped: 1 });
    const runs = await as((tx) => listFollowUpRuns(tx, { ruleId: rule.id }));
    expect(runs[0]).toMatchObject({ opportunityId: unowned.id, outcome: "skipped", detail: "The deal has no owner." });
    expect(runs.some((entry) => entry.opportunityId === deal.id)).toBe(false);
    await switchOffAll();
  });

  it("a quiet deal: one reminder per quiet spell; logging a call ends the spell", async () => {
    // Checked as if on later days; a call can be logged for any time.
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const quiet = await as((tx) => createOpportunity(tx, { name: "Old enquiry", contactId, ownerUserId: rep.id, amount: "90.00", closeDate: "2026-12-31", stage: "meeting" }));
    const busy = await as((tx) => createOpportunity(tx, { name: "Fresh enquiry", contactId, ownerUserId: rep.id, amount: "90.00", closeDate: "2026-12-31", stage: "meeting" }));
    await as((tx) => createActivity(tx, { kind: "call", happenedAt: at(10), subject: "Called", opportunityId: busy.id }));
    await as((tx) => createFollowUpRule(tx, { kind: "deal_quiet", name: "Quiet deals", days: 14 }));
    expect((await sweep({ today: addDays(today, 13) })).tasksCreated).toBe(0);
    expect((await sweep({ today: addDays(today, 14) })).tasksCreated).toBeGreaterThanOrEqual(1);
    const reminders = (await tasksFor(rep.id)).filter((task) => task.title.startsWith("Check in on quiet deal"));
    expect(reminders.filter((task) => task.opportunityId === quiet.id)).toEqual([
      expect.objectContaining({ title: "Check in on quiet deal: Old enquiry", dueDate: addDays(today, 14), body: `Nothing has been logged on this deal since ${today}.` }),
    ]);
    expect(reminders.some((task) => task.opportunityId === busy.id)).toBe(false);
    expect((await sweep({ today: addDays(today, 20) })).tasksCreated).toBe(0);
    // A call on day 15 ends the spell; 14 days after it, a new reminder.
    await as((tx) => createActivity(tx, { kind: "call", happenedAt: at(15), subject: "Called again", opportunityId: quiet.id }));
    const quietOnes = async () => (await tasksFor(rep.id)).filter((task) => task.opportunityId === quiet.id && task.title.startsWith("Check in"));
    await sweep({ today: addDays(today, 28) });
    expect(await quietOnes()).toHaveLength(1);
    await sweep({ today: addDays(today, 29) });
    expect(await quietOnes()).toHaveLength(2);
    await switchOffAll();
  });

  it("an overdue task: a task for the team's manager, once per due date; people outside a team are left alone", async () => {
    const late = await as((tx) => createTask(tx, { title: "Send prices", assigneeUserId: rep.id, dueDate: addDays(today, -5), contactId }));
    const lonely = await as((tx) => createTask(tx, { title: "Lone task", assigneeUserId: loner.id, dueDate: addDays(today, -5), contactId }));
    const recent = await as((tx) => createTask(tx, { title: "Only just due", assigneeUserId: rep.id, dueDate: addDays(today, -1), contactId }));
    await as((tx) => createFollowUpRule(tx, { kind: "task_overdue", name: "Overdue", days: 3 }));
    const result = await sweep();
    const told = (await tasksFor(manager.id)).filter((task) => task.title.startsWith("Overdue:"));
    expect(told.filter((task) => task.title.includes("Send prices"))).toEqual([
      expect.objectContaining({ title: "Overdue: Send prices (Ruby Rep)", body: `Ruby Rep's task was due ${addDays(today, -5)} and isn't done.`, dueDate: today, contactId }),
    ]);
    expect(told.some((task) => task.title.includes(lonely.title) || task.title.includes(recent.title))).toBe(false);
    expect(result.skipped).toBe(0);
    expect((await sweep()).tasksCreated).toBe(0);
    // Moved to a new date and late again: told again.
    await as(async (tx) => tx.query("update crm_tasks set due_date = $2 where id = $1", [late.id, addDays(today, -4)]));
    expect((await sweep()).tasksCreated).toBe(1);
    await switchOffAll();
  });
});
