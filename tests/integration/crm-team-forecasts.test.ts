import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import { crmScope } from "@/lib/crm/access";
import { setQuota } from "@/lib/crm/forecast";
import { adjustForecast, adjustmentHistory, listSnapshots, submitForecast, teamForecast } from "@/lib/crm/forecast-teams";
import { createOpportunity, updateOpportunity } from "@/lib/crm/service";
import { createSalesTeam } from "@/lib/crm/teams";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "crm-team-forecasts";

/** Decision 499 (#216 stage 3; Jess 10 Oct 2026): team roll-ups, adjustments with reasons, submitted snapshots. */
describeWithDatabase("CRM team forecasts (decision 499)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let manager: SessionUser;
  let rep: SessionUser;
  let loner: SessionUser;
  let teamId = "";
  let repDealId = "";
  const today = todayIsoDate();
  const month = `${today.slice(0, 7)}-01`;

  const as = <T>(user: SessionUser, role: "owner" | "sales_manager" | "sales_rep", work: (tx: OrgTx, scope: Awaited<ReturnType<typeof crmScope>>) => Promise<T>) =>
    inOrganisation(ORG, { userId: user.id, email: user.email }, async (tx) => work(tx, await crmScope(tx, role, user.id)));
  const asOwner = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const thisMonth = { period: "month", from: today, periods: 1 };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true, displayName: "Jess" });
    await createTestOrganisation(owner, ORG);
    manager = await createTestUser("manager@example.com", { displayName: "Mere Manager" });
    rep = await createTestUser("rep@example.com", { displayName: "Ruby Rep" });
    loner = await createTestUser("loner@example.com", { displayName: "Lou Loner" });
    await coreQuery(
      "insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'sales_manager'), ($1, $3, 'sales_rep'), ($1, $4, 'sales_rep')",
      [ORG, manager.id, rep.id, loner.id],
    );
    await asOwner((tx) => updateOrganisationSettings(tx, { crmEnabled: true }));
    teamId = (await asOwner((tx) => createSalesTeam(tx, { name: "South", managerUserId: manager.id, memberUserIds: [rep.id] }))).id;
    const contactId = (await asOwner((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Harbour Vets", isProspect: true }))).contact.id;
    const deal = (name: string, ownerUserId: string, amount: string, forecastCategory: string) =>
      asOwner((tx) => createOpportunity(tx, { name, contactId, ownerUserId, amount, closeDate: today, stage: "proposal", forecastCategory }));
    repDealId = (await deal("Ruby's", rep.id, "1000.00", "commit")).id;
    await deal("Ruby's maybe", rep.id, "500.00", "best_case");
    await deal("Mere's", manager.id, "2000.00", "commit");
    await deal("Lou's", loner.id, "300.00", "commit");
    await asOwner((tx) => setQuota(tx, { ownerUserId: rep.id, month, amount: "5000" }));
    await asOwner((tx) => setQuota(tx, { ownerUserId: manager.id, month, amount: "3000" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("a team's figures are its members' and manager's added up, with their quotas", async () => {
    const result = await as(owner, "owner", (tx, scope) => teamForecast(tx, thisMonth, scope));
    expect(result.teams).toEqual([
      expect.objectContaining({
        teamName: "South",
        currencyCode: "NZD",
        commit: "3000.00",
        bestCase: "3500.00",
        adjustedCommit: "3000.00",
        quota: "8000.00",
        count: 3,
      }),
    ]);
    // A rep sees only their own row, and no team.
    const asRep = await as(rep, "sales_rep", (tx, scope) => teamForecast(tx, thisMonth, scope));
    expect(asRep.teams).toEqual([]);
    expect(asRep.rows.map((row) => [row.ownerName, row.canAdjust])).toEqual([["Ruby Rep", false]]);
  });

  it("a manager adjusts a member's figure with a reason; the newest counts; clearing goes back; every change is kept", async () => {
    const adjust = (user: SessionUser, role: "owner" | "sales_manager" | "sales_rep", ownerUserId: string, amount: string | null, reason?: string) =>
      as(user, role, (tx, scope) => adjustForecast(tx, { ownerUserId, period: "month", periodStart: month, currencyCode: "NZD", measure: "commit", amount, reason }, scope));
    await expect(adjust(manager, "sales_manager", rep.id, "1200")).rejects.toThrow(/Say why/);
    await expect(adjust(manager, "sales_manager", rep.id, "1200", "x").then(() => null)).resolves.toBeNull();
    await adjust(manager, "sales_manager", rep.id, "1500", "Ruby expects the Collars order too");
    await expect(adjust(manager, "sales_manager", manager.id, "9", "Mine")).rejects.toThrow(/sales team manager/);
    await expect(adjust(manager, "sales_manager", loner.id, "9", "Not mine")).rejects.toThrow(/sales team manager/);
    await expect(adjust(rep, "sales_rep", rep.id, "9", "Me")).rejects.toThrow(/sales team manager/);
    await expect(
      as(manager, "sales_manager", (tx, scope) => adjustForecast(tx, { ownerUserId: rep.id, period: "month", periodStart: today.slice(0, 8) + "15", currencyCode: "NZD", measure: "commit", amount: "1", reason: "r" }, scope)),
    ).rejects.toThrow(/isn't the start of a month/);

    const managerView = await as(manager, "sales_manager", (tx, scope) => teamForecast(tx, thisMonth, scope));
    const ruby = managerView.rows.find((row) => row.ownerUserId === rep.id)!;
    expect(ruby).toMatchObject({ commit: "1000.00", canAdjust: true, adjusted: { commit: { amount: "1500.00", reason: "Ruby expects the Collars order too", byEmail: "manager@example.com" }, bestCase: null } });
    expect(managerView.rows.find((row) => row.ownerUserId === manager.id)?.canAdjust).toBe(false);
    expect(managerView.teams[0]).toMatchObject({ commit: "3000.00", adjustedCommit: "3500.00" });

    await adjust(owner, "owner", rep.id, null);
    const cleared = await as(owner, "owner", (tx, scope) => teamForecast(tx, thisMonth, scope));
    expect(cleared.rows.find((row) => row.ownerUserId === rep.id)?.adjusted.commit).toBeNull();
    const history = await as(manager, "sales_manager", (tx, scope) => adjustmentHistory(tx, { ownerUserId: rep.id, period: "month", periodStart: month }, scope));
    expect(history.map((entry) => [entry.amount, entry.byEmail])).toEqual([
      [null, "owner@example.com"],
      ["1500.00", "manager@example.com"],
      ["1200.00", "manager@example.com"],
    ]);
    await expect(as(loner, "sales_rep", (tx, scope) => adjustmentHistory(tx, { ownerUserId: rep.id, period: "month", periodStart: month }, scope))).rejects.toThrow(/isn't yours/);
  });

  it("submitted forecasts keep their figures; who can submit and see which", async () => {
    await as(manager, "sales_manager", (tx, scope) =>
      adjustForecast(tx, { ownerUserId: rep.id, period: "month", periodStart: month, currencyCode: "NZD", measure: "commit", amount: "1100", reason: "Call went well" }, scope),
    );
    const own = await as(rep, "sales_rep", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month, ownerUserId: rep.id, note: "On track" }, scope));
    expect(own).toMatchObject({ scopeKind: "owner", name: "Ruby Rep", figures: [expect.objectContaining({ currencyCode: "NZD", commit: "1000.00", adjustedCommit: "1100.00", quota: "5000.00" })] });
    const team = await as(manager, "sales_manager", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month, teamId }, scope));
    expect(team.figures).toEqual([expect.objectContaining({ commit: "3000.00", adjustedCommit: "3100.00", quota: "8000.00" })]);
    await expect(as(rep, "sales_rep", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month }, scope))).rejects.toThrow(/admin/);
    await expect(as(rep, "sales_rep", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month, teamId }, scope))).rejects.toThrow(/team's manager/);
    await expect(as(loner, "sales_rep", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month, ownerUserId: rep.id }, scope))).rejects.toThrow(/isn't yours/);
    const everyone = await as(owner, "owner", (tx, scope) => submitForecast(tx, { period: "month", periodStart: month }, scope));
    expect(everyone.figures).toEqual([expect.objectContaining({ commit: "3300.00", adjustedCommit: "3400.00" })]);

    // The deal grows afterwards: the snapshot stays as it was.
    await asOwner((tx) => updateOpportunity(tx, repDealId, { amount: "4000.00" }));
    const now = await as(owner, "owner", (tx, scope) => teamForecast(tx, thisMonth, scope));
    expect(now.rows.find((row) => row.ownerUserId === rep.id)?.commit).toBe("4000.00");
    const snapshots = (user: SessionUser, role: "owner" | "sales_manager" | "sales_rep") =>
      as(user, role, (tx, scope) => listSnapshots(tx, { period: "month", periodStart: month }, scope));
    expect((await snapshots(owner, "owner")).map((entry) => entry.name)).toEqual(["Everyone", "South", "Ruby Rep"]);
    expect((await snapshots(owner, "owner")).find((entry) => entry.name === "Ruby Rep")?.figures[0].commit).toBe("1000.00");
    expect((await snapshots(manager, "sales_manager")).map((entry) => entry.name)).toEqual(["South", "Ruby Rep"]);
    expect((await snapshots(rep, "sales_rep")).map((entry) => entry.name)).toEqual(["Ruby Rep"]);
    expect(await snapshots(loner, "sales_rep")).toEqual([]);
  });
});
