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
import { cashFlowStatement, changesInEquity, type StatementRow } from "@/lib/reports/statements";
import { requireArray, requireString } from "@/lib/validation";

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

type Line = { key: string; label: string; current: string | null; prior: string | null; kind?: "section" | "total" | "subtotal" };

function nzLong(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

/** Shows an amount as in printed statements: 1,234.56, negatives in brackets, "-" for nothing. */
export function statementAmount(value: string | null): string {
  if (value === null) return "";
  const negative = value.startsWith("-");
  const [whole, cents = "00"] = (negative ? value.slice(1) : value).split(".");
  if (/^0+$/.test(whole) && /^0*$/.test(cents)) return "-";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `(${grouped}.${cents})` : `${grouped}.${cents}`;
}

/** Lines from two years' account lines, matched by account (FS1): an account in only one year shows "-" in the other. */
function merge(current: Array<{ code: string | null; label: string; amount: string }>, prior: Array<{ code: string | null; label: string; amount: string }>): Line[] {
  const lines = new Map<string, Line>();
  for (const row of current) lines.set(row.code ?? row.label, { key: row.code ?? row.label, label: row.label, current: row.amount, prior: null });
  for (const row of prior) {
    const key = row.code ?? row.label;
    const existing = lines.get(key);
    if (existing) existing.prior = row.amount;
    else lines.set(key, { key, label: row.label, current: null, prior: row.amount });
  }
  return [...lines.values()];
}

const accountLines = (sections: Array<{ lines: Array<{ code: string; name: string; amount: string }> }>) =>
  sections.flatMap((section) => section.lines.map((line) => ({ code: line.code, label: line.name, amount: line.amount })));
const rowLines = (rows: StatementRow[]) => rows.map((row) => ({ code: row.code, label: row.label, amount: row.amount }));

export type FinancialStatementsPdf = { fileName: string; bytes: Uint8Array };

/** The year's financial statements as one PDF (FS1-FS3). */
export async function financialStatementsPdf(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<FinancialStatementsPdf> {
  const yearEndMonth = await financialYearEndMonth(tx);
  const yearEnd = parseIsoDate(input.yearEnd, "The year end");
  if (financialYearEnd(yearEnd, yearEndMonth) !== yearEnd) throw new ValidationError("That isn't a financial year end.");
  const yearStart = financialYearStart(yearEnd, yearEndMonth);
  const priorEnd = addDays(yearStart, -1);
  const priorStart = financialYearStart(priorEnd, yearEndMonth);
  const organisation = await getOrganisationSettings(tx);
  const name = organisation.displayName;
  const currentLabel = yearEnd.slice(0, 4);
  const priorLabel = priorEnd.slice(0, 4);

  const pl = await profitAndLoss(tx, { from: yearStart, to: yearEnd });
  const plPrior = await profitAndLoss(tx, { from: priorStart, to: priorEnd });
  const bs = await balanceSheet(tx, { asAt: yearEnd });
  const bsPrior = await balanceSheet(tx, { asAt: priorEnd });
  const sce = await changesInEquity(tx, { from: yearStart, to: yearEnd });
  const scePrior = await changesInEquity(tx, { from: priorStart, to: priorEnd });
  const cf = await cashFlowStatement(tx, { from: yearStart, to: yearEnd });
  const cfPrior = await cashFlowStatement(tx, { from: priorStart, to: priorEnd });
  const notes = await getStatementNotes(tx);

  const writer = await PdfWriter.create({
    title: `${name} financial statements for the year ended ${nzLong(yearEnd)}`,
    author: name,
    footer: `${name} · Financial statements for the year ended ${nzLong(yearEnd)}`,
  });
  const contents = ["Statement of financial performance", "Statement of financial position", "Statement of changes in equity", "Statement of cash flows", "Notes to the financial statements"];
  writer.space(120);
  writer.text(name, { size: 22, bold: true, gap: 8 });
  writer.text("Special purpose financial statements", { size: 15, bold: true, gap: 4 });
  writer.text(`For the year ended ${nzLong(yearEnd)}`, { size: 13, gap: 30 });
  writer.text("Contents", { size: 12, bold: true, gap: 4 });
  for (const entry of contents) writer.text(entry, { gap: 2 });
  writer.space(30);
  writer.text(`Prepared with Tohyee on ${now.toISOString().slice(0, 10)} (UTC). Amounts are in ${tx.baseCurrency}.`, { muted: true });
  if (!notes.saved) writer.text("The notes are drafts that haven't been checked: see the notes.", { muted: true });

  const columns: Column[] = [
    { header: "", width: 3, align: "left" },
    { header: currentLabel, width: 1, align: "right" },
    { header: priorLabel, width: 1, align: "right" },
  ];
  const table = (title: string, subtitle: string, lines: Line[]) => {
    writer.newPage();
    writer.text(name, { size: 12, bold: true, gap: 2 });
    writer.text(title, { size: 14, bold: true, gap: 2 });
    writer.text(subtitle, { muted: true, gap: 10 });
    writer.table(
      columns,
      lines.map((line) => (line.kind === "section" ? [line.label, "", ""] : [line.label, statementAmount(line.current ?? "0"), statementAmount(line.prior ?? "0")])),
      { width: CONTENT_WIDTH, rowKinds: lines.map((line) => (line.kind === "section" ? "section" : line.kind === "total" || line.kind === "subtotal" ? "total" : "normal")) },
    );
  };
  const heading = (label: string): Line => ({ key: `h:${label}`, label, current: null, prior: null, kind: "section" });
  const total = (label: string, current: string | null, prior: string | null, kind: Line["kind"] = "total"): Line => ({ key: `t:${label}`, label, current, prior, kind });
  // A heading only when either year has lines under it.
  const section = (label: string, lines: Line[]): Line[] => (lines.length === 0 ? [] : [heading(label), ...lines]);

  table("Statement of financial performance", `For the year ended ${nzLong(yearEnd)}`, [
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
    return lines.length === 0 ? [] : [heading(label), ...lines, total(`Total ${label.toLowerCase()}`, bs[group][part].total, bsPrior[group][part].total, "subtotal")];
  };
  table("Statement of financial position", `As at ${nzLong(yearEnd)}`, [
    ...term("Current assets", "current", "assets"),
    ...term("Non-current assets", "nonCurrent", "assets"),
    total("Total assets", bs.assets.total, bsPrior.assets.total),
    ...term("Current liabilities", "current", "liabilities"),
    ...term("Non-current liabilities", "nonCurrent", "liabilities"),
    total("Total liabilities", bs.liabilities.total, bsPrior.liabilities.total),
    total("Net assets", bs.netAssets, bsPrior.netAssets),
    heading("Equity"),
    ...merge(accountLines(bs.equity.sections), accountLines(bsPrior.equity.sections)),
    { key: "re", label: "Retained earnings", current: bs.equity.retainedEarnings.total, prior: bsPrior.equity.retainedEarnings.total },
    { key: "cye", label: "Current year earnings", current: bs.equity.currentYearEarnings, prior: bsPrior.equity.currentYearEarnings },
    total("Total equity", bs.equity.total, bsPrior.equity.total),
  ]);

  table("Statement of changes in equity", `For the year ended ${nzLong(yearEnd)}`, [
    total("Equity at the start of the year", sce.openingEquity, scePrior.openingEquity, "subtotal"),
    { key: "profit", label: "Net profit for the year", current: sce.profit, prior: scePrior.profit },
    ...merge(rowLines(sce.movements), rowLines(scePrior.movements)),
    total("Equity at the end of the year", sce.closingEquity, scePrior.closingEquity),
  ]);

  const proceeds = (value: string) => (/^-?0(\.0+)?$/.test(value) ? [] : [{ code: null, label: "Proceeds from disposals of fixed assets", amount: value }]);
  table("Statement of cash flows", `For the year ended ${nzLong(yearEnd)}`, [
    heading("Operating activities"),
    { key: "np", label: "Net profit", current: cf.operating.profit, prior: cfPrior.operating.profit },
    ...merge(rowLines(cf.operating.adjustments), rowLines(cfPrior.operating.adjustments)),
    ...merge(rowLines(cf.operating.workingCapital), rowLines(cfPrior.operating.workingCapital)),
    total("Net cash from operating activities", cf.operating.total, cfPrior.operating.total, "subtotal"),
    heading("Investing activities"),
    ...merge([...rowLines(cf.investing.lines), ...proceeds(cf.investing.disposalProceeds)], [...rowLines(cfPrior.investing.lines), ...proceeds(cfPrior.investing.disposalProceeds)]),
    total("Net cash from investing activities", cf.investing.total, cfPrior.investing.total, "subtotal"),
    heading("Financing activities"),
    ...merge(rowLines(cf.financing.lines), rowLines(cfPrior.financing.lines)),
    total("Net cash from financing activities", cf.financing.total, cfPrior.financing.total, "subtotal"),
    total("Net increase (decrease) in cash", cf.netChange, cfPrior.netChange, "subtotal"),
    ...(/^-?0(\.0+)?$/.test(cf.exchangeOnCash) && /^-?0(\.0+)?$/.test(cfPrior.exchangeOnCash)
      ? []
      : [{ key: "fx", label: "Effect of exchange rates on cash", current: cf.exchangeOnCash, prior: cfPrior.exchangeOnCash }]),
    { key: "open", label: "Cash at the start of the year", current: cf.openingCash, prior: cfPrior.openingCash },
    total("Cash at the end of the year", cf.closingCash, cfPrior.closingCash),
  ]);

  writer.newPage();
  writer.text(name, { size: 12, bold: true, gap: 2 });
  writer.text("Notes to the financial statements", { size: 14, bold: true, gap: 2 });
  writer.text(`For the year ended ${nzLong(yearEnd)}`, { muted: true, gap: 10 });
  if (!notes.saved) {
    writer.text("DRAFT: these notes are Tohyee's starting drafts. Fill in the parts in [square brackets] and have them checked before the statements are used.", { bold: true, gap: 8 });
  }
  notes.notes.forEach((note, index) => {
    writer.text(`${index + 1}. ${note.title}`, { size: 11, bold: true, gap: 3 });
    for (const paragraph of note.body.split(/\n{2,}/)) writer.text(paragraph.trim(), { gap: 6 });
    writer.space(4);
  });

  const safe = name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  return { fileName: `${safe} financial statements ${yearEnd}.pdf`, bytes: await writer.finish() };
}
