import type { OrgTx } from "@/lib/db/org-transaction";
import { add, dec, toFixedString } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { type Column, CONTENT_WIDTH, PdfWriter } from "@/lib/pdf/writer";
import { financialStatementsPdf, getStatementNotes, statementAmount } from "@/lib/reports/financial-statements";
import { categoryLabel, ENTITY_FIELDS, GST_LINE } from "@/lib/reports/performance-categories";
import { type CategoryAmount, getPerformanceSettings, getServicePerformance, performanceFigures, type YearFigures } from "@/lib/reports/performance-report";

/*
 * The Tier 3 or Tier 4 performance report as one PDF (NPR1-NPR9): entity
 * information, the statement of service performance, the statements, and
 * the notes. This year and last year side by side.
 */

type Row = { label: string; current: string | null; prior: string | null; kind?: "section" | "total" | "subtotal" };

function nzLong(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

const total = (rows: CategoryAmount[]) => toFixedString(rows.reduce((sum, row) => add(sum, dec(row.amount)), dec("0")), 2);

/** Rows for categories in either year, matched by category (a category only in one year shows "-" in the other). */
function both(current: CategoryAmount[], prior: CategoryAmount[], label: (key: string) => string): Row[] {
  const keys = [...new Set([...current.map((row) => row.key), ...prior.map((row) => row.key)])];
  // Keep the standard's order: the order the keys come in from the current year, then any only in the prior year.
  return keys.map((key) => ({ label: label(key), current: current.find((row) => row.key === key)?.amount ?? null, prior: prior.find((row) => row.key === key)?.amount ?? null }));
}

const negate = (value: string) => (value.startsWith("-") ? value.slice(1) : value === "0.00" ? value : `-${value}`);
const isZero = (value: string) => /^-?0(\.0+)?$/.test(value);

export async function performanceReportPdf(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<{ fileName: string; bytes: Uint8Array }> {
  const settings = await getPerformanceSettings(tx);
  const tier = settings.format === "tier4" ? "tier4" : "tier3";
  const { yearEnd, current, prior } = await performanceFigures(tx, input.yearEnd);
  const service = await getServicePerformance(tx, yearEnd);
  const notes = await getStatementNotes(tx);
  const organisation = await getOrganisationSettings(tx);
  const name = settings.entity.legalName || organisation.displayName;
  const currentLabel = yearEnd.slice(0, 4);
  const priorLabel = prior.to.slice(0, 4);
  const standard = tier === "tier4" ? "Tier 4 (NFP) Standard" : "Tier 3 (NFP) Standard";
  const writer = await PdfWriter.create({
    title: `${name} performance report for the year ended ${nzLong(yearEnd)}`,
    author: name,
    footer: `${name} · Performance report for the year ended ${nzLong(yearEnd)}`,
  });

  const contents =
    tier === "tier4"
      ? ["Entity information", "Statement of service performance", "Statement of cash received and cash paid", "Basis of preparation and notes"]
      : ["Entity information", "Statement of service performance", "Statement of financial performance", "Statement of financial position", "Statement of cash flows", "Statement of accounting policies and notes"];
  writer.space(120);
  writer.text(name, { size: 22, bold: true, gap: 8 });
  writer.text("Performance report", { size: 15, bold: true, gap: 4 });
  writer.text(`For the year ended ${nzLong(yearEnd)}`, { size: 13, gap: 4 });
  writer.text(`Prepared under the ${standard} issued by the External Reporting Board.`, { gap: 30 });
  writer.text("Contents", { size: 12, bold: true, gap: 4 });
  for (const entry of contents) writer.text(entry, { gap: 2 });
  writer.space(30);
  writer.text(`Prepared with Tohyee on ${now.toISOString().slice(0, 10)} (UTC). Amounts are in ${tx.baseCurrency}.`, { muted: true });
  if (!notes.saved) writer.text("The notes are drafts that haven't been checked: see the notes.", { muted: true });
  if (!service.saved) writer.text("The statement of service performance hasn't been written for this year.", { muted: true });

  const page = (title: string, subtitle: string) => {
    writer.newPage();
    writer.text(name, { size: 12, bold: true, gap: 2 });
    writer.text(title, { size: 14, bold: true, gap: 2 });
    writer.text(subtitle, { muted: true, gap: 10 });
  };
  const columns: Column[] = [
    { header: "", width: 3, align: "left" },
    { header: currentLabel, width: 1, align: "right" },
    { header: priorLabel, width: 1, align: "right" },
  ];
  const table = (rows: Row[]) =>
    writer.table(
      columns,
      rows.map((row) => (row.kind === "section" ? [row.label, "", ""] : [row.label, statementAmount(row.current ?? "0"), statementAmount(row.prior ?? "0")])),
      { width: CONTENT_WIDTH, rowKinds: rows.map((row) => (row.kind === "section" ? "section" : row.kind ? "total" : "normal")) },
    );
  const heading = (label: string): Row => ({ label, current: null, prior: null, kind: "section" });
  const sum = (label: string, currentValue: string, priorValue: string, kind: Row["kind"] = "subtotal"): Row => ({ label, current: currentValue, prior: priorValue, kind });
  const label = (cash = false) => (key: string) => categoryLabel(key, tier, cash);

  // Entity information.
  page("Entity information", `For the year ended ${nzLong(yearEnd)}`);
  const filled = ENTITY_FIELDS.filter((field) => settings.entity[field.key]);
  if (filled.length === 0) writer.text("[Fill in the entity information in Tohyee: Reports › Financial statements.]", { gap: 6 });
  for (const field of filled) {
    writer.text(field.label, { bold: true, gap: 2 });
    writer.text(settings.entity[field.key], { gap: 8 });
  }

  // Statement of service performance (NPR9).
  page("Statement of service performance", `For the year ended ${nzLong(yearEnd)}`);
  if (!service.saved) {
    writer.text("[The statement of service performance for this year hasn't been written yet. Add the entity's key activities and their measures in Tohyee before this report is used.]", { bold: true, gap: 6 });
  }
  for (const activity of service.activities) {
    writer.text(activity.name, { size: 12, bold: true, gap: 3 });
    if (activity.description) writer.text(activity.description, { gap: 6 });
    if (activity.measures.length > 0) {
      writer.table(
        [
          { header: "Measure", width: 3, align: "left" },
          { header: currentLabel, width: 1, align: "right" },
          { header: priorLabel, width: 1, align: "right" },
        ],
        activity.measures.map((measure) => [measure.label, measure.current || "-", measure.prior || "-"]),
        { width: CONTENT_WIDTH },
      );
    }
    writer.space(8);
  }

  if (tier === "tier3") {
    page("Statement of financial performance", `For the year ended ${nzLong(yearEnd)}`);
    table([
      heading("Revenue"),
      ...both(current.revenue, prior.revenue, label()),
      sum("Total revenue", total(current.revenue), total(prior.revenue)),
      heading("Expenses"),
      ...both(current.expenses, prior.expenses, label()),
      sum("Total expenses", total(current.expenses), total(prior.expenses)),
      sum("Surplus or (deficit) for the year", current.surplus, prior.surplus, "total"),
    ]);

    page("Statement of financial position", `As at ${nzLong(yearEnd)}`);
    const part = (title: string, a: CategoryAmount[], b: CategoryAmount[]): Row[] =>
      a.length + b.length === 0 ? [] : [heading(title), ...both(a, b, label()), sum(`Total ${title.toLowerCase()}`, total(a), total(b))];
    table([
      ...part("Current assets", current.assets.current, prior.assets.current),
      ...part("Non-current assets", current.assets.nonCurrent, prior.assets.nonCurrent),
      sum("Total assets", current.assets.total, prior.assets.total, "total"),
      ...part("Current liabilities", current.liabilities.current, prior.liabilities.current),
      ...part("Non-current liabilities", current.liabilities.nonCurrent, prior.liabilities.nonCurrent),
      sum("Total liabilities", current.liabilities.total, prior.liabilities.total, "total"),
      sum("Total assets less total liabilities (net assets)", current.netAssets, prior.netAssets, "total"),
      heading("Accumulated funds"),
      ...both(current.equity, prior.equity, label()),
      sum("Total accumulated funds", total(current.equity), total(prior.equity), "total"),
    ]);

    page("Statement of cash flows", `For the year ended ${nzLong(yearEnd)}`);
    table(cashRows(current, prior, tier, label(true)));
  } else {
    page("Statement of cash received and cash paid", `For the year ended ${nzLong(yearEnd)}`);
    table(cashRows(current, prior, tier, label(true)));
  }

  // Notes.
  page(tier === "tier4" ? "Basis of preparation and notes" : "Statement of accounting policies and notes", `For the year ended ${nzLong(yearEnd)}`);
  if (!notes.saved) {
    writer.text("DRAFT: these notes are Tohyee's starting drafts. Fill in the parts in [square brackets] and have them checked before the report is used.", { bold: true, gap: 8 });
  }
  notes.notes.forEach((note, index) => {
    writer.text(`${index + 1}. ${note.title}`, { size: 11, bold: true, gap: 3 });
    for (const paragraph of note.body.split(/\n{2,}/)) writer.text(paragraph.trim(), { gap: 6 });
    writer.space(4);
  });
  if (tier === "tier4") {
    // Significant assets and liabilities from the books (NPR5), to be checked.
    const listing = (title: string, a: YearFigures["significantAssets"], b: YearFigures["significantAssets"]) => {
      writer.text(`${notes.notes.length + (title.includes("liabilities") ? 2 : 1)}. ${title}`, { size: 11, bold: true, gap: 3 });
      writer.text("From the balances in the books at the end of each year. [Check these, and describe any significant asset or liability not recorded in the books.]", { muted: true, gap: 4 });
      const rows = [...new Set([...a.map((row) => row.code), ...b.map((row) => row.code)])].map((code) => {
        const now = a.find((row) => row.code === code);
        const before = b.find((row) => row.code === code);
        return [(now ?? before)!.name, statementAmount(now?.amount ?? "0"), statementAmount(before?.amount ?? "0")];
      });
      if (rows.length === 0) writer.text("None.", { gap: 6 });
      else writer.table(columns, rows, { width: CONTENT_WIDTH });
      writer.space(6);
    };
    listing("Significant assets", current.significantAssets, prior.significantAssets);
    listing("Significant liabilities", current.significantLiabilities, prior.significantLiabilities);
  }

  const safe = name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  return { fileName: `${safe} performance report ${yearEnd}.pdf`, bytes: await writer.finish() };
}

/** The cash statement rows (NPR3 for Tier 3, NPR4 for Tier 4). */
function cashRows(current: YearFigures, prior: YearFigures, tier: "tier3" | "tier4", label: (key: string) => string): Row[] {
  const heading = (text: string): Row => ({ label: text, current: null, prior: null, kind: "section" });
  const sum = (text: string, a: string, b: string, kind: Row["kind"] = "subtotal"): Row => ({ label: text, current: a, prior: b, kind });
  const a = current.cash;
  const b = prior.cash;
  const receipts = total(a.receipts);
  const receiptsPrior = total(b.receipts);
  const payments = total(a.payments);
  const paymentsPrior = total(b.payments);
  const showGst = !isZero(a.gst) || !isZero(b.gst);
  const operating = toFixedString(add(dec(receipts), add(dec(negate(payments)), dec(a.gst))), 2);
  const operatingPrior = toFixedString(add(dec(receiptsPrior), add(dec(negate(paymentsPrior)), dec(b.gst))), 2);
  const otherIn = total(a.otherReceipts);
  const otherInPrior = total(b.otherReceipts);
  const otherOut = total(a.otherPayments);
  const otherOutPrior = total(b.otherPayments);
  const other = toFixedString(add(dec(otherIn), dec(negate(otherOut))), 2);
  const otherPrior = toFixedString(add(dec(otherInPrior), dec(negate(otherOutPrior))), 2);
  const change = toFixedString(add(dec(operating), dec(other)), 2);
  const changePrior = toFixedString(add(dec(operatingPrior), dec(otherPrior)), 2);
  const negated = (rows: CategoryAmount[]) => rows.map((row) => ({ key: row.key, amount: negate(row.amount) }));
  const otherSection: Row[] =
    a.otherReceipts.length + b.otherReceipts.length + a.otherPayments.length + b.otherPayments.length === 0
      ? []
      : [
          heading(tier === "tier4" ? "Cash received and paid for other activities" : "Cash flows from other activities"),
          ...both(a.otherReceipts, b.otherReceipts, label),
          ...both(negated(a.otherPayments), negated(b.otherPayments), label),
          sum(tier === "tier4" ? "Cash surplus or (deficit) from other activities" : "Net cash flows from other activities", other, otherPrior),
        ];
  if (tier === "tier4") {
    return [
      sum("Opening balance in bank account(s) at the start of the year", a.opening, b.opening),
      heading("Cash received from operating activities"),
      ...both(a.receipts, b.receipts, label),
      sum("Total", receipts, receiptsPrior),
      heading("Cash paid for operating activities"),
      ...both(a.payments, b.payments, label),
      sum("Total", payments, paymentsPrior),
      ...(showGst ? [{ label: GST_LINE.tier4, current: a.gst, prior: b.gst }] : []),
      sum("Cash surplus or (deficit) from operating activities", operating, operatingPrior),
      ...otherSection,
      sum("Increase or (decrease) in cash", change, changePrior),
      sum("Closing balance in bank account(s) at the end of the year", a.closing, b.closing, "total"),
      heading("Represented by"),
      ...[...new Set([...a.accounts.map((row) => row.code), ...b.accounts.map((row) => row.code)])].map((code) => {
        const now = a.accounts.find((row) => row.code === code);
        const before = b.accounts.find((row) => row.code === code);
        return { label: (now ?? before)!.name, current: now?.amount ?? null, prior: before?.amount ?? null };
      }),
      sum("Total cash balances held", a.closing, b.closing, "total"),
    ];
  }
  return [
    heading("Cash flows from operating activities"),
    heading("Cash was received from:"),
    ...both(a.receipts, b.receipts, label),
    heading("Cash was applied to:"),
    ...both(negated(a.payments), negated(b.payments), label),
    ...(showGst ? [{ label: GST_LINE.tier3, current: a.gst, prior: b.gst }] : []),
    sum("Net cash flows from operating activities", operating, operatingPrior),
    ...otherSection,
    sum("Net increase or (decrease) in cash", change, changePrior),
    sum("Opening cash", a.opening, b.opening),
    sum("Closing cash", a.closing, b.closing, "total"),
  ];
}

/** The year-end report in the organisation's chosen format (NPR10): special purpose statements, or a Tier 3 or Tier 4 performance report. */
export async function yearEndReportPdf(tx: OrgTx, input: { yearEnd: unknown }, now = new Date()): Promise<{ fileName: string; bytes: Uint8Array }> {
  const { format } = await getPerformanceSettings(tx);
  return format === "special_purpose" ? financialStatementsPdf(tx, input, now) : performanceReportPdf(tx, input, now);
}
