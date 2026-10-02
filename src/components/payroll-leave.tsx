"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { postForm } from "@/components/rd";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { EmployeeSummary } from "@/lib/payroll/employees";
import { ANNIVERSARY_REGION_LABELS, ANNIVERSARY_REGIONS, type PublicHolidayYear } from "@/lib/payroll/leave/public-holiday-dates";
import { LEAVE_TYPE_LABELS, LEAVE_TYPES, type LeaveType } from "@/lib/payroll/leave/rules";
import { BEREAVEMENT_LABELS, type BereavementKind } from "@/lib/payroll/leave/sick";
import type { OpeningBalances } from "@/lib/payroll/leave-opening";
import type { CashUp, LeaveBooking, PublicHolidayDecision, UnpaidLeaveRecord } from "@/lib/payroll/leave-records";
import type { LeaveLiabilityPosting, LeaveLiabilityReminder } from "@/lib/payroll/leave-liability";
import type { LeaveLiabilityReport, LeaveRecord, LeaveSummary } from "@/lib/payroll/leave-reports";
import type { LeaveSettings, OrganisationLeaveSettings } from "@/lib/payroll/leave-settings";
import type { PayItem } from "@/lib/payroll/pay-items";
import styles from "./payroll-employees.module.css";

/**
 * Holidays Act leave screens (payroll stage P8): Payroll › Leave (balances,
 * bookings, public holidays, cash-ups, the liability report and settings),
 * an employee's leave on their page, and their holiday and leave record.
 * Everything needs payroll access.
 */

const TABS = ["Balances", "Bookings", "Public holidays", "Cash-ups", "Liability", "Settings"] as const;
type Tab = (typeof TABS)[number];

function useEmployees(organisationId: string) {
  return useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", { organisationId });
}

function trim(value: string | null | undefined): string {
  if (!value) return "";
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Payroll › Leave. */
export function LeavePage({ organisationId }: { organisationId: string }) {
  const [tab, setTab] = useState<Tab>("Balances");
  return (
    <div className={styles.stack}>
      <div className={ui.actions} role="tablist">
        {TABS.map((name) => (
          <Button key={name} aria-selected={tab === name} role="tab" size="small" variant={tab === name ? "primary" : "secondary"} onClick={() => setTab(name)}>
            {name}
          </Button>
        ))}
      </div>
      {tab === "Balances" ? <Balances organisationId={organisationId} /> : null}
      {tab === "Bookings" ? <Bookings organisationId={organisationId} /> : null}
      {tab === "Public holidays" ? <PublicHolidays organisationId={organisationId} /> : null}
      {tab === "Cash-ups" ? <CashUps organisationId={organisationId} /> : null}
      {tab === "Liability" ? <Liability organisationId={organisationId} /> : null}
      {tab === "Settings" ? <OrganisationSettings organisationId={organisationId} /> : null}
    </div>
  );
}

function Balances({ organisationId }: { organisationId: string }) {
  const [asAt, setAsAt] = useState(todayInBrowser());
  const balances = useApiData<{ balances: LeaveSummary[] }>("/api/payroll/leave/balances", { organisationId, asAt });
  return (
    <Card
      title="Leave balances"
      description="Annual holidays in weeks with their hours (decision 8), sick and family violence leave in days, alternative holidays, and the running 8% since the last anniversary (HL42). Counted from approved pay runs."
      actions={
        <Field label="As at">
          <input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} />
        </Field>
      }
    >
      {balances.error ? <Notice tone="error">{balances.error}</Notice> : null}
      {balances.loading ? <Empty>Loading…</Empty> : balances.data?.balances.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead>
              <tr><th>Employee</th><th>Annual holidays</th><th>Sick leave</th><th>Family violence leave</th><th>Alternative holidays</th><th>Running 8%</th></tr>
            </thead>
            <tbody>
              {balances.data.balances.map((row) => (
                <tr key={row.employeeId}>
                  <td data-label="Employee"><Link href={`/operations/payroll/leave/record/${row.employeeId}`}>{row.name}</Link></td>
                  {row.kept && row.annual ? (
                    <>
                      <td data-label="Annual holidays">
                        {trim(row.annual.weeks)} weeks<br />
                        <small>{row.annual.hours} h · {trim(row.annual.days)} days · next {formatDate(row.annual.nextEntitled)}</small>
                      </td>
                      <td data-label="Sick leave">{trim(row.sick?.days)} days</td>
                      <td data-label="Family violence leave">{trim(row.familyViolence?.days)} days</td>
                      <td data-label="Alternative holidays">{row.alternative?.untaken ?? 0}</td>
                      <td data-label="Running 8%" className={ui.num}>
                        {row.runningEightPercent && "amount" in row.runningEightPercent ? formatMoney(row.runningEightPercent.amount) : "—"}
                      </td>
                    </>
                  ) : (
                    <td colSpan={5} data-label="Leave"><span className={ui.muted}>{row.notKeptReason}</span></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No employees.</Empty>}
    </Card>
  );
}

type BookingDraft = {
  employeeId: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  hoursWorked: string;
  bereavementKind: BereavementKind;
  inAdvanceAgreed: boolean;
  dayHours: string;
  note: string;
};

function Bookings({ organisationId }: { organisationId: string }) {
  const employees = useEmployees(organisationId);
  const bookings = useApiData<{ bookings: LeaveBooking[] }>("/api/payroll/leave/bookings", { organisationId, includeCancelled: "true" });
  const blank: BookingDraft = { employeeId: "", leaveType: "annual", startDate: "", endDate: "", hoursWorked: "", bereavementKind: "close_family", inAdvanceAgreed: false, dayHours: "", note: "" };
  const [draft, setDraft] = useState<BookingDraft>(blank);
  const [agreement, setAgreement] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const dayHours = draft.dayHours.trim()
        ? Object.fromEntries(
            draft.dayHours
              .split(/[\n,]+/)
              .map((entry) => entry.trim())
              .filter(Boolean)
              .map((entry) => entry.split(/\s*[=:]\s*|\s+/) as [string, string]),
          )
        : undefined;
      const data = {
        organisationId,
        idempotencyKey: newIdempotencyKey("leave-booking"),
        employeeId: draft.employeeId,
        leaveType: draft.leaveType,
        startDate: draft.startDate,
        endDate: draft.endDate || draft.startDate,
        ...(dayHours ? { dayHours } : {}),
        ...(draft.hoursWorked.trim() ? { hoursWorked: draft.hoursWorked.trim() } : {}),
        ...(draft.leaveType === "bereavement" ? { bereavementKind: draft.bereavementKind } : {}),
        ...(draft.inAdvanceAgreed ? { inAdvanceAgreed: true } : {}),
        note: draft.note.trim() || null,
      };
      let result: { booking: LeaveBooking; warnings: string[]; payRuns: string[] };
      if (agreement) {
        const form = new FormData();
        form.set("data", JSON.stringify(data));
        form.set("advanceAgreement", agreement, agreement.name);
        result = await postForm("/api/payroll/leave/bookings", form);
      } else {
        result = await api("/api/payroll/leave/bookings", { method: "POST", body: data });
      }
      setDraft(blank);
      setAgreement(null);
      bookings.reload();
      setMessage({
        tone: result.warnings.length ? "warning" : "success",
        text: [`${result.booking.reference} booked.`, ...result.warnings, result.payRuns.length ? `Worked out again on ${result.payRuns.join(", ")}.` : ""].join(" ").trim(),
      });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (booking: LeaveBooking) => {
    if (!window.confirm(`Cancel ${booking.reference}?`)) return;
    try {
      await api(`/api/payroll/leave/bookings/${booking.id}/cancel`, { method: "POST", body: { organisationId } });
      bookings.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };

  const set = <K extends keyof BookingDraft>(field: K, value: BookingDraft[K]) => setDraft((current) => ({ ...current, [field]: value }));
  return (
    <>
        <Card
          title="Book leave"
          description="Pay runs for the days booked pay it. Public holidays in the leave are paid as public holidays (s 40(1)); sick, bereavement and family violence leave can be booked over annual holidays (s 36-s 38)."
        >
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <form className={styles.stack} onSubmit={book}>
            <div className={ui.grid4}>
              <Field label="Employee">
                <select required value={draft.employeeId} onChange={(event) => set("employeeId", event.target.value)}>
                  <option value="">Choose</option>
                  {(employees.data?.employees ?? []).filter((employee) => !employee.isArchived).map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.firstName} {employee.lastName}</option>
                  ))}
                </select>
              </Field>
              <Field label="Leave">
                <select value={draft.leaveType} onChange={(event) => set("leaveType", event.target.value as LeaveType)}>
                  {LEAVE_TYPES.map((type) => <option key={type} value={type}>{LEAVE_TYPE_LABELS[type]}</option>)}
                </select>
              </Field>
              <Field label="From">
                <input required type="date" value={draft.startDate} onChange={(event) => set("startDate", event.target.value)} />
              </Field>
              <Field label="To">
                <input type="date" value={draft.endDate} onChange={(event) => set("endDate", event.target.value)} />
              </Field>
              {draft.leaveType === "bereavement" ? (
                <Field label="Bereavement">
                  <select value={draft.bereavementKind} onChange={(event) => set("bereavementKind", event.target.value as BereavementKind)}>
                    {Object.entries(BEREAVEMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
              ) : null}
              {draft.leaveType === "sick" || draft.leaveType === "family_violence" ? (
                <Field label="Hours worked that day" hint="Only for part of one day. A whole day comes off unless a part-day agreement is recorded (decision 19).">
                  <input inputMode="decimal" value={draft.hoursWorked} onChange={(event) => set("hoursWorked", event.target.value)} />
                </Field>
              ) : null}
              <Field label="Hours each day" hint="Only for someone whose hours vary: e.g. 2026-11-04=8, 2026-11-05=6.">
                <input value={draft.dayHours} onChange={(event) => set("dayHours", event.target.value)} />
              </Field>
              <Field label="Note">
                <input maxLength={1000} value={draft.note} onChange={(event) => set("note", event.target.value)} />
              </Field>
            </div>
            {draft.leaveType === "annual" ? (
              <Field label="Written agreement to recover holidays in advance" hint="Attach it when the leave goes beyond the balance (decision 15).">
                <input type="file" onChange={(event) => setAgreement(event.target.files?.[0] ?? null)} />
              </Field>
            ) : draft.leaveType !== "alternative" ? (
              <label className={ui.checkbox}>
                <input checked={draft.inAdvanceAgreed} type="checkbox" onChange={(event) => set("inAdvanceAgreed", event.target.checked)} />
                Leave in advance agreed (s 63(3), s 72D(3))
              </label>
            ) : null}
            <div className={ui.actions}>
              <Button disabled={busy} type="submit">Book leave</Button>
            </div>
          </form>
        </Card>
        <Card title="Bookings">
          {bookings.loading ? <Empty>Loading…</Empty> : bookings.data?.bookings.length ? (
            <div className={ui.tableWrap}>
              <table className={ui.stackOnPhone}>
                <thead><tr><th>Booking</th><th>Employee</th><th>Leave</th><th>Dates</th><th>Paid by</th><th>Actions</th></tr></thead>
                <tbody>
                  {bookings.data.bookings.map((booking) => (
                    <tr key={booking.id}>
                      <td data-label="Booking">{booking.reference} {booking.status === "cancelled" ? <Badge>Cancelled</Badge> : null}</td>
                      <td data-label="Employee">{booking.employeeName}</td>
                      <td data-label="Leave">{LEAVE_TYPE_LABELS[booking.leaveType]}{booking.hoursWorked ? ` (part day: ${booking.hoursWorked} h worked)` : ""}</td>
                      <td data-label="Dates">{formatDate(booking.startDate)}{booking.endDate !== booking.startDate ? ` to ${formatDate(booking.endDate)}` : ""}</td>
                      <td data-label="Paid by">{booking.payRuns.map((run) => `${run.reference} (${run.status})`).join(", ") || "—"}</td>
                      <td data-label="Actions">
                        {booking.status === "booked" ? <Button size="small" variant="secondary" onClick={() => void cancel(booking)}>Cancel</Button> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>No leave booked.</Empty>}
        </Card>
    </>
  );
}

function PublicHolidays({ organisationId }: { organisationId: string }) {
  const data = useApiData<{ years: PublicHolidayYear[]; decisions: PublicHolidayDecision[] }>("/api/payroll/leave/public-holidays", { organisationId });
  const employees = useEmployees(organisationId);
  const names = new Map((employees.data?.employees ?? []).map((employee) => [employee.id, `${employee.firstName} ${employee.lastName}`]));
  return (
    <>
      <Card
        title="Public holiday dates"
        description="Dated data from Employment NZ with the source (decision 22). Christmas to 2 January, Waitangi and ANZAC Day move off a weekend for someone who wouldn't otherwise work that day (s 45, s 45A)."
      >
        {data.error ? <Notice tone="error">{data.error}</Notice> : null}
        {(data.data?.years ?? []).map((year) => (
          <details key={year.year}>
            <summary>{year.year}</summary>
            <p className={ui.muted}>Source: <a href={year.source}>{year.source}</a></p>
            <div className={ui.tableWrap}>
              <table>
                <tbody>
                  {year.national.map((holiday) => (
                    <tr key={holiday.key}><th scope="row">{holiday.name}</th><td>{formatDate(holiday.date)}{holiday.transfer ? " (moves off a weekend)" : ""}</td></tr>
                  ))}
                  {ANNIVERSARY_REGIONS.map((region) => (
                    <tr key={region}><th scope="row">{ANNIVERSARY_REGION_LABELS[region]} Anniversary Day</th><td>{formatDate(year.anniversary[region])}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </Card>
      <Card title="Decisions recorded" description="Whether a public holiday would otherwise have been a working day, and the hours worked on it (decisions 21, 23). Record them on the pay run.">
        {data.data?.decisions.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Holiday</th><th>Employee</th><th>Otherwise a working day</th><th>Hours worked</th><th>Decided</th></tr></thead>
              <tbody>
                {data.data.decisions.map((decision) => (
                  <tr key={`${decision.employeeId}:${decision.holidayDate}`}>
                    <td data-label="Holiday">{decision.holidayName}, {formatDate(decision.holidayDate)}</td>
                    <td data-label="Employee">{names.get(decision.employeeId) ?? ""}</td>
                    <td data-label="Otherwise a working day">{decision.otherwiseWorking ? "Yes" : "No"}{decision.suggestion ? <><br /><small>Suggested: {decision.suggestion}</small></> : null}</td>
                    <td data-label="Hours worked">{decision.hoursWorked ?? "—"}</td>
                    <td data-label="Decided">{decision.decidedByEmail}<br /><small>{decision.decidedAt.slice(0, 10)}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No decisions recorded.</Empty>}
      </Card>
    </>
  );
}

function CashUps({ organisationId }: { organisationId: string }) {
  const employees = useEmployees(organisationId);
  const cashUps = useApiData<{ cashUps: CashUp[] }>("/api/payroll/leave/cash-ups", { organisationId });
  const [employeeId, setEmployeeId] = useState("");
  const [requestedOn, setRequestedOn] = useState("");
  const [agreedOn, setAgreedOn] = useState("");
  const [weeks, setWeeks] = useState("");
  const [request, setRequest] = useState<File | null>(null);
  const [answer, setAnswer] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!request || !answer) {
      setMessage({ tone: "error", text: "Attach the employee's written request and the written answer (decision 29)." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("data", JSON.stringify({ organisationId, idempotencyKey: newIdempotencyKey("cash-up"), employeeId, requestedOn, agreedOn: agreedOn || requestedOn, weeks }));
      form.set("request", request, request.name);
      form.set("answer", answer, answer.name);
      const result = await postForm<{ cashUp: CashUp }>("/api/payroll/leave/cash-ups", form);
      setMessage({ tone: "success", text: `${result.cashUp.reference} recorded; the next pay run pays it.` });
      cashUps.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (cashUp: CashUp) => {
    if (!window.confirm(`Cancel ${cashUp.reference}?`)) return;
    try {
      await api(`/api/payroll/leave/cash-ups/${cashUp.id}/cancel`, { method: "POST", body: { organisationId } });
      cashUps.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };

  return (
    <>
      <Card
        title="Cash up annual holidays"
        description="Only when the employee asks in writing and you agree in writing: at most 1 week an entitlement year, never holidays taken in advance (s 28A-s 28E). Paid at the annual holiday rate in the next pay run, as an extra pay; it isn't gross earnings for holiday pay (s 14(c)(iv))."
      >
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        <form className={styles.stack} onSubmit={save}>
          <div className={ui.grid4}>
            <Field label="Employee">
              <select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
                <option value="">Choose</option>
                {(employees.data?.employees ?? []).filter((employee) => !employee.isArchived).map((employee) => (
                  <option key={employee.id} value={employee.id}>{employee.firstName} {employee.lastName}</option>
                ))}
              </select>
            </Field>
            <Field label="Asked on"><input required type="date" value={requestedOn} onChange={(event) => setRequestedOn(event.target.value)} /></Field>
            <Field label="Agreed on"><input type="date" value={agreedOn} onChange={(event) => setAgreedOn(event.target.value)} /></Field>
            <Field label="Weeks" hint="Up to 1 (0.6 is 3 days of a 5-day week)."><input inputMode="decimal" required value={weeks} onChange={(event) => setWeeks(event.target.value)} /></Field>
          </div>
          <div className={ui.grid2}>
            <Field label="The employee's written request"><input required type="file" onChange={(event) => setRequest(event.target.files?.[0] ?? null)} /></Field>
            <Field label="The written answer agreeing"><input required type="file" onChange={(event) => setAnswer(event.target.files?.[0] ?? null)} /></Field>
          </div>
          <div className={ui.actions}><Button disabled={busy} type="submit">Record cash-up</Button></div>
        </form>
      </Card>
      <Card title="Cash-ups">
        {cashUps.data?.cashUps.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Cash-up</th><th>Employee</th><th>Agreed</th><th>Weeks</th><th>Files</th><th>Paid</th><th>Actions</th></tr></thead>
              <tbody>
                {cashUps.data.cashUps.map((cashUp) => (
                  <tr key={cashUp.id}>
                    <td data-label="Cash-up">{cashUp.reference} {cashUp.status === "cancelled" ? <Badge>Cancelled</Badge> : null}</td>
                    <td data-label="Employee">{cashUp.employeeName}</td>
                    <td data-label="Agreed">{formatDate(cashUp.agreedOn)}</td>
                    <td data-label="Weeks">{cashUp.weeks} ({cashUp.hours} h)</td>
                    <td data-label="Files">
                      <a href={`/api/payroll/leave/files/${cashUp.requestFileId}?organisationId=${organisationId}`}>Request</a> ·{" "}
                      <a href={`/api/payroll/leave/files/${cashUp.answerFileId}?organisationId=${organisationId}`}>Answer</a>
                    </td>
                    <td data-label="Paid">{cashUp.paidOn ? `${cashUp.paidOn.reference} (${cashUp.paidOn.status}) $${formatMoney(cashUp.paidOn.amount)}` : "—"}</td>
                    <td data-label="Actions">{cashUp.status === "agreed" ? <Button size="small" variant="secondary" onClick={() => void cancel(cashUp)}>Cancel</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No cash-ups.</Empty>}
      </Card>
    </>
  );
}

function Liability({ organisationId }: { organisationId: string }) {
  const [asAt, setAsAt] = useState(todayInBrowser());
  const report = useApiData<{ report: LeaveLiabilityReport }>("/api/payroll/leave/liability", { organisationId, asAt });
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setError(null);
    try {
      const response = await fetch("/api/payroll/leave/liability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, asAt }),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "The export failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `Leave liability ${asAt}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const data = report.data?.report;
  return (
    <>
    <Card
      title="Leave liability"
      description="Annual holidays entitled to, at the greater of ordinary weekly pay and average weekly earnings; the running 8% since the last anniversary; untaken alternative holidays; and, for anyone who has finished but whose final pay isn't paid yet, the holiday pay on finishing on it. Employer KiwiSaver on it is shown for enrolled employees (gross, before ESCT). Sick, bereavement and family violence leave aren't in it: if your agreements let unused sick leave be taken as annual leave, journal your own estimate (decision 188). Post it to the ledger below (decisions 177, 189, 190)."
      actions={
        <div className={ui.actions}>
          <Field label="As at"><input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} /></Field>
          <Button size="small" variant="secondary" onClick={() => void download()}>CSV</Button>
        </div>
      }
    >
      {error || report.error ? <Notice tone="error">{error ?? report.error}</Notice> : null}
      {data ? (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Employee</th><th>Department</th><th>Annual holidays</th><th>Value</th><th>Running 8%</th><th>Alternative holidays</th><th>Holiday pay on finishing</th><th>Total</th><th>Employer KiwiSaver</th></tr></thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.employeeId}>
                    <td data-label="Employee">{row.name}{row.problem ? <><br /><small>{row.problem}</small></> : null}</td>
                    <td data-label="Department">{row.department ?? "—"}</td>
                    <td data-label="Annual holidays">{row.annualWeeks ? `${trim(row.annualWeeks)} weeks at $${formatMoney(row.weeklyRate)} (${row.rateUsed?.toUpperCase()})` : "—"}</td>
                    <td data-label="Value" className={ui.num}>{formatMoney(row.annualValue)}</td>
                    <td data-label="Running 8%" className={ui.num}>{formatMoney(row.runningEightPercent)}</td>
                    <td data-label="Alternative holidays" className={ui.num}>{row.alternativeHolidays ? `${row.alternativeHolidays}: ${formatMoney(row.alternativeValue)}` : "—"}</td>
                    <td data-label="Holiday pay on finishing" className={ui.num}>
                      {row.finishDate ? <>{formatMoney(row.holidayPayOnFinishing)}<br /><small>finished {formatDate(row.finishDate)}{row.finalPayDate ? `, paid ${formatDate(row.finalPayDate)}` : ""}</small></> : "—"}
                    </td>
                    <td data-label="Total" className={ui.num}>{formatMoney(row.total)}</td>
                    <td data-label="Employer KiwiSaver" className={ui.num}>{row.kiwiSaverRate ? <>{formatMoney(row.kiwiSaver)}<br /><small>{trim(row.kiwiSaverRate)}%</small></> : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>Total</th>
                  <td className={ui.num}>{formatMoney(data.totals.annualValue)}</td>
                  <td className={ui.num}>{formatMoney(data.totals.runningEightPercent)}</td>
                  <td className={ui.num}>{formatMoney(data.totals.alternativeValue)}</td>
                  <td className={ui.num}>{formatMoney(data.totals.holidayPayOnFinishing)}</td>
                  <td className={ui.num}>{formatMoney(data.totals.total)}</td>
                  <td className={ui.num}>{formatMoney(data.totals.kiwiSaver)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <h3>By Department</h3>
          <div className={ui.tableWrap}>
            <table>
              <tbody>
                {data.departments.map((department) => (
                  <tr key={department.departmentId ?? "none"}>
                    <th scope="row">{department.department ?? "No Department"}</th>
                    <td className={ui.num}>{formatMoney(department.total)}</td>
                    <td className={ui.num}>{department.kiwiSaver !== "0.00" ? `+ KiwiSaver ${formatMoney(department.kiwiSaver)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : report.loading ? <Empty>Loading…</Empty> : null}
    </Card>
    <LiabilityPostings organisationId={organisationId} asAt={asAt} total={data && data.rows.every((row) => row.problem === null) ? data.totals.withKiwiSaver : null} onChanged={report.reload} />
    </>
  );
}

/** Posting the liability to the ledger (decision 177; HL52-HL56) and the postings so far. */
function LiabilityPostings({ organisationId, asAt, total, onChanged }: { organisationId: string; asAt: string; total: string | null; onChanged: () => void }) {
  const postings = useApiData<{ postings: LeaveLiabilityPosting[] }>("/api/payroll/leave/liability/postings", { organisationId });
  const [voidDate, setVoidDate] = useState(todayInBrowser());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const list = postings.data?.postings ?? [];
  const last = list.find((posting) => posting.status === "active") ?? null;

  const act = async (work: () => Promise<{ posting: LeaveLiabilityPosting }>, success: (posting: LeaveLiabilityPosting) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await work();
      setMessage({ tone: "success", text: success(result.posting) });
      postings.reload();
      onChanged();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };
  const post = () => {
    if (!window.confirm(`Post the leave liability at ${formatDate(asAt)}? The journal is the change since ${last ? last.reference : "nothing posted"}.`)) return;
    void act(
      () => api("/api/payroll/leave/liability/postings", { method: "POST", body: { organisationId, idempotencyKey: newIdempotencyKey("leave-liability"), asAt } }),
      (posting) => `${posting.reference} posted: the liability at ${formatDate(posting.asAt)} is $${formatMoney(posting.total)} (employer KiwiSaver $${formatMoney(posting.kiwiSaver)} of it), a change of $${formatMoney(posting.change)}.`,
    );
  };
  const voidPosting = (posting: LeaveLiabilityPosting) => {
    if (!window.confirm(`Void ${posting.reference} on ${formatDate(voidDate)}? Its journal is reversed on that date.`)) return;
    void act(
      () => api(`/api/payroll/leave/liability/postings/${posting.id}/void`, { method: "POST", body: { organisationId, idempotencyKey: newIdempotencyKey("leave-liability-void"), voidDate } }),
      (voided) => `${voided.reference} voided.`,
    );
  };

  return (
    <Card
      title="Post to the ledger"
      description="One journal at the date for the change since the last posting not voided: Dr the leave expense account, Cr the employee entitlements account (the other way when it falls), by Department, never naming anyone, with the employer KiwiSaver on it as its own pair of lines. Leave paid in pay runs still goes to wages; the next posting takes the fall. The accounts are under Payroll › Pay items. The home page reminds you after each month end with pay runs."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {postings.error ? <Notice tone="error">{postings.error}</Notice> : null}
      <p>
        {last ? `Last posted: ${last.reference} at ${formatDate(last.asAt)}, $${formatMoney(last.total)}.` : "Nothing posted yet."}
        {total !== null ? ` At ${formatDate(asAt)}: $${formatMoney(total)}.` : ""}
      </p>
      <div className={ui.actions}>
        <Button disabled={busy || total === null} onClick={post}>Post leave liability at {formatDate(asAt)}</Button>
      </div>
      {list.length ? (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Posting</th><th>As at</th><th>Liability</th><th>Change</th><th>By Department</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {list.map((posting) => (
                  <tr key={posting.id}>
                    <td data-label="Posting"><Link href={`/operations/ledger-journals?journal=${posting.journalId}`}>{posting.reference}</Link></td>
                    <td data-label="As at">{formatDate(posting.asAt)}</td>
                    <td data-label="Liability" className={ui.num}>{formatMoney(posting.total)}{posting.kiwiSaver !== "0.00" ? <><br /><small>KiwiSaver {formatMoney(posting.kiwiSaver)}</small></> : null}</td>
                    <td data-label="Change" className={ui.num}>{formatMoney(posting.change)}{posting.previousReference ? <><br /><small>from {posting.previousReference}</small></> : null}</td>
                    <td data-label="By Department">{posting.departments.length ? posting.departments.map((entry) => `${entry.department ?? "No Department"} ${formatMoney(entry.liability)}${entry.kiwiSaver !== "0.00" ? ` + KiwiSaver ${formatMoney(entry.kiwiSaver)}` : ""}`).join("; ") : "—"}</td>
                    <td data-label="Status">{posting.status === "voided" ? <Badge>Voided {formatDate(posting.voidDate)}</Badge> : "Posted"}</td>
                    <td data-label="Actions">
                      {last && posting.id === last.id ? <Button disabled={busy} size="small" variant="secondary" onClick={() => voidPosting(posting)}>Void</Button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {last ? (
            <Field label="Void date" hint="Only the latest posting can be voided; the next posting then measures from the one before it.">
              <input type="date" value={voidDate} onChange={(event) => setVoidDate(event.target.value)} />
            </Field>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function OrganisationSettings({ organisationId }: { organisationId: string }) {
  const settings = useApiData<{ settings: OrganisationLeaveSettings }>("/api/payroll/leave/settings", { organisationId });
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const save = async (change: Partial<OrganisationLeaveSettings>) => {
    try {
      await api("/api/payroll/leave/settings", { method: "PUT", body: { organisationId, ...change } });
      settings.reload();
      setMessage({ tone: "success", text: "Saved." });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };
  const current = settings.data?.settings;
  return (
    <Card title="Leave settings" description="Admins with payroll access can change these.">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {current ? (
        <div className={ui.grid2}>
          <Field label="Anniversary day" hint="Each employee's, unless set on them; if not agreed, the province where they usually work (decision 22).">
            <select value={current.anniversaryRegion ?? ""} onChange={(event) => void save({ anniversaryRegion: (event.target.value || null) as OrganisationLeaveSettings["anniversaryRegion"] })}>
              <option value="">Not chosen</option>
              {ANNIVERSARY_REGIONS.map((region) => <option key={region} value={region}>{ANNIVERSARY_REGION_LABELS[region]}</option>)}
            </select>
          </Field>
          <label className={ui.checkbox}>
            <input checked={current.noCashUps} type="checkbox" onChange={(event) => void save({ noCashUps: event.target.checked })} />
            A policy not to consider requests to cash up annual holidays (s 28E)
          </label>
        </div>
      ) : <Empty>Loading…</Empty>}
    </Card>
  );
}

// An employee's leave (on their page)

type DayDraft = { hours: string; overtimeItemId: string; overtimeHours: string; allowanceItemId: string; allowanceAmount: string };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function daysFrom(settings: LeaveSettings | undefined): DayDraft[] {
  if (!settings || settings.pattern.kind !== "fixed") return WEEKDAYS.map(() => ({ hours: "", overtimeItemId: "", overtimeHours: "", allowanceItemId: "", allowanceAmount: "" }));
  return settings.pattern.days.map((day) => {
    const overtime = day.extras.find((extra) => extra.kind === "overtime");
    const allowance = day.extras.find((extra) => extra.kind === "allowance");
    return {
      hours: day.ordinaryHours,
      overtimeItemId: overtime?.payItemId ?? "",
      overtimeHours: overtime?.hours ?? "",
      allowanceItemId: allowance?.payItemId ?? "",
      allowanceAmount: allowance?.amount ?? "",
    };
  });
}

export function EmployeeLeave({ organisationId, employeeId }: { organisationId: string; employeeId: string }) {
  const data = useApiData<{ summary: LeaveSummary; settings: LeaveSettings[]; unpaidLeave: UnpaidLeaveRecord[]; bookings: LeaveBooking[] }>(
    `/api/payroll/employees/${employeeId}/leave`,
    { organisationId },
  );
  const items = useApiData<{ payItems: PayItem[] }>("/api/payroll/pay-items", { organisationId });
  const latest = data.data?.settings[0];
  const [kind, setKind] = useState<"fixed" | "varies" | null>(null);
  const [days, setDays] = useState<DayDraft[] | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean> | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const patternKind = kind ?? latest?.pattern.kind ?? "fixed";
  const dayDrafts = days ?? daysFrom(latest);
  const values = form ?? {
    effectiveFrom: "",
    weekHours: latest?.pattern.kind === "varies" ? latest.pattern.weekHours : "",
    weekDays: latest?.pattern.kind === "varies" ? latest.pattern.weekDays : "",
    dailyPay: latest?.dailyPay ?? "rdp",
    adpReason: latest?.adpReason ?? "",
    annualPaidInPeriod: latest?.annualPaidInPeriod ?? true,
    partDaySickAgreed: latest?.partDaySickAgreed ?? false,
    employmentType: latest?.employmentType ?? "continuous",
    anniversaryRegion: latest?.anniversaryRegion ?? "",
  };
  const setValue = (field: string, value: string | boolean) => setForm({ ...values, [field]: value });
  const setDay = (index: number, field: keyof DayDraft, value: string) => setDays(dayDrafts.map((day, at) => (at === index ? { ...day, [field]: value } : day)));
  const overtimeItems = (items.data?.payItems ?? []).filter((item) => item.kind === "overtime" && !item.isArchived);
  const allowanceItems = (items.data?.payItems ?? []).filter((item) => item.kind === "allowance" && !item.isArchived);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const pattern =
        patternKind === "varies"
          ? { kind: "varies", weekHours: values.weekHours, weekDays: values.weekDays }
          : {
              kind: "fixed",
              days: dayDrafts.map((day) => ({
                ordinaryHours: day.hours || "0",
                extras: [
                  ...(day.overtimeItemId && day.overtimeHours ? [{ payItemId: day.overtimeItemId, hours: day.overtimeHours, regular: true }] : []),
                  ...(day.allowanceItemId && day.allowanceAmount ? [{ payItemId: day.allowanceItemId, amount: day.allowanceAmount, regular: true }] : []),
                ],
              })),
            };
      const result = await api<{ payRuns: string[] }>(`/api/payroll/employees/${employeeId}/leave`, {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: newIdempotencyKey("leave-settings"),
          ...(values.effectiveFrom ? { effectiveFrom: values.effectiveFrom } : {}),
          pattern,
          dailyPay: values.dailyPay,
          ...(values.dailyPay === "adp" ? { adpReason: values.adpReason } : {}),
          annualPaidInPeriod: values.annualPaidInPeriod,
          partDaySickAgreed: values.partDaySickAgreed,
          employmentType: values.employmentType,
          anniversaryRegion: values.anniversaryRegion || null,
        },
      });
      setForm(null);
      setDays(null);
      setKind(null);
      data.reload();
      setMessage({ tone: "success", text: `Saved.${result.payRuns.length ? ` Leave worked out again on ${result.payRuns.join(", ")}.` : ""}` });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const summary = data.data?.summary;
  return (
    <Card
      title="Leave"
      description="Holidays Act 2003 leave (until the first pay period starting on or after 6 Aug 2028, decision 7)."
      actions={<Link href={`/operations/payroll/leave/record/${employeeId}`}>Holiday and leave record</Link>}
    >
      {data.error ? <Notice tone="error">{data.error}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {summary ? (
        summary.kept && summary.annual ? (
          <p>
            Annual holidays {trim(summary.annual.weeks)} weeks ({summary.annual.hours} h; last entitled {summary.annual.lastEntitled ? formatDate(summary.annual.lastEntitled) : "not yet"},
            next {formatDate(summary.annual.nextEntitled)}) · sick leave {trim(summary.sick?.days)} days · family violence leave {trim(summary.familyViolence?.days)} days ·
            alternative holidays {summary.alternative?.untaken ?? 0}
          </p>
        ) : <Notice tone="info">{summary.notKeptReason}</Notice>
      ) : null}
      <form className={styles.stack} onSubmit={save}>
        <h3>Usual week</h3>
        <div className={ui.grid4}>
          <Field label="Hours and days">
            <select value={patternKind} onChange={(event) => setKind(event.target.value as "fixed" | "varies")}>
              <option value="fixed">The same each week</option>
              <option value="varies">Vary week to week</option>
            </select>
          </Field>
          <Field label="From" hint="Blank: from the start date (first time) or today's settings change.">
            <input type="date" value={String(values.effectiveFrom)} onChange={(event) => setValue("effectiveFrom", event.target.value)} />
          </Field>
        </div>
        {patternKind === "fixed" ? (
          <div className={ui.tableWrap}>
            <table>
              <thead><tr><th>Day</th><th>Ordinary hours</th><th>Overtime</th><th>Overtime hours</th><th>Allowance</th><th>Amount</th></tr></thead>
              <tbody>
                {dayDrafts.map((day, index) => (
                  <tr key={WEEKDAYS[index]}>
                    <th scope="row">{WEEKDAYS[index]}</th>
                    <td><input aria-label={`${WEEKDAYS[index]} hours`} inputMode="decimal" value={day.hours} onChange={(event) => setDay(index, "hours", event.target.value)} /></td>
                    <td>
                      <select aria-label={`${WEEKDAYS[index]} overtime`} value={day.overtimeItemId} onChange={(event) => setDay(index, "overtimeItemId", event.target.value)}>
                        <option value="">None</option>
                        {overtimeItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </td>
                    <td><input aria-label={`${WEEKDAYS[index]} overtime hours`} inputMode="decimal" value={day.overtimeHours} onChange={(event) => setDay(index, "overtimeHours", event.target.value)} /></td>
                    <td>
                      <select aria-label={`${WEEKDAYS[index]} allowance`} value={day.allowanceItemId} onChange={(event) => setDay(index, "allowanceItemId", event.target.value)}>
                        <option value="">None</option>
                        {allowanceItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </td>
                    <td><input aria-label={`${WEEKDAYS[index]} allowance amount`} inputMode="decimal" value={day.allowanceAmount} onChange={(event) => setDay(index, "allowanceAmount", event.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={ui.grid4}>
            <Field label="Hours in the agreed working week (s 17)"><input inputMode="decimal" required value={String(values.weekHours)} onChange={(event) => setValue("weekHours", event.target.value)} /></Field>
            <Field label="Days in the agreed working week"><input inputMode="decimal" required value={String(values.weekDays)} onChange={(event) => setValue("weekDays", event.target.value)} /></Field>
          </div>
        )}
        <p className={ui.muted}>Overtime and allowances in the usual week are a regular part of pay, so they count in ordinary weekly pay (decision 11).</p>
        <div className={ui.grid4}>
          <Field label="Daily pay for holidays and leave">
            <select value={String(values.dailyPay)} onChange={(event) => setValue("dailyPay", event.target.value)}>
              <option value="rdp">Relevant daily pay (s 9)</option>
              <option value="adp">Average daily pay (s 9A)</option>
            </select>
          </Field>
          {values.dailyPay === "adp" ? (
            <Field label="Why average daily pay" hint="Only these two reasons (s 9A(1); decision 13).">
              <select required value={String(values.adpReason)} onChange={(event) => setValue("adpReason", event.target.value)}>
                <option value="">Choose</option>
                <option value="not_practicable">Relevant daily pay can&apos;t practicably be worked out</option>
                <option value="varies_within_period">Daily pay varies within the pay period</option>
              </select>
            </Field>
          ) : null}
          <Field label="Employment">
            <select value={String(values.employmentType)} onChange={(event) => setValue("employmentType", event.target.value)}>
              <option value="continuous">Continuous (sick leave after 6 months)</option>
              <option value="casual">Casual (sick leave by the hours test, s 63(1)(b))</option>
            </select>
          </Field>
          <Field label="Anniversary day">
            <select value={String(values.anniversaryRegion)} onChange={(event) => setValue("anniversaryRegion", event.target.value)}>
              <option value="">The organisation&apos;s</option>
              {ANNIVERSARY_REGIONS.map((region) => <option key={region} value={region}>{ANNIVERSARY_REGION_LABELS[region]}</option>)}
            </select>
          </Field>
        </div>
        <label className={ui.checkbox}>
          <input checked={Boolean(values.annualPaidInPeriod)} type="checkbox" onChange={(event) => setValue("annualPaidInPeriod", event.target.checked)} />
          Agreed that annual holidays are paid in the pay for the period they&apos;re taken (s 27(1)(a))
        </label>
        <label className={ui.checkbox}>
          <input checked={Boolean(values.partDaySickAgreed)} type="checkbox" onChange={(event) => setValue("partDaySickAgreed", event.target.checked)} />
          A part-day sick leave agreement is recorded (decision 19)
        </label>
        <div className={ui.actions}><Button disabled={busy} type="submit">Save leave settings</Button></div>
      </form>
      <OpeningBalancesForm organisationId={organisationId} employeeId={employeeId} onSaved={data.reload} />
      <UnpaidLeave organisationId={organisationId} employeeId={employeeId} records={data.data?.unpaidLeave ?? []} onSaved={data.reload} />
    </Card>
  );
}

/** Reads earnings rows pasted one per line: from, to, gross, irregular, days (dates as YYYY-MM-DD). */
function parseEarningsRows(text: string): Array<{ periodStart: string; periodEnd: string; gross: string; irregular: string; days: number }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^from\b/i.test(line))
    .map((line, index) => {
      const cells = line.split(/[,\t]/).map((cell) => cell.trim());
      if (cells.length < 5) throw new Error(`Earnings line ${index + 1} needs 5 columns: from, to, gross, irregular, days.`);
      return { periodStart: cells[0], periodEnd: cells[1], gross: cells[2].replace(/[$,]/g, ""), irregular: cells[3].replace(/[$,]/g, "") || "0", days: Number(cells[4]) };
    });
}

/**
 * Opening leave balances from another payroll (decision 168; HL43): as at
 * the end of the last day before Tohyee's first pay period for the
 * employee, with the earlier earnings by pay period and the previous
 * payroll's report attached.
 */
function OpeningBalancesForm({ organisationId, employeeId, onSaved }: { organisationId: string; employeeId: string; onSaved: () => void }) {
  const current = useApiData<{ opening: (OpeningBalances & { replaced: unknown[] }) | null }>("/api/payroll/leave/opening", { organisationId, employeeId });
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({
    asAt: "",
    annualWeeks: "",
    annualLastEntitled: "",
    annualCashedUpWeeks: "0",
    annualAdvancePaid: "0",
    sickDays: "",
    familyViolenceDays: "",
    alternativeHolidays: "",
    earnings: "",
    source: "",
  });
  const [report, setReport] = useState<File | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: string, value: string) => setValues({ ...values, [field]: value });
  const opening = current.data?.opening ?? null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (!report) {
      setMessage({ tone: "error", text: "Attach the previous payroll's leave and earnings report." });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set(
        "data",
        JSON.stringify({
          organisationId,
          idempotencyKey: newIdempotencyKey("opening"),
          employeeId,
          asAt: values.asAt,
          annualWeeks: values.annualWeeks,
          annualLastEntitled: values.annualLastEntitled || null,
          annualCashedUpWeeks: values.annualCashedUpWeeks || "0",
          annualAdvancePaid: values.annualAdvancePaid || "0",
          sickDays: values.sickDays,
          familyViolenceDays: values.familyViolenceDays,
          alternativeHolidays: values.alternativeHolidays.split(/[\s,]+/).filter(Boolean),
          earnings: parseEarningsRows(values.earnings),
          source: values.source,
        }),
      );
      form.set("report", report, report.name);
      const result = await postForm<{ payRuns: string[] }>("/api/payroll/leave/opening", form);
      setOpen(false);
      setReport(null);
      current.reload();
      onSaved();
      setMessage({ tone: "success", text: `Opening balances saved.${result.payRuns.length ? ` Leave worked out again on ${result.payRuns.join(", ")}.` : ""}` });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Opening balances</h3>
      <p className={ui.muted}>
        For someone employed before Tohyee&apos;s first pay run for them: their leave and earlier earnings from the previous payroll, as at the end of the
        day before Tohyee&apos;s first pay period for them (decision 168). Enter the earnings one row per pay period of the previous payroll for at least the
        last 12 months (or since they started), without gaps, as Xero asks for them.
      </p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {current.error ? <Notice tone="error">{current.error}</Notice> : null}
      {opening ? (
        <p>
          As at {formatDate(opening.asAt)}: annual holidays {trim(opening.annualWeeks)} weeks
          {opening.annualLastEntitled ? ` (last entitled ${formatDate(opening.annualLastEntitled)})` : ""}, sick leave {trim(opening.sickDays)} days, family violence
          leave {trim(opening.familyViolenceDays)} days, {opening.alternativeHolidays.length} untaken alternative holiday
          {opening.alternativeHolidays.length === 1 ? "" : "s"}; {opening.earnings.length} earnings rows from {formatDate(opening.earnings[0]?.periodStart ?? opening.asAt)}.
          Source: {opening.source} (<a href={`/api/payroll/leave/files/${opening.reportFileId}?organisationId=${organisationId}`}>report</a>; entered by{" "}
          {opening.createdByEmail}).
        </p>
      ) : null}
      {!open ? (
        <div className={ui.actions}>
          <Button size="small" variant="secondary" onClick={() => setOpen(true)}>{opening ? "Replace opening balances…" : "Enter opening balances…"}</Button>
        </div>
      ) : (
        <form className={styles.stack} onSubmit={save}>
          <div className={ui.grid4}>
            <Field label="As at the end of" hint="The last day of a pay period, before Tohyee's first for them.">
              <input required type="date" value={values.asAt} onChange={(event) => set("asAt", event.target.value)} />
            </Field>
            <Field label="Annual holidays (weeks)" hint="Negative if taken in advance.">
              <input inputMode="decimal" required value={values.annualWeeks} onChange={(event) => set("annualWeeks", event.target.value)} />
            </Field>
            <Field label="Last entitled to annual holidays" hint="Blank if not yet 12 months.">
              <input type="date" value={values.annualLastEntitled} onChange={(event) => set("annualLastEntitled", event.target.value)} />
            </Field>
            <Field label="Weeks cashed up that entitlement year" hint="s 28A(2)(b)">
              <input inputMode="decimal" value={values.annualCashedUpWeeks} onChange={(event) => set("annualCashedUpWeeks", event.target.value)} />
            </Field>
            <Field label="Holiday pay paid in advance" hint="Only with a negative balance (s 23(2)(a), s 25(2)(a)).">
              <input inputMode="decimal" value={values.annualAdvancePaid} onChange={(event) => set("annualAdvancePaid", event.target.value)} />
            </Field>
            <Field label="Sick leave (days)"><input inputMode="decimal" required value={values.sickDays} onChange={(event) => set("sickDays", event.target.value)} /></Field>
            <Field label="Family violence leave (days)"><input inputMode="decimal" required value={values.familyViolenceDays} onChange={(event) => set("familyViolenceDays", event.target.value)} /></Field>
            <Field label="Untaken alternative holidays" hint="The date each arose, YYYY-MM-DD, separated by commas.">
              <input value={values.alternativeHolidays} onChange={(event) => set("alternativeHolidays", event.target.value)} />
            </Field>
          </div>
          <Field label="Earnings by pay period" hint="One line each: from, to, gross earnings, irregular or one-off part, days worked or on paid leave (e.g. 2025-10-06, 2025-10-12, 1200.00, 0, 5).">
            <textarea required rows={8} value={values.earnings} onChange={(event) => set("earnings", event.target.value)} />
          </Field>
          <div className={ui.grid4}>
            <Field label="Where the figures came from"><input required value={values.source} onChange={(event) => set("source", event.target.value)} /></Field>
            <Field label="The previous payroll's report"><input required type="file" onChange={(event) => setReport(event.target.files?.[0] ?? null)} /></Field>
          </div>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Save opening balances</Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </>
  );
}

function UnpaidLeave({ organisationId, employeeId, records, onSaved }: { organisationId: string; employeeId: string; records: UnpaidLeaveRecord[]; onSaved: () => void }) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("other");
  const [agreement, setAgreement] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const data = { organisationId, idempotencyKey: newIdempotencyKey("unpaid"), employeeId, startDate, endDate: endDate || startDate, reason, agreedToCount: Boolean(agreement) };
      if (agreement) {
        const form = new FormData();
        form.set("data", JSON.stringify(data));
        form.set("agreement", agreement, agreement.name);
        await postForm("/api/payroll/leave/unpaid", form);
      } else {
        await api("/api/payroll/leave/unpaid", { method: "POST", body: data });
      }
      setStartDate("");
      setEndDate("");
      setAgreement(null);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <>
      <h3>Unpaid leave</h3>
      <p className={ui.muted}>
        A single period of other unpaid leave longer than a week moves the anniversary by its whole length, unless a written agreement to count it is
        attached (s 16(2), s 16(3); decision 14).
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {records.length ? (
        <ul>
          {records.map((record) => (
            <li key={record.id}>
              {formatDate(record.startDate)} to {formatDate(record.endDate)} ({record.reason}){record.movesAnniversary ? " · moves the anniversary" : ""}
              {record.status === "cancelled" ? " · cancelled" : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <form className={ui.grid4} onSubmit={add}>
        <Field label="From"><input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field>
        <Field label="To"><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
        <Field label="Reason">
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="other">Other</option>
            <option value="sick">Unpaid sick leave</option>
            <option value="bereavement">Unpaid bereavement leave</option>
            <option value="family_violence">Unpaid family violence leave</option>
            <option value="parental">Parental leave</option>
            <option value="volunteers">Volunteers leave</option>
            <option value="acc">ACC weekly compensation</option>
          </select>
        </Field>
        <Field label="Written agreement to count it" hint="Optional; only for other unpaid leave.">
          <input type="file" onChange={(event) => setAgreement(event.target.files?.[0] ?? null)} />
        </Field>
        <div className={ui.actions}><Button size="small" type="submit" variant="secondary">Add unpaid leave</Button></div>
      </form>
    </>
  );
}

/** The holiday and leave record (s 81; HL40, HL41): printable, with a CSV export. */
export function LeaveRecordView({ organisationId, employeeId }: { organisationId: string; employeeId: string }) {
  const data = useApiData<{ record: LeaveRecord }>(`/api/payroll/employees/${employeeId}/leave/record`, { organisationId });
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setError(null);
    try {
      const response = await fetch(`/api/payroll/employees/${employeeId}/leave/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId }),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "The export failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `Holiday and leave record.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const record = data.data?.record;
  if (data.loading) return <Empty>Loading…</Empty>;
  if (data.error || !record) return <Notice tone="error">{data.error ?? "Not found."}</Notice>;
  return (
    <div className={styles.stack}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={`${record.name}: holiday and leave record`}
        description={`Started ${formatDate(record.startDate)}${record.finishDate ? `, finished ${formatDate(record.finishDate)}` : ""}. Kept at least 6 years (s 81(4)); shown or copied when the employee, their representative, union or a Labour Inspector asks (s 82).`}
        actions={
          <div className={ui.actions}>
            <Button size="small" variant="secondary" onClick={() => window.print()}>Print</Button>
            <Button size="small" variant="secondary" onClick={() => void download()}>CSV</Button>
          </div>
        }
      >
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>Date</th><th>s 81(2)</th><th>Entry</th><th>Hours</th><th>Amount</th><th>Pay run</th></tr></thead>
            <tbody>
              {record.entries.map((entry, index) => (
                <tr key={index}>
                  <td data-label="Date">{formatDate(entry.date)}{entry.to && entry.to !== entry.date ? ` to ${formatDate(entry.to)}` : ""}</td>
                  <td data-label="s 81(2)">{entry.item}</td>
                  <td data-label="Entry">{entry.entry}</td>
                  <td data-label="Hours" className={ui.num}>{entry.hours ?? ""}</td>
                  <td data-label="Amount" className={ui.num}>{entry.amount ? formatMoney(entry.amount) : ""}</td>
                  <td data-label="Pay run">{entry.payRun ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Hours and pay each pay period (s 81(2)(c))">
        <div className={ui.tableWrap}>
          <table>
            <thead><tr><th>Pay run</th><th>Period</th><th>Hours</th><th>Gross</th></tr></thead>
            <tbody>
              {record.payPeriods.map((period) => (
                <tr key={period.payRun}>
                  <td>{period.payRun}</td>
                  <td>{formatDate(period.periodStart)} to {formatDate(period.periodEnd)}</td>
                  <td className={ui.num}>{period.hours}</td>
                  <td className={ui.num}>{formatMoney(period.gross)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** The leave liability's month-end reminder on the home page (decision 191; HL61): bookkeepers and up with payroll access. */
export function LeaveLiabilityReminders({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ reminders: LeaveLiabilityReminder[] }>(can("bookkeeper") ? "/api/payroll/leave/liability/reminders" : null, { organisationId });
  const reminders = loaded.data?.reminders ?? [];
  if (reminders.length === 0) return null;
  return (
    <Notice tone="warning">
      <strong>Leave liability</strong>
      <ul>
        {reminders.map((reminder) => (
          <li key={reminder.monthEnd}>{reminder.text}.</li>
        ))}
      </ul>
      Post it under <Link href="/operations/payroll/leave">Payroll › Leave › Liability</Link>.
    </Notice>
  );
}
