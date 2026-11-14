import { ANALYTICS_TOOLS } from "@/lib/ai/tool-modules";

/**
 * Which tools a key or connected app is for (#696, decision 1630). Left
 * out, every tool its level allows, as before. "reports" narrows it to
 * reading the books' reports and building Analytics reports: under 30 tools
 * in place of nearly 300, so the AI has less to wade through and the
 * connection can't reach banking, bills or invoices at all. A scope only
 * ever narrows: the access level, the person's role and the organisation's
 * modules still decide what's allowed inside it.
 *
 * Browser-safe: the AI page and the consent screen offer the same choices.
 */
export const AI_TOOL_SCOPES = ["reports"] as const;
export type AiToolScope = (typeof AI_TOOL_SCOPES)[number];

export function isAiToolScope(value: unknown): value is AiToolScope {
  return typeof value === "string" && (AI_TOOL_SCOPES as readonly string[]).includes(value);
}

export const AI_TOOL_SCOPE_LABELS: Record<AiToolScope | "all", string> = {
  all: "Everything its level allows",
  reports: "Reports only",
};

export const AI_TOOL_SCOPE_HELP: Record<AiToolScope | "all", string> = {
  all: "Every tool for the level you chose: sales, purchases, banking, reports and the rest.",
  reports: "The books' reports and Analytics only. It can't see or touch bank lines, bills, invoices or settings.",
};

/** The accounting reports, what they're made from, and the AI's own tables. */
const REPORT_READING_TOOLS: readonly string[] = [
  "get_organisation",
  "list_accounts",
  "account_transactions",
  "trial_balance",
  "profit_and_loss",
  "balance_sheet",
  "aged_receivables",
  "aged_payables",
  "cash_flow_forecast",
  "list_budgets",
  "get_budget",
  "budget_vs_actual",
  "list_tracking",
  "list_custom_reports",
  "run_custom_report",
  "list_datasets",
  "query_dataset",
  "save_dataset",
  "add_dataset_rows",
];

const SCOPE_TOOLS: Record<AiToolScope, ReadonlySet<string>> = {
  reports: new Set([...REPORT_READING_TOOLS, ...ANALYTICS_TOOLS]),
};

/** The tool names a scope reaches (before level, role and modules). */
export function toolsInScope(scope: AiToolScope): readonly string[] {
  return [...SCOPE_TOOLS[scope]];
}

/** Whether a key or connection with this scope may use the tool; no scope allows everything. */
export function scopeAllows(scope: AiToolScope | null | undefined, toolName: string): boolean {
  return !scope || SCOPE_TOOLS[scope].has(toolName);
}

/** What the AI is told when it calls a tool outside its connection's scope. */
export function outsideScopeMessage(scope: AiToolScope, toolName: string): string {
  return `${toolName} is outside what this connection is for: it was set up as "${AI_TOOL_SCOPE_LABELS[scope]}" (${AI_TOOL_SCOPE_HELP[scope]}) The person can make a key or connect again with "${AI_TOOL_SCOPE_LABELS.all}" on Tohyee's AI page.`;
}
