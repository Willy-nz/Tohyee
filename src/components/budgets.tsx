"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { reportCategories, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { BUDGET_LIMITS, fillSameAmount, QUICK_FILL_METHODS, type QuickFillMethod } from "@/lib/budgets/fill";
import type { Budget, BudgetGrid } from "@/lib/budgets/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser, personName } from "@/lib/format";
import type { BudgetVsActual, BudgetVsActualGroup, VarianceFigures } from "@/lib/reports/budget-vs-actual";

/**
 * Budgets (examples BU1-BU8): the list, a budget's month-by-month amounts
 * with quick fill, and the budget vs actual report. Budgets post nothing.
 */

function trackingSuffix(budget: Budget): string {
  return budget.trackingLabel ? ` (${budget.trackingLabel})` : "";
}

export function useBudgets(organisationId: string, archived = false) {
  return useApiData<{ budgets: Budget[] }>("/api/budgets", { organisationId, archived: archived ? "true" : null });
}

/** The list of budgets, with a form to start a named one (BU1). */
export function BudgetList({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [archived, setArchived] = useState(false);
  const list = useBudgets(organisationId, archived);
  const tracking = useTracking(organisationId);
  const categories = reportCategories(tracking.data);
  const [name, setName] = useState("");
  const [valueId, setValueId] = useState("");
  const [createKey, setCreateKey] = useState(() => newIdempotencyKey("budget"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/budgets", { method: "POST", body: { organisationId, source: "ui", idempotencyKey: createKey, name, trackingValueId: valueId || null } });
      setName("");
      setValueId("");
      setCreateKey(newIdempotencyKey("budget"));
      list.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Budgets" description="Monthly amounts per profit and loss account. Budgets post nothing; compare them in Budget vs actual and in custom reports.">
        <div className={ui.tabs} role="tablist" aria-label="Budgets">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              role="tab"
              aria-selected={archived === value}
              className={`${ui.tab} ${archived === value ? ui.tabActive : ""}`}
              onClick={() => setArchived(value)}
            >
              {value ? "Archived" : "Current"}
            </button>
          ))}
        </div>
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data ? <p className={ui.muted}>Loading…</p> : null}
        {list.data && list.data.budgets.length === 0 ? <Empty>No archived budgets.</Empty> : null}
        {list.data && list.data.budgets.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Budget</th>
                  <th>For</th>
                  <th>Last changed</th>
                </tr>
              </thead>
              <tbody>
                {list.data.budgets.map((budget) => (
                  <tr key={budget.id}>
                    <td data-label="Budget">
                      <Link href={`/operations/budgets/${budget.id}`}>{budget.name}</Link> {budget.isOverall ? <Badge tone="blue">Overall</Badge> : null}
                    </td>
                    <td data-label="For">{budget.trackingLabel ?? "Everything"}</td>
                    <td data-label="Last changed" className={ui.muted}>
                      {formatDateTime(budget.updatedAt)}
                      {personName(budget, "updatedBy") ? ` by ${personName(budget, "updatedBy")}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {can("bookkeeper") && !archived ? (
        <Card title="New budget" description="Optionally for one tracking value, e.g. a Department, or a grant set up as a custom segment.">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <form className={ui.inlineForm} onSubmit={(event) => void create(event)}>
            <Field label="Name">
              <input value={name} maxLength={BUDGET_LIMITS.nameLength} onChange={(event) => setName(event.target.value)} required />
            </Field>
            {categories.length > 0 ? (
              <Field label="For">
                <select value={valueId} onChange={(event) => setValueId(event.target.value)}>
                  <option value="">Everything</option>
                  {categories.map((category) => (
                    <optgroup key={category.id} label={category.name}>
                      {category.values
                        .filter((value) => value.isActive)
                        .map((value) => (
                          <option key={value.id} value={value.id}>
                            {category.name}: {value.path}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add budget"}
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function monthLabel(month: string): string {
  return formatDate(`${month}-01`).replace(/^1 /, "");
}

/** Quick fill (BU3, BU4): the same amount each month, or last year's actuals, optionally changed by a %. */
function QuickFill({
  organisationId,
  grid,
  onFilled,
}: {
  organisationId: string;
  grid: BudgetGrid;
  onFilled: (message: string) => void;
}) {
  const [accountCode, setAccountCode] = useState("");
  const [method, setMethod] = useState<QuickFillMethod>("same");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let preview: string[] | null = null;
  if (method === "same" && /^-?\d+(\.\d{1,2})?$/.test(amount.trim()) && (percent.trim() === "" || /^-?\d+(\.\d{1,2})?$/.test(percent.trim()))) {
    preview = fillSameAmount(amount.trim(), Math.min(3, grid.months.length), percent.trim() || null, 2);
  }

  async function fill() {
    setBusy(true);
    setError(null);
    try {
      const codes = accountCode === "*" ? grid.accounts.filter((account) => account.isActive).map((account) => account.code) : [accountCode];
      await api(`/api/budgets/${grid.budget.id}/fill`, {
        method: "POST",
        body: {
          organisationId,
          version: grid.budget.version,
          accountCodes: codes,
          from: grid.months[0],
          months: grid.months.length,
          method,
          amount: method === "same" ? amount : undefined,
          percent: percent.trim() || undefined,
        },
      });
      onFilled(`Filled ${grid.months.length} months.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Quick fill" description={`Replaces the ${grid.months.length} months shown, from ${monthLabel(grid.months[0])}.`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Account">
          <select value={accountCode} onChange={(event) => setAccountCode(event.target.value)}>
            <option value="">Choose…</option>
            {method === "actuals" ? <option value="*">Every account shown</option> : null}
            {grid.accounts
              .filter((account) => account.isActive)
              .map((account) => (
                <option key={account.accountId} value={account.code}>
                  {account.code} · {account.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="With">
          <select
            value={method}
            onChange={(event) => {
              setMethod(event.target.value as QuickFillMethod);
              if (accountCode === "*") setAccountCode("");
            }}
          >
            {(Object.keys(QUICK_FILL_METHODS) as QuickFillMethod[]).map((key) => (
              <option key={key} value={key}>
                {QUICK_FILL_METHODS[key]}
              </option>
            ))}
          </select>
        </Field>
        {method === "same" ? (
          <Field label="Amount">
            <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
        ) : null}
        <Field label={method === "same" ? "% change each month" : "% change"} hint="Optional, e.g. 2 or -5.">
          <input inputMode="decimal" value={percent} onChange={(event) => setPercent(event.target.value)} />
        </Field>
        <Button onClick={() => void fill()} disabled={busy || !accountCode || (method === "same" && !amount.trim())}>
          {busy ? "Filling…" : "Fill"}
        </Button>
      </div>
      {preview ? <p className={ui.muted}>First months: {preview.join(", ")}…</p> : null}
    </Card>
  );
}

/** A budget's amounts, account by month, editable by bookkeepers (BU2). */
export function BudgetEditor({ organisationId, budgetId }: { organisationId: string; budgetId: string }) {
  const { can } = useWorkspace();
  const [from, setFrom] = useState<string | null>(null);
  const [months, setMonths] = useState(12);
  const grid = useApiData<BudgetGrid>(`/api/budgets/${encodeURIComponent(budgetId)}`, { organisationId, from, months });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (grid.error) return <Notice tone="error">{grid.error}</Notice>;
  if (!grid.data) return <p className={ui.muted}>Loading…</p>;
  const data = grid.data;
  const budget = data.budget;
  const editable = can("bookkeeper") && !budget.archivedAt;
  const cellKey = (code: string, month: string) => `${code}|${month}`;
  const changed = Object.entries(edits);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const done = await action();
      setEdits({});
      grid.reload();
      setMessage(done);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const result = await api<{ changed: number }>(`/api/budgets/${budget.id}/amounts`, {
        method: "PUT",
        body: {
          organisationId,
          version: budget.version,
          amounts: changed.map(([key, amount]) => {
            const [accountCode, month] = key.split("|");
            return { accountCode, month, amount: amount.trim() === "" ? "0" : amount.trim() };
          }),
        },
      });
      return result.changed === 1 ? "Saved 1 amount." : `Saved ${result.changed} amounts.`;
    });

  const rename = () =>
    run(async () => {
      await api(`/api/budgets/${budget.id}`, { method: "PUT", body: { organisationId, name, version: budget.version } });
      setName(null);
      return "Renamed.";
    });

  const archive = (archived: boolean) =>
    run(async () => {
      await api(`/api/budgets/${budget.id}/archive`, { method: "POST", body: { organisationId, archived } });
      return archived ? "Archived." : "Brought back.";
    });

  return (
    <>
      <Card
        title={`${budget.name}${trackingSuffix(budget)}`}
        description={`Amounts in ${data.currencyCode}, in each account's natural direction: income and costs both as positive amounts.${
          budget.archivedAt ? ` Archived ${formatDateTime(budget.archivedAt)} by ${personName(budget, "archivedBy")}.` : ""
        }`}
        actions={
          <div className={ui.inlineForm}>
            <Field label="From">
              <input type="month" value={from ?? data.months[0]} onChange={(event) => setFrom(event.target.value || null)} />
            </Field>
            <Field label="Months">
              <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
                {[3, 6, 12, 18, 24].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
        {data.accounts.some((account) => account.fromWorkforce.some(Boolean)) ? (
          <p className={ui.muted}>
            * From workforce budget {[...new Set(data.accounts.flatMap((account) => account.fromWorkforce.filter((name): name is string => Boolean(name))))].join(", ")}: change
            these in Payroll › Workforce budget.
          </p>
        ) : null}
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Account</th>
                {data.months.map((month) => (
                  <th key={month} className={ui.num}>
                    {monthLabel(month)}
                  </th>
                ))}
                <th className={ui.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.accountId}>
                  <td>
                    {account.code} · {account.name}
                    {account.isActive ? "" : " (archived)"}
                  </td>
                  {data.months.map((month, index) => {
                    const key = cellKey(account.code, month);
                    return (
                      <td key={month} className={ui.num}>
                        {account.fromWorkforce[index] ? (
                          <span title={`From workforce budget ${account.fromWorkforce[index]} (Payroll › Workforce budget)`}>
                            <Money value={account.amounts[index]} blankZero />
                            <span className={ui.muted}> *</span>
                          </span>
                        ) : editable && account.isActive ? (
                          <input
                            aria-label={`${account.code} ${monthLabel(month)}`}
                            inputMode="decimal"
                            size={9}
                            value={edits[key] ?? (account.amounts[index] === "0.00" ? "" : account.amounts[index])}
                            onChange={(event) => setEdits({ ...edits, [key]: event.target.value })}
                          />
                        ) : (
                          <Money value={account.amounts[index]} blankZero />
                        )}
                      </td>
                    );
                  })}
                  <td className={ui.num}>
                    <Money value={account.total} blankZero />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total (income and costs added together)</td>
                {data.totals.map((total, index) => (
                  <td key={data.months[index]} className={ui.num}>
                    <Money value={total} blankZero />
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {editable ? (
          <div className={ui.actions}>
            <Button onClick={() => void save()} disabled={busy || changed.length === 0}>
              {busy ? "Saving…" : changed.length > 0 ? `Save ${changed.length} change${changed.length === 1 ? "" : "s"}` : "Save"}
            </Button>
            {changed.length > 0 ? (
              <Button variant="secondary" onClick={() => setEdits({})}>
                Undo changes
              </Button>
            ) : null}
          </div>
        ) : null}
        <p className={ui.muted}>
          Last changed {formatDateTime(budget.updatedAt)}
          {personName(budget, "updatedBy") ? ` by ${personName(budget, "updatedBy")}` : ""}. Every change is kept in the history with the amounts before and after.{" "}
          <Link href={`/operations/reports?report=budget&budget=${budget.id}`}>Budget vs actual</Link>
        </p>
      </Card>
      {editable ? <QuickFill organisationId={organisationId} grid={data} onFilled={(done) => { grid.reload(); setMessage(done); }} /> : null}
      {can("bookkeeper") ? (
        <Card title="Budget settings">
          <div className={ui.inlineForm}>
            {!budget.archivedAt ? (
              <>
                <Field label="Name">
                  <input value={name ?? budget.name} maxLength={BUDGET_LIMITS.nameLength} onChange={(event) => setName(event.target.value)} />
                </Field>
                <Button variant="secondary" disabled={busy || name === null || name.trim() === budget.name} onClick={() => void rename()}>
                  Rename
                </Button>
              </>
            ) : null}
            {budget.isOverall ? (
              <span className={ui.muted}>The overall budget can&apos;t be archived.</span>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => void archive(!budget.archivedAt)}>
                {budget.archivedAt ? "Bring back" : "Archive"}
              </Button>
            )}
          </div>
        </Card>
      ) : null}
    </>
  );
}

function VarianceCells({ figures }: { figures: VarianceFigures }) {
  return (
    <>
      <td className={ui.num}>
        <Money value={figures.actual} />
      </td>
      <td className={ui.num}>
        <Money value={figures.budget} />
      </td>
      <td className={ui.num}>
        <Money value={figures.variance} />
      </td>
      <td className={ui.num}>{figures.variancePercent == null ? "" : `${figures.variancePercent}%`}</td>
    </>
  );
}

function VarianceGroup({ title, group, totalLabel }: { title: string; group: BudgetVsActualGroup; totalLabel: string }) {
  if (group.sections.length === 0) return null;
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={5}>{title}</td>
      </tr>
      {group.sections.map((section) => (
        <Fragment key={section.key}>
          {group.sections.length > 1 ? (
            <tr>
              <td className={ui.muted} colSpan={5}>
                {section.label}
              </td>
            </tr>
          ) : null}
          {section.lines.map((line) => (
            <tr key={line.accountId} className={ui.reportSection}>
              <td>
                {line.code} · {line.name}
              </td>
              <VarianceCells figures={line} />
            </tr>
          ))}
        </Fragment>
      ))}
      <tr className={ui.reportTotal}>
        <td>{totalLabel}</td>
        <VarianceCells figures={group.total} />
      </tr>
    </>
  );
}

/** Budget vs actual (BU5, BU6) for whole months against a chosen budget. */
export function BudgetVsActualReport({ organisationId, initialBudgetId }: { organisationId: string; initialBudgetId?: string | null }) {
  const budgets = useBudgets(organisationId);
  const [budgetId, setBudgetId] = useState<string | null>(initialBudgetId ?? null);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(() => todayInBrowser().slice(0, 7));
  const chosen = budgetId ?? budgets.data?.budgets[0]?.id ?? null;
  const report = useApiData<BudgetVsActual>(chosen ? "/api/reports/budget-vs-actual" : null, { organisationId, budgetId: chosen, from, to });
  const data = report.data;
  return (
    <Card
      title="Budget vs actual"
      description="Variance is actual less budget, so on costs a positive variance is over budget."
      actions={
        <div className={ui.inlineForm}>
          <Field label="Budget">
            <select value={chosen ?? ""} onChange={(event) => setBudgetId(event.target.value)}>
              {(budgets.data?.budgets ?? []).map((budget) => (
                <option key={budget.id} value={budget.id}>
                  {budget.name}
                  {trackingSuffix(budget)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input type="month" value={from ?? data?.from.slice(0, 7) ?? ""} onChange={(event) => setFrom(event.target.value || null)} />
          </Field>
          <Field label="To">
            <input type="month" value={to} onChange={(event) => event.target.value && setTo(event.target.value)} />
          </Field>
        </div>
      }
    >
      {budgets.error ? <Notice tone="error">{budgets.error}</Notice> : null}
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <div className={ui.tableWrap}>
          <p className={ui.muted}>
            {formatDate(data.from)} to {formatDate(data.to)}
            {data.budget.trackingLabel ? `, only lines tagged ${data.budget.trackingLabel}` : ""}.{" "}
            <Link href={`/operations/budgets/${data.budget.id}`}>Open the budget</Link>
          </p>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={ui.num}>Actual</th>
                <th className={ui.num}>Budget</th>
                <th className={ui.num}>Variance</th>
                <th className={ui.num}>%</th>
              </tr>
            </thead>
            <tbody>
              <VarianceGroup title="Revenue" group={data.revenue} totalLabel="Total revenue" />
              <VarianceGroup title="Cost of sales" group={data.costOfSales} totalLabel="Total cost of sales" />
              <tr className={ui.reportTotal}>
                <td>Gross profit</td>
                <VarianceCells figures={data.grossProfit} />
              </tr>
              <VarianceGroup title="Other income" group={data.otherIncome} totalLabel="Total other income" />
              <VarianceGroup title="Expenses" group={data.expenses} totalLabel="Total expenses" />
            </tbody>
            <tfoot>
              <tr>
                <td>Net profit ({data.currencyCode})</td>
                <VarianceCells figures={data.netProfit} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
