"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { reportCategories, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/types";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { CustomReport, CustomReportView } from "@/lib/reports/custom";
import {
  type ComputedBlock,
  type ComputedRow,
  CUSTOM_REPORT_BASES,
  CUSTOM_REPORT_LIMITS,
  type CustomReportBase,
  type CustomReportFigures,
  type CustomReportLayout,
  type FormulaTerm,
  lastDayOfMonth,
  newLayoutId,
  PERIOD_LENGTHS,
  type PeriodLength,
  type ReportBlock,
  type ReportColumn,
  type ReportColumnsSetting,
  type ReportRow,
  type ReportTrackingFilter,
  type ReportValues,
} from "@/lib/reports/custom-layout";
import type { TrackingSetup } from "@/lib/tracking/service";
import type { Budget } from "@/lib/budgets/service";

/**
 * Custom reports (examples CR1-CR10): the lists (drafts, published,
 * archived), starting one from a standard report, and the report page, which
 * is also its editor while it's a draft.
 */

type Loaded = { report: CustomReport; figures: CustomReportFigures };

const pageHref = (id: string) => `/operations/reports/custom/${id}`;

export function StartCustomReport({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [keys] = useState(() => ({ profit_and_loss: newIdempotencyKey("custom-report"), balance_sheet: newIdempotencyKey("custom-report") }));
  const [busy, setBusy] = useState<CustomReportBase | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(base: CustomReportBase) {
    setBusy(base);
    setError(null);
    try {
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: keys[base], base, periodEnd: lastDayOfMonth(todayInBrowser()) },
      });
      router.push(pageHref(result.report.id));
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(null);
    }
  }

  if (!can("bookkeeper")) return <Notice tone="info">Only bookkeepers and admins can make custom reports.</Notice>;
  return (
    <Card
      title="New custom report"
      description="Start from a standard report, then change its title, columns and rows, and add tables and notes. It's saved as a draft; publish it to keep a copy that never changes."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        {(Object.keys(CUSTOM_REPORT_BASES) as CustomReportBase[]).map((base) => (
          <div key={base} className={ui.stat}>
            <div className={ui.statLabel}>Start from</div>
            <div className={ui.statValue}>{CUSTOM_REPORT_BASES[base]}</div>
            <p className={ui.muted}>
              {base === "profit_and_loss"
                ? "Revenue, cost of sales, gross profit, other income, expenses and net profit."
                : "Assets, liabilities, net assets, equity, earnings and total equity."}
            </p>
            <Button onClick={() => void start(base)} disabled={busy !== null}>
              {busy === base ? "Starting…" : "Start from this"}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function CustomReportList({ organisationId, view }: { organisationId: string; view: CustomReportView }) {
  const list = useApiData<{ reports: CustomReport[] }>("/api/custom-reports", { organisationId, view });
  const empty = {
    drafts: "No draft reports. Start one under Custom.",
    published: "No published reports. Publish a draft to keep a copy that never changes.",
    archived: "Nothing archived.",
  }[view];
  return (
    <Card title={{ drafts: "Drafts", published: "Published", archived: "Archived" }[view]}>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.reports.length === 0 ? <Empty>{empty}</Empty> : null}
      {list.data && list.data.reports.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Title</th>
                <th>Started from</th>
                <th>{view === "published" ? "Published" : "Last changed"}</th>
                {view === "archived" ? <th>Was</th> : null}
              </tr>
            </thead>
            <tbody>
              {list.data.reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <Link href={pageHref(report.id)}>{report.title}</Link>
                  </td>
                  <td>{CUSTOM_REPORT_BASES[report.base]}</td>
                  <td>
                    {formatDateTime(report.publishedAt ?? report.updatedAt)} · {report.publishedByEmail ?? report.updatedByEmail ?? ""}
                  </td>
                  {view === "archived" ? <td>{report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function periodSummary(figures: CustomReportFigures): string {
  const periods = figures.columns.filter((column) => column.kind === "period");
  if (periods.length === 0) return "";
  const newest = periods[0];
  if (figures.base === "balance_sheet") {
    return periods.length === 1 ? `As at ${formatDate(newest.to)}` : `As at ${formatDate(newest.to)}, compared with ${periods.length - 1} earlier date${periods.length > 2 ? "s" : ""}`;
  }
  return `${formatDate(periods[periods.length - 1].from)} to ${formatDate(newest.to)}`;
}

function Cell({ column, values }: { column: ReportColumn; values: ReportValues }) {
  const value = values[column.key];
  if (column.kind === "percent") return <td className={ui.num}>{value == null ? "" : `${value}%`}</td>;
  return (
    <td className={ui.num}>
      <Money value={value ?? null} />
    </td>
  );
}

type Editing =
  | { kind: "row"; blockId: string; row: ReportRow; isNew: boolean }
  | { kind: "columns" }
  | null;

function RowButtons({
  onUp,
  onDown,
  onEdit,
  onDelete,
  disabled,
  label,
}: {
  onUp: () => void;
  onDown: () => void;
  onEdit?: () => void;
  onDelete: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <span className={ui.rowButtons} data-print="hide">
      <button type="button" className={ui.iconButton} onClick={onUp} disabled={disabled} aria-label={`Move ${label} up`} title="Move up">
        ↑
      </button>
      <button type="button" className={ui.iconButton} onClick={onDown} disabled={disabled} aria-label={`Move ${label} down`} title="Move down">
        ↓
      </button>
      {onEdit ? (
        <button type="button" className={ui.iconButton} onClick={onEdit} disabled={disabled} aria-label={`Change ${label}`} title="Change">
          ✎
        </button>
      ) : null}
      <button type="button" className={ui.iconButton} onClick={onDelete} disabled={disabled} aria-label={`Delete ${label}`} title="Delete">
        ✕
      </button>
    </span>
  );
}

function move<T>(items: T[], index: number, by: -1 | 1): boolean {
  const to = index + by;
  if (index < 0 || to < 0 || to >= items.length) return false;
  const [item] = items.splice(index, 1);
  items.splice(to, 0, item);
  return true;
}

function ReportTable({
  block,
  figures,
  layoutBlock,
  editable,
  busy,
  onChange,
  onEditRow,
  onError,
}: {
  block: Extract<ComputedBlock, { kind: "table" }>;
  figures: CustomReportFigures;
  layoutBlock: Extract<ReportBlock, { kind: "table" }> | undefined;
  editable: boolean;
  busy: boolean;
  onChange: (change: (layout: CustomReportLayout) => boolean | void) => void;
  onEditRow: (row: ReportRow, isNew: boolean) => void;
  onError: (message: string) => void;
}) {
  const columns = figures.columns;
  const span = columns.length + 1 + (editable ? 1 : 0);
  const [title, setTitle] = useState(block.title);
  const tableOf = (layout: CustomReportLayout) => layout.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "table" }>;

  const actions = (row: ComputedRow) => {
    const layoutRow = layoutBlock?.rows.find((entry) => entry.id === row.id);
    if (!editable || !layoutRow) return null;
    return (
      <td className={ui.num} data-print="hide">
        <RowButtons
          label={row.label}
          disabled={busy}
          onUp={() => onChange((layout) => move(tableOf(layout).rows, tableOf(layout).rows.findIndex((r) => r.id === row.id), -1))}
          onDown={() => onChange((layout) => move(tableOf(layout).rows, tableOf(layout).rows.findIndex((r) => r.id === row.id), 1))}
          onEdit={() => onEditRow(structuredClone(layoutRow), false)}
          onDelete={() => {
            const users = (layoutBlock?.rows ?? []).filter((r) => r.kind === "formula" && r.terms.some((term) => term.rowId === row.id));
            if (users.length > 0) {
              onError(`${users.map((r) => r.label).join(" and ")} ${users.length === 1 ? "uses" : "use"} ${row.label}. Change or delete ${users.length === 1 ? "it" : "them"} first.`);
              return;
            }
            if (!window.confirm(`Delete the row ${row.label}?`)) return;
            onChange((layout) => {
              const rows = tableOf(layout).rows;
              rows.splice(rows.findIndex((r) => r.id === row.id), 1);
            });
          }}
        />
      </td>
    );
  };

  return (
    <div className={ui.reportBlock}>
      {editable ? (
        <div className={ui.blockHeader} data-print="hide">
          <input
            aria-label="Table title"
            placeholder="Table title (optional)"
            value={title}
            maxLength={CUSTOM_REPORT_LIMITS.labelLength}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (title.trim() !== block.title) onChange((layout) => void (tableOf(layout).title = title.trim()));
            }}
          />
        </div>
      ) : null}
      {block.title ? <h3 className={`${ui.reportBlockTitle} ${editable ? ui.printOnly : ""}`}>{block.title}</h3> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.reportTable}`}>
          <thead>
            <tr>
              <th />
              {columns.map((column) => (
                <th key={column.key} className={ui.num}>
                  {column.label}
                </th>
              ))}
              {editable ? <th data-print="hide" /> : null}
            </tr>
          </thead>
          <tbody>
            {block.rows.length === 0 ? (
              <tr>
                <td colSpan={span} className={ui.muted}>
                  No rows yet.
                </td>
              </tr>
            ) : null}
            {block.rows.map((row) => {
              if (row.kind === "heading") {
                return (
                  <tr key={row.id} className={ui.reportHeading}>
                    <td colSpan={columns.length + 1}>{row.label}</td>
                    {actions(row)}
                  </tr>
                );
              }
              if (row.kind === "group" && row.showAccounts) {
                return (
                  <Fragment key={row.id}>
                    <tr className={ui.reportHeading}>
                      <td colSpan={columns.length + 1}>{row.label}</td>
                      {actions(row)}
                    </tr>
                    {row.lines.length === 0 ? (
                      <tr>
                        <td className={ui.muted} colSpan={span}>
                          Nothing in these periods.
                        </td>
                      </tr>
                    ) : null}
                    {row.lines.map((line) => (
                      <tr key={line.code} className={ui.reportSection}>
                        <td>
                          {line.code} · {line.name}
                        </td>
                        {columns.map((column) => (
                          <Cell key={column.key} column={column} values={line.values} />
                        ))}
                        {editable ? <td data-print="hide" /> : null}
                      </tr>
                    ))}
                    <tr className={ui.reportTotal}>
                      <td>Total {row.label.charAt(0).toLowerCase() + row.label.slice(1)}</td>
                      {columns.map((column) => (
                        <Cell key={column.key} column={column} values={row.values} />
                      ))}
                      {editable ? <td data-print="hide" /> : null}
                    </tr>
                  </Fragment>
                );
              }
              return (
                <tr key={row.id} className={row.kind === "formula" ? ui.reportTotal : undefined}>
                  <td>{row.label}</td>
                  {columns.map((column) => (
                    <Cell key={column.key} column={column} values={row.values} />
                  ))}
                  {actions(row)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable ? (
        <div className={ui.actions} data-print="hide">
          <span className={ui.muted}>Add a row:</span>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => onEditRow({ id: newLayoutId("r"), kind: "group", label: "", accountTypes: [], accountCodes: [], showAccounts: true }, true)}
          >
            Group of accounts
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => onEditRow({ id: newLayoutId("r"), kind: "formula", label: "", terms: [] }, true)}
          >
            Formula
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => onEditRow({ id: newLayoutId("r"), kind: "heading", label: "" }, true)}>
            Heading
          </Button>
          {figures.base === "balance_sheet" ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => onEditRow({ id: newLayoutId("r"), kind: "earnings", label: "Current year earnings", which: "current" }, true)}
            >
              Earnings
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RowEditor({
  base,
  table,
  initial,
  isNew,
  accounts,
  busy,
  onSave,
  onCancel,
}: {
  base: CustomReportBase;
  table: Extract<ReportBlock, { kind: "table" }>;
  initial: ReportRow;
  isNew: boolean;
  accounts: Account[];
  busy: boolean;
  onSave: (row: ReportRow) => void;
  onCancel: () => void;
}) {
  const [row, setRow] = useState<ReportRow>(initial);
  const [byCode, setByCode] = useState(initial.kind === "group" && initial.accountCodes.length > 0);
  const [error, setError] = useState<string | null>(null);
  const others = table.rows.filter((entry) => entry.id !== row.id && entry.kind !== "heading");
  const kindName = { group: "group of accounts", formula: "formula", heading: "heading", earnings: "earnings row" }[row.kind];

  function save() {
    if (!row.label.trim()) return setError("Give the row a name.");
    if (row.kind === "group") {
      const cleaned = byCode ? { ...row, accountTypes: [] } : { ...row, accountCodes: [] };
      if (cleaned.accountTypes.length === 0 && cleaned.accountCodes.length === 0) return setError("Tick the account types or accounts in this group.");
      return onSave({ ...cleaned, label: row.label.trim() });
    }
    if (row.kind === "formula" && row.terms.length === 0) return setError("Add at least one row to the formula.");
    onSave({ ...row, label: row.label.trim() });
  }

  const toggle = <T,>(items: T[], item: T) => (items.includes(item) ? items.filter((entry) => entry !== item) : [...items, item]);
  const inScope = (account: Account) =>
    base === "profit_and_loss" ? account.accountClass === "revenue" || account.accountClass === "expense" : !["revenue", "expense"].includes(account.accountClass);

  return (
    <Card title={isNew ? `New ${kindName}` : `Change ${initial.label || kindName}`} description={table.title ? `In the table ${table.title}.` : undefined}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Name">
          <input value={row.label} maxLength={CUSTOM_REPORT_LIMITS.labelLength} onChange={(event) => setRow({ ...row, label: event.target.value })} autoFocus />
        </Field>
        {row.kind === "group" ? (
          <>
            <div className={ui.actions}>
              <label className={ui.checkbox}>
                <input type="radio" checked={!byCode} onChange={() => setByCode(false)} /> By account type
              </label>
              <label className={ui.checkbox}>
                <input type="radio" checked={byCode} onChange={() => setByCode(true)} /> Chosen accounts
              </label>
              <label className={ui.checkbox}>
                <input type="checkbox" checked={row.showAccounts} onChange={(event) => setRow({ ...row, showAccounts: event.target.checked })} /> Show each account
                (otherwise just the total)
              </label>
            </div>
            {byCode ? (
              <div className={ui.choiceList}>
                {[...accounts]
                  .sort((a, b) => Number(inScope(b)) - Number(inScope(a)) || a.code.localeCompare(b.code))
                  .map((account) => (
                    <label key={account.id} className={ui.checkbox}>
                      <input
                        type="checkbox"
                        checked={row.accountCodes.includes(account.code)}
                        onChange={() => setRow({ ...row, accountCodes: toggle(row.accountCodes, account.code) })}
                      />
                      {account.code} · {account.name}
                      {account.isActive ? "" : " (archived)"}
                    </label>
                  ))}
              </div>
            ) : (
              <div className={ui.choiceList}>
                {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((type) => (
                  <label key={type} className={ui.checkbox}>
                    <input type="checkbox" checked={row.accountTypes.includes(type)} onChange={() => setRow({ ...row, accountTypes: toggle(row.accountTypes, type) })} />
                    {ACCOUNT_TYPES[type].label}
                  </label>
                ))}
              </div>
            )}
            <p className={ui.muted}>
              Amounts are shown the way the standard reports show them: income as a plus, costs as a plus. To take one from the other, put them in separate
              groups and add a formula.
            </p>
          </>
        ) : null}
        {row.kind === "formula" ? (
          <>
            {row.terms.length === 0 ? <p className={ui.muted}>No rows yet.</p> : null}
            {row.terms.map((term, index) => (
              <div key={index} className={ui.actions}>
                <select
                  aria-label="Add or subtract"
                  value={term.sign}
                  onChange={(event) => {
                    const terms = [...row.terms];
                    terms[index] = { ...term, sign: Number(event.target.value) as 1 | -1 };
                    setRow({ ...row, terms });
                  }}
                >
                  <option value={1}>+ add</option>
                  <option value={-1}>− subtract</option>
                </select>
                <select
                  aria-label="Row"
                  value={term.rowId}
                  onChange={(event) => {
                    const terms = [...row.terms];
                    terms[index] = { ...term, rowId: event.target.value };
                    setRow({ ...row, terms });
                  }}
                >
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.label}
                    </option>
                  ))}
                </select>
                <Button size="small" variant="secondary" onClick={() => setRow({ ...row, terms: row.terms.filter((_, i) => i !== index) })}>
                  Remove
                </Button>
              </div>
            ))}
            {others.length > 0 ? (
              <div>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setRow({ ...row, terms: [...row.terms, { rowId: others[0].id, sign: 1 } satisfies FormulaTerm] })}
                >
                  Add a row to it
                </Button>
              </div>
            ) : (
              <p className={ui.muted}>This table has no other rows to add up yet.</p>
            )}
          </>
        ) : null}
        {row.kind === "earnings" ? (
          <Field label="Which earnings">
            <select value={row.which} onChange={(event) => setRow({ ...row, which: event.target.value as "previous" | "current" })}>
              <option value="current">Current year earnings</option>
              <option value="previous">Earnings from previous years</option>
            </select>
          </Field>
        ) : null}
        <div className={ui.actions}>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : isNew ? "Add row" : "Save row"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ColumnsEditor({
  base,
  initial,
  initialFilter,
  tracking,
  budgets,
  busy,
  onSave,
  onCancel,
}: {
  base: CustomReportBase;
  initial: ReportColumnsSetting;
  initialFilter: ReportTrackingFilter | null;
  tracking: TrackingSetup | null;
  budgets: Budget[];
  busy: boolean;
  onSave: (setting: ReportColumnsSetting, filter: ReportTrackingFilter | null) => void;
  onCancel: () => void;
}) {
  const [setting, setSetting] = useState(initial);
  const [filter, setFilter] = useState(initialFilter ? `${initialFilter.categoryId}:${initialFilter.valueId}` : "");
  const [error, setError] = useState<string | null>(null);
  // Only a profit and loss can be filtered: balance sheet lines (AR, AP, GST, bank) aren't tagged (TC8).
  const categories = base === "profit_and_loss" ? reportCategories(tracking) : [];
  function save() {
    if (setting.difference && setting.periodCount < 2) return setError("A difference needs at least two period columns.");
    const [categoryId, valueId] = filter.split(":");
    const { budgetId, budgetDifference, ...rest } = setting;
    onSave(
      {
        ...rest,
        percent: setting.difference && setting.percent,
        yearToDate: base === "profit_and_loss" && setting.yearToDate,
        // A budget column for the first period (BU7), profit and loss only.
        ...(base === "profit_and_loss" && budgetId ? { budgetId, budgetDifference: Boolean(budgetDifference) } : {}),
      },
      filter && categoryId && valueId ? { categoryId, valueId } : null,
    );
  }
  return (
    <Card title="Columns" description="Whole months, quarters or years, newest first, ending on a month end.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label={base === "balance_sheet" ? "Newest column is as at the end of" : "Newest column ends with"}>
          <input
            type="month"
            value={setting.periodEnd.slice(0, 7)}
            onChange={(event) => event.target.value && setSetting({ ...setting, periodEnd: lastDayOfMonth(`${event.target.value}-01`) })}
            required
          />
        </Field>
        <Field label="Each column is">
          <select value={setting.periodLength} onChange={(event) => setSetting({ ...setting, periodLength: event.target.value as PeriodLength })}>
            {(Object.keys(PERIOD_LENGTHS) as PeriodLength[]).map((length) => (
              <option key={length} value={length}>
                {{ month: "A month", quarter: "A quarter (3 months)", year: "A year (12 months)" }[length]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How many columns">
          <input
            type="number"
            min={1}
            max={CUSTOM_REPORT_LIMITS.periods}
            value={setting.periodCount}
            onChange={(event) => setSetting({ ...setting, periodCount: Math.max(1, Math.min(CUSTOM_REPORT_LIMITS.periods, Number(event.target.value) || 1)) })}
          />
        </Field>
      </div>
      <div className={ui.actions}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={setting.difference} onChange={(event) => setSetting({ ...setting, difference: event.target.checked })} /> Difference
          (newest less the one before)
        </label>
        <label className={ui.checkbox}>
          <input
            type="checkbox"
            checked={setting.difference && setting.percent}
            disabled={!setting.difference}
            onChange={(event) => setSetting({ ...setting, percent: event.target.checked })}
          />{" "}
          % change
        </label>
        {base === "profit_and_loss" ? (
          <label className={ui.checkbox}>
            <input type="checkbox" checked={setting.yearToDate} onChange={(event) => setSetting({ ...setting, yearToDate: event.target.checked })} /> Year to
            date
          </label>
        ) : null}
      </div>
      {categories.length > 0 || filter ? (
        <Field label="Only lines tagged" hint="Counts only lines tagged with this value or a value under it.">
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">Everything (no filter)</option>
            {categories.map((category) => (
              <optgroup key={category.id} label={category.name}>
                {category.values
                  .filter((value) => value.isActive || filter === `${category.id}:${value.id}`)
                  .map((value) => (
                    <option key={value.id} value={`${category.id}:${value.id}`}>
                      {category.name}: {value.path}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
      ) : null}
      {base === "profit_and_loss" ? (
        <div className={ui.grid3}>
          <Field label="Budget column" hint="The budget for the first (newest) period.">
            <select value={setting.budgetId ?? ""} onChange={(event) => setSetting({ ...setting, budgetId: event.target.value || undefined })}>
              <option value="">No budget column</option>
              {budgets
                .filter((budget) => !budget.archivedAt || budget.id === setting.budgetId)
                .map((budget) => (
                  <option key={budget.id} value={budget.id}>
                    {budget.name}
                    {budget.trackingLabel ? ` (${budget.trackingLabel})` : ""}
                  </option>
                ))}
            </select>
          </Field>
          <label className={ui.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(setting.budgetId && setting.budgetDifference)}
              disabled={!setting.budgetId}
              onChange={(event) => setSetting({ ...setting, budgetDifference: event.target.checked })}
            />{" "}
            Actual less budget
          </label>
        </div>
      ) : null}
      <div className={ui.actions}>
        <Button onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save columns"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function NoteBlock({
  block,
  editable,
  busy,
  onSave,
}: {
  block: Extract<ComputedBlock, { kind: "text" }>;
  editable: boolean;
  busy: boolean;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(block.text);
  if (!editable) return <p className={ui.reportNote}>{block.text}</p>;
  return (
    <>
      <textarea
        className={ui.noteInput}
        data-print="hide"
        aria-label="Note"
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        maxLength={CUSTOM_REPORT_LIMITS.noteLength}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() && text.trim() !== block.text) onSave(text.trim());
        }}
      />
      <p className={`${ui.reportNote} ${ui.printOnly}`}>{block.text}</p>
    </>
  );
}

export function CustomReportPage({ organisationId, reportId }: { organisationId: string; reportId: string }) {
  const router = useRouter();
  const { can, current } = useWorkspace();
  const loaded = useApiData<Loaded>(`/api/custom-reports/${encodeURIComponent(reportId)}`, { organisationId });
  const accounts = useAccounts(organisationId, true);
  const tracking = useTracking(organisationId);
  const budgets = useApiData<{ budgets: Budget[] }>("/api/budgets", { organisationId });
  const [state, setState] = useState<Loaded | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishKey, setPublishKey] = useState(() => newIdempotencyKey("custom-report-publish"));
  const [title, setTitle] = useState<string | null>(null);

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const { report, figures } = state ?? loaded.data;
  const editable = report.kind === "draft" && !report.archivedAt && can("bookkeeper");
  const titleValue = title ?? report.title;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  /** Applies a change to a copy of the layout and saves it; the new figures come back. */
  function change(apply: (layout: CustomReportLayout) => boolean | void, after?: () => void) {
    const layout = structuredClone(report.layout);
    if (apply(layout) === false) return;
    void run(async () => {
      const saved = await api<Loaded>(`/api/custom-reports/${report.id}`, { method: "PUT", body: { organisationId, layout, version: report.version } });
      setState(saved);
      setTitle(null);
      after?.();
    });
  }

  function saveRow(blockId: string, row: ReportRow, isNew: boolean) {
    change(
      (layout) => {
        const table = layout.blocks.find((block) => block.id === blockId) as Extract<ReportBlock, { kind: "table" }>;
        if (isNew) table.rows.push(row);
        else table.rows[table.rows.findIndex((entry) => entry.id === row.id)] = row;
      },
      () => setEditing(null),
    );
  }

  function moveBlock(id: string, by: -1 | 1) {
    change((layout) => move(layout.blocks, layout.blocks.findIndex((block) => block.id === id), by));
  }
  function deleteBlock(id: string, what: string) {
    if (!window.confirm(`Delete this ${what}?`)) return;
    change((layout) => {
      layout.blocks.splice(layout.blocks.findIndex((block) => block.id === id), 1);
    });
  }

  const publish = () =>
    run(async () => {
      const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/publish`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: publishKey },
      });
      setPublishKey(newIdempotencyKey("custom-report-publish"));
      router.push(pageHref(result.report.id));
    });
  const setArchived = (archived: boolean) =>
    run(async () => {
      const result = await api<{ report: CustomReport }>(`/api/custom-reports/${report.id}/archive`, { method: "POST", body: { organisationId, archived } });
      setState({ report: result.report, figures });
      setMessage(archived ? "Archived. It's under Reports › Archived." : "Brought back.");
    });
  const remove = () => {
    if (!window.confirm(`Delete the draft ${report.title}? Published copies of it stay.`)) return;
    void run(async () => {
      await api(`/api/custom-reports/${report.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/reports?view=drafts");
    });
  };

  const tableBlocks = new Map(report.layout.blocks.filter((block) => block.kind === "table").map((block) => [block.id, block as Extract<ReportBlock, { kind: "table" }>]));
  const editingTable = editing?.kind === "row" ? tableBlocks.get(editing.blockId) : undefined;

  return (
    <>
      <div className={ui.actions} data-print="hide">
        <Link href={`/operations/reports?view=${report.archivedAt ? "archived" : report.kind === "published" ? "published" : "drafts"}`}>← Reports</Link>
        {report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}
        {report.archivedAt ? <Badge tone="amber">Archived</Badge> : null}
      </div>
      <div data-print="hide">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
      </div>
      {report.kind === "published" ? (
        <div data-print="hide">
          <Notice tone="info">
            A frozen copy, published {formatDateTime(report.publishedAt)} by {report.publishedByEmail}. Its figures are as they were then and never change.
            {report.publishedFromId ? (
              <>
                {" "}
                <Link href={pageHref(report.publishedFromId)}>Open its draft</Link>
              </>
            ) : null}
          </Notice>
        </div>
      ) : null}
      <div className={ui.toolbar} data-print="hide">
        {editable ? (
          <>
            <Button size="small" variant="secondary" disabled={busy} onClick={() => setEditing({ kind: "columns" })}>
              Columns…
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => change((layout) => void layout.blocks.push({ id: newLayoutId("t"), kind: "table", title: "New table", rows: [] }))}
            >
              Add table
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => change((layout) => void layout.blocks.push({ id: newLayoutId("n"), kind: "text", text: "Notes" }))}
            >
              Add note
            </Button>
            <Button size="small" disabled={busy} onClick={() => void publish()}>
              Publish
            </Button>
          </>
        ) : null}
        <Button size="small" variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        {can("bookkeeper") ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void setArchived(!report.archivedAt)}>
            {report.archivedAt ? "Bring back" : "Archive"}
          </Button>
        ) : null}
        {can("bookkeeper") && report.kind === "draft" ? (
          <Button size="small" variant="danger" disabled={busy} onClick={remove}>
            Delete
          </Button>
        ) : null}
        {busy ? <span className={ui.muted}>Saving…</span> : null}
      </div>

      {editing?.kind === "columns" ? (
        <ColumnsEditor
          base={report.base}
          initial={report.layout.columns}
          initialFilter={report.layout.filter ?? null}
          tracking={tracking.data}
          budgets={budgets.data?.budgets ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(setting, filter) =>
            change(
              (layout) => {
                layout.columns = setting;
                if (filter) layout.filter = filter;
                else delete layout.filter;
              },
              () => setEditing(null),
            )
          }
        />
      ) : null}
      {editing?.kind === "row" && editingTable ? (
        <RowEditor
          key={editing.row.id}
          base={report.base}
          table={editingTable}
          initial={editing.row}
          isNew={editing.isNew}
          accounts={accounts.data?.accounts ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(row) => saveRow(editing.blockId, row, editing.isNew)}
        />
      ) : null}

      <article className={ui.reportPaper}>
        <header className={ui.reportPaperHeader}>
          {editable ? (
            <input
              data-print="hide"
              className={ui.reportTitleInput}
              aria-label="Report title"
              value={titleValue}
              maxLength={CUSTOM_REPORT_LIMITS.titleLength}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                if (titleValue.trim() && titleValue.trim() !== report.title) change((layout) => void (layout.title = titleValue.trim()));
                else setTitle(null);
              }}
            />
          ) : null}
          <h2 className={`${ui.reportPaperTitle} ${editable ? ui.printOnly : ""}`}>{report.title}</h2>
          <p className={ui.reportPaperMeta}>
            {current?.displayName}
            <br />
            {CUSTOM_REPORT_BASES[report.base]} · {periodSummary(figures)} · {figures.currencyCode}
            {figures.filterLabel ? (
              <>
                <br />
                Only lines tagged {figures.filterLabel}
              </>
            ) : null}
          </p>
        </header>
        {figures.blocks.map((block) => (
          <section key={block.id} className={ui.reportPaperBlock}>
            {editable ? (
              <div className={ui.blockTools} data-print="hide">
                <span className={ui.muted}>{block.kind === "table" ? "Table" : "Note"}</span>
                <RowButtons
                  label={block.kind === "table" ? "this table" : "this note"}
                  disabled={busy}
                  onUp={() => moveBlock(block.id, -1)}
                  onDown={() => moveBlock(block.id, 1)}
                  onDelete={() => deleteBlock(block.id, block.kind === "table" ? "table and its rows" : "note")}
                />
              </div>
            ) : null}
            {block.kind === "table" ? (
              <ReportTable
                key={`${block.id}:${report.version}`}
                block={block}
                figures={figures}
                layoutBlock={tableBlocks.get(block.id)}
                editable={editable}
                busy={busy}
                onChange={(apply) => change(apply)}
                onEditRow={(row, isNew) => setEditing({ kind: "row", blockId: block.id, row, isNew })}
                onError={setError}
              />
            ) : (
              <NoteBlock
                key={`${block.id}:${report.version}`}
                block={block}
                editable={editable}
                busy={busy}
                onSave={(text) =>
                  change((layout) => {
                    const note = layout.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "text" }>;
                    note.text = text;
                  })
                }
              />
            )}
          </section>
        ))}
        {figures.blocks.length === 0 ? <Empty>This report has no tables or notes.</Empty> : null}
        {figures.notInReport.length > 0 ? (
          <Notice tone="warning">
            <strong>Not in this report:</strong> these accounts have amounts but aren&apos;t in any group, so the report doesn&apos;t add up to the ledger.
            <ul>
              {figures.notInReport.map((line) => (
                <li key={line.code}>
                  {line.code} · {line.name}:{" "}
                  {figures.columns
                    .filter((column) => column.kind === "period" || column.kind === "year_to_date")
                    .map((column) => `${column.label} ${line.values[column.key]}`)
                    .join(", ")}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {figures.inSeveralGroups.length > 0 ? (
          <Notice tone="warning">
            <strong>Counted more than once:</strong>
            <ul>
              {figures.inSeveralGroups.map((entry) => (
                <li key={`${entry.tableTitle}:${entry.code}`}>
                  {entry.code} · {entry.name} is in {entry.groups.join(" and ")}
                  {entry.tableTitle ? ` (${entry.tableTitle})` : ""}.
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <p className={ui.reportPaperFooter}>
          {report.kind === "published" ? `Published ${formatDateTime(report.publishedAt)}.` : `Worked out ${formatDateTime(figures.computedAt)} from the ledger.`}
        </p>
      </article>
    </>
  );
}
