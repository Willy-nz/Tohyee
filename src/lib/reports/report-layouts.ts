import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { compareAmountColumns } from "@/lib/reports/compare-columns";
import { type CashFlowFigures, computeCashFlowLayout } from "@/lib/reports/cash-flow-layout";
import { computeCustomReport, type CustomReport, getCustomReport } from "@/lib/reports/custom";
import type { CashFlowLayout, CustomReportFigures, CustomReportLayout, FinancialReportBase, LayoutBase, ReportColumn } from "@/lib/reports/custom-layout";
import { balanceSheet, financialYearEndMonth, profitAndLoss, totalsFilter } from "@/lib/reports/financial";
import { parseCompare } from "@/lib/reports/statement-compare";
import { parseTrackingFilter } from "@/lib/reports/tracking-filter";
import { requireId } from "@/lib/validation";

/**
 * Default layouts and favourites (decisions 1359 and 1362). "Edit layout" on
 * the standard profit and loss or balance sheet makes a draft custom report;
 * "Set as default layout" makes Reports show it, with the toolbar's dates,
 * comparisons and tracking filter, instead of the standard rows. Each person
 * can star reports, standard or custom, to list them first in the picker.
 * Unlike Xero (which changes the one layout for everyone, with no
 * versions), named versions stay as drafts and one is the default.
 */

export type { LayoutBase };
const BASES: readonly LayoutBase[] = ["profit_and_loss", "balance_sheet", "cash_flows"];

function parseBase(input: unknown): LayoutBase {
  if (typeof input !== "string" || !BASES.includes(input as LayoutBase)) throw new ValidationError("Choose the profit and loss, the balance sheet or cash flows.");
  return input as LayoutBase;
}

export type LayoutDefault = { base: LayoutBase; reportId: string; title: string; setByEmail: string | null; setAt: string };

export async function listLayoutDefaults(tx: OrgTx): Promise<LayoutDefault[]> {
  const found = await tx.query<{ base: LayoutBase; report_id: string; title: string; set_by_email: string | null; set_at: string }>(
    `select d.base, d.custom_report_id::text as report_id, r.title, d.set_by_email, d.set_at
       from report_layout_defaults d join custom_reports r on r.id = d.custom_report_id
      order by d.base`,
  );
  return found.rows.map((row) => ({ base: row.base, reportId: row.report_id, title: row.title, setByEmail: row.set_by_email, setAt: row.set_at }));
}

/** Makes a draft the default layout for its report, or (reportId null) goes back to the standard layout. Doing it twice changes nothing. */
export async function setLayoutDefault(tx: OrgTx, input: { base: unknown; reportId: unknown }): Promise<LayoutDefault[]> {
  const base = parseBase(input.base);
  if (input.reportId == null || input.reportId === "") {
    const removed = await tx.query("delete from report_layout_defaults where base = $1", [base]);
    if (removed.rowCount) await writeAuditEvent(tx, { eventType: "report_layout.default_cleared", entityType: "report_layout", entityId: base, details: {} });
    return listLayoutDefaults(tx);
  }
  const reportId = requireId(input.reportId, "reportId");
  const found = await tx.query<{ kind: string; base: string; archived_at: string | null }>("select kind, base, archived_at from custom_reports where id = $1 for update", [reportId]);
  const report = found.rows[0];
  if (!report) throw new NotFoundError("Report not found.");
  if (report.base !== base) throw new ValidationError("That report starts from a different standard report.");
  if (report.kind !== "draft") throw new ConflictError("A published report is a frozen copy, so it can't be the layout reports are worked out with. Use its draft.");
  if (report.archived_at) throw new ConflictError("This report is archived. Bring it back first.");
  await tx.query(
    `insert into report_layout_defaults (base, custom_report_id, set_by_email) values ($1, $2, $3)
     on conflict (base) do update set custom_report_id = excluded.custom_report_id, set_by_email = excluded.set_by_email, set_at = now()
     where report_layout_defaults.custom_report_id <> excluded.custom_report_id`,
    [base, reportId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "report_layout.default_set", entityType: "report_layout", entityId: base, details: { reportId } });
  return listLayoutDefaults(tx);
}

/** Before a draft is archived or deleted it stops being a default (the standard layout comes back). */
export async function clearDefaultFor(tx: OrgTx, reportId: string): Promise<void> {
  await tx.query("delete from report_layout_defaults where custom_report_id = $1", [reportId]);
}

/**
 * The standard report worked out with its default layout and the toolbar's
 * options (decision 1359): the chosen dates and earlier periods (and year to
 * date) as the layout's columns, and the tracking filter. Null when the
 * report has no default layout. Total and % of trading income columns are
 * the standard layout's; a custom layout has its own formula rows.
 */
export async function runDefaultLayout(
  tx: OrgTx,
  input: {
    base: unknown;
    from?: unknown;
    to?: unknown;
    asAt?: unknown;
    compare?: unknown;
    compareBy?: unknown;
    order?: unknown;
    ytd?: unknown;
    trackingCategoryId?: unknown;
    trackingValueId?: unknown;
  },
): Promise<{ report: CustomReport; figures: CustomReportFigures } | null> {
  const parsed = parseBase(input.base);
  if (parsed === "cash_flows") throw new ValidationError("Use the cash flows layout.");
  const base: FinancialReportBase = parsed;
  const defaults = await listLayoutDefaults(tx);
  const chosen = defaults.find((entry) => entry.base === base);
  if (!chosen) return null;
  const { report } = await getCustomReport(tx, chosen.reportId);
  const filter = await parseTrackingFilter(tx, input.trackingCategoryId, input.trackingValueId);
  const compare = parseCompare({ compare: input.compare, compareBy: input.compareBy, order: input.order, ytd: base === "profit_and_loss" ? input.ytd : undefined }) ?? {
    periods: 0,
    periodLength: "month" as const,
  };
  // The dates as the standard report reads them (defaults, checks).
  const range =
    base === "profit_and_loss"
      ? await profitAndLoss(tx, { from: input.from, to: input.to, filter }).then((r) => ({ from: r.from as string | null, to: r.to }))
      : await balanceSheet(tx, { asAt: input.asAt, filter }).then((r) => ({ from: null, to: r.asAt }));
  const columns: ReportColumn[] = compareAmountColumns(base, range, { ...compare, total: false, percentOfIncome: false }, await financialYearEndMonth(tx))
    .filter((column) => column.kind === "period" || column.kind === "year_to_date")
    .map((column) => ({ key: column.key, kind: column.kind === "year_to_date" ? "year_to_date" : "period", label: column.label, from: column.from, to: column.to }));
  const figures = await computeCustomReport(tx, base, report.layout as CustomReportLayout, {
    columns,
    filter: filter ? { ...totalsFilter(filter)!, label: filter.label } : null,
  });
  return { report, figures };
}

/**
 * The default cash flows layout for a period, with earlier periods to
 * compare (CFL5), or null when there's none (the standard statement shows).
 */
export async function runDefaultCashFlowLayout(
  tx: OrgTx,
  input: { from: string; to: string; compare?: unknown; compareBy?: unknown; order?: unknown },
): Promise<{ report: CustomReport; figures: CashFlowFigures } | null> {
  const chosen = (await listLayoutDefaults(tx)).find((entry) => entry.base === "cash_flows");
  if (!chosen) return null;
  const { report } = await getCustomReport(tx, chosen.reportId);
  const compare = parseCompare({ compare: input.compare, compareBy: input.compareBy, order: input.order }) ?? { periods: 0, periodLength: "month" as const };
  const columns: ReportColumn[] = compareAmountColumns("profit_and_loss", { from: input.from, to: input.to }, { ...compare, total: false, percentOfIncome: false }, await financialYearEndMonth(tx))
    .filter((column) => column.kind === "period")
    .map((column) => ({ key: column.key, kind: "period", label: column.label, from: column.from, to: column.to }));
  return { report, figures: await computeCashFlowLayout(tx, report.layout as CashFlowLayout, { columns }) };
}

const FAVOURITE_KEY = /^(std:[a-z]{2,20}|custom:[1-9][0-9]{0,17})$/;

export async function listFavourites(tx: OrgTx): Promise<string[]> {
  if (!tx.actor.userId) return [];
  const found = await tx.query<{ report_key: string }>("select report_key from report_favourites where user_id = $1 order by created_at, report_key", [tx.actor.userId]);
  return found.rows.map((row) => row.report_key);
}

/** Stars or unstars a report for the signed-in person (decision 1362). */
export async function setFavourite(tx: OrgTx, input: { key: unknown; favourite: unknown }): Promise<string[]> {
  if (!tx.actor.userId) throw new ValidationError("Sign in to keep favourites.");
  if (typeof input.key !== "string" || !FAVOURITE_KEY.test(input.key)) throw new ValidationError("That isn't a report.");
  if (typeof input.favourite !== "boolean") throw new ValidationError("favourite must be true or false.");
  if (input.favourite) {
    await tx.query("insert into report_favourites (user_id, report_key) values ($1, $2) on conflict do nothing", [tx.actor.userId, input.key]);
  } else {
    await tx.query("delete from report_favourites where user_id = $1 and report_key = $2", [tx.actor.userId, input.key]);
  }
  return listFavourites(tx);
}
