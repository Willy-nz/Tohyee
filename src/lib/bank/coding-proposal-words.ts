import { add, dec, isNegative, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * Bank coding proposals (#544, decisions 1292-1299): the parts shared by the
 * server, the MCP tools and the review screen. Browser-safe: no server
 * imports, and money is added up with decimal strings, never floats.
 */

/**
 * Where a row is:
 * - proposed: drafted (by an AI or by a person), not reviewed yet;
 * - approved: a person approved it and it's waiting to be posted;
 * - posted: spend or receive money was posted and the line reconciled;
 * - failed: approved, but posting was refused (with why);
 * - rejected: a person turned it down.
 */
export const PROPOSAL_ROW_STATES = ["proposed", "approved", "posted", "failed", "rejected"] as const;
export type ProposalRowState = (typeof PROPOSAL_ROW_STATES)[number];

export const PROPOSAL_STATE_LABELS: Record<ProposalRowState, string> = {
  proposed: "Proposed",
  approved: "Approved, not posted yet",
  posted: "Posted",
  failed: "Failed",
  rejected: "Rejected",
};

export const PROPOSAL_STATE_TONES: Record<ProposalRowState, "neutral" | "blue" | "green" | "red" | "amber"> = {
  proposed: "neutral",
  approved: "blue",
  posted: "green",
  failed: "red",
  rejected: "amber",
};

export const GST_EVIDENCE_LABELS: Record<string, string> = {
  tax_document: "Tax invoice or receipt",
  person_said: "A person said",
  contact_usual: "Contact's usual code",
  no_gst_supply: "No GST (e.g. bank fees, wages)",
};

/** What the person decided, plus the approval action's status: the state shown. Pure. */
export function rowState(status: "proposed" | "rejected" | "approved", actionStatus: string | null): ProposalRowState {
  if (status !== "approved") return status;
  if (actionStatus === "committed") return "posted";
  if (actionStatus === "failed") return "failed";
  return "approved";
}

/** Whether a person can still edit, reject or approve a row in this state. */
export function isOpen(state: ProposalRowState): boolean {
  return state === "proposed" || state === "failed";
}

export type ProblemKind = "stale" | "locked" | "gst";
export type RowProblem = { kind: ProblemKind; text: string };

/** The line as it was when proposed, and as it is now. */
export type LineSnapshot = { status: string; date: string; amount: string; reconciliations: number };

/**
 * Why a row no longer fits its statement line (decision 1295): the line was
 * reconciled, excluded or deleted, its date or amount changed, or it was
 * reconciled and unreconciled since. The row is flagged, never changed to
 * match. Pure.
 */
export function staleReasons(seen: Omit<LineSnapshot, "status">, now: LineSnapshot): string[] {
  const reasons: string[] = [];
  if (now.status !== "unreconciled") reasons.push(`The line is now ${now.status}.`);
  if (now.date !== seen.date) reasons.push("The line's date has changed.");
  if (toFixedString(dec(now.amount), 2) !== toFixedString(dec(seen.amount), 2)) reasons.push("The line's amount has changed.");
  if (now.status === "unreconciled" && now.reconciliations !== seen.reconciliations) {
    reasons.push("The line was reconciled and unreconciled since this was proposed.");
  }
  return reasons;
}

/**
 * Whether the GST treatment can be approved (decision 1296, from #546's
 * GSR10): `status` is the organisation's GST status on the line's date,
 * `category` the tax code's (null: no GST). Pure.
 */
export function gstProblem(
  status: "registered" | "not_registered" | "unconfirmed",
  evidence: string | null,
  category: string | null,
): string | null {
  const withGst = category !== null && category !== "out_of_scope";
  if (status === "not_registered") return withGst ? "Not registered for GST on this date. Choose no GST." : null;
  if (status === "unconfirmed") return withGst ? "GST registration isn't confirmed. Confirm it in Settings, or choose no GST." : null;
  if (evidence === null) return "Nothing supports the GST. Check the tax code, then save the row.";
  if (evidence === "no_gst_supply" && withGst) return "Says no GST, but has a GST code. Check the tax code, then save the row.";
  return null;
}

type TotalsRow = {
  state: ProposalRowState;
  /** Signed: money out is negative. */
  lineAmount: string;
  accountCode: string;
  accountName: string | null;
  taxCode: string | null;
  taxLabel: string | null;
};

export type TotalLine = { key: string; label: string; rows: number; moneyIn: string; moneyOut: string };
export type ProposalTotals = { byAccount: TotalLine[]; byTax: TotalLine[]; rows: number; moneyIn: string; moneyOut: string };

/**
 * Totals by account and by tax code (decision 1294), over the rows that
 * aren't rejected. Money in and money out are kept apart, both shown
 * without a sign. Pure.
 */
export function proposalTotals(rows: readonly TotalsRow[]): ProposalTotals {
  type Acc = { label: string; rows: number; moneyIn: ReturnType<typeof dec>; moneyOut: ReturnType<typeof dec> };
  const byAccount = new Map<string, Acc>();
  const byTax = new Map<string, Acc>();
  let moneyIn = ZERO_DECIMAL;
  let moneyOut = ZERO_DECIMAL;
  let count = 0;
  const bump = (map: Map<string, Acc>, key: string, label: string, amount: ReturnType<typeof dec>, out: boolean) => {
    const entry = map.get(key) ?? { label, rows: 0, moneyIn: ZERO_DECIMAL, moneyOut: ZERO_DECIMAL };
    entry.rows += 1;
    if (out) entry.moneyOut = add(entry.moneyOut, amount);
    else entry.moneyIn = add(entry.moneyIn, amount);
    map.set(key, entry);
  };
  for (const row of rows) {
    if (row.state === "rejected") continue;
    const signed = dec(row.lineAmount);
    const out = isNegative(signed);
    const amount = dec(row.lineAmount.replace(/^-/, ""));
    count += 1;
    if (out) moneyOut = add(moneyOut, amount);
    else moneyIn = add(moneyIn, amount);
    bump(byAccount, row.accountCode, row.accountName ? `${row.accountCode} ${row.accountName}` : row.accountCode, amount, out);
    bump(byTax, row.taxCode ?? "", row.taxCode ? (row.taxLabel ? `${row.taxCode} ${row.taxLabel}` : row.taxCode) : "No GST", amount, out);
  }
  const list = (map: Map<string, Acc>): TotalLine[] =>
    [...map.entries()]
      .sort(([left], [right]) => (left === right ? 0 : left === "" ? 1 : right === "" ? -1 : left < right ? -1 : 1))
      .map(([key, entry]) => ({ key, label: entry.label, rows: entry.rows, moneyIn: toFixedString(entry.moneyIn, 2), moneyOut: toFixedString(entry.moneyOut, 2) }));
  return { byAccount: list(byAccount), byTax: list(byTax), rows: count, moneyIn: toFixedString(moneyIn, 2), moneyOut: toFixedString(moneyOut, 2) };
}

/** The review filter (decision 1297): a state, or "attention" for open rows with a problem. */
export const PROPOSAL_FILTERS = ["all", "attention", ...PROPOSAL_ROW_STATES] as const;
export type ProposalFilter = (typeof PROPOSAL_FILTERS)[number];

export const PROPOSAL_FILTER_LABELS: Record<ProposalFilter, string> = {
  all: "All",
  attention: "Needs a look",
  ...PROPOSAL_STATE_LABELS,
  approved: "Approved",
};

export function matchesFilter(row: { state: ProposalRowState; problems: readonly RowProblem[] }, filter: ProposalFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return isOpen(row.state) && row.problems.length > 0;
  return row.state === filter;
}

type CsvRow = {
  id: string;
  lineId: string;
  line: { date: string; description: string; amount: string };
  state: ProposalRowState;
  contactName: string | null;
  accountCode: string;
  taxCode: string | null;
  description: string;
  confidence: string | null;
  gstEvidence: string | null;
  rationale: string | null;
  evidence: string | null;
  problems: readonly RowProblem[];
  error: string | null;
};

function csvCell(value: string | null): string {
  const text = value ?? "";
  // A leading = + - @ would run as a formula in a spreadsheet: quote it as text.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as a CSV file for review outside Tohyee (decision 1297). Pure. */
export function proposalCsv(rows: readonly CsvRow[]): string {
  const header = ["Row", "Line", "Date", "Bank description", "Amount", "State", "Contact", "Account", "Tax code", "Description", "Confidence", "GST evidence", "Why", "Evidence", "Problems"];
  const lines = rows.map((row) =>
    [
      row.id,
      row.lineId,
      row.line.date,
      row.line.description,
      row.line.amount,
      PROPOSAL_STATE_LABELS[row.state],
      row.contactName,
      row.accountCode,
      row.taxCode ?? "No GST",
      row.description,
      row.confidence,
      row.gstEvidence ? (GST_EVIDENCE_LABELS[row.gstEvidence] ?? row.gstEvidence) : null,
      row.rationale,
      row.evidence,
      [...row.problems.map((problem) => problem.text), ...(row.error ? [row.error] : [])].join(" ") || null,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

/** "12 proposed, 3 posted, 1 failed" (only the parts that aren't zero). */
export function proposalCountsText(counts: Partial<Record<ProposalRowState, number>>): string {
  const parts = PROPOSAL_ROW_STATES.filter((state) => counts[state]).map((state) => `${counts[state]} ${state === "approved" ? "waiting to post" : state}`);
  return parts.length ? parts.join(", ") : "No rows";
}

/** A confidence of 0-1 as a percentage, e.g. "0.85" → "85%". */
export function confidenceText(confidence: string | null): string {
  if (confidence === null) return "—";
  const [whole, fraction = ""] = confidence.split(".");
  const hundredths = `${fraction}00`.slice(0, 2);
  const percent = Number.parseInt(`${whole}${hundredths}`, 10);
  return `${percent}%`;
}
