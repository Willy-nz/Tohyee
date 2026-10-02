"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { LEAVE_TYPE_LABELS, LEAVE_TYPES, type LeaveType } from "@/lib/payroll/leave/rules";
import { BEREAVEMENT_LABELS, BEREAVEMENT_KINDS, type BereavementKind } from "@/lib/payroll/leave/sick";
import type { LeaveRequest, LeaveRequestStatus, MyLeave } from "@/lib/payroll/leave-requests";
import styles from "./payroll-employees.module.css";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Payroll › Leave requests (decision 169; HL49-HL51): an employee asks for
 * leave and sees their balances in weeks and days; their approver (or
 * someone with payroll access) approves, which books the leave, or rejects
 * it with a reason. Never pay.
 */

const STATUS: Record<LeaveRequestStatus, { label: string; tone: "amber" | "blue" | "green" | "neutral" }> = {
  pending: { label: "Waiting", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Rejected", tone: "amber" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

function typeLabel(type: LeaveType | "special"): string {
  return type === "special" ? "Special leave" : LEAVE_TYPE_LABELS[type];
}

type Loaded = { requests: LeaveRequest[]; mine: MyLeave[]; approves: number };

export function LeaveRequestsPage({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const loaded = useApiData<Loaded>("/api/payroll/leave/requests", { organisationId });
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const data = loaded.data;

  const act = async (request: LeaveRequest, action: "approve" | "withdraw" | "reject") => {
    setMessage(null);
    let reason: string | null = null;
    if (action === "reject") {
      reason = window.prompt(`Why is ${request.reference} rejected? ${request.employeeName} sees this.`);
      if (!reason) return;
    }
    if (action === "withdraw" && !(await confirm(`Withdraw ${request.reference}?`))) return;
    try {
      const result = await api<{ request: LeaveRequest; warnings?: string[] }>(`/api/payroll/leave/requests/${request.id}/${action}`, {
        method: "POST",
        body: { organisationId, ...(reason ? { reason } : {}) },
      });
      loaded.reload();
      const done = action === "approve" ? `approved and booked as ${result.request.booking}` : action === "reject" ? "rejected" : "withdrawn";
      setMessage({ tone: "success", text: [`${request.reference} ${done}.`, ...(result.warnings ?? [])].join(" ") });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };

  return (
    <div className={styles.stack}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {(data?.mine ?? []).map((me) => (
        <AskForLeave key={me.employeeId} organisationId={organisationId} me={me} onAsked={(text) => { loaded.reload(); setMessage({ tone: "success", text }); }} />
      ))}
      <Card title="Requests" description="Your own, the ones you approve, or everyone's with payroll access. Days and hours only.">
        {!data ? <Empty>Loading…</Empty> : data.requests.length === 0 ? <Empty>No leave requests.</Empty> : (
          <div className={ui.tableWrap}>
            <table>
              <thead>
                <tr><th>Request</th><th>Employee</th><th>Leave</th><th>Dates</th><th>Days</th><th>Hours</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {data.requests.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Request">{request.reference}</td>
                    <td data-label="Employee">{request.employeeName}</td>
                    <td data-label="Leave">
                      {typeLabel(request.leaveType)}
                      {request.bereavementKind ? <><br /><small>{BEREAVEMENT_LABELS[request.bereavementKind]}</small></> : null}
                      {request.note ? <><br /><small>{request.note}</small></> : null}
                    </td>
                    <td data-label="Dates">{formatDate(request.startDate)}{request.endDate !== request.startDate ? ` to ${formatDate(request.endDate)}` : ""}</td>
                    <td data-label="Days">{request.days}</td>
                    <td data-label="Hours">{request.hours}</td>
                    <td data-label="Status">
                      <Badge tone={STATUS[request.status].tone}>{STATUS[request.status].label}</Badge>
                      {request.booking ? <><br /><small>Booked as {request.booking}</small></> : null}
                      {request.rejectionReason ? <><br /><small>{request.rejectionReason}</small></> : null}
                      {request.decidedByEmail ? <><br /><small>by {request.decidedByEmail}</small></> : null}
                    </td>
                    <td>
                      <div className={ui.actions}>
                        {request.canDecide ? <Button size="small" onClick={() => void act(request, "approve")}>Approve</Button> : null}
                        {request.canDecide ? <Button size="small" variant="secondary" onClick={() => void act(request, "reject")}>Reject…</Button> : null}
                        {request.canChange ? <Button size="small" variant="secondary" onClick={() => void act(request, "withdraw")}>Withdraw</Button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={ui.muted}>
          Approving books the leave as you, and the next pay run pays it. To cancel approved leave, someone with payroll access cancels its booking under
          Payroll › Leave, before a pay run has paid it.
        </p>
      </Card>
    </div>
  );
}

function AskForLeave({ organisationId, me, onAsked }: { organisationId: string; me: MyLeave; onAsked: (text: string) => void }) {
  const [leaveType, setLeaveType] = useState<LeaveType>("annual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [bereavementKind, setBereavementKind] = useState<BereavementKind>("close_family");
  const [dayHours, setDayHours] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const hours = dayHours.trim()
        ? Object.fromEntries(dayHours.split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
            const [date, value] = entry.split(/[\s=:]+/);
            return [date, value];
          }))
        : undefined;
      const result = await api<{ request: LeaveRequest }>("/api/payroll/leave/requests", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: newIdempotencyKey("leave-request"),
          employeeId: me.employeeId,
          leaveType,
          startDate,
          endDate: endDate || startDate,
          ...(leaveType === "bereavement" ? { bereavementKind } : {}),
          ...(hours ? { dayHours: hours } : {}),
          note: note.trim() || null,
        },
      });
      setStartDate("");
      setEndDate("");
      setDayHours("");
      setNote("");
      onAsked(`${result.request.reference} sent: ${result.request.days} days, ${result.request.hours} hours.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Ask for leave (${me.name})`} description="Your approver sees the dates and hours; nobody sees pay here.">
      {me.problem ? <Notice tone="info">{me.problem}</Notice> : (
        <p>
          Annual holidays {me.annual?.weeks.replace(/\.?0+$/, "")} weeks ({me.annual?.hours} hours) · sick leave {me.sickDays?.replace(/\.?0+$/, "")} days
        </p>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className={ui.grid4} onSubmit={submit}>
        <Field label="Leave">
          <select value={leaveType} onChange={(event) => setLeaveType(event.target.value as LeaveType)}>
            {LEAVE_TYPES.map((type) => <option key={type} value={type}>{LEAVE_TYPE_LABELS[type]}</option>)}
          </select>
        </Field>
        <Field label="From"><input required type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field>
        <Field label="To"><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
        {leaveType === "bereavement" ? (
          <Field label="Bereavement">
            <select value={bereavementKind} onChange={(event) => setBereavementKind(event.target.value as BereavementKind)}>
              {BEREAVEMENT_KINDS.map((kind) => <option key={kind} value={kind}>{BEREAVEMENT_LABELS[kind]}</option>)}
            </select>
          </Field>
        ) : null}
        <Field label="Hours each day" hint="Only if your hours vary: e.g. 2027-03-01 6.5, 2027-03-02 4">
          <input value={dayHours} onChange={(event) => setDayHours(event.target.value)} />
        </Field>
        <Field label="Note"><input value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        <div className={ui.actions}><Button disabled={busy} type="submit">Ask for leave</Button></div>
      </form>
    </Card>
  );
}
