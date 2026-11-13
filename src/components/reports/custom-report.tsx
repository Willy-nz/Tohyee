"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import { useAccounts } from "@/components/books";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { reportCategories, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { ACCOUNT_TYPES, type AccountType } from "@/lib/accounts/types";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDateTime, todayInBrowser, personName } from "@/lib/format";
import type { CustomReport, CustomReportView } from "@/lib/reports/custom";
import type { AnyCustomReportFigures } from "@/lib/reports/custom";
import {
  type ComputedBlock,
  CUSTOM_REPORT_BASES,
  isEquityLayout,
  isTransactionReportBase,
  CUSTOM_REPORT_LIMITS,
  type CustomReportBase,
  type CustomReportFigures,
  type CustomReportLayout,
  type FinancialReportBase,
  type FormulaTerm,
  FORMULA_OPERATIONS,
  type FormulaOperation,
  groupAccounts,
  moveAccounts,
  lastDayOfMonth,
  moveRow,
  newLayoutId,
  PERIOD_LENGTHS,
  type PeriodLength,
  type ReportBlock,
  type ReportColumnsSetting,
  type AddedColumn,
  type AddedColumnKind,
  ADDED_COLUMN_KINDS,
  addedColumnKey,
  type ReportRow,
  type ReportTrackingFilter,
} from "@/lib/reports/custom-layout";
import type { TrackingSetup } from "@/lib/tracking/service";
import type { Budget } from "@/lib/budgets/service";
import { useConfirm } from "@/components/confirm-dialog";
import { statementAsAt, statementPeriod } from "@/lib/reports/report-dates";
import { InfoTip } from "@/components/info-tip";
import { CustomFiguresTable, type RowEditor } from "@/components/reports/custom-report-table";
import { CashFlowCustomReportPage } from "@/components/reports/cash-flow-custom-report";
import { EquityCustomReportPage } from "@/components/reports/equity-custom-report";
import { TransactionCustomReportPage } from "@/components/reports/transaction-custom-report";
import { MoreMenu, type MoreMenuItem } from "@/components/more-menu";
import { ExportMenu } from "@/components/reports/report-export";

/**
 * Custom reports (examples CR1-CR10): the lists (drafts, published,
 * archived), starting one from a standard report, and the report page, which
 * is also its editor while it's a draft.
 */

type Loaded = { report: CustomReport; figures: AnyCustomReportFigures };

const pageHref = (id: string) => `/operations/reports/custom/${id}`;

/** What each starting point gives (CRS1). */
const START_TEXT: Partial<Record<CustomReportBase, string>> = {
  profit_and_loss: "Revenue, cost of sales, gross profit, other income, expenses and net profit.",
  balance_sheet: "Assets, liabilities, net assets, equity, earnings and total equity.",
  cash_flows: "Operating, investing and financing, then the net change and cash at the start and end.",
  trial_balance: "Every account's debit or credit balance at the end of this month.",
  inventory_valuation: "Each stock item's quantity, average cost and value today.",
  bank_reconciliation: "Your first bank account at the end of this month. Save one from the Bank reconciliation report to choose the account.",
  budget_vs_actual: "Your latest budget against actuals this financial year. Save one from the Budget vs actual report to choose the budget.",
  changes_in_equity: "Equity at the start, profit, owner money in and out, and equity at the end.",
};

export function StartCustomReport({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [keys] = useState(() => Object.fromEntries(Object.keys(CUSTOM_REPORT_BASES).map((base) => [base, newIdempotencyKey("custom-report")])) as Record<CustomReportBase, string>);
  const [busy, setBusy] = useState<CustomReportBase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [ledgerKey] = useState(() => newIdempotencyKey("custom-report"));

  async function start(base: CustomReportBase, generalLedger = false) {
    setBusy(base);
    setError(null);
    const periodEnd = lastDayOfMonth(todayInBrowser());
    try {
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: generalLedger
          ? {
              organisationId,
              source: "ui",
              idempotencyKey: ledgerKey,
              base,
              layout: {
                title: "General ledger",
                filters: {
                  from: null,
                  to: periodEnd,
                  accountId: null,
                  trackingCategoryId: null,
                  trackingValueId: null,
                },
                columns: ["date", "source", "description", "debit", "credit", "balance"],
              },
            }
          : {
              organisationId,
              source: "ui",
              idempotencyKey: keys[base],
              base,
              periodEnd,
            },
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
            <p className={ui.muted}>{START_TEXT[base] ?? "Save the report's filters and columns as a new editable custom report."}</p>
            <Button onClick={() => void start(base)} disabled={busy !== null}>
              {busy === base ? "Starting…" : "Start from this"}
            </Button>
          </div>
        ))}
        <div className={ui.stat}>
          <div className={ui.statLabel}>Start from</div>
          <div className={ui.statValue}>General ledger</div>
          <p className={ui.muted}>Every account with a balance or lines this financial year: opening, lines and closing.</p>
          <Button onClick={() => void start("account_transactions", true)} disabled={busy !== null}>
            Start from this
          </Button>
        </div>
        <div className={ui.stat}>
          <div className={ui.statLabel}>Start from</div>
          <div className={ui.statValue}>Annual financial statements</div>
          <p className={ui.muted}>Built from your profit and loss, balance sheet, changes in equity and cash flows layouts: edit them with Edit layout beside each statement.</p>
          <Link className={`${ui.button} ${ui.secondary}`} href="/operations/reports?report=statements">
            Open the statements
          </Link>
        </div>
      </div>
    </Card>
  );
}

export function CustomReportList({ organisationId, view }: { organisationId: string; view: CustomReportView }) {
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const [version, setVersion] = useState(0);
  const list = useApiData<{ reports: CustomReport[] }>("/api/custom-reports", {
    organisationId,
    view,
    v: version,
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drafts can be deleted (CR7), a few at a time or all at once; published copies are archived instead.
  const deletable = (list.data?.reports ?? []).filter((report) => report.kind === "draft");
  const canDelete = can("bookkeeper") && deletable.length > 0;
  async function remove(ids: string[]) {
    const titles = deletable.filter((report) => ids.includes(report.id)).map((report) => report.title);
    if (ids.length === 0) return;
    const ok = await confirm(ids.length === 1 ? `Delete the draft "${titles[0]}"? This can't be undone.` : `Delete these ${ids.length} drafts? This can't be undone.`, {
      title: ids.length === 1 ? "Delete draft" : "Delete drafts",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of ids)
        await api(`/api/custom-reports/${id}`, {
          method: "DELETE",
          query: { organisationId },
        });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setChosen([]);
      setBusy(false);
      setVersion((value) => value + 1);
    }
  }
  const empty = {
    drafts: "No draft reports. Start one under Custom.",
    published: "No published reports. Publish a draft to keep a copy that never changes.",
    archived: "Nothing archived.",
  }[view];
  return (
    <Card
      title={{ drafts: "Drafts", published: "Published", archived: "Archived" }[view]}
      actions={
        canDelete ? (
          <Button variant="secondary" disabled={busy || chosen.length === 0} onClick={() => void remove(chosen)}>
            {chosen.length > 0 ? `Delete ${chosen.length} selected` : "Delete selected"}
          </Button>
        ) : undefined
      }
    >
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.reports.length === 0 ? <Empty>{empty}</Empty> : null}
      {list.data && list.data.reports.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                {canDelete ? (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select every draft"
                      checked={chosen.length > 0 && chosen.length === deletable.length}
                      onChange={(event) => setChosen(event.target.checked ? deletable.map((report) => report.id) : [])}
                    />
                  </th>
                ) : null}
                <th>Title</th>
                <th>Started from</th>
                <th>{view === "published" ? "Published" : "Last changed"}</th>
                {view === "archived" ? <th>Was</th> : null}
                {canDelete ? <th aria-label="Delete" /> : null}
              </tr>
            </thead>
            <tbody>
              {list.data.reports.map((report) => (
                <tr key={report.id}>
                  {canDelete ? (
                    <td>
                      {report.kind === "draft" ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${report.title}`}
                          checked={chosen.includes(report.id)}
                          onChange={(event) => setChosen(event.target.checked ? [...chosen, report.id] : chosen.filter((id) => id !== report.id))}
                        />
                      ) : null}
                    </td>
                  ) : null}
                  <td>
                    <Link href={pageHref(report.id)}>{report.title}</Link>
                  </td>
                  <td>{CUSTOM_REPORT_BASES[report.base]}</td>
                  <td>
                    {formatDateTime(report.publishedAt ?? report.updatedAt)} · {personName(report, "publishedBy") ?? personName(report, "updatedBy") ?? ""}
                  </td>
                  {view === "archived" ? <td>{report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}</td> : null}
                  {canDelete ? (
                    <td>
                      {report.kind === "draft" ? (
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => void remove([report.id])}>
                          Delete
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

/** The report's period in the statement's words (decision 1350). */
function periodSummary(figures: CustomReportFigures): string {
  const periods = figures.columns.filter((column) => column.kind === "period");
  if (periods.length === 0) return "";
  // p0 is the chosen period, wherever the order puts it (decision 1366).
  const newest = periods.find((column) => column.key === "p0") ?? periods[0];
  if (figures.base === "balance_sheet") {
    return periods.length === 1 ? statementAsAt(newest.to!) : `${statementAsAt(newest.to!)}, compared with ${periods.length - 1} earlier date${periods.length > 2 ? "s" : ""}`;
  }
  return periods.length === 1
    ? statementPeriod(newest.from!, newest.to!)
    : `${statementPeriod(newest.from!, newest.to!)}, compared with ${periods.length - 1} earlier period${periods.length > 2 ? "s" : ""}`;
}

type Editing =
  | {
      kind: "row";
      blockId: string;
      row: ReportRow;
      isNew: boolean;
      after?: string;
    }
  | { kind: "columns" }
  | null;

/** What's picked in the layout editor, to change in Details (LE1). */
type Picked = { kind: "row"; blockId: string; rowId: string } | { kind: "block"; blockId: string } | { kind: "columns" } | null;

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
  onEditNote,
  onError,
  filter,
  onPick,
  pickedRowId,
  onPickColumns,
}: {
  filter?: ReportTrackingFilter | null;
  block: Extract<ComputedBlock, { kind: "table" }>;
  figures: CustomReportFigures;
  layoutBlock: Extract<ReportBlock, { kind: "table" }> | undefined;
  editable: boolean;
  busy: boolean;
  onChange: (change: (layout: CustomReportLayout) => boolean | void) => void;
  onEditRow: (row: ReportRow, isNew: boolean) => void;
  onEditNote: (row: ReportRow) => void;
  onError: (message: string) => void;
  onPick?: (rowId: string) => void;
  pickedRowId?: string | null;
  onPickColumns?: () => void;
}) {
  const confirm = useConfirm();
  const [title, setTitle] = useState(block.title);
  const tableOf = (layout: CustomReportLayout) => layout.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "table" }>;
  const rowOf = (layout: CustomReportLayout, id: string) => tableOf(layout).rows.find((r) => r.id === id)!;
  const [announce, setAnnounce] = useState("");
  /** Just this table, for checking a change before it's made. */
  const figuresLayout = (rows: ReportRow[]): CustomReportLayout => ({ title: "", columns: {} as CustomReportLayout["columns"], blocks: [{ id: block.id, kind: "table", title: block.title, rows }] });

  const editor: RowEditor | undefined = editable
    ? {
        busy,
        select: onPick,
        selectedId: pickedRowId,
        selectColumns: onPickColumns,
        rename: (rowId, label) => onChange((layout) => void (rowOf(layout, rowId).label = label)),
        move: (rowId, toIndex) => {
          const rows = layoutBlock?.rows ?? [];
          if (toIndex < 0 || toIndex >= rows.length) return;
          onChange((layout) => {
            const moved = moveRow(layout, block.id, rowId, toIndex);
            layout.blocks = moved.blocks;
          });
          const row = rows.find((entry) => entry.id === rowId);
          setAnnounce(`${row?.label ?? "Row"} moved to row ${toIndex + 1} of ${rows.length}.`);
          // Keep focus on the handle the person is using.
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[aria-label^="Move ${CSS.escape(row?.label ?? "")}, row"]`)?.focus());
        },
        group: (rowId, codes, label) =>
          onChange((layout) => {
            const grouped = groupAccounts(layout, block.id, rowId, codes, label);
            layout.blocks = grouped.layout.blocks;
          }),
        moveAccounts: (fromRowId, codes, toRowId) => {
          const rows = layoutBlock?.rows ?? [];
          const to = rows.find((entry) => entry.id === toRowId);
          try {
            // Checked first, so a refusal (the group's last account) shows as a message.
            moveAccounts(figuresLayout(rows), block.id, fromRowId, codes, toRowId);
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : "Those accounts can't be moved there.");
            return;
          }
          onChange((layout) => {
            layout.blocks = moveAccounts(layout, block.id, fromRowId, codes, toRowId).blocks;
          });
          setAnnounce(`${codes.length} ${codes.length === 1 ? "account" : "accounts"} moved to ${to?.label ?? "the group"}.`);
        },
        rowMenu: (row) => {
          const layoutRow = layoutBlock?.rows.find((entry) => entry.id === row.id);
          if (!layoutRow) return [];
          const toggle = (field: "hidden" | "pageBreakAfter") =>
            onChange((layout) => {
              const target = rowOf(layout, row.id);
              if (target[field]) delete target[field];
              else target[field] = true;
            });
          return [
            ...(layoutRow.kind !== "heading"
              ? [
                  {
                    label: "Change…",
                    onSelect: () => onEditRow(structuredClone(layoutRow), false),
                  },
                ]
              : []),
            {
              label: layoutRow.hidden ? "Show" : "Hide",
              onSelect: () => toggle("hidden"),
            },
            {
              label: layoutRow.pageBreakAfter ? "No page break after" : "Page break after",
              onSelect: () => toggle("pageBreakAfter"),
            },
            {
              label: layoutRow.note ? "Change note…" : "Add note…",
              onSelect: () => onEditNote(structuredClone(layoutRow)),
            },
            {
              label: "Delete",
              danger: true,
              onSelect: async () => {
                const users = (layoutBlock?.rows ?? []).filter((r) => r.kind === "formula" && formulaRows(r).includes(row.id));
                if (users.length > 0) {
                  onError(
                    `${users.map((r) => r.label).join(" and ")} ${users.length === 1 ? "uses" : "use"} ${row.label}. Change or delete ${users.length === 1 ? "it" : "them"} first.`,
                  );
                  return;
                }
                if (!(await confirm(`Delete the row ${row.label}?`))) return;
                onChange((layout) => {
                  const rows = tableOf(layout).rows;
                  rows.splice(
                    rows.findIndex((r) => r.id === row.id),
                    1,
                  );
                });
              },
            },
          ];
        },
      }
    : undefined;

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
      <CustomFiguresTable id={`custom-report-${block.id}`} block={block} figures={figures} filter={filter} editor={editor} />
      <p className={ui.srOnly} role="status" aria-live="polite">
        {announce}
      </p>
      {editable ? (
        <div className={ui.actions} data-print="hide">
          <span className={ui.muted}>Add a row:</span>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              onEditRow(
                {
                  id: newLayoutId("r"),
                  kind: "group",
                  label: "",
                  accountTypes: [],
                  accountCodes: [],
                  showAccounts: true,
                },
                true,
              )
            }
          >
            Group of accounts
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => onEditRow({ id: newLayoutId("r"), kind: "formula", label: "", terms: [] }, true)}>
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
              onClick={() =>
                onEditRow(
                  {
                    id: newLayoutId("r"),
                    kind: "earnings",
                    label: "Current year earnings",
                    which: "current",
                  },
                  true,
                )
              }
            >
              Earnings
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The rows a formula uses (browser-side copy of the server's check). */
function formulaRows(row: Extract<ReportRow, { kind: "formula" }>): string[] {
  return (row.operation ?? "sum") === "sum" ? row.terms.map((term) => term.rowId) : [row.a ?? "", ...(row.b ? [row.b] : [])];
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
  // Rows a formula can use: not headings, and not a % (CR17).
  const others = table.rows.filter((entry) => entry.id !== row.id && entry.kind !== "heading" && !(entry.kind === "formula" && entry.operation === "percent"));
  const kindName = {
    group: "group of accounts",
    formula: "formula",
    heading: "heading",
    earnings: "earnings row",
  }[row.kind];

  function save() {
    if (!row.label.trim()) return setError("Give the row a name.");
    if (row.kind === "group") {
      const cleaned = byCode ? { ...row, accountTypes: [] } : { ...row, accountCodes: [] };
      if (cleaned.accountTypes.length === 0 && cleaned.accountCodes.length === 0) return setError("Tick the account types or accounts in this group.");
      return onSave({ ...cleaned, label: row.label.trim() });
    }
    if (row.kind === "formula" && (row.operation ?? "sum") === "sum" && row.terms.length === 0) return setError("Add at least one row to the formula.");
    if (row.kind === "formula" && (row.operation ?? "sum") !== "sum") {
      if (!row.a) return setError("Choose the first row.");
      if (!row.b && !row.by) return setError(row.operation === "percent" ? "Choose the row it's a % of." : "Choose the second row, or type a number.");
      if (row.by && !/^-?\d+(\.\d+)?$/.test(row.by)) return setError(`${row.by} isn't a number.`);
    }
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
                <input type="checkbox" checked={row.showAccounts} onChange={(event) => setRow({ ...row, showAccounts: event.target.checked })} /> Show each account (otherwise just
                the total)
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
                        onChange={() =>
                          setRow({
                            ...row,
                            accountCodes: toggle(row.accountCodes, account.code),
                          })
                        }
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
                    <input
                      type="checkbox"
                      checked={row.accountTypes.includes(type)}
                      onChange={() =>
                        setRow({
                          ...row,
                          accountTypes: toggle(row.accountTypes, type),
                        })
                      }
                    />
                    {ACCOUNT_TYPES[type].label}
                  </label>
                ))}
              </div>
            )}
            <p className={ui.muted}>
              Amounts are shown the way the standard reports show them: income as a plus, costs as a plus. To take one from the other, put them in separate groups and add a
              formula.
            </p>
          </>
        ) : null}
        {row.kind === "formula" ? (
          <Field label="Works out">
            <select
              value={row.operation ?? "sum"}
              onChange={(event) => {
                const operation = event.target.value as FormulaOperation;
                setRow(
                  operation === "sum"
                    ? {
                        id: row.id,
                        kind: "formula",
                        label: row.label,
                        terms: row.terms,
                      }
                    : {
                        id: row.id,
                        kind: "formula",
                        label: row.label,
                        terms: [],
                        operation,
                        a: row.a ?? others[0]?.id,
                        b: row.b ?? others[1]?.id ?? others[0]?.id,
                      },
                );
              }}
            >
              {(Object.keys(FORMULA_OPERATIONS) as FormulaOperation[]).map((operation) => (
                <option key={operation} value={operation}>
                  {FORMULA_OPERATIONS[operation]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {row.kind === "formula" && (row.operation ?? "sum") !== "sum" ? (
          <div className={ui.actions}>
            <select aria-label="First row" value={row.a ?? ""} onChange={(event) => setRow({ ...row, a: event.target.value })}>
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
            <span>{row.operation === "multiply" ? "×" : row.operation === "divide" ? "÷" : "% of"}</span>
            <select
              aria-label="Second row"
              value={row.by ? "" : (row.b ?? "")}
              onChange={(event) =>
                setRow({
                  ...row,
                  b: event.target.value || undefined,
                  by: event.target.value ? undefined : (row.by ?? "1"),
                })
              }
            >
              {row.operation !== "percent" ? <option value="">A number</option> : null}
              {others.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
            {row.operation !== "percent" && !row.b ? (
              <input aria-label="Number" inputMode="decimal" value={row.by ?? ""} onChange={(event) => setRow({ ...row, by: event.target.value })} style={{ maxWidth: 120 }} />
            ) : null}
            <InfoTip label="How it's worked out">
              In decimal maths. Money is rounded to the cent and a % to one decimal place, halves away from zero. Dividing by 0.00 shows a blank.
            </InfoTip>
          </div>
        ) : null}
        {row.kind === "formula" && (row.operation ?? "sum") === "sum" ? (
          <>
            {row.terms.length === 0 ? <p className={ui.muted}>No rows yet.</p> : null}
            {row.terms.map((term, index) => (
              <div key={index} className={ui.actions}>
                <select
                  aria-label="Add or subtract"
                  value={term.sign}
                  onChange={(event) => {
                    const terms = [...row.terms];
                    terms[index] = {
                      ...term,
                      sign: Number(event.target.value) as 1 | -1,
                    };
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
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    setRow({
                      ...row,
                      terms: row.terms.filter((_, i) => i !== index),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {others.length > 0 ? (
              <div>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() =>
                    setRow({
                      ...row,
                      terms: [...row.terms, { rowId: others[0].id, sign: 1 } satisfies FormulaTerm],
                    })
                  }
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
            <select
              value={row.which}
              onChange={(event) =>
                setRow({
                  ...row,
                  which: event.target.value as "previous" | "current",
                })
              }
            >
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
  rows,
  busy,
  onSave,
  onCancel,
}: {
  base: CustomReportBase;
  initial: ReportColumnsSetting;
  initialFilter: ReportTrackingFilter | null;
  tracking: TrackingSetup | null;
  budgets: Budget[];
  /** The report's rows, for a Percentage column (LE8). */
  rows: Array<{ id: string; label: string }>;
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
            onChange={(event) =>
              event.target.value &&
              setSetting({
                ...setting,
                periodEnd: lastDayOfMonth(`${event.target.value}-01`),
              })
            }
            required
          />
        </Field>
        <Field label="Each column is">
          <select
            value={setting.periodLength}
            onChange={(event) =>
              setSetting({
                ...setting,
                periodLength: event.target.value as PeriodLength,
              })
            }
          >
            {(Object.keys(PERIOD_LENGTHS) as PeriodLength[]).map((length) => (
              <option key={length} value={length}>
                {
                  {
                    month: "A month",
                    quarter: "A quarter (3 months)",
                    year: "A year (12 months)",
                  }[length]
                }
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
            onChange={(event) =>
              setSetting({
                ...setting,
                periodCount: Math.max(1, Math.min(CUSTOM_REPORT_LIMITS.periods, Number(event.target.value) || 1)),
              })
            }
          />
        </Field>
      </div>
      <div className={ui.actions}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={setting.difference} onChange={(event) => setSetting({ ...setting, difference: event.target.checked })} /> Difference (newest less the one
          before)
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
            <input type="checkbox" checked={setting.yearToDate} onChange={(event) => setSetting({ ...setting, yearToDate: event.target.checked })} /> Year to date
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
            <select
              value={setting.budgetId ?? ""}
              onChange={(event) =>
                setSetting({
                  ...setting,
                  budgetId: event.target.value || undefined,
                })
              }
            >
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
              onChange={(event) =>
                setSetting({
                  ...setting,
                  budgetDifference: event.target.checked,
                })
              }
            />{" "}
            Actual less budget
          </label>
        </div>
      ) : null}
      <AddedColumnsEditor base={base} setting={setting} rows={rows} budgets={budgets} onChange={(added) => setSetting({ ...setting, added })} />
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

/** A row's text in a Notes column (LE7), saved when the box loses focus. */
function NotesCellInput({ label, value, busy, onSave }: { label: string; value: string; busy: boolean; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Field label={`${label} column`}>
      <input
        value={text}
        disabled={busy}
        maxLength={CUSTOM_REPORT_LIMITS.cellLength}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() !== value) onSave(text.trim());
        }}
      />
    </Field>
  );
}

/** The columns a column added at `index` can use (LE4): the usual ones, then money columns added before it. */
function usableColumns(setting: ReportColumnsSetting, index: number): Array<{ key: string; label: string }> {
  const out = Array.from({ length: setting.periodCount }, (_, at) => ({ key: `p${at}`, label: at === 0 ? "Newest period" : `Period ${at + 1} (earlier)` }));
  if (setting.difference) out.push({ key: "diff", label: "Difference" });
  if (setting.yearToDate) out.push({ key: "ytd", label: "Year to date" });
  if (setting.budgetId) out.push({ key: "bud", label: "Budget" });
  if (setting.budgetId && setting.budgetDifference) out.push({ key: "bdiff", label: "Actual less budget" });
  for (const column of (setting.added ?? []).slice(0, index)) {
    if (column.kind === "date" || column.kind === "budget" || column.kind === "formula" || (column.kind === "variance" && !column.percentOfSecond)) {
      out.push({ key: addedColumnKey(column), label: column.heading || ADDED_COLUMN_KINDS[column.kind] });
    }
  }
  return out;
}

/** Add column (LE4-LE9): Date, Budget, Formula, Notes, Percentage and Variance columns after the usual ones. */
function AddedColumnsEditor({
  base,
  setting,
  rows,
  budgets,
  onChange,
}: {
  base: CustomReportBase;
  setting: ReportColumnsSetting;
  rows: Array<{ id: string; label: string }>;
  budgets: Budget[];
  onChange: (added: AddedColumn[]) => void;
}) {
  const added = setting.added ?? [];
  const monthStart = `${setting.periodEnd.slice(0, 7)}-01`;
  const kinds = (Object.keys(ADDED_COLUMN_KINDS) as AddedColumnKind[]).filter((kind) => base === "profit_and_loss" || kind !== "budget");
  const update = (index: number, column: AddedColumn) => onChange(added.map((entry, at) => (at === index ? column : entry)));
  function add(kind: AddedColumnKind) {
    const id = newLayoutId("c");
    const from = base === "balance_sheet" ? null : monthStart;
    const column: AddedColumn =
      kind === "date"
        ? { id, kind, from, to: setting.periodEnd }
        : kind === "budget"
          ? { id, kind, budgetId: budgets.find((budget) => !budget.archivedAt)?.id ?? "", from: monthStart, to: setting.periodEnd }
          : kind === "formula"
            ? { id, kind, terms: [{ column: "p0", sign: 1 }] }
            : kind === "notes"
              ? { id, kind }
              : kind === "percentage"
                ? { id, kind, column: "p0", ofRowId: rows[0]?.id ?? "" }
                : { id, kind, first: "p0", second: setting.periodCount > 1 ? "p1" : "p0" };
    onChange([...added, column]);
  }
  const columnSelect = (index: number, value: string, label: string, set: (value: string) => void) => (
    <Field label={label}>
      <select value={value} onChange={(event) => set(event.target.value)}>
        {usableColumns(setting, index).map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
      {added.map((column, index) => (
        <div key={column.id} style={{ display: "grid", gap: 8, padding: 12, border: "1px solid var(--border)", borderRadius: 6 }}>
          <strong>{ADDED_COLUMN_KINDS[column.kind]} column</strong>
          <Field label="Heading" hint="Blank uses a heading of its own.">
            <input value={column.heading ?? ""} maxLength={CUSTOM_REPORT_LIMITS.labelLength} onChange={(event) => update(index, { ...column, heading: event.target.value || undefined })} />
          </Field>
          {column.kind === "date" || column.kind === "budget" ? (
            <>
              {column.kind === "budget" ? (
                <Field label="Budget">
                  <select value={column.budgetId} onChange={(event) => update(index, { ...column, budgetId: event.target.value })}>
                    <option value="">Choose a budget</option>
                    {budgets
                      .filter((budget) => !budget.archivedAt || budget.id === column.budgetId)
                      .map((budget) => (
                        <option key={budget.id} value={budget.id}>
                          {budget.name}
                        </option>
                      ))}
                  </select>
                </Field>
              ) : null}
              {column.from !== null ? (
                <Field label="From">
                  <DateInput value={column.from} onChange={(event) => update(index, { ...column, from: event.target.value } as AddedColumn)} />
                </Field>
              ) : null}
              <Field label={column.from === null ? "As at" : "To"}>
                <DateInput value={column.to} onChange={(event) => update(index, { ...column, to: event.target.value })} />
              </Field>
            </>
          ) : null}
          {column.kind === "formula" ? (
            <>
              {column.terms.map((term, at) => (
                <div key={at} className={ui.actions}>
                  <select
                    aria-label="Add or take away"
                    value={term.sign}
                    onChange={(event) => update(index, { ...column, terms: column.terms.map((entry, k) => (k === at ? { ...entry, sign: Number(event.target.value) as 1 | -1 } : entry)) })}
                  >
                    <option value={1}>+ add</option>
                    <option value={-1}>− take away</option>
                  </select>
                  <select
                    aria-label="Column"
                    value={term.column}
                    onChange={(event) => update(index, { ...column, terms: column.terms.map((entry, k) => (k === at ? { ...entry, column: event.target.value } : entry)) })}
                  >
                    {usableColumns(setting, index).map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                  <Button size="small" variant="secondary" onClick={() => update(index, { ...column, terms: column.terms.filter((_, k) => k !== at) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <div>
                <Button size="small" variant="secondary" onClick={() => update(index, { ...column, terms: [...column.terms, { column: "p0", sign: 1 }] })}>
                  Add a column to it
                </Button>
              </div>
            </>
          ) : null}
          {column.kind === "notes" ? <p className={ui.muted} style={{ margin: 0 }}>Type each row&apos;s text in its Details.</p> : null}
          {column.kind === "percentage" ? (
            <>
              {columnSelect(index, column.column, "Column", (value) => update(index, { ...column, column: value }))}
              <Field label="As a % of the row">
                <select value={column.ofRowId} onChange={(event) => update(index, { ...column, ofRowId: event.target.value })}>
                  {rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : null}
          {column.kind === "variance" ? (
            <>
              {columnSelect(index, column.first, "First column", (value) => update(index, { ...column, first: value }))}
              {columnSelect(index, column.second, "Second column", (value) => update(index, { ...column, second: value }))}
              <label className={ui.checkbox}>
                <input type="checkbox" checked={Boolean(column.percentOfSecond)} onChange={(event) => update(index, { ...column, percentOfSecond: event.target.checked || undefined })} /> % of second
              </label>
            </>
          ) : null}
          <div>
            <Button size="small" variant="secondary" onClick={() => onChange(added.filter((_, at) => at !== index))}>
              Remove this column
            </Button>
          </div>
        </div>
      ))}
      {added.length < CUSTOM_REPORT_LIMITS.addedColumns ? (
        <div>
          <MoreMenu label="Add column" text="Add column" items={kinds.map((kind) => ({ label: ADDED_COLUMN_KINDS[kind], onSelect: () => add(kind) }))} />
        </div>
      ) : null}
    </div>
  );
}

function NoteBlock({ block, editable, busy, onSave }: { block: Extract<ComputedBlock, { kind: "text" }>; editable: boolean; busy: boolean; onSave: (text: string) => void }) {
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

function NoteEditor({ row, busy, onSave, onCancel }: { row: ReportRow; busy: boolean; onSave: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(row.note ?? "");
  return (
    <Card title={`Note on ${row.label}`}>
      <Field label="Note">
        <textarea rows={3} maxLength={CUSTOM_REPORT_LIMITS.rowNoteLength} value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      </Field>
      <div className={ui.actions}>
        <Button onClick={() => onSave(text.trim())} disabled={busy}>
          {text.trim() ? "Keep note" : "Remove note"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function SaveAsForm({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (title: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Card title="Save as a new report">
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <Field label="Name">
          <input value={name} maxLength={CUSTOM_REPORT_LIMITS.titleLength} onChange={(event) => setName(event.target.value)} autoFocus required />
        </Field>
        <Button type="submit" disabled={busy || !name.trim()}>
          Save as
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </Card>
  );
}

/** Whether a report is starred, and a way to star it (decision 1362). */
export function useFavourite(organisationId: string, reportKey: string) {
  const list = useApiData<{ favourites: string[] }>("/api/report-favourites", {
    organisationId,
  });
  const [override, setOverride] = useState<string[] | null>(null);
  const favourites = override ?? list.data?.favourites ?? [];
  const on = favourites.includes(reportKey);
  async function toggle() {
    const result = await api<{ favourites: string[] }>("/api/report-favourites", {
      method: "PUT",
      body: { organisationId, key: reportKey, favourite: !on },
    });
    setOverride(result.favourites);
  }
  return { on, favourites, toggle, loaded: Boolean(list.data) };
}

export function FavouriteButton({ organisationId, reportKey, name }: { organisationId: string; reportKey: string; name: string }) {
  const favourite = useFavourite(organisationId, reportKey);
  return <FavouriteToggle favourite={favourite} name={name} />;
}

/** The star button (aria-pressed), for a favourite state that's shared with a list. */
export function FavouriteToggle({ favourite, name }: { favourite: ReturnType<typeof useFavourite>; name: string }) {
  if (!favourite.loaded) return null;
  return (
    <button
      type="button"
      className={`${ui.button} ${ui.secondary} ${ui.favouriteButton}`}
      aria-pressed={favourite.on}
      aria-label={`Favourite: ${name}`}
      title={favourite.on ? "In your favourites" : "Add to your favourites"}
      onClick={() => void favourite.toggle()}
      data-print="hide"
    >
      <span aria-hidden="true">{favourite.on ? "★" : "☆"}</span>
    </button>
  );
}

export function CustomReportPage({ organisationId, reportId }: { organisationId: string; reportId: string }) {
  const confirm = useConfirm();
  const router = useRouter();
  const fromEditLayout = useSearchParams()?.get("from") === "edit-layout";
  const { can, current } = useWorkspace();
  const loaded = useApiData<Loaded>(`/api/custom-reports/${encodeURIComponent(reportId)}`, { organisationId });
  const accounts = useAccounts(organisationId, true);
  const tracking = useTracking(organisationId);
  const budgets = useApiData<{ budgets: Budget[] }>("/api/budgets", {
    organisationId,
  });
  const defaults = useApiData<{
    defaults: Array<{ base: string; reportId: string }>;
  }>("/api/report-layouts", { organisationId });
  const [defaultsOverride, setDefaultsOverride] = useState<Array<{
    base: string;
    reportId: string;
  }> | null>(null);
  const [state, setState] = useState<Loaded | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [picked, setPicked] = useState<Picked>(null);
  const [sideTab, setSideTab] = useState<"details" | "preview">("details");
  const [noteFor, setNoteFor] = useState<{
    blockId: string;
    row: ReportRow;
  } | null>(null);
  const [saveAs, setSaveAs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishKey, setPublishKey] = useState(() => newIdempotencyKey("custom-report-publish"));
  const [saveAsKey] = useState(() => newIdempotencyKey("custom-report-copy"));
  const [title, setTitle] = useState<string | null>(null);
  // Changes are kept here until Save (decision 1360); the figures shown are a preview of them.
  const [draft, setDraft] = useState<CustomReportLayout | null>(null);
  const [preview, setPreview] = useState<CustomReportFigures | null>(null);

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const currentLoaded = state ?? loaded.data;
  if (isEquityLayout(currentLoaded.report.base, currentLoaded.report.layout)) {
    return <EquityCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  if (isTransactionReportBase(currentLoaded.report.base)) {
    return <TransactionCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  if (currentLoaded.report.base === "cash_flows") {
    return <CashFlowCustomReportPage organisationId={organisationId} loaded={currentLoaded} />;
  }
  const report = currentLoaded.report as CustomReport & {
    base: FinancialReportBase;
    layout: CustomReportLayout;
  };
  const layout = draft ?? report.layout;
  const figures = (draft ? preview : null) ?? (currentLoaded.figures as CustomReportFigures);
  const editable = report.kind === "draft" && !report.archivedAt && can("bookkeeper");
  const titleValue = title ?? layout.title;
  const defaultList = defaultsOverride ?? defaults.data?.defaults ?? [];
  const isDefault = defaultList.some((entry) => entry.reportId === report.id);
  const baseName = CUSTOM_REPORT_BASES[report.base].toLowerCase();

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

  /** Applies a change to a copy of the layout, unsaved, and shows its figures. */
  function change(apply: (layout: CustomReportLayout) => boolean | void, after?: () => void) {
    const next = structuredClone(layout);
    if (apply(next) === false) return;
    void run(async () => {
      const result = await api<{ figures: CustomReportFigures }>(`/api/custom-reports/${report.id}/preview`, { method: "POST", body: { organisationId, layout: next } });
      setDraft(next);
      setPreview(result.figures);
      setTitle(null);
      after?.();
    });
  }

  const save = () =>
    run(async () => {
      if (!draft) return;
      const saved = await api<Loaded>(`/api/custom-reports/${report.id}`, {
        method: "PUT",
        body: { organisationId, layout: draft, version: report.version },
      });
      setState(saved);
      setDraft(null);
      setPreview(null);
      // Started with Edit layout on a report that has no layout of its own yet: Reports shows this one from now on, as in Xero (CR22, decision 1615).
      if (fromEditLayout && !defaultList.some((entry) => entry.base === report.base)) {
        const result = await api<{ defaults: Array<{ base: string; reportId: string }> }>("/api/report-layouts", {
          method: "PUT",
          body: { organisationId, base: report.base, reportId: report.id },
        });
        setDefaultsOverride(result.defaults);
        setMessage(`Saved. Reports now shows the ${baseName} in this layout. To go back to the standard one, choose "Stop using as the ${baseName} layout" under ⋯.`);
        return;
      }
      setMessage("Saved.");
    });

  function saveRow(blockId: string, row: ReportRow, isNew: boolean, after?: string) {
    change(
      (next) => {
        const table = next.blocks.find((block) => block.id === blockId) as Extract<ReportBlock, { kind: "table" }>;
        const at = after ? table.rows.findIndex((entry) => entry.id === after) : -1;
        if (isNew && at >= 0) table.rows.splice(at + 1, 0, row);
        else if (isNew) table.rows.push(row);
        else table.rows[table.rows.findIndex((entry) => entry.id === row.id)] = row;
      },
      () => {
        setEditing(null);
        setPicked({ kind: "row", blockId, rowId: row.id });
      },
    );
  }

  // The layout editor's toolbar (LE1-LE3): each acts on what's picked.
  const pickedBlockId = picked && picked.kind !== "columns" ? picked.blockId : null;
  function insertBlock(block: ReportBlock) {
    change(
      (next) => {
        const at = pickedBlockId ? next.blocks.findIndex((entry) => entry.id === pickedBlockId) : -1;
        if (at >= 0) next.blocks.splice(at + 1, 0, block);
        else next.blocks.push(block);
      },
      () => setPicked({ kind: "block", blockId: block.id }),
    );
  }
  function addSection() {
    const tableId =
      pickedBlockId && layout.blocks.find((entry) => entry.id === pickedBlockId)?.kind === "table" ? pickedBlockId : layout.blocks.find((entry) => entry.kind === "table")?.id;
    if (!tableId) {
      setError("Add a table first: a section goes in a table.");
      return;
    }
    setSideTab("details");
    setEditing({
      kind: "row",
      blockId: tableId,
      row: { id: newLayoutId("r"), kind: "heading", label: "" },
      isNew: true,
      after: picked?.kind === "row" ? picked.rowId : undefined,
    });
  }
  function togglePageBreak() {
    if (!picked || picked.kind === "columns") {
      setError("Pick a row, table or note first, then Page break puts a new page after it.");
      return;
    }
    change((next) => {
      const block = next.blocks.find((entry) => entry.id === picked.blockId);
      if (!block) return false;
      const target: { pageBreakAfter?: boolean } | undefined = picked.kind === "row" && block.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : block;
      if (!target) return false;
      if (target.pageBreakAfter) delete target.pageBreakAfter;
      else target.pageBreakAfter = true;
    });
  }
  function movePicked(by: -1 | 1) {
    if (!picked || picked.kind === "columns") return;
    if (picked.kind === "block") return moveBlock(picked.blockId, by);
    const rows = (layout.blocks.find((entry) => entry.id === picked.blockId) as Extract<ReportBlock, { kind: "table" }> | undefined)?.rows ?? [];
    const index = rows.findIndex((entry) => entry.id === picked.rowId);
    if (index + by < 0 || index + by >= rows.length) return;
    change((next) => {
      next.blocks = moveRow(next, picked.blockId, picked.rowId, index + by).blocks;
    });
  }
  async function deletePicked() {
    if (!picked || picked.kind === "columns") return;
    const block = layout.blocks.find((entry) => entry.id === picked.blockId);
    if (!block) return;
    if (picked.kind === "block") {
      await deleteBlock(block.id, block.kind === "table" ? "table and its rows" : "note");
      setPicked(null);
      return;
    }
    if (block.kind !== "table") return;
    const row = block.rows.find((entry) => entry.id === picked.rowId);
    if (!row) return;
    const users = block.rows.filter((entry) => entry.kind === "formula" && formulaRows(entry).includes(row.id));
    if (users.length > 0) {
      setError(
        `${users.map((entry) => entry.label).join(" and ")} ${users.length === 1 ? "uses" : "use"} ${row.label}. Change or delete ${users.length === 1 ? "it" : "them"} first.`,
      );
      return;
    }
    if (!(await confirm(`Delete the row ${row.label}?`))) return;
    change(
      (next) => {
        const rows = (next.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "table" }>).rows;
        rows.splice(
          rows.findIndex((entry) => entry.id === row.id),
          1,
        );
      },
      () => setPicked(null),
    );
  }
  function cancelChanges() {
    setDraft(null);
    setPreview(null);
    setEditing(null);
    setPicked(null);
    setNoteFor(null);
    setTitle(null);
    setMessage("Changes cancelled.");
  }

  function moveBlock(id: string, by: -1 | 1) {
    change((next) =>
      move(
        next.blocks,
        next.blocks.findIndex((block) => block.id === id),
        by,
      ),
    );
  }
  async function deleteBlock(id: string, what: string) {
    if (!(await confirm(`Delete this ${what}?`))) return;
    change((next) => {
      next.blocks.splice(
        next.blocks.findIndex((block) => block.id === id),
        1,
      );
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
      setState({ report: result.report, figures: currentLoaded.figures });
      setMessage(archived ? "Archived. It's under Reports › Archived." : "Brought back.");
      defaults.reload();
      setDefaultsOverride(null);
    });
  const remove = async () => {
    if (!(await confirm(`Delete the draft ${report.title}? Published copies of it stay.`))) return;
    void run(async () => {
      await api(`/api/custom-reports/${report.id}`, {
        method: "DELETE",
        query: { organisationId },
      });
      router.push("/operations/reports?view=drafts");
    });
  };
  const setDefault = (on: boolean) =>
    run(async () => {
      const result = await api<{
        defaults: Array<{ base: string; reportId: string }>;
      }>("/api/report-layouts", {
        method: "PUT",
        body: {
          organisationId,
          base: report.base,
          reportId: on ? report.id : null,
        },
      });
      setDefaultsOverride(result.defaults);
      setMessage(on ? `Reports now shows the ${baseName} in this layout.` : `Reports shows the standard ${baseName} again.`);
    });
  const copy = (copyTitle: string) =>
    run(async () => {
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: saveAsKey,
          base: report.base,
          layout: { ...layout, title: copyTitle },
        },
      });
      router.push(pageHref(result.report.id));
    });

  const reportRows = layout.blocks.flatMap((block) => (block.kind === "table" ? block.rows.filter((row) => row.kind !== "heading").map((row) => ({ id: row.id, label: row.label })) : []));
  const tableBlocks = new Map(layout.blocks.filter((block) => block.kind === "table").map((block) => [block.id, block as Extract<ReportBlock, { kind: "table" }>]));
  const editingTable = editing?.kind === "row" ? tableBlocks.get(editing.blockId) : undefined;
  const exportTables = figures.blocks
    .filter((block) => block.kind === "table")
    .map((block) => ({
      id: `custom-report-${block.id}`,
      title: (block as { title: string }).title || undefined,
    }));
  const editorsPanel = (
    <>
      {noteFor ? (
        <NoteEditor
          row={noteFor.row}
          busy={busy}
          onCancel={() => setNoteFor(null)}
          onSave={(note) =>
            change(
              (next) => {
                const table = next.blocks.find((block) => block.id === noteFor.blockId) as Extract<ReportBlock, { kind: "table" }>;
                const target = table.rows.find((entry) => entry.id === noteFor.row.id)!;
                if (note) target.note = note;
                else delete target.note;
              },
              () => setNoteFor(null),
            )
          }
        />
      ) : null}
      {editing?.kind === "columns" ? (
        <ColumnsEditor
          base={report.base}
          initial={layout.columns}
          initialFilter={layout.filter ?? null}
          rows={reportRows}
          tracking={tracking.data}
          budgets={budgets.data?.budgets ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(setting, filter) =>
            change(
              (next) => {
                next.columns = setting;
                if (filter) next.filter = filter;
                else delete next.filter;
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
          onSave={(row) => saveRow(editing.blockId, row, editing.isNew, editing.after)}
        />
      ) : null}
    </>
  );
  // The layout editor's side panel (LE1, LE2): Details for what's picked, or a Preview of the report as it prints.
  const pickedTable = picked && picked.kind !== "columns" ? tableBlocks.get(picked.blockId) : undefined;
  const pickedRow = picked?.kind === "row" ? pickedTable?.rows.find((entry) => entry.id === picked.rowId) : undefined;
  const pickedBlock = picked?.kind === "block" ? layout.blocks.find((entry) => entry.id === picked.blockId) : undefined;
  const flag = (field: "hidden" | "pageBreakAfter", on: boolean) =>
    change((next) => {
      if (!picked || picked.kind === "columns") return false;
      const block = next.blocks.find((entry) => entry.id === picked.blockId);
      const target: { hidden?: boolean; pageBreakAfter?: boolean } | undefined =
        picked.kind === "row" && block?.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : field === "pageBreakAfter" ? block : undefined;
      if (!target) return false;
      if (on) target[field] = true;
      else delete target[field];
    });
  const details = (() => {
    if (editing?.kind === "row" || noteFor) return editorsPanel;
    if (picked?.kind === "columns") {
      return (
        <ColumnsEditor
          base={report.base}
          initial={layout.columns}
          initialFilter={layout.filter ?? null}
          rows={reportRows}
          tracking={tracking.data}
          budgets={budgets.data?.budgets ?? []}
          busy={busy}
          onCancel={() => setPicked(null)}
          onSave={(setting, filter) =>
            change((next) => {
              next.columns = setting;
              if (filter) next.filter = filter;
              else delete next.filter;
            })
          }
        />
      );
    }
    if (pickedRow && pickedTable && picked?.kind === "row") {
      return (
        <div style={{ display: "grid", gap: 12 }}>
          <RowEditor
            key={`${pickedRow.id}:${JSON.stringify(pickedRow)}`}
            base={report.base}
            table={pickedTable}
            initial={structuredClone(pickedRow)}
            isNew={false}
            accounts={accounts.data?.accounts ?? []}
            busy={busy}
            onCancel={() => setPicked(null)}
            onSave={(row) => saveRow(picked.blockId, row, false)}
          />
          <label>
            <input type="checkbox" checked={Boolean(pickedRow.hidden)} disabled={busy} onChange={(event) => flag("hidden", event.target.checked)} /> Hide this row
          </label>
          <label>
            <input type="checkbox" checked={Boolean(pickedRow.pageBreakAfter)} disabled={busy} onChange={(event) => flag("pageBreakAfter", event.target.checked)} /> New page after
            this row
          </label>
          {(layout.columns.added ?? [])
            .filter((column) => column.kind === "notes")
            .map((column) => (
              <NotesCellInput
                key={`${pickedRow.id}:${column.id}:${pickedRow.cells?.[addedColumnKey(column)] ?? ""}`}
                label={column.heading || "Notes"}
                value={pickedRow.cells?.[addedColumnKey(column)] ?? ""}
                busy={busy}
                onSave={(value) =>
                  change((next) => {
                    const block = next.blocks.find((entry) => entry.id === picked.blockId);
                    const target = block?.kind === "table" ? block.rows.find((entry) => entry.id === picked.rowId) : undefined;
                    if (!target) return false;
                    const cells = { ...(target.cells ?? {}) };
                    if (value) cells[addedColumnKey(column)] = value;
                    else delete cells[addedColumnKey(column)];
                    if (Object.keys(cells).length > 0) target.cells = cells;
                    else delete target.cells;
                  })
                }
              />
            ))}
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                setNoteFor({
                  blockId: picked.blockId,
                  row: structuredClone(pickedRow),
                })
              }
            >
              {pickedRow.note ? "Change note" : "Add note"}
            </Button>
          </div>
        </div>
      );
    }
    if (pickedBlock) {
      return (
        <div style={{ display: "grid", gap: 12 }}>
          <strong>{pickedBlock.kind === "table" ? `Table${pickedBlock.title ? `: ${pickedBlock.title}` : ""}` : "Text"}</strong>
          <p className={ui.muted} style={{ margin: 0 }}>
            {pickedBlock.kind === "table"
              ? "Type the table's title above it on the left. Click a row to change it, or use Section to add a heading. Add rows with the buttons under the table."
              : "Type the text on the left."}
          </p>
          <label>
            <input type="checkbox" checked={Boolean(pickedBlock.pageBreakAfter)} disabled={busy} onChange={(event) => flag("pageBreakAfter", event.target.checked)} /> New page
            after this {pickedBlock.kind === "table" ? "table" : "text"}
          </label>
        </div>
      );
    }
    return (
      <p className={ui.muted}>
        Click a row, table, text or column heading on the left to change it here. The toolbar adds text, tables, sections and page breaks after what&apos;s picked.
      </p>
    );
  })();
  const previewPanel = (
    <div style={{ display: "grid", gap: 12, fontSize: "var(--text-sm)" }}>
      <strong>{layout.title}</strong>
      <span className={ui.muted}>{periodSummary(figures)}</span>
      {figures.blocks.map((block) =>
        block.kind === "table" ? (
          <div key={block.id}>
            {block.title ? <strong>{block.title}</strong> : null}
            <CustomFiguresTable id={`preview-${block.id}`} block={block} figures={figures} filter={layout.filter ?? null} />
          </div>
        ) : (
          <p key={block.id} className={ui.reportNote}>
            {block.text}
          </p>
        ),
      )}
      <span className={ui.muted}>{draft ? "With your changes, not saved yet." : "As saved."}</span>
    </div>
  );
  const canvas = (
    <article className={ui.reportPaper}>
      <header className={ui.statementHeading}>
        {editable ? (
          <input
            data-print="hide"
            className={ui.reportTitleInput}
            aria-label="Report title"
            value={titleValue}
            maxLength={CUSTOM_REPORT_LIMITS.titleLength}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if (titleValue.trim() && titleValue.trim() !== layout.title) change((next) => void (next.title = titleValue.trim()));
              else setTitle(null);
            }}
          />
        ) : null}
        <h2 className={`${ui.statementTitle} ${editable ? ui.printOnly : ""}`}>{layout.title}</h2>
        <p className={ui.statementOrg}>{current?.displayName}</p>
        <p>{periodSummary(figures)}</p>
        {figures.filterLabel ? <p>Only lines tagged {figures.filterLabel}</p> : null}
      </header>
      {figures.blocks.map((block) => (
        <Fragment key={block.id}>
          <section
            className={`${ui.reportPaperBlock} ${editable && picked?.kind === "block" && picked.blockId === block.id ? ui.layoutBlockSelected : ""} ${block.pageBreakAfter ? ui.pageBreakAfter : ""}`}
            {...(block.pageBreakAfter ? { "data-block-page-break": "after" } : {})}
            onClick={
              editable
                ? (event) => {
                    // A click on a row picks the row (the table handles it); anywhere else in the block picks the block.
                    if (event.target instanceof Element && event.target.closest("tbody tr, thead th, input, button, a, select, textarea, label")) return;
                    setEditing(null);
                    setPicked({ kind: "block", blockId: block.id });
                    setSideTab("details");
                  }
                : undefined
            }
          >
            {editable ? (
              <div className={ui.blockTools} data-print="hide">
                <span className={ui.muted}>{block.kind === "table" ? "Table" : "Text"}</span>
              </div>
            ) : null}
            {block.kind === "table" ? (
              <ReportTable
                key={`${block.id}:${report.version}:${draft ? "d" : "s"}`}
                block={block}
                figures={figures}
                layoutBlock={tableBlocks.get(block.id)}
                editable={editable}
                busy={busy}
                onChange={(apply) => change(apply)}
                onEditRow={(row, isNew) => {
                  setSideTab("details");
                  setEditing({ kind: "row", blockId: block.id, row, isNew });
                }}
                onEditNote={(row) => setNoteFor({ blockId: block.id, row })}
                onError={setError}
                filter={layout.filter ?? null}
                onPick={(rowId) => {
                  setEditing(null);
                  setPicked({ kind: "row", blockId: block.id, rowId });
                  setSideTab("details");
                }}
                pickedRowId={picked?.kind === "row" && picked.blockId === block.id ? picked.rowId : null}
                onPickColumns={() => {
                  setEditing(null);
                  setPicked({ kind: "columns" });
                  setSideTab("details");
                }}
              />
            ) : (
              <NoteBlock
                key={`${block.id}:${report.version}`}
                block={block}
                editable={editable}
                busy={busy}
                onSave={(text) =>
                  change((next) => {
                    const note = next.blocks.find((entry) => entry.id === block.id) as Extract<ReportBlock, { kind: "text" }>;
                    note.text = text;
                  })
                }
              />
            )}
          </section>
          {editable && block.pageBreakAfter ? (
            <div className={ui.layoutPageBreakMark} data-print="hide">
              Page break
            </div>
          ) : null}
        </Fragment>
      ))}
      {figures.blocks.length === 0 ? <Empty>This report has no tables or notes.</Empty> : null}
      <ReportWarnings figures={figures} />
      <p className={ui.reportPaperFooter}>
        {report.kind === "published" ? `Published ${formatDateTime(report.publishedAt)}.` : `Worked out ${formatDateTime(figures.computedAt)} from the ledger.`}
      </p>
    </article>
  );
  const more: MoreMenuItem[] = [
    ...(editable
      ? [
          { label: "Save as…", onSelect: () => setSaveAs(true) },
          isDefault
            ? {
                label: `Stop using as the ${baseName} layout`,
                onSelect: () => void setDefault(false),
              }
            : {
                label: `Set as default layout for the ${baseName}`,
                disabled: Boolean(draft),
                onSelect: () => void setDefault(true),
              },
          {
            label: "Publish",
            disabled: Boolean(draft),
            onSelect: () => void publish(),
          },
        ]
      : []),
    { label: "Print", onSelect: () => window.print() },
    ...(can("bookkeeper")
      ? [
          {
            label: report.archivedAt ? "Bring back" : "Archive",
            onSelect: () => void setArchived(!report.archivedAt),
          },
        ]
      : []),
    ...(can("bookkeeper") && report.kind === "draft" ? [{ label: "Delete draft", danger: true, onSelect: () => void remove() }] : []),
  ];

  return (
    <>
      <div className={ui.actions} data-print="hide">
        <Link href={`/operations/reports?view=${report.archivedAt ? "archived" : report.kind === "published" ? "published" : "drafts"}`}>← Reports</Link>
        {report.kind === "published" ? <Badge tone="blue">Published</Badge> : <Badge>Draft</Badge>}
        {report.archivedAt ? <Badge tone="amber">Archived</Badge> : null}
        {isDefault ? <Badge tone="green">Default {baseName} layout</Badge> : null}
        {draft ? <Badge tone="amber">Unsaved changes</Badge> : null}
      </div>
      <div data-print="hide">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
      </div>
      {report.kind === "published" ? (
        <div data-print="hide">
          <Notice tone="info">
            A frozen copy, published {formatDateTime(report.publishedAt)} by {personName(report, "publishedBy")}. Its figures are as they were then and never change.
            {report.publishedFromId ? (
              <>
                {" "}
                <Link href={pageHref(report.publishedFromId)}>Open its draft</Link>
              </>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {editable ? (
        <div className={ui.layoutToolbar} data-print="hide" role="toolbar" aria-label="Layout tools">
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => insertBlock({ id: newLayoutId("n"), kind: "text", text: "Notes" })}
            title="Add a text block after what's picked"
          >
            Text
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              insertBlock({
                id: newLayoutId("t"),
                kind: "table",
                title: "New table",
                rows: [],
              })
            }
            title="Add a table after what's picked"
          >
            Table
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={addSection} title="Add a section heading after the picked row">
            Section
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setNoteFor(null);
              setPicked({ kind: "columns" });
              setSideTab("details");
            }}
            title="Change the columns"
          >
            Columns
          </Button>
          <Button size="small" variant="secondary" disabled={busy} onClick={togglePageBreak} title="Start a new page after what's picked">
            Page break
          </Button>
          <span className={ui.layoutToolbarRule} aria-hidden="true" />
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => movePicked(-1)} aria-label="Move up" title="Move up">
            ↑
          </Button>
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => movePicked(1)} aria-label="Move down" title="Move down">
            ↓
          </Button>
          <Button size="small" variant="secondary" disabled={busy || !picked || picked.kind === "columns"} onClick={() => void deletePicked()} aria-label="Delete" title="Delete">
            ✕
          </Button>
          <span className={ui.layoutToolbarRule} aria-hidden="true" />
          <ExportMenu
            organisationId={organisationId}
            report="custom-report"
            title={report.title}
            period={periodSummary(figures)}
            filters={figures.filterLabel ? [`Only lines tagged ${figures.filterLabel}`] : []}
            style="statement"
            tables={exportTables}
          />
          <div className={ui.layoutToolbarEnd}>
            {busy ? <span className={ui.muted}>Working…</span> : null}
            <FavouriteButton organisationId={organisationId} reportKey={`custom:${report.id}`} name={report.title} />
            <MoreMenu label="More report actions" items={more} />
            <Button size="small" variant="secondary" disabled={busy || !draft} onClick={cancelChanges}>
              Cancel
            </Button>
            <Button size="small" disabled={busy || !draft} onClick={() => void save()}>
              {busy ? "Saving…" : "Update layout"}
            </Button>
          </div>
        </div>
      ) : null}
      {editable ? null : (
        <div className={ui.toolbar} data-print="hide" role="group" aria-label="Report actions">
          <FavouriteButton organisationId={organisationId} reportKey={`custom:${report.id}`} name={report.title} />
          <MoreMenu label="More report actions" items={more} />
          {editable ? null : (
            <ExportMenu
              organisationId={organisationId}
              report="custom-report"
              title={report.title}
              period={periodSummary(figures)}
              filters={figures.filterLabel ? [`Only lines tagged ${figures.filterLabel}`] : []}
              style="statement"
              tables={exportTables}
            />
          )}
          {busy ? <span className={ui.muted}>Working…</span> : null}
        </div>
      )}

      {saveAs ? <SaveAsForm initial={`${layout.title} (copy)`} busy={busy} onCancel={() => setSaveAs(false)} onSave={(name) => void copy(name)} /> : null}
      {editable ? null : editorsPanel}
      {editable ? (
        <div className={ui.layoutEditor}>
          {canvas}
          <aside className={ui.layoutSide} data-print="hide" aria-label="Details">
            <div className={ui.tabs} role="tablist" aria-label="Side panel">
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "details"}
                className={`${ui.tab} ${sideTab === "details" ? ui.tabActive : ""}`}
                onClick={() => setSideTab("details")}
              >
                Details
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sideTab === "preview"}
                className={`${ui.tab} ${sideTab === "preview" ? ui.tabActive : ""}`}
                onClick={() => setSideTab("preview")}
              >
                Preview
              </button>
            </div>
            <div style={{ marginTop: 12 }}>{sideTab === "details" ? details : previewPanel}</div>
          </aside>
        </div>
      ) : (
        canvas
      )}
    </>
  );
}

/** Accounts left out of a report, or counted twice, so it doesn't hide that it no longer adds up. */
export function ReportWarnings({ figures }: { figures: CustomReportFigures }) {
  return (
    <>
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
    </>
  );
}
