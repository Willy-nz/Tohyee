import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@/lib/auth/roles";
import { defaultTilesFor, homeKindFor, type HomeContext } from "@/lib/dashboard/defaults";
import { dashboardCardIds, dashboardPage, maxTilesFor } from "@/lib/dashboard/pages";
import { jobsAtAGlance } from "@/lib/dashboard/home-cards";
import type { JobSummary } from "@/lib/projects/jobs";

/** Which dashboard and cards a person starts with (decision 660, HD1-HD4). Made-up people and settings. */
describe("starting dashboards", () => {
  const base: HomeContext = { role: "owner", farming: false, crm: false, gstRegistered: true, hasJobs: false };

  it("HD1 sales roles get the CRM's sales Home; with Farming on everyone else gets the farm Home; otherwise the owner's", () => {
    expect(homeKindFor({ role: "sales_rep", farming: false })).toBe("sales");
    expect(homeKindFor({ role: "sales_manager", farming: true })).toBe("sales");
    for (const role of ["report_viewer", "viewer", "bookkeeper", "admin", "owner"] as Role[]) {
      expect(homeKindFor({ role, farming: true })).toBe("farming");
      expect(homeKindFor({ role, farming: false })).toBe("owner");
    }
  });

  it("HD2 Home starts with cash and money owed both ways, then GST, or jobs or sales when not registered", () => {
    expect(defaultTilesFor("home", base)).toEqual(["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"]);
    // Registered for GST: GST wins, whatever else is on.
    expect(defaultTilesFor("home", { ...base, crm: true, hasJobs: true }).at(-1)).toBe("next_gst_return");
    expect(defaultTilesFor("home", { ...base, gstRegistered: false, hasJobs: true, crm: true }).at(-1)).toBe("jobs");
    expect(defaultTilesFor("home", { ...base, gstRegistered: false, crm: true }).at(-1)).toBe("sales_pipeline");
    expect(defaultTilesFor("home", { ...base, gstRegistered: false }).at(-1)).toBe("next_gst_return");
  });

  it("HD3 the farm Home starts with today's work, records to catch up on and the season's cash, for every role", () => {
    for (const role of ["viewer", "bookkeeper", "owner"] as Role[]) {
      expect(defaultTilesFor("farm_home", { ...base, role, farming: true }).slice(0, 3)).toEqual(["farm_calendar", "catch_up", "season_cash"]);
    }
  });

  it("HD4 the CRM Home: a rep starts with next actions, a manager and everyone else with the pipeline", () => {
    expect(defaultTilesFor("crm_home", { ...base, role: "sales_rep" })[0]).toBe("next_actions");
    expect(defaultTilesFor("crm_home", { ...base, role: "sales_manager" }).slice(0, 2)).toEqual(["pipeline", "conversion"]);
    expect(defaultTilesFor("crm_home", { ...base, role: "owner" })[0]).toBe("pipeline");
  });

  it("every starting set is cards the page offers, within its limit", () => {
    for (const page of ["home", "farm_home", "crm_home"]) {
      const definition = dashboardPage(page)!;
      for (const role of ROLES) {
        for (const flags of [base, { ...base, gstRegistered: false, hasJobs: true }, { ...base, gstRegistered: false, crm: true }]) {
          const tiles = defaultTilesFor(page, { ...flags, role });
          expect(tiles.every((tile) => dashboardCardIds(definition).includes(tile))).toBe(true);
          expect(tiles.length).toBeLessThanOrEqual(maxTilesFor(definition));
          expect(new Set(tiles).size).toBe(tiles.length);
        }
      }
    }
    expect(defaultTilesFor("no_such_page", base)).toEqual([]);
  });

  it("Home's Jobs card counts open jobs, visits in the next seven days, jobs with none booked and services due", () => {
    const job = (name: string, status: string, nextVisit: string | null): JobSummary => ({ projectId: name, name, contactName: "Made-up Ltd", siteAddress: null, status, nextVisit, lastVisit: null });
    expect(
      jobsAtAGlance(
        [job("a", "in_progress", "2026-10-21 09:00:00+13"), job("b", "in_progress", "2026-10-26 09:00:00+13"), job("c", "in_progress", "2026-10-27 09:00:00+13"), job("d", "in_progress", null), job("e", "closed", null)],
        2,
        "2026-10-20",
      ),
    ).toEqual({ open: 4, visitSoon: 2, noVisit: 1, servicesDue: 2 });
  });
});
