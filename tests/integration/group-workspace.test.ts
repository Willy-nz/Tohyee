import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { addGroupCustomerLink, createGroupCustomer, listGroupCustomers, removeGroupCustomerLink, searchMemberContacts } from "@/lib/consolidation/customers";
import { createAdjustment, createGroup, listGroups, requireGroup, setMembershipDates, setRateOverride, setSteward, updateGroup } from "@/lib/consolidation/groups";
import { planGroupRecordMove } from "@/lib/consolidation/move-plan";
import { consolidatedBalanceSheet, consolidatedProfitAndLoss } from "@/lib/consolidation/report";
import { getReportSnapshot, listReportSnapshots, saveReportSnapshot } from "@/lib/consolidation/snapshots";
import { listStageMappings, saveStageMappings } from "@/lib/consolidation/stage-mappings";
import { groupWorkspace, TAX_NOTE } from "@/lib/consolidation/workspace";
import { workspaceCacheSize } from "@/lib/consolidation/workspace-cache";
import { createContact } from "@/lib/contacts/service";
import { createOpportunity } from "@/lib/crm/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addExchangeRates } from "@/lib/fx/rates";
import { postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * The group workspace (#200 stage 1, decisions 640-646, example CO13).
 * Made-up group: Harakeke Holdings (parent, NZD), Harakeke Retail (NZD) and
 * Harakeke Pty (AUD). Jess owns all three; Vic is a viewer of all three;
 * Mere is a bookkeeper of Retail only; Ola is in none.
 */
describeWithDatabase("group workspace (#200, CO13)", () => {
  let server: TestServer;
  let jess: SessionUser;
  let vic: SessionUser;
  let mere: SessionUser;
  let ola: SessionUser;
  const ids = { holdings: "gw-holdings", retail: "gw-retail", pty: "gw-pty" };
  const as = <T>(org: string, work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: jess.id, email: jess.email }, work);
  const me = () => ({ id: jess.id, email: jess.email });
  const asVic = () => ({ id: vic.id, email: vic.email });
  let groupId = "";
  const contacts: Record<string, string> = {};

  beforeAll(async () => {
    server = await startTestServer();
    jess = await createTestUser("gw-jess@example.com", { displayName: "Jess" });
    vic = await createTestUser("gw-vic@example.com", { displayName: "Vic" });
    mere = await createTestUser("gw-mere@example.com", { displayName: "Mere" });
    ola = await createTestUser("gw-ola@example.com", { displayName: "Ola" });
    await createTestOrganisation(jess, ids.holdings);
    await createTestOrganisation(jess, ids.retail);
    await createTestOrganisation(jess, ids.pty, { baseCurrency: "AUD" });
    for (const id of Object.values(ids)) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [id, vic.id]);
      await as(id, (tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    }
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ids.retail, mere.id]);
    // The same café is a customer of all three, each its own contact (same name in two).
    for (const [org, name] of [
      [ids.holdings, "Tūī Café"],
      [ids.retail, "Tūī Café"],
      [ids.pty, "Tūī Café Pty"],
    ] as const) {
      contacts[org] = (await as(org, (tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true }))).contact.id;
    }
    const deal = (org: string, amount: string) => as(org, (tx) => createOpportunity(tx, { name: `Catering ${amount}`, contactId: contacts[org], amount, closeDate: "2026-12-15" }));
    await deal(ids.holdings, "2400.00");
    await deal(ids.retail, "1000.00");
    await deal(ids.pty, "1250.50");
    // Some trading to consolidate, and the parent's AUD rates.
    await as(ids.holdings, (tx) =>
      postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-10-10", reference: "Sales", lines: [{ accountCode: "1000", debitAmount: "5000.00" }, { accountCode: "4000", creditAmount: "5000.00" }] }),
    );
    await as(ids.pty, (tx) =>
      postJournal(tx, { idempotencyKey: key("j"), postingDate: "2026-10-10", reference: "Sales", lines: [{ accountCode: "1000", debitAmount: "1000.00" }, { accountCode: "4000", creditAmount: "1000.00" }] }),
    );
    await as(ids.holdings, (tx) =>
      addExchangeRates(tx, {
        idempotencyKey: key("rates"),
        rates: [
          { currencyCode: "AUD", effectiveDate: "2026-04-01", rate: "1.1" },
          { currencyCode: "AUD", effectiveDate: "2026-10-31", rate: "1.15" },
        ],
      }),
    );
    groupId = (await createGroup(me(), { name: "Harakeke group", parentOrganisationId: ids.holdings, organisationIds: [ids.retail, ids.pty] })).id;
  }, 600_000);

  afterAll(async () => {
    await server?.teardown();
  });

  it("shows the whole group on one page: accounting as the consolidation makes it, pipeline per currency, and the tax note", async () => {
    const workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.taxNote).toBe(TAX_NOTE);
    expect(workspace.members.map((member) => [member.organisationId, member.isParent, member.isSteward])).toEqual([
      [ids.holdings, true, true],
      [ids.pty, false, false],
      [ids.retail, false, false],
    ]);
    // Accounting reconciles to the consolidated profit and loss (same rules, CO4).
    const report = await consolidatedProfitAndLoss(me(), groupId, { to: "2026-10-31" });
    const net = report.totals.find((line) => line.name === "Net profit")!;
    expect(workspace.accounting.netProfit).toBe(net.consolidated);
    expect(workspace.accounting.from).toBe(report.from);
    expect(workspace.accounting.error).toBeNull();
    // NZD and AUD are never added together.
    expect(workspace.pipeline.byCurrency).toEqual([
      { currencyCode: "NZD", amount: "3400.00", weighted: "340.00", count: 2 },
      { currencyCode: "AUD", amount: "1250.50", weighted: "125.05", count: 1 },
    ]);
    expect(workspace.pipeline.translated).toBeNull();
    // The default stages are the same in all three, so they're combined.
    expect(workspace.pipeline.unmappedStages).toEqual([]);
    expect(workspace.pipeline.byStage).toEqual([{ groupStage: "New", totals: workspace.pipeline.byCurrency }]);
    expect(workspace.complete).toBe(true);

    // Translated only when asked, and labelled with its rate: 1,250.50 × 1.15 = 1,438.08.
    const translated = await groupWorkspace(me(), groupId, { asAt: "2026-10-31", basis: "consolidation_current" });
    expect(translated.pipeline.translated).toMatchObject({ currencyCode: "NZD", amount: "4838.08", rates: [{ currencyCode: "AUD", rate: "1.15", date: "2026-10-31", changed: false }] });
    expect(translated.pipeline.translated!.label).toContain("current rates on 31 Oct 2026");
    expect(translated.pipeline.byCurrency).toEqual(workspace.pipeline.byCurrency);
  });

  it("never merges customers by name: only a person's links combine them, and the links are kept by the steward", async () => {
    expect((await listGroupCustomers(me(), groupId)).customers).toEqual([]);
    const found = await searchMemberContacts(me(), groupId, { organisationId: ids.retail, q: "caf" });
    expect(found.map((contact) => [contact.id, contact.linkedTo])).toEqual([[contacts[ids.retail], null]]);
    // A link needs two organisations, and someone who isn't a bookkeeper of every member can't make one.
    await expect(createGroupCustomer(me(), groupId, { name: "Tūī Café", links: [{ organisationId: ids.retail, contactId: contacts[ids.retail] }] })).rejects.toThrow(/at least two/);
    await expect(createGroupCustomer({ id: mere.id, email: mere.email }, groupId, { name: "x", links: [] })).rejects.toThrow("Consolidation group not found.");
    await expect(createGroupCustomer(asVic(), groupId, { name: "x", links: [] })).rejects.toThrow(/bookkeeper or above/);

    const made = await createGroupCustomer(me(), groupId, {
      name: "Tūī Café",
      links: [
        { organisationId: ids.holdings, contactId: contacts[ids.holdings] },
        { organisationId: ids.retail, contactId: contacts[ids.retail] },
      ],
    });
    expect(made.customers).toHaveLength(1);
    expect(made.customers[0].links.map((link) => [link.organisationId, link.contactName, link.inGroup])).toEqual([
      [ids.holdings, "Tūī Café", true],
      [ids.retail, "Tūī Café", true],
    ]);
    // A contact is one group customer at a time.
    await expect(
      createGroupCustomer(me(), groupId, {
        name: "Again",
        links: [
          { organisationId: ids.retail, contactId: contacts[ids.retail] },
          { organisationId: ids.pty, contactId: contacts[ids.pty] },
        ],
      }),
    ).rejects.toThrow(/already linked/);

    let workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.customers.items).toHaveLength(1);
    expect(workspace.customers.items[0].pipeline).toEqual([{ currencyCode: "NZD", amount: "3400.00", weighted: "340.00", count: 2 }]);
    expect(workspace.customers.items[0].owed).toEqual([{ currencyCode: "NZD", amount: "0.00" }]);

    // Adding Pty's contact keeps AUD apart.
    await addGroupCustomerLink(me(), groupId, made.customers[0].id, { organisationId: ids.pty, contactId: contacts[ids.pty] });
    workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.customers.items[0].pipeline.map((entry) => [entry.currencyCode, entry.amount])).toEqual([
      ["NZD", "3400.00"],
      ["AUD", "1250.50"],
    ]);

    // Kept in the steward's (Holdings') own database, not the core database or the other members'.
    const held = await as(ids.holdings, (tx) => tx.query<{ count: number }>("select count(*)::int as count from group_customer_links where group_id = $1 and unlinked_at is null", [groupId]));
    expect(held.rows[0].count).toBe(3);
    const elsewhere = await as(ids.retail, (tx) => tx.query<{ count: number }>("select count(*)::int as count from group_customer_links"));
    expect(elsewhere.rows[0].count).toBe(0);
    const ptyLink = (await listGroupCustomers(me(), groupId)).customers[0].links.find((link) => link.organisationId === ids.pty)!;
    const after = await removeGroupCustomerLink(me(), groupId, made.customers[0].id, ptyLink.id);
    expect(after.customers[0].links).toHaveLength(2);
    // The contact itself is untouched.
    const contact = await as(ids.pty, (tx) => tx.query<{ name: string }>("select name from contacts where id = $1", [contacts[ids.pty]]));
    expect(contact.rows[0].name).toBe("Tūī Café Pty");
  });

  it("combines stages only where they're the same or a person mapped them", async () => {
    await as(ids.pty, (tx) => tx.query("update crm_opportunity_stages set name = 'Enquiry' where key = 'new'"));
    let workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.pipeline.byStage).toBeNull();
    expect(workspace.pipeline.unmappedStages.map((stage) => `${stage.organisationId}|${stage.key}`).sort()).toEqual([`${ids.holdings}|new`, `${ids.pty}|new`, `${ids.retail}|new`].sort());
    await expect(saveStageMappings(asVic(), groupId, { mappings: [] })).rejects.toThrow(/admin or owner/);
    await expect(saveStageMappings(me(), groupId, { mappings: [{ organisationId: ids.pty, stageKey: "nope", groupStage: "New" }] })).rejects.toThrow(/no such stage/);
    await saveStageMappings(me(), groupId, {
      mappings: [ids.holdings, ids.retail, ids.pty].map((organisationId) => ({ organisationId, stageKey: "new", groupStage: "New enquiry" })),
    });
    const view = await listStageMappings(me(), groupId);
    expect(view.stages.filter((stage) => stage.key === "new").every((stage) => stage.how === "mapped" && stage.groupStage === "New enquiry")).toBe(true);
    workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.pipeline.unmappedStages).toEqual([]);
    expect(workspace.pipeline.byStage?.map((entry) => [entry.groupStage, entry.totals.map((total) => `${total.currencyCode} ${total.amount}`)])).toEqual([["New enquiry", ["NZD 3400.00", "AUD 1250.50"]]]);
  });

  it("someone who can't see every member sees none of the group's figures, and losing access works at once despite the copy", async () => {
    for (const user of [mere, ola]) {
      const who = { id: user.id, email: user.email };
      await expect(groupWorkspace(who, groupId)).rejects.toThrow("Consolidation group not found.");
      await expect(listGroupCustomers(who, groupId)).rejects.toThrow("Consolidation group not found.");
      await expect(listReportSnapshots(who, groupId)).rejects.toThrow("Consolidation group not found.");
      await expect(searchMemberContacts(who, groupId, { organisationId: ids.retail })).rejects.toThrow("Consolidation group not found.");
    }
    const first = await groupWorkspace(asVic(), groupId, { asAt: "2026-10-31" });
    expect(first.fromCopy).toBe(false);
    expect((await groupWorkspace(asVic(), groupId, { asAt: "2026-10-31" })).fromCopy).toBe(true);
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [ids.pty, vic.id]);
    await expect(groupWorkspace(asVic(), groupId, { asAt: "2026-10-31" })).rejects.toThrow("Consolidation group not found.");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ids.pty, vic.id]);
    // Back again: a new role set is a new copy, worked out afresh.
    expect((await groupWorkspace(asVic(), groupId, { asAt: "2026-10-31" })).fromCopy).toBe(false);
  });

  it("CO13: membership dates decide who's in each report; saved reports keep the members they used", async () => {
    const saved = await saveReportSnapshot(me(), groupId, { report: "balance_sheet", asAt: "2026-10-31" });
    expect(saved.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.pty, ids.retail]);
    await expect(saveReportSnapshot(asVic(), groupId, { report: "balance_sheet" })).rejects.toThrow(/bookkeeper or above/);
    // The snapshot is kept by the steward, never changed.
    await expect(as(ids.holdings, (tx) => tx.query("update group_report_snapshots set group_name = 'x'"))).rejects.toThrow();

    // The parent can't have dates, the steward can't leave, and stays can't overlap.
    let group = await requireGroup(me(), groupId);
    await expect(setMembershipDates(me(), groupId, { organisationId: ids.holdings, effectiveFrom: "2026-01-01", version: group.version })).rejects.toThrow(/parent/);
    await expect(setSteward(me(), groupId, { organisationId: ids.retail, version: group.version })).rejects.toThrow(/already keeps/);

    // Pty left the group after 30 September 2026.
    await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspaceCacheSize(groupId)).toBeGreaterThan(0);
    group = await setMembershipDates(me(), groupId, { organisationId: ids.pty, effectiveTo: "2026-09-30", version: group.version });
    expect(workspaceCacheSize(groupId)).toBe(0);
    expect(group.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.retail]);
    expect(group.formerMembers).toEqual([{ organisationId: ids.pty, name: `Test ${ids.pty}`, currencyCode: "AUD", effectiveFrom: null, effectiveTo: "2026-09-30" }]);

    const october = await consolidatedBalanceSheet(me(), groupId, { asAt: "2026-10-31" });
    expect(october.group.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.retail]);
    const september = await consolidatedBalanceSheet(me(), groupId, { asAt: "2026-09-30" });
    expect(september.group.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.pty, ids.retail]);
    await expect(consolidatedProfitAndLoss(me(), groupId, { from: "2026-04-01", to: "2026-10-31" })).rejects.toThrow(
      `Test ${ids.pty} left the group after 2026-09-30. Tohyee doesn't split an organisation's results at the day it joined or left, so choose dates on one side of that.`,
    );
    const afterLeaving = await consolidatedProfitAndLoss(me(), groupId, { from: "2026-10-01", to: "2026-10-31" });
    expect(afterLeaving.group.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.retail]);
    // The workspace's accounting says why, rather than showing a part-year figure.
    const workspace = await groupWorkspace(me(), groupId, { asAt: "2026-10-31" });
    expect(workspace.members.map((member) => member.organisationId)).toEqual([ids.holdings, ids.retail]);
    expect(workspace.accounting.error).toContain("left the group after 2026-09-30");
    expect(workspace.complete).toBe(false);

    // The saved report still has Pty in it.
    const list = await listReportSnapshots(me(), groupId);
    expect(list.snapshots.map((snapshot) => snapshot.members.map((member) => member.organisationId))).toEqual([[ids.holdings, ids.pty, ids.retail]]);
    expect((await getReportSnapshot(me(), groupId, saved.id)).body.group.members).toHaveLength(3);

    // Vic stops being a member of Pty: Vic still sees the group (Pty has left) but not Pty's figures.
    await coreQuery("delete from organisation_members where organisation_id = $1 and user_id = $2", [ids.pty, vic.id]);
    expect((await listGroups(asVic())).map((item) => item.id)).toContain(groupId);
    expect(await listReportSnapshots(asVic(), groupId)).toEqual({ snapshots: [], hidden: 1 });
    await expect(getReportSnapshot(asVic(), groupId, saved.id)).rejects.toThrow("Saved report not found.");
    await expect(consolidatedBalanceSheet(asVic(), groupId, { asAt: "2026-09-30" })).rejects.toThrow(/can't see every organisation that was in the group/);
    expect((await consolidatedBalanceSheet(asVic(), groupId, { asAt: "2026-10-31" })).group.members).toHaveLength(2);

    // Pty comes back from 1 January 2027 through the group's settings: a new stay, the old one kept.
    group = await requireGroup(me(), groupId);
    await expect(setMembershipDates(me(), groupId, { organisationId: ids.retail, effectiveTo: "2026-08-01", effectiveFrom: "2026-09-01", version: group.version })).rejects.toThrow(/before the first day/);
    group = await updateGroup(me(), groupId, { name: group.name, organisationIds: [ids.retail, ids.pty], version: group.version });
    const back = group.members.find((member) => member.organisationId === ids.pty)!;
    expect(back.effectiveFrom).not.toBeNull();
    expect(group.formerMembers.map((member) => member.effectiveTo)).toEqual(["2026-09-30"]);
    await expect(setMembershipDates(me(), groupId, { organisationId: ids.pty, effectiveFrom: "2026-09-01", version: group.version })).rejects.toThrow(/overlaps/);
    group = await setMembershipDates(me(), groupId, { organisationId: ids.pty, effectiveFrom: "2027-01-01", version: group.version });
    expect(group.members.find((member) => member.organisationId === ids.pty)?.effectiveFrom).toBe("2027-01-01");
  });

  it("the plan for moving existing consolidation records is a dry run that accounts for every row and writes nothing", async () => {
    const group = await requireGroup(me(), groupId);
    await setRateOverride(me(), groupId, { currencyCode: "AUD", month: "2026-10", kind: "current", rate: "1.2", reason: "Test rate" });
    await createAdjustment(me(), groupId, {
      date: "2026-10-31",
      description: "Test adjustment",
      lines: [
        { organisationId: ids.holdings, accountCode: "4000", debit: "10.00" },
        { organisationId: ids.retail, accountCode: "4000", credit: "10.00" },
      ],
    });
    const before = await coreQuery<{ count: number }>("select (select count(*) from consolidation_rate_overrides) + (select count(*) from consolidation_adjustment_lines) as count");
    const plan = await planGroupRecordMove(group.id);
    expect(plan.destructive).toBe(false);
    expect(plan.ready).toBe(true);
    expect(Object.fromEntries(plan.tables.map((table) => [table.from, table.rows]))).toEqual({
      consolidation_rate_overrides: 1,
      consolidation_budget_rates: 0,
      consolidation_adjustments: 1,
      consolidation_adjustment_lines: 2,
      consolidation_commentaries: 0,
    });
    expect(plan.tables.every((table) => table.checksum === table.roundTripChecksum)).toBe(true);
    const afterPlan = await coreQuery<{ count: number }>("select (select count(*) from consolidation_rate_overrides) + (select count(*) from consolidation_adjustment_lines) as count");
    expect(afterPlan.rows[0].count).toEqual(before.rows[0].count);
    // Nothing went to the steward either.
    const steward = await as(ids.holdings, (tx) => tx.query("select table_name from information_schema.tables where table_name like 'group_adjustment%' or table_name like 'group_rate%'"));
    expect(steward.rowCount).toBe(0);
  });
});
