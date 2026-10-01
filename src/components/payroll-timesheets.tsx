"use client";

import { type FormEvent, useState } from "react";
import { useApiData, useHydrated } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { addDays } from "@/lib/financial-year";
import { formatDate, formatDateTime, personName, todayInBrowser } from "@/lib/format";
import { add, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { weekStartOf } from "@/lib/payroll/timesheet-split";
import type {
  ProjectTimeSuggestion,
  Timesheet,
  TimesheetPerson,
  TimesheetStatus,
  TimesheetSummary,
  TimesheetTargets,
  TimesheetWeek,
} from "@/lib/payroll/timesheets";
import styles from "./payroll-employees.module.css";

/**
 * Payroll › Timesheets (examples TS1-TS11): pick a week, fill in the week's
 * hours by row and day, submit, and approve, reject or reopen. Hours only,
 * never pay (decision 95).
 */

const STATUS: Record<TimesheetStatus, { label: string; tone: "amber" | "blue" | "green" }> = {
  draft: { label: "Draft", tone: "amber" },
  submitted: { label: "Submitted", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function StatusBadge({ status }: { status: TimesheetStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

function hoursTotal(values: string[]): string {
  let total = ZERO_DECIMAL;
  for (const value of values) {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) total = add(total, dec(text));
  }
  return toFixedString(total, 2);
}

export function TimesheetsPage({ organisationId }: { organisationId: string }) {
  const hydrated = useHydrated();
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const week = hydrated ? weekStart ?? weekStartOf(todayInBrowser()) : null;
  const loaded = useApiData<{ week: TimesheetWeek }>(week ? "/api/payroll/timesheets" : null, { organisationId, weekStart: week });

  if (!week) return <Empty>Loading…</Empty>;
  const data = loaded.data?.week;

  const move = (days: number) => {
    setWeekStart(addDays(week, days));
    setSelected(null);
  };
  const open = async (employeeId: string) => {
    setMessage(null);
    try {
      const result = await api<{ timesheet: Timesheet }>("/api/payroll/timesheets", {
        method: "POST",
        body: { organisationId, idempotencyKey: newIdempotencyKey("timesheet"), employeeId, weekStart: week },
      });
      setSelected(result.timesheet.id);
      loaded.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };

  return (
    <div className={styles.stack}>
      <Card
        title={`Week starting ${formatDate(week)}`}
        description="Timesheets run Monday to Sunday. Hours are stamped when they're saved, so they count as a record made at the time (IR1240 p 100)."
        actions={
          <>
            <Button variant="secondary" size="small" onClick={() => move(-7)}>Previous week</Button>
            <Button variant="secondary" size="small" onClick={() => move(7)}>Next week</Button>
          </>
        }
      >
        <div className={ui.grid3}>
          <Field label="Go to the week of">
            <input
              type="date"
              value={week}
              onChange={(event) => {
                if (event.target.value) {
                  setWeekStart(weekStartOf(event.target.value));
                  setSelected(null);
                }
              }}
            />
          </Field>
        </div>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {loaded.loading ? <Empty>Loading…</Empty> : data && data.employees.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Employee</th><th>You are</th><th>Status</th><th className={ui.num}>Hours</th><th></th></tr></thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr key={employee.employeeId} className={employee.timesheet?.id === selected ? ui.selectedRow : undefined}>
                    <td data-label="Employee">{employee.name}</td>
                    <td data-label="You are">{employee.relation === "own" ? "The employee" : employee.relation === "approver" ? "Their approver" : "Payroll"}</td>
                    <td data-label="Status">
                      {employee.timesheet ? <StatusBadge status={employee.timesheet.status} /> : <span className={ui.muted}>Not started</span>}
                      {employee.timesheet && employee.timesheet.lateCount > 0 ? <> <Badge tone="amber">Entered late</Badge></> : null}
                    </td>
                    <td data-label="Hours" className={ui.num}>{employee.timesheet?.total ?? ""}</td>
                    <td>
                      {employee.timesheet ? (
                        <Button size="small" variant="secondary" onClick={() => setSelected(employee.timesheet!.id)}>Open</Button>
                      ) : employee.relation !== "approver" ? (
                        <Button size="small" variant="secondary" onClick={() => open(employee.employeeId)}>Start</Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No timesheets for you this week. You see your own (once someone with payroll access links your login to your employee record),
            the ones you approve, or everyone&apos;s with payroll access.
          </Empty>
        )}
      </Card>

      {data && data.toApprove.length > 0 ? (
        <ToApprove items={data.toApprove} onOpen={(item) => { setWeekStart(item.weekStart); setSelected(item.id); }} />
      ) : null}

      {selected ? (
        <TimesheetEditor
          key={selected}
          organisationId={organisationId}
          timesheetId={selected}
          onChanged={() => loaded.reload()}
        />
      ) : null}

      {data?.hasPayrollAccess ? <TimesheetPeople organisationId={organisationId} /> : null}
    </div>
  );
}

function ToApprove({ items, onOpen }: { items: TimesheetSummary[]; onOpen: (item: TimesheetSummary) => void }) {
  return (
    <Card title="To approve" description="Submitted timesheets you can approve or reject.">
      <div className={ui.tableWrap}>
        <table className={ui.stackOnPhone}>
          <thead><tr><th>Employee</th><th>Week starting</th><th className={ui.num}>Hours</th><th></th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td data-label="Employee">{item.employeeName}</td>
                <td data-label="Week starting">{formatDate(item.weekStart)}</td>
                <td data-label="Hours" className={ui.num}>{item.total}</td>
                <td><Button size="small" variant="secondary" onClick={() => onOpen(item)}>Open</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type DraftRow = {
  departmentId: string;
  projectId: string;
  rdActivityId: string;
  description: string;
  hours: Record<string, string>;
};

function draftRows(timesheet: Timesheet): DraftRow[] {
  return timesheet.rows.map((row) => ({
    departmentId: row.departmentId ?? "",
    projectId: row.projectId ?? "",
    rdActivityId: row.rdActivityId ?? "",
    description: row.description ?? "",
    hours: { ...row.hours },
  }));
}

function TimesheetEditor({ organisationId, timesheetId, onChanged }: { organisationId: string; timesheetId: string; onChanged: () => void }) {
  const loaded = useApiData<{ timesheet: Timesheet }>(`/api/payroll/timesheets/${timesheetId}`, { organisationId });
  const targets = useApiData<{ targets: TimesheetTargets }>("/api/payroll/timesheets/targets", { organisationId });
  const [version, setVersion] = useState<number | null>(null);
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [fresh, setFresh] = useState<Timesheet | null>(null);

  const timesheet = fresh ?? loaded.data?.timesheet ?? null;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!timesheet) return <Empty>Loading…</Empty>;
  const grid = rows !== null && version === timesheet.version ? rows : draftRows(timesheet);
  const editable = timesheet.canEnter;

  const changed = (next: DraftRow[]) => {
    setRows(next);
    setVersion(timesheet.version);
  };
  const setCell = (index: number, date: string, value: string) =>
    changed(grid.map((row, at) => (at === index ? { ...row, hours: { ...row.hours, [date]: value } } : row)));
  const setField = (index: number, field: "departmentId" | "projectId" | "rdActivityId" | "description", value: string) =>
    changed(grid.map((row, at) => (at === index ? { ...row, [field]: value } : row)));

  const act = async (work: () => Promise<{ timesheet: Timesheet }>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await work();
      setFresh(result.timesheet);
      setRows(null);
      setVersion(null);
      setReason("");
      setMessage({ tone: "success", text: done });
      onChanged();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void act(
      () =>
        api<{ timesheet: Timesheet }>(`/api/payroll/timesheets/${timesheet.id}`, {
          method: "PUT",
          body: {
            organisationId,
            version: timesheet.version,
            rows: grid.map((row) => ({
              departmentId: row.departmentId || null,
              projectId: row.projectId || null,
              rdActivityId: row.rdActivityId || null,
              description: row.description.trim() || null,
              hours: row.hours,
            })),
          },
        }),
      "Hours saved.",
    );
  };
  const step = (path: string, done: string, body: Record<string, unknown> = {}) =>
    act(() => api<{ timesheet: Timesheet }>(`/api/payroll/timesheets/${timesheet.id}/${path}`, { method: "POST", body: { organisationId, ...body } }), done);
  const fill = async () => {
    setMessage(null);
    try {
      const result = await api<{ suggestions: ProjectTimeSuggestion[] }>(`/api/payroll/timesheets/${timesheet.id}/project-time`, { query: { organisationId } });
      if (result.suggestions.length === 0) {
        setMessage({ tone: "success", text: "No project time for this week." });
        return;
      }
      const next = [...grid];
      for (const suggestion of result.suggestions) {
        const existing = next.find((row) => row.projectId === suggestion.projectId && !row.departmentId && !row.rdActivityId);
        if (existing) existing.hours = { ...existing.hours, ...suggestion.hours };
        else next.push({ departmentId: "", projectId: suggestion.projectId, rdActivityId: "", description: "", hours: { ...suggestion.hours } });
      }
      changed(next);
      setMessage({ tone: "success", text: "Project time added below. Check it, then save." });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };

  const t = targets.data?.targets;
  const dayTotal = (date: string) => hoursTotal(grid.map((row) => row.hours[date] ?? ""));

  return (
    <Card
      title={`${timesheet.employeeName}: week starting ${formatDate(timesheet.weekStart)}`}
      description={`Monday ${formatDate(timesheet.weekStart)} to Sunday ${formatDate(timesheet.weekEnd)}. Hours to 2 decimal places (7 h 30 min is 7.5).`}
      actions={<StatusBadge status={timesheet.status} />}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {timesheet.usedBy.length > 0 ? (
        <Notice tone="info">Used by {timesheet.usedBy.join(", ")} to split pay, so it can&apos;t be reopened unless that pay run is voided.</Notice>
      ) : null}
      {timesheet.lateCount > 0 ? (
        <Notice tone="warning">{timesheet.lateCount} entr{timesheet.lateCount === 1 ? "y was" : "ies were"} entered more than 14 days after the work (decision 38). They still count.</Notice>
      ) : null}
      <form className={styles.stack} onSubmit={save}>
        <div className={ui.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Row</th>
                {timesheet.days.map((date, index) => (
                  <th key={date} className={ui.num}>{DAY_NAMES[index]}<br /><span className={ui.muted}>{date.slice(8)}/{date.slice(5, 7)}</span></th>
                ))}
                <th className={ui.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row, index) => {
                const saved = timesheet.rows.find(
                  (each) => (each.departmentId ?? "") === row.departmentId && (each.projectId ?? "") === row.projectId && (each.rdActivityId ?? "") === row.rdActivityId,
                );
                return (
                  <tr key={index}>
                    <td>
                      {editable ? (
                        <div className={styles.stack}>
                          <select aria-label="R&D activity" value={row.rdActivityId} onChange={(event) => setField(index, "rdActivityId", event.target.value)}>
                            <option value="">No R&amp;D activity</option>
                            {(t?.rdActivities ?? []).map((activity) => <option key={activity.id} value={activity.id}>{activity.code} {activity.name}</option>)}
                          </select>
                          <select aria-label="Department" value={row.departmentId} onChange={(event) => setField(index, "departmentId", event.target.value)}>
                            <option value="">No Department</option>
                            {(t?.departments ?? []).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
                          </select>
                          <select aria-label="Project" value={row.projectId} onChange={(event) => setField(index, "projectId", event.target.value)}>
                            <option value="">No project</option>
                            {(t?.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                          </select>
                          <input aria-label="Description" placeholder="Description (optional)" value={row.description} onChange={(event) => setField(index, "description", event.target.value)} />
                        </div>
                      ) : (
                        <>
                          {saved?.label ?? "Other work (default split)"}
                          {row.description ? <div className={ui.muted}>{row.description}</div> : null}
                        </>
                      )}
                    </td>
                    {timesheet.days.map((date, dayIndex) => {
                      const entry = saved?.entries[date];
                      return (
                        <td key={date} className={ui.num}>
                          {editable ? (
                            <input
                              aria-label={`${DAY_NAMES[dayIndex]} hours`}
                              inputMode="decimal"
                              size={5}
                              value={row.hours[date] ?? ""}
                              onChange={(event) => setCell(index, date, event.target.value)}
                            />
                          ) : (
                            row.hours[date] ?? ""
                          )}
                          {entry?.enteredLate ? (
                            <div title={`${entry.timelinessText}, by ${entry.enteredByEmail}`}><Badge tone="amber">Late</Badge></div>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className={ui.num}>{hoursTotal(Object.values(row.hours))}</td>
                  </tr>
                );
              })}
              {grid.length === 0 ? (
                <tr><td colSpan={9}><span className={ui.muted}>No hours yet.</span></td></tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <td>Day total</td>
                {timesheet.days.map((date) => <td key={date} className={ui.num}>{dayTotal(date)}</td>)}
                <td className={ui.num}>{hoursTotal(timesheet.days.map(dayTotal))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {editable ? (
          <div className={ui.actions}>
            <Button variant="secondary" onClick={() => changed([...grid, { departmentId: "", projectId: "", rdActivityId: "", description: "", hours: {} }])}>Add row</Button>
            <Button variant="secondary" onClick={() => void fill()}>Fill from project time</Button>
            <Button type="submit" disabled={busy}>Save hours</Button>
            {timesheet.canSubmit && rows === null ? (
              <Button variant="secondary" disabled={busy} onClick={() => void step("submit", "Submitted for approval.")}>Submit for approval</Button>
            ) : null}
          </div>
        ) : null}
      </form>

      {timesheet.canApprove || timesheet.canReopen ? (
        <div className={styles.stack}>
          <Field label="Reason" hint={timesheet.canApprove ? "Needed to reject." : "Needed to reopen."}>
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
          </Field>
          <div className={ui.actions}>
            {timesheet.canApprove ? (
              <>
                <Button disabled={busy} onClick={() => void step("approve", "Approved. Pay runs approved from now on use it.")}>Approve</Button>
                <Button variant="danger" disabled={busy} onClick={() => void step("reject", "Sent back to draft.", { reason })}>Reject</Button>
              </>
            ) : null}
            {timesheet.canReopen ? (
              <Button variant="danger" disabled={busy} onClick={() => void step("reopen", "Reopened as a draft.", { reason })}>Reopen</Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {timesheet.changes.length > 0 ? (
        <details>
          <summary>Changed hours ({timesheet.changes.length})</summary>
          <ul>
            {timesheet.changes.map((change, index) => (
              <li key={index}>
                {change.label}, {formatDate(change.workDate)}: {change.hours} h entered {formatDateTime(change.enteredAt)} by {personName(change, "enteredBy")};{" "}
                {change.outcome === "replaced" ? `changed to ${change.newHours} h` : "cleared"} on {formatDateTime(change.endedAt)} by {personName(change, "endedBy")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details>
        <summary>History</summary>
        <ul>
          {timesheet.history.map((event, index) => (
            <li key={index}>
              {event.action[0].toUpperCase() + event.action.slice(1)} by {personName(event, "actor")} on {formatDateTime(event.at)}
              {event.reason ? `: ${event.reason}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

/** Who fills in and approves each employee's timesheets (TS1). Payroll access only. */
function TimesheetPeople({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ people: TimesheetPerson[]; members: Array<{ userId: string; email: string; displayName: string; role: string }> }>(
    "/api/payroll/timesheets/people",
    { organisationId },
  );
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const save = async (person: TimesheetPerson, userId: string | null, approverUserId: string | null) => {
    setMessage(null);
    try {
      await api("/api/payroll/timesheets/people", { method: "PUT", body: { organisationId, employeeId: person.employeeId, userId, approverUserId } });
      setMessage({ tone: "success", text: `${person.name} saved.` });
      loaded.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    }
  };
  const members = loaded.data?.members ?? [];
  const approvers = members.filter((member) => member.role !== "viewer");
  return (
    <Card
      title="Who fills in and approves"
      description="Link an employee to their login so they can fill in their own timesheets (viewers can). Their approver needs the bookkeeper role or higher; with none, the login linked to their reports-to manager approves. People with payroll access can always enter and approve."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {loaded.data ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>Employee</th><th>Their login</th><th>Timesheet approver</th></tr></thead>
            <tbody>
              {loaded.data.people.map((person) => (
                <tr key={person.employeeId}>
                  <td data-label="Employee">{person.name}</td>
                  <td data-label="Their login">
                    <select aria-label={`${person.name}'s login`} value={person.userId ?? ""} onChange={(event) => void save(person, event.target.value || null, person.approverUserId)}>
                      <option value="">Not linked</option>
                      {members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName || member.email}</option>)}
                    </select>
                  </td>
                  <td data-label="Timesheet approver">
                    <select aria-label={`${person.name}'s approver`} value={person.approverUserId ?? ""} onChange={(event) => void save(person, person.userId, event.target.value || null)}>
                      <option value="">{person.managerUserId ? "Their reports-to manager" : "Only people with payroll access"}</option>
                      {approvers.map((member) => <option key={member.userId} value={member.userId}>{member.displayName || member.email}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>Loading…</Empty>}
    </Card>
  );
}
