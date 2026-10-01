"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { IrdLiability, IrdPayment, IrdPeriodSummary } from "@/lib/payroll/ird-payments";
import type { PayRunPayments, WagePayment } from "@/lib/payroll/wage-payments";
import styles from "./payroll-employees.module.css";

/** Bank and credit card accounts in the base currency: what wages and IRD are paid from (PPAY1, PPAY11). */
function isPaymentAccount(account: Account): boolean {
  return (account.accountType === "bank" || account.accountType === "credit_card") && account.currencyCode === null && account.isActive;
}

function defaultBank(accounts: Account[]): string {
  const banks = accounts.filter(isPaymentAccount);
  return (banks.find((account) => account.systemKey === "bank") ?? banks[0])?.code ?? "";
}

function journalLink(journalId: string, label: string) {
  return <Link href={`/operations/ledger-journals?journal=${journalId}`}>{label}</Link>;
}

function StatusBadge({ status, voidDate }: { status: "active" | "voided"; voidDate: string | null }) {
  return status === "voided" ? <Badge tone="neutral">Voided {formatDate(voidDate)}</Badge> : <Badge tone="green">Paid</Badge>;
}

/**
 * The pay run's wages: what's unpaid, paying it from a bank account as a
 * whole or per employee, and the payments with a void for each (PPAY1-PPAY3).
 */
export function PayRunWagePayments({ organisationId, payRunId }: { organisationId: string; payRunId: string }) {
  const loaded = useApiData<{ payments: PayRunPayments }>(`/api/payroll/pay-runs/${payRunId}/payments`, { organisationId });
  const accounts = useAccounts(organisationId);
  const [updated, setUpdated] = useState<PayRunPayments | null>(null);
  const data = updated ?? loaded.data?.payments ?? null;
  const [mode, setMode] = useState<"whole" | "per_employee" | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState<string | null>(null);
  const [paymentDate, setPaymentDate] = useState<string | null>(null);
  const [bankCode, setBankCode] = useState<string | null>(null);
  const [payKey, setPayKey] = useState(() => newIdempotencyKey("wages"));
  const [voidKeys] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (loaded.loading) return <Card title="Wages paid"><Empty>Loading…</Empty></Card>;
  if (loaded.error) return <Card title="Wages paid"><Notice tone="error">{loaded.error}</Notice></Card>;
  if (!data) return null;

  const payMode = mode ?? data.paidAs ?? "whole";
  const chosen = data.employees.find((entry) => entry.employeeId === employeeId) ?? null;
  const unpaidNow = payMode === "whole" ? data.unpaid : chosen?.unpaid ?? "";
  const bank = bankCode ?? defaultBank(accounts.data?.accounts ?? []);
  const date = paymentDate ?? (todayInBrowser() > data.payDate ? todayInBrowser() : data.payDate);

  const pay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ payment: WagePayment; payments: PayRunPayments }>(`/api/payroll/pay-runs/${payRunId}/payments`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: payKey,
          paymentDate: date,
          amount: amount ?? unpaidNow,
          bankAccountCode: bank,
          ...(payMode === "per_employee" ? { employeeId } : {}),
        },
      });
      setUpdated(result.payments);
      setPayKey(newIdempotencyKey("wages"));
      setAmount(null);
      setEmployeeId("");
      setMessage({ tone: "success", text: `${result.payment.reference} recorded: ${formatMoney(result.payment.amount)} from ${result.payment.bankAccountCode}.` });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const voidPayment = async (payment: WagePayment) => {
    const voidDate = window.prompt(`Void ${payment.reference} on (YYYY-MM-DD)? This posts the exact reversal of its journal.`, todayInBrowser());
    if (!voidDate) return;
    const idempotencyKey = voidKeys.get(payment.id) ?? newIdempotencyKey("wages-void");
    voidKeys.set(payment.id, idempotencyKey);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ payments: PayRunPayments }>(`/api/payroll/pay-runs/${payRunId}/payments/${payment.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey, voidDate },
      });
      setUpdated(result.payments);
      setMessage({ tone: "success", text: `${payment.reference} voided.` });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const canPay = data.payRunStatus === "approved" && data.unpaid !== "0.00";

  return (
    <Card
      title="Wages paid"
      description="Record the net pay leaving the bank: one payment for the pay run, or one per employee when the bank shows a line for each person. Journals say “Net pay”, never whose."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.statRow}>
        <Stat label="Net pay" value={formatMoney(data.netPay)} />
        <Stat label="Paid" value={formatMoney(data.paid)} />
        <Stat label="Unpaid" value={formatMoney(data.unpaid)} />
      </div>
      {canPay ? (
        <form className={styles.stack} onSubmit={pay}>
          {data.paidAs === null ? (
            <Field label="Pay">
              <select value={payMode} onChange={(event) => setMode(event.target.value as "whole" | "per_employee")}>
                <option value="whole">The whole pay run in one payment</option>
                <option value="per_employee">Each employee separately</option>
              </select>
            </Field>
          ) : (
            <p className={ui.muted}>{data.paidAs === "whole" ? "This pay run is being paid as a whole." : "This pay run is being paid per employee."}</p>
          )}
          <div className={ui.grid4}>
            {payMode === "per_employee" ? (
              <Field label="Employee">
                <select required value={employeeId} onChange={(event) => { setEmployeeId(event.target.value); setAmount(null); }}>
                  <option value="">Choose an employee</option>
                  {data.employees.filter((entry) => entry.unpaid !== "0.00").map((entry) => (
                    <option key={entry.employeeId} value={entry.employeeId}>{entry.name} ({formatMoney(entry.unpaid)} unpaid)</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="Paid on" hint={`On or after the pay date (${formatDate(data.payDate)}).`}>
              <input min={data.payDate} required type="date" value={date} onChange={(event) => setPaymentDate(event.target.value)} />
            </Field>
            <Field label="Amount">
              <input inputMode="decimal" required value={amount ?? unpaidNow} onChange={(event) => setAmount(event.target.value)} />
            </Field>
            <Field label="From">
              <AccountSelect accounts={accounts.data?.accounts ?? []} value={bank} onChange={setBankCode} filter={isPaymentAccount} ariaLabel="Bank account" />
            </Field>
          </div>
          <div className={ui.actions}>
            <Button disabled={busy || !bank || (payMode === "per_employee" && !employeeId)} type="submit">Record payment</Button>
          </div>
        </form>
      ) : data.payRunStatus === "approved" ? <Notice tone="success">The net pay is paid in full.</Notice> : null}
      {data.paidAs === "per_employee" ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>Employee</th><th>Net pay</th><th>Paid</th><th>Unpaid</th></tr></thead>
            <tbody>
              {data.employees.map((entry) => (
                <tr key={entry.employeeId}>
                  <td data-label="Employee">{entry.name}</td>
                  <td data-label="Net pay"><Money value={entry.netPay} /></td>
                  <td data-label="Paid"><Money value={entry.paid} /></td>
                  <td data-label="Unpaid"><Money value={entry.unpaid} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.payments.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>Payment</th><th>Date</th><th>For</th><th>From</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.payments.map((payment) => (
                <tr key={payment.id}>
                  <td data-label="Payment">{journalLink(payment.journalId, payment.reference)}</td>
                  <td data-label="Date">{formatDate(payment.paymentDate)}</td>
                  <td data-label="For">{payment.employeeName ?? "Whole pay run"}</td>
                  <td data-label="From">{payment.bankAccountCode} · {payment.bankAccountName}</td>
                  <td data-label="Amount"><Money value={payment.amount} /></td>
                  <td data-label="Status"><StatusBadge status={payment.status} voidDate={payment.voidDate} /></td>
                  <td>
                    {payment.status === "active" ? (
                      <Button disabled={busy} size="small" variant="secondary" onClick={() => void voidPayment(payment)}>Void</Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No wage payments yet.</Empty>}
    </Card>
  );
}

const PUBLIC_HOLIDAY_NOTE = "If that day is a public holiday, IRD accepts payment on the next working day. Tohyee doesn't check public holidays yet.";

function DueDate({ period }: { period: IrdPeriodSummary }) {
  return (
    <>
      {period.dueWeekday} {formatDate(period.dueDate)}
      {period.payBy !== period.dueDate ? <span className={ui.muted}> · IRD accepts payment by Monday {formatDate(period.payBy)}</span> : null}
    </>
  );
}

function IrdPeriodPay({
  organisationId,
  period,
  onPaid,
}: {
  organisationId: string;
  period: IrdPeriodSummary;
  onPaid: (period: IrdPeriodSummary, message: string) => void;
}) {
  const accounts = useAccounts(organisationId);
  const [amounts, setAmounts] = useState<Partial<Record<IrdLiability, string>>>({});
  const [paymentDate, setPaymentDate] = useState(() => (todayInBrowser() < period.start ? period.start : todayInBrowser()));
  const [bankCode, setBankCode] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey("ird"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bank = bankCode ?? defaultBank(accounts.data?.accounts ?? []);
  const amountFor = (liability: IrdLiability, owing: string) => amounts[liability] ?? owing;

  const pay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const lines = period.liabilities
        .map((entry) => ({ liability: entry.liability, amount: amountFor(entry.liability, entry.owing).trim() }))
        .filter((line) => line.amount !== "" && !/^0*(\.0*)?$/.test(line.amount));
      const result = await api<{ payment: IrdPayment; period: IrdPeriodSummary }>("/api/payroll/ird-payments", {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, periodStart: period.start, paymentDate, bankAccountCode: bank, lines },
      });
      setKey(newIdempotencyKey("ird"));
      setAmounts({});
      onPaid(result.period, `${result.payment.reference} recorded: ${formatMoney(result.payment.amount)} to IRD from ${result.payment.bankAccountCode}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.stack} onSubmit={pay}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.stackOnPhone}>
          <thead><tr><th>Liability</th><th>Account</th><th>From pay runs</th><th>Paid</th><th>Owing</th><th>Pay now</th></tr></thead>
          <tbody>
            {period.liabilities.map((entry) => (
              <tr key={entry.liability}>
                <td data-label="Liability">{entry.label}</td>
                <td data-label="Account">{entry.accountCode ?? "—"}</td>
                <td data-label="From pay runs"><Money value={entry.fromPayRuns} /></td>
                <td data-label="Paid"><Money value={entry.paid} /></td>
                <td data-label="Owing"><Money value={entry.owing} /></td>
                <td data-label="Pay now">
                  <input
                    aria-label={`${entry.label} to pay`}
                    disabled={entry.owing === "0.00"}
                    inputMode="decimal"
                    value={amountFor(entry.liability, entry.owing)}
                    onChange={(event) => setAmounts((current) => ({ ...current, [entry.liability]: event.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.grid3}>
        <Field label="Paid on">
          <input min={period.start} required type="date" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
        </Field>
        <Field label="From">
          <AccountSelect accounts={accounts.data?.accounts ?? []} value={bank} onChange={setBankCode} filter={isPaymentAccount} ariaLabel="Bank account" />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button disabled={busy || !bank} type="submit">Record IRD payment</Button>
      </div>
    </form>
  );
}

/**
 * Payroll › IRD payments (PPAY4-PPAY9): what's owing to IRD per period from
 * approved pay runs (by pay date), the due date, paying it in full or in
 * part, and voiding payments.
 */
export function IrdPayments({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ frequency: "monthly" | "twice_monthly"; periods: IrdPeriodSummary[] }>("/api/payroll/ird-payments", { organisationId });
  const [replaced, setReplaced] = useState<Record<string, IrdPeriodSummary>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [voidKeys] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (loaded.loading) return <Empty>Loading…</Empty>;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const periods = (loaded.data?.periods ?? []).map((period) => replaced[`${period.start}|${period.end}`] ?? period);
  const today = todayInBrowser();

  const voidPayment = async (payment: IrdPayment) => {
    const voidDate = window.prompt(`Void ${payment.reference} on (YYYY-MM-DD)? This posts the exact reversal of its journal.`, today);
    if (!voidDate) return;
    const idempotencyKey = voidKeys.get(payment.id) ?? newIdempotencyKey("ird-void");
    voidKeys.set(payment.id, idempotencyKey);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ period: IrdPeriodSummary }>(`/api/payroll/ird-payments/${payment.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey, voidDate },
      });
      setReplaced((current) => ({ ...current, [`${result.period.start}|${result.period.end}`]: result.period }));
      setMessage({ tone: "success", text: `${payment.reference} voided.` });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.stack}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Notice tone="info">
        You pay IRD {loaded.data?.frequency === "twice_monthly" ? "twice a month" : "monthly"} (change it under Payroll › Pay items). Pay runs count in the
        period of their pay date. {PUBLIC_HOLIDAY_NOTE}
      </Notice>
      {periods.length === 0 ? <Empty>No approved pay runs yet, so nothing is owing to IRD.</Empty> : null}
      {periods.map((period) => {
        const id = `${period.start}|${period.end}`;
        const late = period.totalOwing !== "0.00" && today > period.payBy;
        return (
          <Card
            key={id}
            title={`${formatDate(period.start)} to ${formatDate(period.end)}`}
            description={period.payRuns.length ? `Pay runs: ${period.payRuns.map((run) => run.reference).join(", ")}` : "No approved pay runs in this period."}
            actions={
              period.totalOwing === "0.00" ? <Badge tone="green">Paid</Badge> : late ? <Badge tone="red">Late</Badge> : <Badge tone="amber">Owing</Badge>
            }
          >
            <div className={ui.statRow}>
              <Stat label="Owing" value={formatMoney(period.totalOwing)} />
              <Stat label="Paid" value={formatMoney(period.totalPaid)} />
              <Stat label="Due" value={<DueDate period={period} />} />
            </div>
            {open === id ? (
              <IrdPeriodPay
                organisationId={organisationId}
                period={period}
                onPaid={(summary, text) => {
                  setReplaced((current) => ({ ...current, [id]: summary }));
                  setOpen(null);
                  setMessage({ tone: "success", text });
                }}
              />
            ) : period.totalOwing !== "0.00" ? (
              <div className={ui.actions}>
                <Button onClick={() => setOpen(id)}>Pay IRD for this period</Button>
              </div>
            ) : null}
            {period.payments.length ? (
              <div className={ui.tableWrap}>
                <table className={ui.stackOnPhone}>
                  <thead><tr><th>Payment</th><th>Date</th><th>Pays</th><th>From</th><th>Amount</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {period.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td data-label="Payment">{journalLink(payment.journalId, payment.reference)}</td>
                        <td data-label="Date">{formatDate(payment.paymentDate)}</td>
                        <td data-label="Pays">{payment.lines.map((line) => `${line.label} ${formatMoney(line.amount)}`).join(" · ")}</td>
                        <td data-label="From">{payment.bankAccountCode} · {payment.bankAccountName}</td>
                        <td data-label="Amount"><Money value={payment.amount} /></td>
                        <td data-label="Status"><StatusBadge status={payment.status} voidDate={payment.voidDate} /></td>
                        <td>
                          {payment.status === "active" ? (
                            <Button disabled={busy} size="small" variant="secondary" onClick={() => void voidPayment(payment)}>Void</Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
