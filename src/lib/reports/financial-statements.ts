import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { getLivestockSettings } from "@/lib/livestock/movements";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { type Column, CONTENT_WIDTH, PdfWriter } from "@/lib/pdf/writer";
import { balanceSheet, financialYearEndMonth, profitAndLoss } from "@/lib/reports/financial";
import { getPerformanceSettings } from "@/lib/reports/performance-report";
import type { ComputedRow, CustomReportFigures, FinancialReportBase } from "@/lib/reports/custom-layout";
import type { CashFlowFigures } from "@/lib/reports/cash-flow-layout";
import { CASH_FLOW_END_LABELS, EQUITY_END_LABELS } from "@/lib/reports/custom-layout";
import type { EquityFigures } from "@/lib/reports/equity-layout";
import { type LayoutBase, runDefaultCashFlowLayout, runDefaultEquityLayout, runDefaultLayout } from "@/lib/reports/report-layouts";
import { cashFlowStatement, changesInEquity, type StatementRow } from "@/lib/reports/statements";
import { statementAmount, statementValue } from "@/lib/reports/statement-format";
import { requireArray, requireString } from "@/lib/validation";

export { statementAmount, statementValue };

/*
 * Year-end financial statements (#259; examples FS1-FS3, decision 532): one
 * PDF with a cover and contents, the statement of financial performance and
 * the statement of financial position (each with last year beside it), the
 * statement of changes in equity, the statement of cash flows, and notes.
 * The figures come from the same functions as the report screens. The notes
 * are the organisation's own, edited in Tohyee. Until they're saved, drafts
 * are offered, and the PDF marks them as drafts to be checked. These are
 * special purpose statements; Tier 3 and Tier 4 (public benefit entity)
 * formats aren't built.
 */

export type StatementNote = { title: string; body: string };
export type StatementNotes = { saved: boolean; notes: StatementNote[] };

/** Draft notes for a special purpose report (FS2): placeholders in [square brackets] are for the preparer to fill in or confirm. */
export async function draftNotes(tx: OrgTx): Promise<StatementNote[]> {
  const format = (await getPerformanceSettings(tx)).format;
  if (format !== "special_purpose") return performanceDraftNotes(tx, format);
  const organisation = await getOrganisationSettings(tx);
  const livestock = await getLivestockSettings(tx).catch(() => null);
  const stock = await tx.query("select 1 from inventory_item_balances where on_hand_quantity <> 0 limit 1").catch(() => ({ rowCount: 0 }));
  const assets = await tx.query("select 1 from accounts where account_type = 'fixed_asset' and is_active limit 1");
  const notes: StatementNote[] = [
    {
      title: "Reporting entity",
      body: `${organisation.displayName} is [describe the entity: for example a company registered under the Companies Act 1993, a partnership, a trust or a sole trader]. Its main activity is [describe it].`,
    },
    {
      title: "Basis of preparation",
      body:
        "These are special purpose financial statements, prepared for the owners and for income tax purposes. They aren't general purpose financial statements. " +
        "[Name the framework they follow: for example the Special Purpose Financial Reporting Framework for use by For-Profit Entities, issued by Chartered Accountants Australia and New Zealand. A company also meets the minimum requirements of the Tax Administration (Financial Statements—Domestic Companies) Order 2014.] " +
        `Amounts are in ${tx.baseCurrency} on the historical cost basis, except where a note says otherwise.`,
    },
    {
      title: "Changes in accounting policies",
      body: "There have been no changes in accounting policies this year. [Edit this if there have been.]",
    },
    {
      title: "Goods and services tax (GST)",
      body: organisation.gstRegistered
        ? "Amounts are shown excluding GST, except accounts receivable and accounts payable, which include GST."
        : "The entity isn't registered for GST, so amounts include any GST charged to it.",
    },
  ];
  if ((stock.rowCount ?? 0) > 0) {
    notes.push({ title: "Inventory", body: "Stock is valued at cost, using weighted average cost. [Confirm that no stock is worth less than its cost; if some is, say how it was written down.]" });
  }
  if (assets.rowCount !== 0) {
    notes.push({
      title: "Property, plant and equipment",
      body: "Fixed assets are shown at cost less accumulated depreciation. Depreciation is charged at the rates and methods allowed by Inland Revenue. [Check this matches the fixed asset register.]",
    });
  }
  if (livestock?.enabled) {
    notes.push({
      title: "Livestock",
      body:
        "Livestock is valued at the end of each year under the valuation methods elected with Inland Revenue, as shown in the livestock valuation. [Name the methods used for each type of stock.] " +
        (livestock.revaluationTarget === "reserve"
          ? "The herd scheme revaluation of opening stock is taken to the herd scheme revaluation reserve in equity. "
          : "The herd scheme revaluation of opening stock is shown in profit and loss as a separate, non-taxable item. ") +
        (livestock.currentClasses.length > 0
          ? "Livestock held for sale in the normal operating cycle is a current asset; breeding and other stock kept is non-current."
          : "All livestock is shown as a non-current asset."),
    });
  }
  notes.push({
    title: "Income tax",
    body: "[Say how income tax is accounted for: for example, income tax expense is the tax payable on the year's taxable income.]",
  });
  return notes;
}

/** Draft notes for a Tier 3 or Tier 4 performance report (NPR, decision 536). */
async function performanceDraftNotes(tx: OrgTx, format: "tier3" | "tier4"): Promise<StatementNote[]> {
  const organisation = await getOrganisationSettings(tx);
  const name = organisation.displayName;
  const gst: StatementNote = {
    title: "Goods and services tax (GST)",
    body: organisation.gstRegistered
      ? format === "tier4"
        ? "The entity is registered for GST. Cash received and paid is shown excluding GST, and the GST paid or refunded is shown on its own line."
        : "The entity is registered for GST. Amounts are shown excluding GST, except debtors and creditors, which include GST."
      : "The entity isn't registered for GST, so amounts include any GST charged to it.",
  };
  if (format === "tier4") {
    return [
      {
        title: "Basis of preparation",
        body: `${name} is permitted to apply the Tier 4 (NFP) Standard because it doesn't have public accountability and its annual operating payments are under the Tier 4 threshold. [Confirm this.] The performance report is prepared on the cash basis: cash received and paid is recorded when it moves in or out of the entity's bank accounts.`,
      },
      gst,
      { title: "Related party transactions", body: "[Describe any transactions with people or organisations related to the entity, or say there were none.]" },
      { title: "Correction of errors", body: "There were no corrections of errors this year. [Edit this if there were.]" },
    ];
  }
  const assets = await tx.query("select 1 from accounts where account_type = 'fixed_asset' and is_active limit 1");
  const notes: StatementNote[] = [
    {
      title: "Basis of preparation",
      body: `${name} has elected to apply the Tier 3 (NFP) Standard because it doesn't have public accountability and its total expenses are under the Tier 3 threshold. [Confirm this.] All transactions are reported on the accrual basis, on the assumption that the entity will continue to operate for the foreseeable future.`,
    },
    gst,
    {
      title: "Revenue",
      body: "[Say how donations, grants and fees are recognised: for example, grants are recognised as revenue when received, unless there is a documented expectation that unspent funds must be used in a particular way or returned, in which case they are deferred.]",
    },
  ];
  if (assets.rowCount !== 0) {
    notes.push({ title: "Property, plant and equipment", body: "Property, plant and equipment is shown at cost less accumulated depreciation. [Give the depreciation methods and rates, and any revaluations.]" });
  }
  notes.push(
    { title: "Income tax", body: `${name} is [wholly exempt from New Zealand income tax as a registered charity]. [Edit this if it isn't.]` },
    { title: "Related party transactions", body: "[Describe any transactions with people or organisations related to the entity, or say there were none.]" },
    { title: "Events after the balance date", body: "There were no events after the balance date that affect this report. [Edit this if there were.]" },
  );
  return notes;
}

export async function getStatementNotes(tx: OrgTx): Promise<StatementNotes> {
  const rows = await tx.query<StatementNote>("select title, body from financial_statement_notes order by position");
  if (rows.rows.length > 0) return { saved: true, notes: rows.rows };
  return { saved: false, notes: await draftNotes(tx) };
}

/** Saves the organisation's notes, replacing any saved before (FS2). An empty list goes back to the drafts. */
export async function saveStatementNotes(tx: OrgTx, input: { notes: unknown }): Promise<StatementNotes> {
  const notes = requireArray(input.notes, "notes", 100).map((raw, index): StatementNote => {
    const note = (raw ?? {}) as Record<string, unknown>;
    return {
      title: requireString(note.title, `Note ${index + 1}'s title`, { maxLength: 150 }),
      body: requireString(note.body, `Note ${index + 1}'s text`, { maxLength: 10000 }),
    };
  });
  await tx.query("delete from financial_statement_notes");
  for (const [index, note] of notes.entries()) {
    await tx.query("insert into financial_statement_notes (position, title, body, updated_by_email) values ($1, $2, $3, $4)", [index + 1, note.title, note.body, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "reports.statement_notes_saved", entityType: "organisation", entityId: tx.organisationId, details: { count: notes.length } });
  return getStatementNotes(tx);
}

/** A line of a statement: a heading ("section"), an amount, or a total. Amounts are decimal strings; null shows nothing. */
export type StatementLine = {
  key: string;
  label: string;
  current: string | null;
  prior: string | null;
  kind?: "section" | "total" | "subtotal";
  /** From a layout row: "percent" shows with a %, "number" plain; money otherwise. */
  format?: "money" | "percent" | "number";
  /** From a layout row's note. */
  note?: string;
  /** The accounts that make up the amounts, for clicking through to their transactions (decision 1575). */
  accountIds?: string[];
};
type Line = StatementLine;

export type FinancialStatement = {
  key: "performance" | "position" | "equity" | "cash_flows";
  title: string;
  subtitle: string;
  /** The standard report its layout comes from, for Edit layout (decisions 1560, CFL5); null for the fixed statement. */
  base: LayoutBase | null;
  /** The default layout it follows, or null for the standard lines. */
  layout: { reportId: string; title: string } | null;
  lines: StatementLine[];
  /** A layout's text blocks, printed after the table. */
  paragraphs: string[];
  /** The dates each column's amounts cover, for clicking through; null where lines aren't accounts' (decision 1575). */
  drill: { current: { from: string; to: string }; prior: { from: string; to: string } } | null;
};

/** The year's financial statements, for the screen and the PDF alike (FS4, decision 1559). */
export type FinancialStatements = {
  name: string;
  heading: string;
  yearEnd: string;
  period: string;
  columns: { current: string; prior: string };
  currencyCode: string;
  preparedOn: string;
  statements: FinancialStatement[];
  notes: StatementNotes;
};

function nzLong(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

/** Lines from two years' account lines, matched by account (FS1): an account in only one year shows "-" in the other. */
type MergeRow = { code: string | null; label: string; amount: string; accountId?: string };
const ids = (row: MergeRow) => (row.accountId ? { accountIds: [row.accountId] } : {});
function merge(current: MergeRow[], prior: MergeRow[]): Line[] {
  const lines = new Map<string, Line>();
  for (const row of current) lines.set(row.code ?? row.label, { key: row.code ?? row.label, label: row.label, current: row.amount, prior: null, ...ids(row) });
  for (const row of prior) {
    const key = row.code ?? row.label;
    const existing = lines.get(key);
    if (existing) existing.prior = row.amount;
    else lines.set(key, { key, label: row.label, current: null, prior: row.amount, ...ids(row) });
  }
  return [...lines.values()];
}

const accountLines = (sections: Array<{ lines: Array<{ accountId: string; code: string; name: string; amount: string }> }>) =>
  sections.flatMap((section) => section.lines.map((line) => ({ code: line.code, label: line.name, amount: line.amount, accountId: line.accountId })));
const rowLines = (rows: StatementRow[]) => rows.map((row) => ({ code: row.code, label: row.label, amount: row.amount }));

/**
 * A default layout's figures as statement lines (FS5): headings, groups
 * (with their accounts and a total, or one line), formulas as totals, the
 * earnings rows as lines; hidden rows left out; text blocks as paragraphs.
 */
function layoutLines(figures: CustomReportFigures, yearEnd: string, priorEnd: string): { lines: Line[]; paragraphs: string[] } {
  const current = figures.columns.find((column) => column.to === yearEnd)?.key;
  const prior = figures.columns.find((column) => column.to === priorEnd)?.key;
  const value = (values: Record<string, string | null>, key: string | undefined) => (key ? (values[key] ?? null) : null);
  const lines: Line[] = [];
  const paragraphs: string[] = [];
  const groupIds = (row: ComputedRow) => (row.accountIds && row.accountIds.length > 0 ? { accountIds: row.accountIds } : {});
  const extras = (row: ComputedRow) => ({
    ...(row.format && row.format !== "money" ? { format: row.format } : {}),
    ...(row.note ? { note: row.note } : {}),
  });
  for (const block of figures.blocks) {
    if (block.kind === "text") {
      paragraphs.push(block.text);
      continue;
    }
    if (block.title)
      lines.push({
        key: `b:${block.id}`,
        label: block.title,
        current: null,
        prior: null,
        kind: "section",
      });
    for (const row of block.rows) {
      if (row.hidden) continue;
      if (row.kind === "heading")
        lines.push({
          key: row.id,
          label: row.label,
          current: null,
          prior: null,
          kind: "section",
        });
      else if (row.kind === "group" && row.showAccounts) {
        lines.push({
          key: `h:${row.id}`,
          label: row.label,
          current: null,
          prior: null,
          kind: "section",
        });
        for (const account of row.lines)
          lines.push({
            key: `${row.id}:${account.code}`,
            label: account.name,
            current: value(account.values, current),
            prior: value(account.values, prior),
            ...(account.accountId ? { accountIds: [account.accountId] } : {}),
          });
        lines.push({
          key: row.id,
          label: `Total ${row.label}`,
          current: value(row.values, current),
          prior: value(row.values, prior),
          kind: "subtotal",
          ...extras(row),
          ...groupIds(row),
        });
      } else if (row.kind === "formula")
        lines.push({
          key: row.id,
          label: row.label,
          current: value(row.values, current),
          prior: value(row.values, prior),
          kind: "total",
          ...extras(row),
        });
      else
        lines.push({
          key: row.id,
          label: row.label,
          current: value(row.values, current),
          prior: value(row.values, prior),
          ...extras(row),
          ...(row.kind === "group" ? groupIds(row) : {}),
        });
    }
  }
  return { lines, paragraphs };
}

/** A default cash flows layout as statement lines (CFL5): each section, its rows and total, then the last lines. */
function cashFlowLines(figures: CashFlowFigures, yearEnd: string, priorEnd: string): { lines: Line[]; paragraphs: string[] } {
  const current = figures.columns.find((column) => column.to === yearEnd)?.key;
  const prior = figures.columns.find((column) => column.to === priorEnd)?.key;
  const value = (values: Record<string, string | null>, key: string | undefined) => (key ? (values[key] ?? null) : null);
  const lines: Line[] = [];
  const paragraphs: string[] = [];
  for (const block of figures.blocks) {
    if (block.kind === "text") {
      paragraphs.push(block.text);
      continue;
    }
    lines.push({ key: `s:${block.id}`, label: block.title, current: null, prior: null, kind: "section" });
    for (const row of block.rows) {
      if (row.hidden) continue;
      const note = row.note ? { note: row.note } : {};
      if (row.kind === "heading") lines.push({ key: row.id, label: row.label, current: null, prior: null, kind: "section", ...note });
      else if (row.showLines) {
        lines.push({ key: `h:${row.id}`, label: row.label, current: null, prior: null, kind: "section" });
        for (const line of row.lines) lines.push({ key: `${row.id}:${line.ref}`, label: line.label, current: value(line.values, current), prior: value(line.values, prior) });
        lines.push({ key: row.id, label: `Total ${row.label}`, current: value(row.values, current), prior: value(row.values, prior), kind: "subtotal", ...note });
      } else lines.push({ key: row.id, label: row.label, current: value(row.values, current), prior: value(row.values, prior), ...note });
    }
    lines.push({ key: `t:${block.id}`, label: block.total.label, current: value(block.total.values, current), prior: value(block.total.values, prior), kind: "subtotal" });
  }
  for (const end of figures.end) {
    // The standard names say "year" here, as the statements cover one.
    const label = end.label === CASH_FLOW_END_LABELS[end.key] ? end.label.replace(/of the period$/, "of the year") : end.label;
    lines.push({ key: `e:${end.key}`, label, current: value(end.values, current), prior: value(end.values, prior), ...(end.key === "netChange" ? { kind: "subtotal" as const } : end.key === "closingCash" ? { kind: "total" as const } : {}) });
  }
  return { lines, paragraphs };
}

/** A default changes in equity layout as statement lines (CEL5): equity at the start, the rows, then equity at the end. */
function equityLines(figures: EquityFigures, yearEnd: string, priorEnd: string): { lines: Line[]; paragraphs: string[] } {
  const current = figures.columns.find((column) => column.to === yearEnd)?.key;
  const prior = figures.columns.find((column) => column.to === priorEnd)?.key;
  const value = (values: Record<string, string | null>, key: string | undefined) => (key ? (values[key] ?? null) : null);
  // The standard names say "year" here, as the statements cover one.
  const yearly = (label: string, standard: string) => (label === standard ? label.replace(/of the period$/, "of the year") : label);
  const lines: Line[] = [
    { key: "e:opening", label: yearly(figures.opening.label, EQUITY_END_LABELS.opening), current: value(figures.opening.values, current), prior: value(figures.opening.values, prior), kind: "subtotal" },
  ];
  const paragraphs: string[] = [];
  for (const row of figures.blocks) {
    if (row.kind === "text") {
      paragraphs.push(row.text);
      continue;
    }
    if (row.hidden) continue;
    const note = row.note ? { note: row.note } : {};
    if (row.kind === "heading") lines.push({ key: row.id, label: row.label, current: null, prior: null, kind: "section", ...note });
    else if (row.showLines) {
      lines.push({ key: `h:${row.id}`, label: row.label, current: null, prior: null, kind: "section" });
      for (const line of row.lines) lines.push({ key: `${row.id}:${line.ref}`, label: line.label, current: value(line.values, current), prior: value(line.values, prior) });
      lines.push({ key: row.id, label: `Total ${row.label}`, current: value(row.values, current), prior: value(row.values, prior), kind: "subtotal", ...note });
    } else lines.push({ key: row.id, label: row.label, current: value(row.values, current), prior: value(row.values, prior), ...note });
  }
  lines.push({ key: "e:closing", label: yearly(figures.closing.label, EQUITY_END_LABELS.closing), current: value(figures.closing.values, current), prior: value(figures.closing.values, prior), kind: "total" });
  return { lines, paragraphs };
}

/** The year's statements (FS1, FS4-FS7): the standard lines, or the default layouts for financial performance and position (decision 1560). */
export async function buildFinancialStatements(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<FinancialStatements> {
  const yearEndMonth = await financialYearEndMonth(tx);
  const yearEnd = parseIsoDate(input.yearEnd, "The year end");
  if (financialYearEnd(yearEnd, yearEndMonth) !== yearEnd) throw new ValidationError("That isn't a financial year end.");
  const yearStart = financialYearStart(yearEnd, yearEndMonth);
  const priorEnd = addDays(yearStart, -1);
  const priorStart = financialYearStart(priorEnd, yearEndMonth);
  const organisation = await getOrganisationSettings(tx);
  const period = `For the year ended ${nzLong(yearEnd)}`;

  const pl = await profitAndLoss(tx, { from: yearStart, to: yearEnd });
  const plPrior = await profitAndLoss(tx, { from: priorStart, to: priorEnd });
  const bs = await balanceSheet(tx, { asAt: yearEnd });
  const bsPrior = await balanceSheet(tx, { asAt: priorEnd });
  const sce = await changesInEquity(tx, { from: yearStart, to: yearEnd });
  const scePrior = await changesInEquity(tx, {
    from: priorStart,
    to: priorEnd,
  });
  const cf = await cashFlowStatement(tx, { from: yearStart, to: yearEnd });
  const cfPrior = await cashFlowStatement(tx, {
    from: priorStart,
    to: priorEnd,
  });
  const notes = await getStatementNotes(tx);
  // This year and last year in each default layout.
  const layout = (base: FinancialReportBase) =>
    runDefaultLayout(
      tx,
      base === "profit_and_loss"
        ? {
            base,
            from: yearStart,
            to: yearEnd,
            compare: 1,
            compareBy: "year",
            order: "newest_first",
          }
        : {
            base,
            asAt: yearEnd,
            compare: 1,
            compareBy: "year",
            order: "newest_first",
          },
    );
  const plLayout = await layout("profit_and_loss");
  const bsLayout = await layout("balance_sheet");
  const ceLayout = await runDefaultEquityLayout(tx, { from: yearStart, to: yearEnd, compare: 1, compareBy: "year", order: "newest_first" });
  const cfLayout = await runDefaultCashFlowLayout(tx, { from: yearStart, to: yearEnd, compare: 1, compareBy: "year", order: "newest_first" });

  const heading = (label: string): Line => ({
    key: `h:${label}`,
    label,
    current: null,
    prior: null,
    kind: "section",
  });
  const total = (label: string, current: string | null, prior: string | null, kind: Line["kind"] = "total"): Line => ({
    key: `t:${label}`,
    label,
    current,
    prior,
    kind,
  });
  // A heading only when either year has lines under it.
  const section = (label: string, lines: Line[]): Line[] => (lines.length === 0 ? [] : [heading(label), ...lines]);
  // Each year's dates, as the layouts' own click-through uses (decision 1575).
  const drill = { current: { from: yearStart, to: yearEnd }, prior: { from: priorStart, to: priorEnd } };
  const fromLayout = (
    run: Awaited<ReturnType<typeof layout>>,
    base: FinancialReportBase,
    key: FinancialStatement["key"],
    title: string,
    subtitle: string,
    standard: () => Line[],
  ): FinancialStatement => {
    if (!run)
      return {
        key,
        title,
        subtitle,
        base,
        layout: null,
        lines: standard(),
        paragraphs: [],
        drill,
      };
    return {
      key,
      title,
      subtitle,
      base,
      layout: { reportId: run.report.id, title: run.report.title },
      ...layoutLines(run.figures, yearEnd, priorEnd),
      drill,
    };
  };

  const performance = fromLayout(plLayout, "profit_and_loss", "performance", "Statement of financial performance", period, () => [
    heading("Revenue"),
    ...merge(accountLines(pl.revenue.sections), accountLines(plPrior.revenue.sections)),
    total("Total revenue", pl.revenue.total, plPrior.revenue.total, "subtotal"),
    ...section("Cost of sales", merge(accountLines(pl.costOfSales.sections), accountLines(plPrior.costOfSales.sections))),
    total("Gross profit", pl.grossProfit, plPrior.grossProfit, "subtotal"),
    ...section("Other income", merge(accountLines(pl.otherIncome.sections), accountLines(plPrior.otherIncome.sections))),
    heading("Expenses"),
    ...merge(accountLines(pl.expenses.sections), accountLines(plPrior.expenses.sections)),
    total("Total expenses", pl.expenses.total, plPrior.expenses.total, "subtotal"),
    total("Net profit", pl.netProfit, plPrior.netProfit),
  ]);

  const term = (label: string, part: "current" | "nonCurrent", group: "assets" | "liabilities") => {
    const lines = merge(accountLines(bs[group][part].sections), accountLines(bsPrior[group][part].sections));
    return lines.length === 0
      ? []
      : [heading(label), ...lines, total(`Total ${label.toLowerCase()}`, bs[group][part].total, bsPrior[group][part].total, "subtotal")];
  };
  const position = fromLayout(bsLayout, "balance_sheet", "position", "Statement of financial position", `As at ${nzLong(yearEnd)}`, () => [
    ...term("Current assets", "current", "assets"),
    ...term("Non-current assets", "nonCurrent", "assets"),
    total("Total assets", bs.assets.total, bsPrior.assets.total),
    ...term("Current liabilities", "current", "liabilities"),
    ...term("Non-current liabilities", "nonCurrent", "liabilities"),
    total("Total liabilities", bs.liabilities.total, bsPrior.liabilities.total),
    total("Net assets", bs.netAssets, bsPrior.netAssets),
    heading("Equity"),
    ...merge(accountLines(bs.equity.sections), accountLines(bsPrior.equity.sections)),
    {
      key: "re",
      label: "Retained earnings",
      current: bs.equity.retainedEarnings.total,
      prior: bsPrior.equity.retainedEarnings.total,
    },
    {
      key: "cye",
      label: "Current year earnings",
      current: bs.equity.currentYearEarnings,
      prior: bsPrior.equity.currentYearEarnings,
    },
    total("Total equity", bs.equity.total, bsPrior.equity.total),
  ]);

  const equityStandard: FinancialStatement = {
    key: "equity",
    title: "Statement of changes in equity",
    subtitle: period,
    base: "changes_in_equity",
    layout: null,
    paragraphs: [],
    drill: null,
    lines: [
      total("Equity at the start of the year", sce.openingEquity, scePrior.openingEquity, "subtotal"),
      {
        key: "profit",
        label: "Net profit for the year",
        current: sce.profit,
        prior: scePrior.profit,
      },
      ...merge(rowLines(sce.movements), rowLines(scePrior.movements)),
      total("Equity at the end of the year", sce.closingEquity, scePrior.closingEquity),
    ],
  };

  // The default changes in equity layout, when there's one (CEL5).
  const equity: FinancialStatement = ceLayout
    ? { ...equityStandard, layout: { reportId: ceLayout.report.id, title: ceLayout.report.title }, ...equityLines(ceLayout.figures, yearEnd, priorEnd) }
    : equityStandard;

  const proceeds = (value: string) =>
    /^-?0(\.0+)?$/.test(value)
      ? []
      : [
          {
            code: null,
            label: "Proceeds from disposals of fixed assets",
            amount: value,
          },
        ];
  const cashFlowsStandard: FinancialStatement = {
    key: "cash_flows",
    title: "Statement of cash flows",
    subtitle: period,
    base: "cash_flows",
    layout: null,
    paragraphs: [],
    drill: null,
    lines: [
      heading("Operating activities"),
      {
        key: "np",
        label: "Net profit",
        current: cf.operating.profit,
        prior: cfPrior.operating.profit,
      },
      ...merge(rowLines(cf.operating.adjustments), rowLines(cfPrior.operating.adjustments)),
      ...merge(rowLines(cf.operating.workingCapital), rowLines(cfPrior.operating.workingCapital)),
      total("Net cash from operating activities", cf.operating.total, cfPrior.operating.total, "subtotal"),
      heading("Investing activities"),
      ...merge(
        [...rowLines(cf.investing.lines), ...proceeds(cf.investing.disposalProceeds)],
        [...rowLines(cfPrior.investing.lines), ...proceeds(cfPrior.investing.disposalProceeds)],
      ),
      total("Net cash from investing activities", cf.investing.total, cfPrior.investing.total, "subtotal"),
      heading("Financing activities"),
      ...merge(rowLines(cf.financing.lines), rowLines(cfPrior.financing.lines)),
      total("Net cash from financing activities", cf.financing.total, cfPrior.financing.total, "subtotal"),
      total("Net increase (decrease) in cash", cf.netChange, cfPrior.netChange, "subtotal"),
      ...(/^-?0(\.0+)?$/.test(cf.exchangeOnCash) && /^-?0(\.0+)?$/.test(cfPrior.exchangeOnCash)
        ? []
        : [
            {
              key: "fx",
              label: "Effect of exchange rates on cash",
              current: cf.exchangeOnCash,
              prior: cfPrior.exchangeOnCash,
            },
          ]),
      {
        key: "open",
        label: "Cash at the start of the year",
        current: cf.openingCash,
        prior: cfPrior.openingCash,
      },
      total("Cash at the end of the year", cf.closingCash, cfPrior.closingCash),
    ],
  };

  // The default cash flows layout, when there's one (CFL5).
  const cashFlows: FinancialStatement = cfLayout
    ? { ...cashFlowsStandard, layout: { reportId: cfLayout.report.id, title: cfLayout.report.title }, ...cashFlowLines(cfLayout.figures, yearEnd, priorEnd) }
    : cashFlowsStandard;

  return {
    name: organisation.displayName,
    heading: "Special purpose financial statements",
    yearEnd,
    period,
    columns: { current: yearEnd.slice(0, 4), prior: priorEnd.slice(0, 4) },
    currencyCode: tx.baseCurrency,
    preparedOn: now.toISOString().slice(0, 10),
    statements: [performance, position, equity, cashFlows],
    notes,
  };
}

export type FinancialStatementsPdf = { fileName: string; bytes: Uint8Array };

/** The year's financial statements as one PDF (FS1-FS3), made from what the report shows (FS4). */
export async function financialStatementsPdf(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<FinancialStatementsPdf> {
  const report = await buildFinancialStatements(tx, input, now);
  const { name, notes } = report;
  const yearEnd = report.yearEnd;

  const writer = await PdfWriter.create({
    title: `${name} financial statements for the year ended ${nzLong(yearEnd)}`,
    author: name,
    footer: `${name} · Financial statements for the year ended ${nzLong(yearEnd)}`,
  });
  writer.space(120);
  writer.text(name, { size: 22, bold: true, gap: 8 });
  writer.text(report.heading, { size: 15, bold: true, gap: 4 });
  writer.text(report.period, { size: 13, gap: 30 });
  writer.text("Contents", { size: 12, bold: true, gap: 4 });
  for (const entry of [...report.statements.map((statement) => statement.title), "Notes to the financial statements"]) writer.text(entry, { gap: 2 });
  writer.space(30);
  writer.text(`Prepared with Tohyee on ${report.preparedOn} (UTC). Amounts are in ${report.currencyCode}.`, { muted: true });
  if (!notes.saved) writer.text("The notes are drafts that haven't been checked: see the notes.", { muted: true });

  const columns: Column[] = [
    { header: "", width: 3, align: "left" },
    { header: report.columns.current, width: 1, align: "right" },
    { header: report.columns.prior, width: 1, align: "right" },
  ];
  for (const statement of report.statements) {
    writer.newPage();
    writer.text(name, { size: 12, bold: true, gap: 2 });
    writer.text(statement.title, { size: 14, bold: true, gap: 2 });
    writer.text(statement.subtitle, { muted: true, gap: 10 });
    writer.table(
      columns,
      statement.lines.map((line) =>
        line.kind === "section" ? [line.label, "", ""] : [line.label, statementValue(line, line.current), statementValue(line, line.prior)],
      ),
      {
        width: CONTENT_WIDTH,
        rowKinds: statement.lines.map((line) => (line.kind === "section" ? "section" : line.kind === "total" || line.kind === "subtotal" ? "total" : "normal")),
      },
    );
    for (const paragraph of statement.paragraphs) writer.text(paragraph, { gap: 6 });
  }

  writer.newPage();
  writer.text(name, { size: 12, bold: true, gap: 2 });
  writer.text("Notes to the financial statements", {
    size: 14,
    bold: true,
    gap: 2,
  });
  writer.text(report.period, { muted: true, gap: 10 });
  if (!notes.saved) {
    writer.text(
      "DRAFT: these notes are Tohyee's starting drafts. Fill in the parts in [square brackets] and have them checked before the statements are used.",
      { bold: true, gap: 8 },
    );
  }
  notes.notes.forEach((note, index) => {
    writer.text(`${index + 1}. ${note.title}`, {
      size: 11,
      bold: true,
      gap: 3,
    });
    for (const paragraph of note.body.split(/\n{2,}/)) writer.text(paragraph.trim(), { gap: 6 });
    writer.space(4);
  });

  const safe = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return {
    fileName: `${safe} financial statements ${yearEnd}.pdf`,
    bytes: await writer.finish(),
  };
}
