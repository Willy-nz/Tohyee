import { isSalesRole, type Role } from "@/lib/auth/roles";

/*
 * Which dashboard a person starts with, and its first cards (decision 660;
 * #360 item 20, Codex, delegated by owner, 20 October 2026). Tohyee's roles
 * don't say who's "sales" or "farm staff", so this goes by what Tohyee does
 * know: the person's role and the organisation's modules and records. A
 * person's own choice in Customise always wins: these are only used while
 * they haven't saved one. Pure, so the server, the screens and the tests
 * share it.
 */

/** The kinds of dashboard: the business owner's, sales, and the farm's. */
export type HomeKind = "owner" | "sales" | "farming";

export type HomeContext = {
  role: Role;
  /** Farming is on (and so Accounting). */
  farming: boolean;
  /** The CRM is on. */
  crm: boolean;
  /** Registered for GST: the GST return shows. */
  gstRegistered: boolean;
  /** At least one project is a job (JV1). */
  hasJobs: boolean;
};

/**
 * The person's kind of dashboard:
 * - a **sales rep or manager** (decision 491) is sales: they only have the
 *   CRM, so their Home is the CRM's;
 * - otherwise, with **Farming on**, farming: the farm Home (FH1);
 * - otherwise the **owner's** Home: cash, money owed both ways and what
 *   needs attention.
 */
export function homeKindFor(context: Pick<HomeContext, "role" | "farming">): HomeKind {
  if (isSalesRole(context.role)) return "sales";
  if (context.farming) return "farming";
  return "owner";
}

/**
 * The cards a person starts with on a page, before they customise it.
 *
 * - **Home** (owner): Cash in bank, Owed to you, Bills to pay, then Next GST
 *   return when registered for GST; when not, Jobs if there are any, else
 *   Sales pipeline if the CRM is on, else still the GST card (it says how to
 *   start).
 * - **Farm home** (farming): today's work first (the calendar), then records
 *   to catch up on and the season's cash, then the farm's records.
 * - **CRM home** (sales): a sales rep starts with their next actions; a
 *   manager, and anyone else who opens the CRM, with the pipeline and
 *   conversion first.
 */
export function defaultTilesFor(page: string, context: HomeContext): string[] {
  if (page === "home") {
    const fourth = context.gstRegistered ? "next_gst_return" : context.hasJobs ? "jobs" : context.crm ? "sales_pipeline" : "next_gst_return";
    return ["cash_in_bank", "owed_to_you", "bills_to_pay", fourth];
  }
  if (page === "farm_home") {
    return ["farm_calendar", "catch_up", "season_cash", "stock", "pasture", "fertiliser", "performance", "money", "notebook"];
  }
  if (page === "crm_home") {
    if (context.role === "sales_rep") return ["next_actions", "my_opportunities", "my_tasks", "pipeline", "conversion", "recent_activities"];
    return ["pipeline", "conversion", "next_actions", "my_opportunities", "my_tasks", "recent_activities"];
  }
  return [];
}

/** How Customise describes where the starting cards came from. */
export function defaultsNote(page: string, context: Pick<HomeContext, "role">): string {
  if (page === "crm_home") {
    return context.role === "sales_rep"
      ? "Sales reps start with their next actions and own opportunities."
      : "Sales managers and everyone else start with the pipeline and conversion.";
  }
  if (page === "farm_home") return "Everyone on a farm starts with today's work, records to catch up on and the season's cash.";
  return "Home starts with cash and money owed both ways, then GST, or your jobs or sales when you're not registered for GST.";
}
