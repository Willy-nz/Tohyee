import { formatDate } from "@/lib/format";
import { addDays, addMonth } from "@/lib/organisations/access-window";

/*
 * "Hire help" (decisions 1475-1480): a job brief for hiring a bookkeeper or
 * other help, written from facts in the books. Only counts and periods go in:
 * never the organisation's name, its customers or suppliers, amounts, or
 * anything else private. The person sees and edits it before copying it.
 * Pure (no database), so the page writes it as choices change.
 */

export const HIRE_TASKS = [
  { key: "bank_reconciliation", label: "Bank reconciliation", help: "Matching bank statement lines to what was spent and received." },
  { key: "gst_return", label: "GST return", help: "Checking the GST return and getting it ready to file." },
  { key: "catch_up", label: "Catch up on past months", help: "Bringing the books up to date." },
  { key: "year_end", label: "Year-end preparation", help: "Getting the year ready for the accountant." },
  { key: "payroll", label: "Payroll", help: "Pay runs, payslips and payday filing." },
  { key: "set_up", label: "Setting up the books", help: "Accounts, bank feeds, GST and other settings." },
] as const;

export type HireTask = (typeof HIRE_TASKS)[number]["key"];

/** Facts from the books, as counts and periods only. */
export type HireFacts = {
  bankAccounts: number;
  unreconciledLines: number;
  /** The first and last month (YYYY-MM) with lines not reconciled, and how many months have some. */
  unreconciledFrom: string | null;
  unreconciledTo: string | null;
  unreconciledMonths: number;
  gstRegistered: boolean;
  /** 1, 2 or 6; null when not set. */
  gstPeriodMonths: number | null;
  gstBasis: "invoice" | "payments" | "hybrid";
  financialYearEndMonth: number;
  /** The modules that are on, by name. */
  modules: string[];
  /** Active employees; null when the person asking can't see payroll. */
  employees: number | null;
};

export const HIRE_ROLES = ["bookkeeper", "viewer", "admin"] as const;
export type HireRole = (typeof HIRE_ROLES)[number];

export const HIRE_LENGTHS = [
  { key: "1_week", label: "1 week" },
  { key: "2_weeks", label: "2 weeks" },
  { key: "1_month", label: "1 month" },
  { key: "3_months", label: "3 months" },
  { key: "custom", label: "Choose an end date" },
] as const;
export type HireLength = (typeof HIRE_LENGTHS)[number]["key"];

export type HireChoices = {
  tasks: HireTask[];
  /** For "Catch up": how many months. */
  catchUpMonths: number;
  role: HireRole;
  /** YYYY-MM-DD. */
  startDate: string;
  length: HireLength;
  /** YYYY-MM-DD, used when length is "custom". */
  untilDate: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthName(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The last day of access (inclusive), from the start and length. */
export function accessUntilFor(startDate: string, length: HireLength, untilDate: string): string {
  if (length === "custom") return untilDate;
  if (length === "1_week") return addDays(startDate, 6);
  if (length === "2_weeks") return addDays(startDate, 13);
  if (length === "1_month") return addDays(addMonth(startDate), -1);
  return addDays(addMonth(addMonth(addMonth(startDate))), -1);
}

export const ROLE_IN_BRIEF: Record<HireRole, string> = {
  viewer: "Read-only access: you can see the books and reports, and can't change anything.",
  bookkeeper: "Bookkeeper access: you can enter and reconcile transactions, and can't change settings or people.",
  admin: "Admin access: you can also change settings, the chart of accounts and tax codes.",
};

const GST_BASIS_TEXT: Record<HireFacts["gstBasis"], string> = {
  invoice: "the invoice basis",
  payments: "the payments basis",
  hybrid: "the hybrid basis",
};

const GST_PERIOD_TEXT: Record<number, string> = { 1: "monthly", 2: "two-monthly", 6: "six-monthly" };

function taskLine(task: HireTask, facts: HireFacts, choices: HireChoices): string {
  switch (task) {
    case "bank_reconciliation":
      if (facts.unreconciledLines === 0) return `Bank reconciliation: keeping ${plural(facts.bankAccounts, "bank or card account")} reconciled.`;
      return [
        `Bank reconciliation: about ${plural(facts.unreconciledLines, "bank statement line")} across ${plural(facts.bankAccounts, "bank or card account")} aren't reconciled yet`,
        facts.unreconciledFrom && facts.unreconciledTo
          ? facts.unreconciledFrom === facts.unreconciledTo
            ? `, all in ${monthName(facts.unreconciledFrom)}.`
            : `, from ${monthName(facts.unreconciledFrom)} to ${monthName(facts.unreconciledTo)} (${plural(facts.unreconciledMonths, "month")} with lines to do).`
          : ".",
      ].join("");
    case "gst_return":
      if (!facts.gstRegistered) return "GST: the organisation isn't registered for GST yet; help deciding and registering.";
    {
      const period = facts.gstPeriodMonths ? GST_PERIOD_TEXT[facts.gstPeriodMonths] : undefined;
      return period
        ? `GST return: GST is filed ${period} on ${GST_BASIS_TEXT[facts.gstBasis]}.`
        : `GST return: on ${GST_BASIS_TEXT[facts.gstBasis]} (how often isn't set in the books yet).`;
    }
    case "catch_up":
      return `Catch-up: bring the books up to date for the last ${plural(Math.max(1, choices.catchUpMonths), "month")}.`;
    case "year_end":
      return `Year-end preparation: the financial year ends on the last day of ${MONTHS[facts.financialYearEndMonth - 1]}.`;
    case "payroll":
      return facts.employees === null ? "Payroll: pay runs and payday filing." : `Payroll: pay runs and payday filing for ${plural(facts.employees, "employee")}.`;
    case "set_up":
      return "Setting up: accounts, bank feeds, GST and other settings.";
  }
}

/** The brief, as plain text. Nothing in it names the organisation or anyone in it, or any amount. */
export function writeBrief(facts: HireFacts, choices: HireChoices): string {
  const tasks = HIRE_TASKS.filter((task) => choices.tasks.includes(task.key)).map((task) => task.key);
  const until = accessUntilFor(choices.startDate, choices.length, choices.untilDate);
  const lines = [
    "Bookkeeping help wanted for a New Zealand organisation",
    "",
    "What needs doing",
    ...(tasks.length ? tasks.map((task) => `- ${taskLine(task, facts, choices)}`) : ["- (Choose what needs doing.)"]),
    "",
    "The books",
    "- Kept in Tohyee, a New Zealand accounting app. You'll get your own login; there's nothing to install.",
    ...(facts.modules.length ? [`- Parts in use: ${facts.modules.join(", ")}.`] : []),
    // Bank reconciliation's line already says how many.
    ...(facts.bankAccounts > 0 && !tasks.includes("bank_reconciliation") ? [`- ${plural(facts.bankAccounts, "bank or card account")}.`] : []),
    "",
    "Access and time",
    `- ${ROLE_IN_BRIEF[choices.role]}`,
    choices.startDate && until
      ? `- From ${formatDate(choices.startDate)} to ${formatDate(until)}. Your access stops by itself at the end, and can be extended.`
      : "- (Choose when it starts and ends.)",
    "",
    "When you apply, please say",
    "- Your experience with New Zealand GST and bookkeeping.",
    "- When you could start, and how many hours you expect it to take.",
  ];
  return lines.join("\n");
}

/** The People and roles invite, filled in (decision 1479). */
export function inviteHref(choices: Pick<HireChoices, "role" | "startDate" | "length" | "untilDate">): string {
  const until = accessUntilFor(choices.startDate, choices.length, choices.untilDate);
  const query = new URLSearchParams({ invite: "1", role: choices.role });
  if (choices.startDate) query.set("from", choices.startDate);
  if (until) query.set("until", until);
  return `/operations/members?${query.toString()}`;
}
