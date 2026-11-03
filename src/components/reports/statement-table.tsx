"use client";

import Link from "next/link";
import { Money } from "@/components/books";
import { InfoTip } from "@/components/info-tip";
import { Field, ui } from "@/components/ui";
import type { TrackingSetup } from "@/lib/tracking/service";
import { reportCategories } from "@/components/tracking";
import { accountTransactionsHref } from "@/lib/reports/drilldown";
import type { StatementColumn } from "@/lib/reports/compare-columns";
import type { MultiColumnStatement, StatementRow } from "@/lib/reports/statement-compare";

/**
 * A statement with several columns (decisions 1353-1354): earlier periods,
 * a total, a year to date and % of trading income, in statement style. Each
 * period's account amounts open that account's transactions for the
 * column's dates (and the report's tracking filter).
 */

export type TrackingChoice = { categoryId: string; valueId: string } | null;

/** "categoryId:valueId", or "" for none, as the filter select holds it. */
export function trackingChoiceValue(choice: TrackingChoice): string {
  return choice ? `${choice.categoryId}:${choice.valueId}` : "";
}

export function parseTrackingChoice(value: string): TrackingChoice {
  const [categoryId = "", valueId = ""] = value.split(":");
  return categoryId && valueId ? { categoryId, valueId } : null;
}

/** The query parameters for a tracking filter. */
export function trackingQuery(choice: TrackingChoice) {
  return { trackingCategoryId: choice?.categoryId ?? null, trackingValueId: choice?.valueId ?? null };
}

/** The toolbar's Tracking field: any value (and those under it) of any category, or Not set (RX5). */
export function TrackingFilterField({ setup, value, onChange, exclude }: { setup: TrackingSetup | null; value: string; onChange: (value: string) => void; exclude?: string }) {
  const categories = reportCategories(setup).filter((category) => category.id !== exclude);
  if (categories.length === 0) return null;
  return (
    <Field label="Tracking">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Everything</option>
        {categories.map((category) => (
          <optgroup key={category.id} label={category.name}>
            {category.values.map((entry) => (
              <option key={entry.id} value={`${category.id}:${entry.id}`}>
                {category.name}: {entry.path ?? entry.name}
              </option>
            ))}
            <option value={`${category.id}:unassigned`}>{category.name}: Not set</option>
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

const rowClass: Record<StatementRow["kind"], string | undefined> = {
  heading: ui.reportHeading,
  subheading: ui.reportSubheading,
  account: ui.reportSection,
  earnings: ui.reportSection,
  total: ui.reportTotal,
  grand: ui.reportGrand,
};

const ZERO = /^-?0*(\.0*)?$/;

function Amount({ row, column, tracking }: { row: StatementRow; column: StatementColumn; tracking: TrackingChoice }) {
  const value = row.values[column.key] ?? null;
  if (column.kind === "percent") {
    const of = column.of ? row.values[column.of] : null;
    // A blank amount has a blank %, as its amount does.
    if (value == null || (row.kind === "account" && (of == null || ZERO.test(of)))) return null;
    return <>{`${value}%`}</>;
  }
  const linked = row.accountId && column.to && (column.kind === "period" || column.kind === "year_to_date");
  if (row.kind === "account" && (value == null || ZERO.test(value))) return <Money value={value} blankZero />;
  if (!linked) return <Money value={value} />;
  return (
    <Link
      href={accountTransactionsHref({
        accountId: row.accountId,
        from: column.drillFrom ?? column.from,
        to: column.to!,
        trackingCategoryId: tracking?.categoryId,
        trackingValueId: tracking?.valueId === "unassigned" ? null : tracking?.valueId,
        trackingUnassigned: tracking?.valueId === "unassigned",
      })}
    >
      <Money value={value} />
    </Link>
  );
}

export function MultiColumnStatementTable({ id, report, tracking }: { id: string; report: MultiColumnStatement; tracking: TrackingChoice }) {
  const span = report.columns.length + 1;
  return (
    <div className={ui.statementWrap}>
      <table id={id} className={`${ui.table} ${ui.statement} ${ui.statementWide}`}>
        <thead>
          <tr>
            <th>
              <span className={ui.srOnly}>Account</span>
            </th>
            {report.columns.map((column) => (
              <th key={column.key} className={ui.num} title={column.kind === "percent" ? "% of trading income" : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) =>
            row.kind === "heading" || row.kind === "subheading" ? (
              <tr key={row.key} className={rowClass[row.kind]}>
                <td colSpan={span}>{row.label}</td>
              </tr>
            ) : (
              <tr key={row.key} className={rowClass[row.kind]}>
                <td>
                  {row.label}
                  {row.note ? (
                    <>
                      {" "}
                      <span data-export-ignore>
                        <InfoTip label={row.label}>{row.note}</InfoTip>
                      </span>
                    </>
                  ) : null}
                </td>
                {report.columns.map((column) => (
                  <td key={column.key} className={ui.num}>
                    <Amount row={row} column={column} tracking={tracking} />
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
