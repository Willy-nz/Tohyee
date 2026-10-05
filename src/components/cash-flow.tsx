"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { ReportCommentary } from "@/components/report-commentary";
import { ReportExport } from "@/components/reports/report-export";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import {
  CASH_FLOW_LIMITS,
  type CashFlowAverage,
  type CashFlowForecast,
  type CashFlowItem,
  cashFlowLineHref,
  type CashFlowPeriod,
  type CashFlowPeriodKind,
} from "@/lib/cash-flow/types";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatMoney, personName, todayInBrowser } from "@/lib/format";

/**
 * Reports › Cash flow forecast (CF1-CF9), like NetSuite's Cash 360: the
 * bank balance today and each period's money in and out, with the documents
 * behind each amount, forecast items and account averages.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodLabel(period: CashFlowPeriod, kind: CashFlowPeriodKind): string {
  const [, startMonth, startDay] = period.start.split("-").map(Number);
  const [endYear, endMonth, endDay] = period.end.split("-").map(Number);
  if (kind === "month") return `${MONTHS[startMonth - 1]} ${endYear}`;
  if (kind === "day") return formatDate(period.start);
  return startMonth === endMonth ? `${startDay}-${endDay} ${MONTHS[endMonth - 1]}` : `${startDay} ${MONTHS[startMonth - 1]}-${endDay} ${MONTHS[endMonth - 1]}`;
}

const KIND_WORDS: Record<CashFlowPeriodKind, string> = { day: "Days", week: "Weeks", month: "Months" };

function PeriodLines({ period }: { period: CashFlowPeriod }) {
  if (period.lines.length === 0) return <p className={ui.muted}>Nothing expected.</p>;
  return (
    <table className={`${ui.table} ${ui.stackOnPhone}`}>
      <thead>
        <tr>
          <th>In or out</th>
          <th>From</th>
          <th>Expected</th>
          <th className={ui.num}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {period.lines.map((line, index) => {
          const href = cashFlowLineHref(line);
          return (
            <tr key={`${line.source}-${line.id}-${line.date}-${index}`}>
              <td data-label="In or out">{line.direction === "in" ? "In" : "Out"}</td>
              <td data-label="From">
                {href ? <Link href={href}>{line.label}</Link> : line.label} {line.overdue ? <Badge tone="red">Overdue</Badge> : null}{" "}
                {line.draft ? <Badge tone="amber">Draft</Badge> : null} {line.fromOrder ? <Badge tone="blue">Order</Badge> : null}
              </td>
              <td data-label="Expected">{formatDate(line.date)}</td>
              <td data-label="Amount" className={ui.num}>
                <Money value={line.baseAmount} />
                {line.amount !== line.baseAmount ? (
                  <div className={ui.muted}>
                    {line.currencyCode} {formatMoney(line.amount)}
                  </div>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ForecastItems({ organisationId, canEdit, onChanged }: { organisationId: string; canEdit: boolean; onChanged: () => void }) {
  const confirm = useConfirm();
  const loaded = useApiData<{ items: CashFlowItem[] }>("/api/cash-flow/items", { organisationId });
  const blank = { direction: "out" as "in" | "out", description: "", amount: "", date: todayInBrowser(), repeat: "none" as CashFlowItem["repeat"], untilDate: "" };
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<CashFlowItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { organisationId, ...form, untilDate: form.repeat === "none" ? null : form.untilDate || null, ...(editing ? { version: editing.version } : {}) };
      await api(editing ? `/api/cash-flow/items/${editing.id}` : "/api/cash-flow/items", { method: editing ? "PUT" : "POST", body });
      setForm(blank);
      setEditing(null);
      loaded.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const items = loaded.data?.items;
  return (
    <Card title="Forecast items" description="Money you expect in or out that isn't in the books yet, once or every week or month, e.g. a GST payment or a loan.">
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {items && items.length === 0 ? <Empty>No forecast items.</Empty> : null}
      {items && items.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Description</th>
                <th>In or out</th>
                <th>Date</th>
                <th>Repeats</th>
                <th className={ui.num}>Amount</th>
                {canEdit ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="Description">
                    {item.description}
                    <div className={ui.muted}>Changed by {personName(item, "updatedBy") ?? "unknown"}</div>
                  </td>
                  <td data-label="In or out">{item.direction === "in" ? "Money in" : "Money out"}</td>
                  <td data-label="Date">{formatDate(item.date)}</td>
                  <td data-label="Repeats">{item.repeat === "none" ? "Once" : `Every ${item.repeat}${item.untilDate ? ` until ${formatDate(item.untilDate)}` : ""}`}</td>
                  <td data-label="Amount" className={ui.num}>
                    <Money value={item.amount} />
                  </td>
                  {canEdit ? (
                    <td data-label="Actions">
                      <div className={ui.actions}>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => {
                            setEditing(item);
                            setForm({ direction: item.direction, description: item.description, amount: item.amount, date: item.date, repeat: item.repeat, untilDate: item.untilDate ?? "" });
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          variant="danger"
                          onClick={async () => {
                            if (!(await confirm(`Remove "${item.description}" from the forecast?`))) return;
                            try {
                              await api(`/api/cash-flow/items/${item.id}`, { method: "DELETE", query: { organisationId } });
                              loaded.reload();
                              onChanged();
                            } catch (caught) {
                              setError(errorMessage(caught));
                            }
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {canEdit ? (
        <form onSubmit={save}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={ui.inlineForm}>
            <Field label="Description">
              <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={200} required />
            </Field>
            <Field label="In or out">
              <select value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as "in" | "out" })}>
                <option value="out">Money out</option>
                <option value="in">Money in</option>
              </select>
            </Field>
            <Field label="Amount">
              <input value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} inputMode="decimal" required />
            </Field>
            <Field label="Date">
              <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
            </Field>
            <Field label="Repeats">
              <select value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value as CashFlowItem["repeat"] })}>
                <option value="none">Once</option>
                <option value="week">Every week</option>
                <option value="month">Every month</option>
              </select>
            </Field>
            {form.repeat !== "none" ? (
              <Field label="Until" hint="Blank for no end.">
                <input type="date" value={form.untilDate} onChange={(event) => setForm({ ...form, untilDate: event.target.value })} />
              </Field>
            ) : null}
            <Button type="submit" disabled={busy}>
              {editing ? "Save item" : "Add item"}
            </Button>
            {editing ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setForm(blank);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function AccountAverages({ organisationId, canEdit, onChanged }: { organisationId: string; canEdit: boolean; onChanged: () => void }) {
  const loaded = useApiData<{ averages: CashFlowAverage[] }>("/api/cash-flow/averages", { organisationId });
  const accounts = useAccounts(organisationId);
  const [code, setCode] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [months, setMonths] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const averages = loaded.data?.averages;

  async function save(next: Array<{ accountId: string; direction: string; months: number }>) {
    setError(null);
    try {
      await api("/api/cash-flow/averages", { method: "PUT", body: { organisationId, averages: next } });
      loaded.reload();
      onChanged();
      setCode("");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const current = (averages ?? []).map((entry) => ({ accountId: entry.accountId, direction: entry.direction, months: entry.months }));
  return (
    <Card
      title="Account averages"
      description="Accounts forecast from their average over the last 3 or 6 whole months, e.g. wages. Each period gets the average daily amount times its days. Don't average an account whose bills are already in the forecast, or they're counted twice."
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {averages && averages.length === 0 ? <Empty>No accounts are averaged.</Empty> : null}
      {averages && averages.length > 0 ? (
        <ul className={ui.relatedList}>
          {averages.map((entry) => (
            <li key={entry.accountId}>
              {entry.accountCode} {entry.accountName}: money {entry.direction}, average of the last {entry.months} months{" "}
              {canEdit ? (
                <Button size="small" variant="secondary" onClick={() => save(current.filter((item) => item.accountId !== entry.accountId))}>
                  Stop averaging
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className={ui.inlineForm}>
          <Field label="Account">
            <AccountSelect
              accounts={accounts.data?.accounts ?? []}
              value={code}
              onChange={setCode}
              filter={(account) => account.accountClass === "expense" || account.accountClass === "revenue" || account.accountClass === "liability"}
            />
          </Field>
          <Field label="In or out">
            <select value={direction} onChange={(event) => setDirection(event.target.value as "in" | "out")}>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </Field>
          <Field label="Average of">
            <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
              <option value={3}>Last 3 months</option>
              <option value={6}>Last 6 months</option>
            </select>
          </Field>
          <Button
            disabled={!code}
            onClick={() => {
              const account = accounts.data?.accounts.find((item) => item.code === code);
              if (account) void save([...current, { accountId: account.id, direction, months }]);
            }}
          >
            Average it
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function CashFlowForecastView({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [period, setPeriod] = useState<CashFlowPeriodKind>("week");
  const [count, setCount] = useState(CASH_FLOW_LIMITS.week.default);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [includeOrders, setIncludeOrders] = useState(false);
  const [accountIds, setAccountIds] = useState<string[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const loaded = useApiData<{ forecast: CashFlowForecast }>("/api/cash-flow", {
    organisationId,
    period,
    count: String(count),
    includeDrafts: includeDrafts ? "true" : null,
    includeOrders: includeOrders ? "true" : null,
    accountIds: accountIds ? accountIds.join(",") : null,
  });
  const forecast = loaded.data?.forecast;
  const chosen = accountIds ?? forecast?.accounts.map((account) => account.id) ?? [];

  return (
    <>
      <Card
        actions={
          <div className={ui.inlineForm}>
            <Field label="Show">
              <select
                value={period}
                onChange={(event) => {
                  const next = event.target.value as CashFlowPeriodKind;
                  setPeriod(next);
                  setCount(CASH_FLOW_LIMITS[next].default);
                  setOpen(null);
                }}
              >
                {(["day", "week", "month"] as const).map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_WORDS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`How many ${KIND_WORDS[period].toLowerCase()}`}>
              <input type="number" min={1} max={CASH_FLOW_LIMITS[period].max} value={count} onChange={(event) => setCount(Math.max(1, Math.min(CASH_FLOW_LIMITS[period].max, Number(event.target.value) || 1)))} />
            </Field>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={includeOrders} onChange={(event) => setIncludeOrders(event.target.checked)} /> Sales and purchase orders
            </label>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={includeDrafts} onChange={(event) => setIncludeDrafts(event.target.checked)} /> Drafts
            </label>
          </div>
        }
        title="Cash flow forecast"
        description="From today's bank balance: open invoices and bills on their due dates, repeating invoices and bills, unpaid expense claims, forecast items and account averages. It posts nothing."
      >
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {!forecast ? <p className={ui.muted}>Loading…</p> : null}
        {forecast ? (
          <>
            {forecast.availableAccounts.length > 0 ? (
              <div className={ui.choiceList} aria-label="Bank accounts">
                {forecast.availableAccounts.map((account) => (
                  <label key={account.id} className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(account.id)}
                      onChange={(event) => {
                        const next = event.target.checked ? [...chosen, account.id] : chosen.filter((id) => id !== account.id);
                        if (next.length > 0) setAccountIds(next);
                      }}
                    />{" "}
                    {account.code} {account.name}
                    {account.accountType === "credit_card" ? " (card)" : ""}
                  </label>
                ))}
              </div>
            ) : null}
            <div className={ui.statRow}>
              <Stat label={`In the bank today (${formatDate(forecast.today)})`} value={<Money value={forecast.opening} />} />
              <Stat label={`Lowest (${periodLabel(forecast.periods[forecast.lowest.index], forecast.period)})`} value={<Money value={forecast.lowest.closing} />} />
              <Stat label={`At the end (${periodLabel(forecast.periods[forecast.periods.length - 1], forecast.period)})`} value={<Money value={forecast.periods[forecast.periods.length - 1].closing} />} />
            </div>
            {forecast.firstBelowZero !== null ? (
              <Notice tone="warning">
                The balance goes below zero in {periodLabel(forecast.periods[forecast.firstBelowZero], forecast.period)} ({formatMoney(forecast.periods[forecast.firstBelowZero].closing)}).
              </Notice>
            ) : null}
            {forecast.excluded.length > 0 ? (
              <Notice tone="warning">
                Left out:{" "}
                {forecast.excluded.map((entry) => `${entry.label}: ${entry.reason}`).join("; ")}. Add a rate in Accounting › Exchange rates.
              </Notice>
            ) : null}
            <ReportExport
              organisationId={organisationId}
              report="cash-flow-forecast"
              title="Cash flow forecast"
              period={`${KIND_WORDS[forecast.period]} from ${formatDate(forecast.periods[0].start)} to ${formatDate(forecast.periods[forecast.periods.length - 1].end)}`}
              filters={[
                `Accounts: ${forecast.accounts.map((account) => account.code).join(", ")}`,
                ...(forecast.includeOrders ? ["Including sales and purchase orders"] : []),
                ...(forecast.includeDrafts ? ["Including drafts"] : []),
              ]}
              tables={[{ id: "cash-flow-forecast-report", columns: ["Period", "Money in", "Money out", "Net", "Closing balance"] }]}
            />
            <div className={ui.tableWrap}>
              <table id="cash-flow-forecast-report" className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th className={ui.num}>Money in</th>
                    <th className={ui.num}>Money out</th>
                    <th className={ui.num}>Net</th>
                    <th className={ui.num}>Closing balance</th>
                    <th data-export-ignore aria-label="Details" />
                  </tr>
                </thead>
                <tbody>
                  {forecast.periods.map((entry, index) => (
                    <Fragment key={entry.start}>
                      <tr className={index === forecast.lowest.index ? ui.reportTotal : undefined}>
                        <td data-label="Period">{periodLabel(entry, forecast.period)}</td>
                        <td data-label="Money in" className={ui.num}>
                          <Money value={entry.moneyIn} />
                        </td>
                        <td data-label="Money out" className={ui.num}>
                          <Money value={entry.moneyOut} />
                        </td>
                        <td data-label="Net" className={ui.num}>
                          <Money value={entry.net} />
                        </td>
                        <td data-label="Closing balance" className={ui.num}>
                          <Money value={entry.closing} />
                        </td>
                        <td data-export-ignore>
                          <Button size="small" variant="secondary" onClick={() => setOpen(open === index ? null : index)} aria-expanded={open === index}>
                            {open === index ? "Hide" : `Details (${entry.lines.length})`}
                          </Button>
                        </td>
                      </tr>
                      {open === index ? (
                        <tr data-export-skip>
                          <td colSpan={6} data-export-ignore>
                            <PeriodLines period={entry} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Card>
      {forecast ? (
        <ReportCommentary
          path="/api/cash-flow/commentary"
          organisationId={organisationId}
          report="cash_flow_forecast"
          periodLabel={`${KIND_WORDS[forecast.period]} from ${formatDate(forecast.periods[0].start)} to ${formatDate(forecast.periods[forecast.periods.length - 1].end)}`}
          canEdit={can("bookkeeper")}
        />
      ) : null}
      <ForecastItems organisationId={organisationId} canEdit={can("bookkeeper")} onChanged={loaded.reload} />
      <AccountAverages organisationId={organisationId} canEdit={can("bookkeeper")} onChanged={loaded.reload} />
    </>
  );
}
