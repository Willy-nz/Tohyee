/** Commentary on reports (decision 446). Browser-safe. */

export const COMMENTARY_REPORTS = ["cash_flow_forecast", "consolidated_profit_and_loss", "consolidated_balance_sheet"] as const;
export type CommentaryReport = (typeof COMMENTARY_REPORTS)[number];

export type Commentary = {
  id: string;
  report: CommentaryReport;
  /** What it's about, e.g. "Weeks from 5 Oct 2026 to 3 Jan 2027". */
  periodLabel: string;
  body: string;
  /** Suggested by the connected AI and not checked yet, or accepted by a person (or written by one). */
  status: "suggested" | "accepted";
  writtenByEmail: string;
  /** 'AI key "Claude"' for the connected AI; null for a person. */
  writtenVia: string | null;
  acceptedByEmail: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** "Suggested by Jess's AI key Claude, not checked" (the wording in the approved example, 5 Oct 2026). */
export function suggestedByText(name: string, via: string): string {
  return `Suggested by ${name}'s ${via.replace(/"/g, "")}, not checked`;
}
