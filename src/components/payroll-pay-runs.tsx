"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PAY_FREQUENCY_LABELS } from "@/components/payroll-groups";
import { PayRunPaydayFilingCard } from "@/components/payroll-payday-filing";
import { PayRunBankFileCard, PayRunPayslips } from "@/components/payroll-p5";
import { PayRunWagePayments } from "@/components/payroll-payments";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { PayGroup } from "@/lib/payroll/groups";
import type { PayItem } from "@/lib/payroll/pay-items";
import type { PayRate } from "@/lib/payroll/pay-rates";
import type { PayRun, PayRunEmployee, PayRunPosting, PayRunStatus, PayRunSummary, PayRunTotals } from "@/lib/payroll/pay-runs";
import styles from "./payroll-employees.module.css";
import { useConfirm } from "@/components/confirm-dialog";

const STATUS: Record<PayRunStatus, { label: string; tone: "amber" | "green" | "neutral" }> = {
  draft: { label: "Draft", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  voided: { label: "Voided", tone: "neutral" },
};

function StatusBadge({ status }: { status: PayRunStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

/** The figures shown for one person or the whole run (PRUN1). */
const FIGURES: Array<[keyof PayRunTotals, string]> = [
  ["gross", "Gross"],
  ["paye", "PAYE (incl. ACC levy)"],
  ["studentLoan", "Student loan"],
  ["kiwiSaverEmployee", "KiwiSaver (employee)"],
  ["deductions", "After-tax deductions"],
  ["netPay", "Net pay"],
  ["kiwiSaverEmployer", "KiwiSaver (employer)"],
  ["esct", "ESCT"],
  ["employerCost", "Employer cost"],
];

function Figures({ figures }: { figures: PayRunTotals }) {
  return (
    <div className={ui.tableWrap}>
      <table>
        <tbody>
          {FIGURES.map(([field, label]) => (
            <tr key={field}>
              <th scope="row">{label}</th>
              <td className={ui.num}>{formatMoney(figures[field])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Payroll › Pay runs: start a draft and list the runs (PRUN1). */
export function PayRunList({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const groups = useApiData<{ payGroups: PayGroup[] }>("/api/payroll/groups", { organisationId });
  const runs = useApiData<{ payRuns: PayRunSummary[] }>("/api/payroll/pay-runs", { organisationId });
  const [payGroupId, setPayGroupId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [payDate, setPayDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ payRun: PayRun }>("/api/payroll/pay-runs", {
        method: "POST",
        body: { organisationId, idempotencyKey: newIdempotencyKey("pay-run"), payGroupId, periodStart, payDate },
      });
      router.push(`/operations/payroll/pay-runs/${result.payRun.id}`);
    } catch (cause) {
      setMessage(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div className={styles.stack}>
      <Card title="Start a pay run">
        <form className={styles.stack} onSubmit={create}>
          <p>
            Tohyee adds everyone in the pay group who works during the period, with their pay rate. The period ends one week, fortnight,
            four weeks or month after it starts, by the group&apos;s frequency.
          </p>
          {message ? <Notice tone="error">{message}</Notice> : null}
          <div className={ui.grid3}>
            <Field label="Pay group">
              <select required value={payGroupId} onChange={(event) => setPayGroupId(event.target.value)}>
                <option value="">Choose a pay group</option>
                {(groups.data?.payGroups ?? []).map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name} ({PAY_FREQUENCY_LABELS[group.payFrequency].toLowerCase()})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Period starts">
              <input required type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
            </Field>
            <Field label="Pay date" hint="IRD's rates are picked by this date.">
              <input required type="date" value={payDate} onChange={(event) => setPayDate(event.target.value)} />
            </Field>
          </div>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Start pay run</Button>
          </div>
        </form>
      </Card>

      <Card title="Pay runs">
        {runs.error ? <Notice tone="error">{runs.error}</Notice> : null}
        {runs.loading ? <Empty>Loading…</Empty> : runs.data?.payRuns.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Pay run</th><th>Pay group</th><th>Period</th><th>Pay date</th><th>Employees</th><th>Status</th></tr></thead>
              <tbody>
                {runs.data.payRuns.map((run) => (
                  <tr key={run.id}>
                    <td data-label="Pay run"><Link href={`/operations/payroll/pay-runs/${run.id}`}>{run.reference}</Link></td>
                    <td data-label="Pay group">{run.payGroupName}</td>
                    <td data-label="Period">{formatDate(run.periodStart)} to {formatDate(run.periodEnd)}</td>
                    <td data-label="Pay date">{formatDate(run.payDate)}</td>
                    <td data-label="Employees">{run.employeeCount}</td>
                    <td data-label="Status"><StatusBadge status={run.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No pay runs yet.</Empty>}
      </Card>
    </div>
  );
}

type DraftLine = { payItemId: string; quantity: string; rate: string; amount: string; description: string; regular: boolean | null };

/** Pay item kinds Tohyee works out from leave (P8): never typed. */
const LEAVE_KINDS = new Set([
  "annual_leave",
  "sick_leave",
  "bereavement_leave",
  "family_violence_leave",
  "public_holiday",
  "public_holiday_worked",
  "alternative_holiday",
  "annual_leave_cash_up",
  "alternative_holiday_payout",
]);

/**
 * Typed lines (and, unless the usual pay stays Tohyee's, the usual pay):
 * back pay worked out from pay rate history (XP10) and leave Tohyee worked
 * out (P8) aren't edited here.
 */
function draftLines(employee: PayRunEmployee, keepUsualPay: boolean): DraftLine[] {
  return employee.lines
    .filter((line) => line.backPayForPayRunId === null && line.source !== "leave" && (line.source === "typed" || !keepUsualPay))
    .map((line) => ({
      payItemId: line.payItemId,
      quantity: line.quantity ?? "",
      rate: line.quantity === null ? "" : line.rate ?? "",
      amount: line.quantity === null ? line.amount : "",
      description: line.description ?? "",
      regular: line.regular,
    }));
}

const SOURCE_LABELS: Record<string, string> = { usual_pay: "Usual week", leave: "Leave" };

/** A leave line's dates and units, for the table (decision 8). */
function leaveDetail(line: PayRunEmployee["lines"][number]): string {
  const leave = line.leave;
  if (!leave) return "";
  const parts: string[] = [];
  if (leave.units && leave.hours) parts.push(`${leave.units} ${["annual", "cash_up"].includes(leave.type) ? "weeks" : "days"}, ${leave.hours} h`);
  else if (leave.hours) parts.push(`${leave.hours} h`);
  if (leave.inAdvance) parts.push("in advance");
  return parts.join(" · ");
}

function EmployeePay({
  organisationId,
  run,
  employee,
  payItems,
  onChanged,
}: {
  organisationId: string;
  run: PayRun;
  employee: PayRunEmployee;
  payItems: PayItem[];
  onChanged: (message: string, payRun?: PayRun) => void;
}) {
  const confirm = useConfirm();
  const editable = run.status === "draft";
  const hasUsualPay = employee.lines.some((line) => line.source === "usual_pay");
  const [keepUsualPay, setKeepUsualPay] = useState(hasUsualPay);
  const [lines, setLines] = useState<DraftLine[]>(() => draftLines(employee, hasUsualPay));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = new Set(employee.lines.map((line) => line.payItemId));
  const choices = payItems.filter(
    (item) => item.category !== "employer_contribution" && !LEAVE_KINDS.has(item.kind) && (!item.isArchived || used.has(item.id)),
  );

  const change = (index: number, field: keyof DraftLine, value: string) =>
    setLines((current) => current.map((line, at) => (at === index ? { ...line, [field]: value } : line)));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        organisationId,
        keepUsualPay: hasUsualPay && keepUsualPay,
        lines: lines.map((line) => ({
          payItemId: line.payItemId,
          ...(line.quantity.trim() ? { quantity: line.quantity.trim(), rate: line.rate.trim() || null } : { amount: line.amount.trim() }),
          description: line.description.trim() || null,
          ...(line.regular === null ? {} : { regular: line.regular }),
        })),
      };
      const result = await api<{ payRun: PayRun }>(`/api/payroll/pay-runs/${run.id}/employees/${employee.employeeId}`, { method: "PUT", body });
      setEditing(false);
      onChanged(`${employee.name}'s pay saved.`, result.payRun);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm(`Leave ${employee.name} out of ${run.reference}? You can't add them back to this draft.`))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ payRun: PayRun }>(`/api/payroll/pay-runs/${run.id}/employees/${employee.employeeId}`, {
        method: "DELETE",
        query: { organisationId },
      });
      onChanged(`${employee.name} left out of ${run.reference}.`, result.payRun);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const backPayLines = employee.lines.filter((line) => line.backPayForPayRunId !== null);
  const removeBackPay = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ payRun: PayRun }>(`/api/payroll/pay-runs/${run.id}/employees/${employee.employeeId}/back-pay`, {
        method: "DELETE",
        query: { organisationId },
      });
      onChanged(`Back pay taken off ${employee.name}'s pay.`, result.payRun);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const kiwiSaver =
    employee.kiwiSaverStatus === "enrolled"
      ? `KiwiSaver ${employee.kiwiSaverEmployeeRate}% / employer ${employee.kiwiSaverEmployerRate}%${employee.esctRate ? `, ESCT ${employee.esctRate}%` : ""}`
      : "Not in KiwiSaver";

  return (
    <Card
      title={employee.name}
      description={`Tax code ${employee.taxCode} · ${kiwiSaver}${employee.hourlyRate ? ` · $${employee.hourlyRate} an hour` : ""}`}
      actions={
        editable && !editing ? (
          <div className={ui.actions}>
            <Button disabled={busy} size="small" variant="secondary" onClick={() => setEditing(true)}>Edit pay</Button>
            <Button disabled={busy} size="small" variant="secondary" onClick={() => void remove()}>Leave out</Button>
          </div>
        ) : null
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {employee.problem ? <Notice tone="warning">{employee.problem}</Notice> : null}
      {employee.notes.map((note) => <Notice key={note}>{note}</Notice>)}
      {employee.timesheets ? (
        <p className={ui.muted}>
          {employee.timesheets.count} approved timesheet{employee.timesheets.count === 1 ? "" : "s"} ({employee.timesheets.hours} h) cover{" "}
          {employee.timesheets.coveredDays} of {employee.timesheets.periodDays} days: costs for those days follow the timesheets
          {employee.timesheets.allDaysCovered ? "" : ", the rest the default cost allocation"}.
          {run.status === "draft" ? " Worked out again when the pay run is approved." : ""}
        </p>
      ) : null}
      {editing ? (
        <form className={styles.stack} onSubmit={save}>
          {hasUsualPay ? (
            <label className={ui.checkbox}>
              <input
                checked={keepUsualPay}
                type="checkbox"
                onChange={(event) => {
                  setKeepUsualPay(event.target.checked);
                  setLines(draftLines(employee, event.target.checked));
                }}
              />
              Keep the usual pay from the usual week (Tohyee takes leave and public holidays off it). Untick to change it by hand.
            </label>
          ) : null}
          {lines.map((line, index) => (
            <div className={ui.grid4} key={index}>
              <Field label="Pay item">
                <select required value={line.payItemId} onChange={(event) => change(index, "payItemId", event.target.value)}>
                  <option value="">Choose a pay item</option>
                  {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </Field>
              <Field label="Hours" hint="Or leave blank and give an amount.">
                <input inputMode="decimal" value={line.quantity} onChange={(event) => change(index, "quantity", event.target.value)} />
              </Field>
              {line.quantity.trim() ? (
                <Field label="Rate" hint="Blank uses the hourly rate.">
                  <input inputMode="decimal" value={line.rate} onChange={(event) => change(index, "rate", event.target.value)} />
                </Field>
              ) : (
                <Field label="Amount">
                  <input inputMode="decimal" value={line.amount} onChange={(event) => change(index, "amount", event.target.value)} />
                </Field>
              )}
              <Field label="Description">
                <input maxLength={200} value={line.description} onChange={(event) => change(index, "description", event.target.value)} />
              </Field>
              {["overtime", "allowance"].includes(payItems.find((item) => item.id === line.payItemId)?.kind ?? "") ? (
                <label className={ui.checkbox}>
                  <input
                    checked={line.regular ?? false}
                    type="checkbox"
                    onChange={(event) => setLines((current) => current.map((entry, at) => (at === index ? { ...entry, regular: event.target.checked } : entry)))}
                  />
                  A regular part of pay (holiday pay, decision 11)
                </label>
              ) : null}
              <div className={ui.actions}>
                <Button size="small" variant="secondary" onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>
                  Remove line
                </Button>
              </div>
            </div>
          ))}
          {backPayLines.length ? (
            <p className={ui.muted}>
              Back pay worked out from the pay rate history ({backPayLines.length} line{backPayLines.length === 1 ? "" : "s"}) stays as it is.
            </p>
          ) : null}
          <div className={ui.actions}>
            <Button
              variant="secondary"
              onClick={() => setLines((current) => [...current, { payItemId: "", quantity: "", rate: "", amount: "", description: "", regular: null }])}
            >
              Add line
            </Button>
            <Button disabled={busy} type="submit">Save and calculate</Button>
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => {
                setLines(draftLines(employee, keepUsualPay));
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : employee.lines.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>Pay item</th><th>Hours</th><th>Rate</th><th>Amount</th></tr></thead>
            <tbody>
              {employee.lines.map((line) => (
                <tr key={line.lineNumber}>
                  <td data-label="Pay item">
                    {line.payItemName}
                    {line.source !== "typed" ? <> <Badge tone={line.source === "leave" ? "blue" : "neutral"}>{SOURCE_LABELS[line.source]}</Badge></> : null}
                    {line.description ? <span className={ui.muted}> · {line.description}</span> : null}
                    {line.leave ? <span className={ui.muted}> {leaveDetail(line) ? `(${leaveDetail(line)})` : ""}</span> : null}
                  </td>
                  <td data-label="Hours" className={ui.num}>{line.quantity ?? ""}</td>
                  <td data-label="Rate" className={ui.num}>{line.rate ?? ""}</td>
                  <td data-label="Amount">
                    {line.category === "deduction" ? "−" : ""}
                    <Money value={line.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No earnings yet.</Empty>}
      {editable && !editing ? <PublicHolidayDecision organisationId={organisationId} run={run} employee={employee} onChanged={onChanged} /> : null}
      {editable && !editing ? (
        <BackPay
          organisationId={organisationId}
          run={run}
          employee={employee}
          payItems={payItems}
          hasBackPay={backPayLines.length > 0}
          busy={busy}
          onRemove={() => void removeBackPay()}
          onChanged={onChanged}
        />
      ) : null}
      {employee.pay ? <Figures figures={employee.pay} /> : null}
    </Card>
  );
}

/**
 * Records whether a public holiday in the period would otherwise have been a
 * working day for the employee and the hours worked on it (decisions 21,
 * 23), then works the draft's leave out again.
 */
function PublicHolidayDecision({
  organisationId,
  run,
  employee,
  onChanged,
}: {
  organisationId: string;
  run: PayRun;
  employee: PayRunEmployee;
  onChanged: (message: string, payRun?: PayRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [holidayDate, setHolidayDate] = useState(run.periodStart);
  const [otherwiseWorking, setOtherwiseWorking] = useState("true");
  const [hoursWorked, setHoursWorked] = useState("");
  const [penal, setPenal] = useState("");
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const suggestion = employee.problem?.match(/Tohyee suggests (yes|no): ([^)]+)\)/);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/api/payroll/leave/public-holidays", {
        method: "POST",
        body: {
          organisationId,
          employeeId: employee.employeeId,
          holidayDate,
          otherwiseWorking: otherwiseWorking === "true",
          hoursWorked: hoursWorked.trim() || null,
          penalHourlyRate: penal.trim() || null,
          extraAmount: extra.trim() || null,
          suggestion: suggestion ? suggestion[2] : null,
        },
      });
      const result = await api<{ payRun: PayRun }>(`/api/payroll/pay-runs/${run.id}`, { query: { organisationId } });
      setOpen(false);
      onChanged(`Public holiday decision recorded for ${employee.name}.`, result.payRun);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className={ui.actions}>
        <Button size="small" variant="secondary" onClick={() => setOpen(true)}>Public holiday…</Button>
      </div>
    );
  }
  return (
    <form className={styles.stack} onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Whether a public holiday would otherwise have been a working day for {employee.name} (s 12), and any hours worked on it (s 50: time and a
        half, and an alternative holiday if it would otherwise have been a working day). The decision is recorded with who made it.
        {suggestion ? ` Tohyee suggests ${suggestion[1]}: ${suggestion[2]}.` : ""} That suggestion only looks at recent weeks: also weigh the
        employment agreement, rosters, whether they work only when work is available, what you both reasonably expected, and whether they&apos;d have
        worked but for the holiday (s 12(3)). Employment NZ: you can&apos;t rely on one factor alone (decision 173).
      </p>
      <div className={ui.grid4}>
        <Field label="Public holiday">
          <input required type="date" min={run.periodStart} max={run.periodEnd} value={holidayDate} onChange={(event) => setHolidayDate(event.target.value)} />
        </Field>
        <Field label="Would otherwise be a working day">
          <select value={otherwiseWorking} onChange={(event) => setOtherwiseWorking(event.target.value)}>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </Field>
        <Field label="Hours worked" hint="Blank if not worked.">
          <input inputMode="decimal" value={hoursWorked} onChange={(event) => setHoursWorked(event.target.value)} />
        </Field>
        <Field label="Penal rate an hour" hint="Only if the agreement has one (s 50(1)(b)).">
          <input inputMode="decimal" value={penal} onChange={(event) => setPenal(event.target.value)} />
        </Field>
        <Field label="Extra under the agreement" hint="Typed, for working part of the day (decision 23).">
          <input inputMode="decimal" value={extra} onChange={(event) => setExtra(event.target.value)} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button disabled={saving} type="submit">Record decision</Button>
        <Button disabled={saving} variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Adds back pay for approved pay periods from a pay rate in the employee's history (XP10). */
function BackPay({
  organisationId,
  run,
  employee,
  payItems,
  hasBackPay,
  busy,
  onRemove,
  onChanged,
}: {
  organisationId: string;
  run: PayRun;
  employee: PayRunEmployee;
  payItems: PayItem[];
  hasBackPay: boolean;
  busy: boolean;
  onRemove: () => void;
  onChanged: (message: string, payRun?: PayRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [payItemId, setPayItemId] = useState("");
  const [payRateId, setPayRateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backPayItems = payItems.filter((item) => item.kind === "back_pay" && !item.isArchived);
  const rates = useApiData<{ payRates: PayRate[] }>(open ? `/api/payroll/employees/${employee.employeeId}/pay-rates` : null, { organisationId });
  const earlier = (rates.data?.payRates ?? []).filter((rate) => rate.effectiveFrom < run.periodStart);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ payRun: PayRun }>(`/api/payroll/pay-runs/${run.id}/employees/${employee.employeeId}/back-pay`, {
        method: "POST",
        body: { organisationId, payItemId, payRateId },
      });
      setOpen(false);
      onChanged(`Back pay added to ${employee.name}'s pay.`, result.payRun);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className={ui.actions}>
        <Button disabled={busy} size="small" variant="secondary" onClick={() => setOpen(true)}>Add back pay</Button>
        {hasBackPay ? <Button disabled={busy} size="small" variant="secondary" onClick={onRemove}>Remove back pay</Button> : null}
      </div>
    );
  }
  return (
    <form className={styles.stack} onSubmit={add}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Back pay for approved pay periods paid at less than a pay rate in {employee.name}&apos;s history. It&apos;s taxed as an extra pay.
        Add the new pay rate under Employees first.
      </p>
      {backPayItems.length === 0 ? <Notice tone="warning">Add a pay item of the kind Back pay under Payroll › Pay items first.</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Pay item">
          <select required value={payItemId} onChange={(event) => setPayItemId(event.target.value)}>
            <option value="">Choose</option>
            {backPayItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="Pay rate">
          <select required value={payRateId} onChange={(event) => setPayRateId(event.target.value)}>
            <option value="">Choose</option>
            {earlier.map((rate) => (
              <option key={rate.id} value={rate.id}>
                From {formatDate(rate.effectiveFrom)}: {rate.payBasis === "salary" ? `$${formatMoney(rate.annualSalary)} a year` : `$${formatMoney(rate.hourlyRate)} an hour`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className={ui.actions}>
        <Button disabled={saving || busy} type="submit">Add back pay</Button>
        <Button disabled={saving} variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** One pay run: the per-employee breakdown, then approve or void (PRUN1-PRUN11). */
export function PayRunView({ organisationId, payRunId }: { organisationId: string; payRunId: string }) {
  const confirm = useConfirm();
  const router = useRouter();
  const loaded = useApiData<{ payRun: PayRun }>(`/api/payroll/pay-runs/${payRunId}`, { organisationId });
  const items = useApiData<{ payItems: PayItem[] }>("/api/payroll/pay-items", { organisationId, includeArchived: "true" });
  const [updated, setUpdated] = useState<PayRun | null>(null);
  const run = updated ?? loaded.data?.payRun ?? null;
  const postings = useApiData<{ postings: PayRunPosting[] }>(
    run && run.status !== "draft" ? `/api/payroll/pay-runs/${payRunId}/postings` : null,
    { organisationId },
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [voidDate, setVoidDate] = useState("");

  if (loaded.loading) return <Empty>Loading…</Empty>;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!run) return <Empty>That pay run wasn&apos;t found.</Empty>;

  const act = async (work: () => Promise<{ payRun: PayRun }>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await work();
      setUpdated(result.payRun);
      setMessage({ tone: "success", text: success });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!(await confirm(`Approve ${run.reference}? This posts its journal dated ${formatDate(run.payDate)}. It can't be changed afterwards, only voided.`))) return;
    void act(
      () => api(`/api/payroll/pay-runs/${run.id}/approve`, { method: "POST", body: { organisationId, idempotencyKey: newIdempotencyKey("pay-run-approve") } }),
      `${run.reference} approved and its journal posted.`,
    );
  };

  const voidRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!(await confirm(`Void ${run.reference}? This posts a reversing journal dated ${formatDate(voidDate)}.`))) return;
    void act(
      () =>
        api(`/api/payroll/pay-runs/${run.id}/void`, {
          method: "POST",
          body: { organisationId, idempotencyKey: newIdempotencyKey("pay-run-void"), voidDate },
        }),
      `${run.reference} voided.`,
    );
  };

  const remove = async () => {
    if (!(await confirm(`Delete the draft ${run.reference}? Nothing has been posted.`))) return;
    setBusy(true);
    try {
      await api(`/api/payroll/pay-runs/${run.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/payroll/pay-runs");
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
      setBusy(false);
    }
  };

  const blockedBySelf = run.status === "draft" && run.approverMustDiffer && run.preparedByMe;
  const payItems = items.data?.payItems ?? [];

  return (
    <div className={styles.stack}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card
        title={`${run.reference} · ${run.payGroupName}`}
        description={`${PAY_FREQUENCY_LABELS[run.payFrequency]} · ${formatDate(run.periodStart)} to ${formatDate(run.periodEnd)} · paid ${formatDate(run.payDate)}`}
        actions={<StatusBadge status={run.status} />}
      >
        <div className={ui.statRow}>
          <Stat label="Gross" value={formatMoney(run.totals.gross)} />
          <Stat label="Net pay" value={formatMoney(run.totals.netPay)} />
          <Stat label="Employer cost" value={formatMoney(run.totals.employerCost)} />
          <Stat label="Employees" value={run.employees.length} />
        </div>
        <p className={ui.muted}>
          Prepared by {run.createdByEmail}
          {run.approvedByEmail ? ` · approved by ${run.approvedByEmail} on ${formatDateTime(run.approvedAt)}` : ""}
          {run.voidedByEmail ? ` · voided by ${run.voidedByEmail}, dated ${formatDate(run.voidDate)}` : ""}
        </p>
        {run.approvalJournalId ? (
          <p>
            <Link href={`/operations/ledger-journals?journal=${run.approvalJournalId}`}>Its journal</Link>
            {run.voidJournalId ? (
              <>
                {" "}
                · <Link href={`/operations/ledger-journals?journal=${run.voidJournalId}`}>Void journal</Link>
              </>
            ) : null}
          </p>
        ) : null}
        {run.status === "draft" ? (
          <>
            {run.problemCount ? (
              <Notice tone="warning">
                {run.problemCount === 1 ? "One person's pay can't be calculated" : `${run.problemCount} people's pay can't be calculated`}. Fix it
                before approving.
              </Notice>
            ) : null}
            {blockedBySelf ? <Notice tone="info">You prepared this pay run, so someone else must approve it.</Notice> : null}
            <div className={ui.actions}>
              <Button disabled={busy || run.problemCount > 0 || blockedBySelf || run.employees.length === 0} onClick={approve}>
                Approve and post
              </Button>
              <Button
                disabled={busy}
                variant="secondary"
                onClick={() =>
                  void act(
                    () => api(`/api/payroll/pay-runs/${run.id}/leave`, { method: "POST", body: { organisationId } }),
                    "Leave worked out again from the bookings, public holidays and earlier pay runs.",
                  )
                }
              >
                Update leave
              </Button>
              <Button disabled={busy} variant="danger" onClick={() => void remove()}>Delete draft</Button>
            </div>
            <p className={ui.muted}>
              Leave (Payroll › Leave) is worked out when the draft is made and whenever a booking or decision changes; approving works it out
              again and stops if it changed.
            </p>
          </>
        ) : null}
        {run.status === "approved" ? (
          <form className={styles.stack} onSubmit={voidRun}>
            <div className={ui.grid2}>
              <Field label="Void date" hint="The reversing journal's date. It can't be before the pay date or in a locked period. Void its wage and IRD payments first.">
                <input min={run.payDate} required type="date" value={voidDate} onChange={(event) => setVoidDate(event.target.value)} />
              </Field>
            </div>
            <div className={ui.actions}>
              <Button disabled={busy} type="submit" variant="danger">Void pay run</Button>
            </div>
          </form>
        ) : null}
      </Card>

      {run.status === "approved" ? <PayRunPaydayFilingCard key={`${run.id}:payday-filing`} organisationId={organisationId} payRunId={run.id} /> : null}
      {run.status === "approved" ? <PayRunBankFileCard key={`${run.id}:bank-file`} organisationId={organisationId} payRunId={run.id} payDate={run.payDate} /> : null}

      {run.status !== "draft" ? <PayRunWagePayments key={`${run.id}:${run.status}`} organisationId={organisationId} payRunId={run.id} /> : null}

      {run.status === "approved" ? <PayRunPayslips key={`${run.id}:payslips`} organisationId={organisationId} payRunId={run.id} /> : null}

      <Card title="Totals">
        <Figures figures={run.totals} />
      </Card>

      {run.employees.map((employee) => (
        <EmployeePay
          key={`${employee.employeeId}:${JSON.stringify(employee.lines)}`}
          employee={employee}
          organisationId={organisationId}
          payItems={payItems}
          run={run}
          onChanged={(text, payRun) => {
            if (payRun) setUpdated(payRun);
            setMessage({ tone: "success", text });
          }}
        />
      ))}

      {run.status !== "draft" ? (
        <Card
          title="Cost allocation"
          description="How each person's earnings and employer KiwiSaver were split by their allocation on the pay date. Only people with payroll access see this; the journal shows totals by account and tracking."
        >
          {postings.error ? <Notice tone="error">{postings.error}</Notice> : null}
          {postings.loading ? <Empty>Loading…</Empty> : postings.data?.postings.length ? (
            <div className={ui.tableWrap}>
              <table className={ui.stackOnPhone}>
                <thead><tr><th>Employee</th><th>Pay item</th><th>Account</th><th>Journal line</th><th>Share</th><th>Amount</th></tr></thead>
                <tbody>
                  {postings.data.postings.map((posting) => (
                    <tr key={posting.postingNumber}>
                      <td data-label="Employee">{posting.employeeName}</td>
                      <td data-label="Pay item">{posting.payItemName}</td>
                      <td data-label="Account">{posting.accountCode}</td>
                      <td data-label="Journal line">{posting.journalLineOrder}</td>
                      <td data-label="Share" className={ui.num}>{posting.percentage}%</td>
                      <td data-label="Amount"><Money value={posting.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No postings.</Empty>}
        </Card>
      ) : null}
    </div>
  );
}
