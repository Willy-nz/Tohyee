import type { OrgTx } from "@/lib/db/org-transaction";

/**
 * Which AI tools an organisation's modules offer (#576, decisions 1385-1387).
 *
 * The MCP tool list follows the same module switches as the app's menus
 * (src/components/navigation.ts, src/components/modules.tsx): an
 * organisation that doesn't farm isn't offered farm tools, one without
 * livestock isn't offered livestock tools, and so on. The tool list's
 * version is a hash of the tools offered (decision 1342), so switching a
 * module on or off changes the version and the client is told
 * (notifications/tools/list_changed). Calls to a hidden tool are refused
 * with the reason. This narrows what's offered; it never grants anything
 * (access level and role still decide, decision 346).
 */

/** The module switches the tool list follows, as the menus see them (Settings › Modules). */
export type ToolModules = {
  /** Accounting (MOD2): false only when it's been turned off. */
  accounting: boolean;
  /** Farming (#249): needs Accounting. */
  farming: boolean;
  /** Livestock (#221): part of Accounting. */
  livestock: boolean;
  /** Advanced reporting: tracking categories and custom fields. */
  reporting: boolean;
  /** Not-for-profit: fund tracking. */
  notForProfit: boolean;
  /** Analytics (#591): its own module, apart from Accounting. */
  analytics: boolean;
};

export type ToolGroupKey = "accounting" | "farming" | "livestock" | "tracking" | "analytics";

type ToolGroup = {
  key: ToolGroupKey;
  label: string;
  /** Tool names in this group (accounting is every catalogue tool not in another group or ALWAYS_OFFERED). */
  tools: readonly string[];
  /** Null when the group is on; otherwise why it's hidden, in words for the AI. */
  hiddenBecause(modules: ToolModules): string | null;
};

/** Offered whatever modules are on: the organisation itself, and the AI's own workspace (files, tables, dashboards). */
export const ALWAYS_OFFERED: readonly string[] = [
  "get_organisation",
  "list_ai_uploads",
  "read_ai_upload",
  "list_datasets",
  "query_dataset",
  "list_ai_dashboards",
  "get_ai_dashboard",
  "save_dataset",
  "add_dataset_rows",
  "save_ai_dashboard",
];

const ACCOUNTING_OFF = "Accounting is turned off for this organisation (Settings › Modules).";

/** Farms, paddocks, pasture, soil, fertiliser and the farm notebook: the Farm app's menus (FARM_MENUS, module "farming"). */
export const FARMING_TOOLS: readonly string[] = [
  "farm_notebook",
  "add_farm_note",
  "update_farm_note",
  "list_farms_and_paddocks",
  "farm_benchmarks",
  "list_soil_tests",
  "list_fertiliser_products",
  "list_fertiliser_plans",
  "get_fertiliser_plan",
  "fertiliser_what_if",
  "pasture_cover",
  "list_pasture_readings",
  "list_grazings",
  "list_supplements_fed",
  "list_pasture_photos_awaiting_estimate",
  "get_pasture_photo",
  "propose_pasture_cover_estimate",
];

/** Livestock: the Accounting › Livestock links (module "livestock"). */
export const LIVESTOCK_TOOLS: readonly string[] = [
  "livestock_overview",
  "list_livestock_movements",
  "list_livestock_suggestions",
  "suggest_livestock_movements",
];

/** Tracking categories: Settings › Tracking categories shows with Advanced reporting, which the tracking service itself needs (Not-for-profit's fund tracking does too). */
export const TRACKING_TOOLS: readonly string[] = [
  "list_tracking",
  "create_tracking_category",
  "update_tracking_category",
  "create_tracking_option",
  "update_tracking_option",
];

/** Analytics reports and their tables (#591): the Analytics app (Settings › Modules › Analytics), apart from Accounting. */
export const ANALYTICS_TOOLS: readonly string[] = [
  "list_analytics_tables",
  "run_analytics_query",
  "list_analytics_dashboards",
  "get_analytics_dashboard",
  "create_analytics_dashboard",
  "update_analytics_dashboard",
];

const GROUPS: readonly ToolGroup[] = [
  {
    key: "farming",
    label: "Farming (farms, paddocks, pasture, soil, fertiliser, farm notebook)",
    tools: FARMING_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting ? ACCOUNTING_OFF : modules.farming ? null : "Farming is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "livestock",
    label: "Livestock (stock on hand, movements)",
    tools: LIVESTOCK_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting ? ACCOUNTING_OFF : modules.livestock ? null : "Livestock is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "tracking",
    label: "Tracking categories",
    tools: TRACKING_TOOLS,
    hiddenBecause: (modules) =>
      !modules.accounting
        ? ACCOUNTING_OFF
        : modules.reporting
          ? null
          : "Tracking categories come with Advanced reporting, which is turned off for this organisation (Settings › Modules).",
  },
  {
    key: "analytics",
    label: "Analytics (reports over the books, Shopify, Google, Meta, files and databases)",
    tools: ANALYTICS_TOOLS,
    hiddenBecause: (modules) => (modules.analytics ? null : "Analytics is turned off for this organisation (Settings › Modules)."),
  },
];

const ACCOUNTING_GROUP: ToolGroup = {
  key: "accounting",
  label: "Accounting (invoices, bills, banking, reports, GST, and the rest of the books)",
  tools: [],
  hiddenBecause: (modules) => (modules.accounting ? null : ACCOUNTING_OFF),
};

/** The group a tool belongs to, or null for one that's always offered (and tools that aren't in the catalogue, like private mail). */
export function toolGroupOf(name: string): ToolGroup | null {
  if (ALWAYS_OFFERED.includes(name)) return null;
  return GROUPS.find((group) => group.tools.includes(name)) ?? ACCOUNTING_GROUP;
}

/** Why the organisation's modules hide this tool, or null when they don't. */
export function moduleHidesTool(name: string, modules: ToolModules | null): string | null {
  if (!modules) return null;
  const group = toolGroupOf(name);
  const reason = group?.hiddenBecause(modules) ?? null;
  return reason ? `${name} isn't offered: ${reason}` : null;
}

/** For get_organisation: each tool group, whether it's offered, and why not. */
export type ToolGroupStatus = { group: ToolGroupKey; label: string; offered: boolean; hiddenBecause?: string };

export function toolGroupStatuses(modules: ToolModules | null): ToolGroupStatus[] {
  return [ACCOUNTING_GROUP, ...GROUPS].map((group) => {
    const reason = modules ? group.hiddenBecause(modules) : null;
    return reason ? { group: group.key, label: group.label, offered: false, hiddenBecause: reason } : { group: group.key, label: group.label, offered: true };
  });
}

type ModuleRow = {
  accounting_enabled: boolean;
  farming_enabled: boolean;
  livestock_enabled: boolean;
  advanced_features: boolean;
  not_for_profit_enabled: boolean;
  analytics_enabled: boolean;
};

/** The switches from organisation_settings, as useModules (the menus) reads them: Farming and Livestock need Accounting. */
export function toolModulesFrom(row: ModuleRow): ToolModules {
  const accounting = row.accounting_enabled !== false;
  return {
    accounting,
    farming: accounting && row.farming_enabled === true,
    livestock: accounting && row.livestock_enabled === true,
    reporting: row.advanced_features === true,
    notForProfit: row.not_for_profit_enabled === true,
    analytics: row.analytics_enabled === true,
  };
}

export async function loadToolModules(tx: OrgTx): Promise<ToolModules> {
  const result = await tx.query<ModuleRow>(
    `select accounting_enabled, advanced_features, not_for_profit_enabled, analytics_enabled,
            coalesce((select enabled from livestock_settings where id = true), false) as livestock_enabled,
            coalesce((select enabled from farming_settings where id = true), false) as farming_enabled
       from organisation_settings where id = true`,
  );
  const row = result.rows[0];
  return row
    ? toolModulesFrom(row)
    : { accounting: true, farming: false, livestock: false, reporting: false, notForProfit: false, analytics: false };
}
