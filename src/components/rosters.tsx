"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, Stat, ui, WarningNote } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { EmployeeSummary } from "@/lib/payroll/employees";
import type { MyShift, RosterArea, RosterShift, RosterWeek, Unavailability } from "@/lib/payroll/rosters";

/**
 * Rosters inside Payroll (examples RS1-RS4): an area's week of shifts, their
 * cost against its weekly budget, warnings for unavailability and leave,
 * publishing, and each employee's own published shifts.
 */

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIME_ZONE = "Pacific/Auckland";

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function dayName(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

/** A date and a time on the device (NZ) as an instant. */
function instant(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString();
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      done?.(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

export function Rosters({ organisationId }: { organisationId: string }) {
  const areas = useApiData<{ areas: RosterArea[] }>("/api/payroll/rosters/areas", { organisationId });
  const [areaId, setAreaId] = useState<string | null>(null);
  const [weekOf, setWeekOf] = useState(todayInBrowser());
  if (areas.error) return <Notice tone="error">{areas.error}</Notice>;
  if (!areas.data) return <p className={ui.muted}>Loading…</p>;
  const active = areas.data.areas.filter((area) => area.isActive);
  const area = active.find((entry) => entry.id === areaId) ?? active[0] ?? null;
  return (
    <>
      <AreasCard organisationId={organisationId} areas={areas.data.areas} onSaved={() => areas.reload()} />
      {area ? (
        <>
          {active.length > 1 ? (
            <div className={ui.tabs} role="tablist" aria-label="Areas">
              {active.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={entry.id === area.id}
                  className={`${ui.tab} ${entry.id === area.id ? ui.tabActive : ""}`}
                  onClick={() => setAreaId(entry.id)}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          ) : null}
          <RosterWeekView key={`${area.id}-${weekOf}`} organisationId={organisationId} areaId={area.id} weekOf={weekOf} onWeek={setWeekOf} />
          <UnavailabilityCard organisationId={organisationId} />
        </>
      ) : null}
    </>
  );
}

function AreasCard({ organisationId, areas, onSaved }: { organisationId: string; areas: RosterArea[]; onSaved: () => void }) {
  const [editing, setEditing] = useState<RosterArea | "new" | null>(areas.length === 0 ? "new" : null);
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const { busy, error, run } = useRun();
  const start = (area: RosterArea | "new") => {
    setEditing(area);
    setName(area === "new" ? "" : area.name);
    setBudget(area === "new" ? "" : (area.weeklyBudget ?? ""));
  };
  const save = (isActive = true) =>
    void run(
      () =>
        api("/api/payroll/rosters/areas", {
          method: "POST",
          body: { organisationId, id: editing === "new" ? undefined : editing?.id, name, weeklyBudget: budget || null, isActive },
        }),
      () => {
        setEditing(null);
        onSaved();
      },
    );
  return (
    <Card
      title="Areas"
      description="Where people are rostered, such as the shop, each with a weekly budget for wages and employer KiwiSaver."
      actions={editing ? null : <Button variant="secondary" onClick={() => start("new")}>Add an area</Button>}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {areas.length > 0 ? (
        <div className={ui.actions}>
          {areas.map((area) => (
            <Button key={area.id} size="small" variant="secondary" onClick={() => start(area)}>
              {area.name}
              {area.weeklyBudget ? ` · ${area.weeklyBudget} a week` : ""}
              {area.isActive ? "" : " (not in use)"}
            </Button>
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={ui.inlineForm}>
          <Field label="Name">
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Weekly budget" hint="Blank: no budget.">
            <input inputMode="decimal" value={budget} onChange={(event) => setBudget(event.target.value)} />
          </Field>
          <Button onClick={() => save()} disabled={busy || !name.trim()}>
            Save
          </Button>
          {editing !== "new" ? (
            <Button variant="secondary" onClick={() => save(!editing.isActive)} disabled={busy}>
              {editing.isActive ? "Stop using" : "Use again"}
            </Button>
          ) : null}
          {areas.length > 0 ? (
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function RosterWeekView({ organisationId, areaId, weekOf, onWeek }: { organisationId: string; areaId: string; weekOf: string; onWeek: (date: string) => void }) {
  const confirm = useConfirm();
  const loaded = useApiData<{ roster: RosterWeek }>("/api/payroll/rosters", { organisationId, areaId, weekStart: weekOf });
  const employees = useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", { organisationId });
  const [updated, setUpdated] = useState<RosterWeek | null>(null);
  const roster = updated ?? loaded.data?.roster ?? null;
  const { busy, error, run } = useRun();
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!roster) return <p className={ui.muted}>Loading…</p>;
  const remove = async (shift: RosterShift) => {
    if (!(await confirm(`Remove ${shift.employeeName}'s shift on ${dayName(shift.date)}?`))) return;
    void run(() => api<{ roster: RosterWeek }>(`/api/payroll/rosters/shifts/${shift.id}`, { method: "DELETE", body: { organisationId } }), (result) => setUpdated(result.roster));
  };
  const publish = () =>
    void run(() => api<{ roster: RosterWeek }>("/api/payroll/rosters/publish", { method: "POST", body: { organisationId, areaId, weekStart: roster.weekStart } }), (result) =>
      setUpdated(result.roster),
    );
  const over = roster.remaining !== null && roster.remaining.startsWith("-");
  return (
    <>
      <Card
        title={`${roster.area.name}: week of ${formatDate(roster.weekStart)}`}
        description={
          roster.publishedAt
            ? `Published ${formatDate(roster.publishedAt.slice(0, 10))} by ${roster.publishedByEmail}. Employees see the published shifts.`
            : "Not published yet: employees don't see these shifts."
        }
        actions={
          <div className={ui.actions}>
            <Button variant="secondary" onClick={() => onWeek(addDays(roster.weekStart, -7))}>
              Previous week
            </Button>
            <Button variant="secondary" onClick={() => onWeek(todayInBrowser())}>
              This week
            </Button>
            <Button variant="secondary" onClick={() => onWeek(addDays(roster.weekStart, 7))}>
              Next week
            </Button>
          </div>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={ui.statRow}>
          <Stat label="Hours" value={roster.totals.hours} />
          <Stat label="Wages" value={<Money value={roster.totals.wages} />} />
          <Stat label="Employer KiwiSaver" value={<Money value={roster.totals.kiwiSaver} />} />
          <Stat label="Cost" value={<Money value={roster.totals.cost} />} />
          {roster.budget !== null ? <Stat label={over ? "Over budget" : "Budget left"} value={<Money value={over ? roster.remaining!.slice(1) : roster.remaining} />} /> : null}
        </div>
        <p className={ui.muted}>
          Cost is the hours less unpaid breaks at each person&apos;s hourly rate, plus employer KiwiSaver. Shifts in leave aren&apos;t counted.
          {roster.notCosted > 0 ? ` ${roster.notCosted} shift${roster.notCosted === 1 ? " isn't" : "s aren't"} costed: salaried, or no pay rate yet.` : ""}
          {roster.budget !== null ? ` Budget ${roster.budget} a week.` : ""} Nothing is posted.
        </p>
        {roster.changes.length > 0 ? (
          <Notice tone="warning">
            <strong>Changed since published:</strong>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {roster.changes.map((change, index) => (
                <li key={index}>
                  {change.employeeName}: {change.text}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div className={ui.actions}>
          <Button onClick={publish} disabled={busy || (roster.publishedAt !== null && roster.changes.length === 0) || (roster.publishedAt === null && roster.shifts.length === 0)}>
            {roster.publishedAt ? "Publish changes" : "Publish"}
          </Button>
        </div>
        {roster.days.map((day) => {
          const onDay = roster.shifts.filter((shift) => shift.date === day);
          return (
            <section key={day}>
              <h3>{dayName(day)}</h3>
              {onDay.length === 0 ? (
                <p className={ui.muted}>No shifts.</p>
              ) : (
                <div className={ui.tableWrap}>
                  <table className={`${ui.table} ${ui.stackOnPhone}`}>
                    <thead>
                      <tr>
                        <th>Who</th>
                        <th>Time</th>
                        <th className={ui.num}>Hours</th>
                        <th className={ui.num}>Cost</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {onDay.map((shift) => (
                        <tr key={shift.id}>
                          <td data-label="Who">
                            {shift.employeeName}
                            {shift.warnings.map((warning) => (
                              <div key={warning}>
                                <WarningNote text={warning} />
                              </div>
                            ))}
                          </td>
                          <td data-label="Time">
                            {timeOf(shift.startsAt)}-{timeOf(shift.endsAt)}
                            {shift.breakMinutes ? <span className={ui.muted}> · {shift.breakMinutes} min break</span> : null}
                          </td>
                          <td data-label="Hours" className={ui.num}>
                            {shift.hours}
                          </td>
                          <td data-label="Cost" className={ui.num}>
                            {shift.cost === null ? <span className={ui.muted}>Not costed</span> : shift.onLeave ? <span className={ui.muted}>On leave</span> : <Money value={shift.cost} />}
                          </td>
                          <td>
                            <Button size="small" variant="secondary" onClick={() => void remove(shift)} disabled={busy}>
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}
      </Card>
      <AddShiftCard organisationId={organisationId} areaId={areaId} days={roster.days} employees={(employees.data?.employees ?? []).filter((employee) => !employee.isArchived)} onAdded={setUpdated} />
    </>
  );
}

function AddShiftCard({
  organisationId,
  areaId,
  days,
  employees,
  onAdded,
}: {
  organisationId: string;
  areaId: string;
  days: string[];
  employees: EmployeeSummary[];
  onAdded: (roster: RosterWeek) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(days[0]);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [reason, setReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const { busy, error, run, setError } = useRun();
  const add = () =>
    void run(
      async () => {
        try {
          return await api<{ roster: RosterWeek }>("/api/payroll/rosters/shifts", {
            method: "POST",
            body: { organisationId, areaId, employeeId, startsAt: instant(date, start), endsAt: instant(end <= start ? addDays(date, 1) : date, end), breakMinutes, unavailableReason: reason || null },
          });
        } catch (caught) {
          if (errorMessage(caught).includes("Give a reason")) setNeedsReason(true);
          throw caught;
        }
      },
      (result) => {
        setReason("");
        setNeedsReason(false);
        setError(null);
        onAdded(result.roster);
      },
    );
  return (
    <Card title="Add a shift" description="A shift ending at or before its start time ends the next day.">
      {error ? <Notice tone={needsReason ? "warning" : "error"}>{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Employee">
          <select value={employeeId} onChange={(event) => (setEmployeeId(event.target.value), setNeedsReason(false))}>
            <option value="">Choose…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.firstName} {employee.lastName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Day">
          <select value={date} onChange={(event) => (setDate(event.target.value), setNeedsReason(false))}>
            {days.map((day) => (
              <option key={day} value={day}>
                {dayName(day)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start">
          <input type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        </Field>
        <Field label="End">
          <input type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
        </Field>
        <Field label="Unpaid break (minutes)">
          <input inputMode="numeric" value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} />
        </Field>
        {needsReason ? (
          <Field label="Reason to roster them anyway">
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
        ) : null}
        <Button onClick={add} disabled={busy || !employeeId || (needsReason && !reason.trim())}>
          {needsReason ? "Roster anyway" : "Add shift"}
        </Button>
      </div>
    </Card>
  );
}

const WEEKDAY_OPTIONS = WEEKDAYS.map((name, index) => ({ value: String(index + 1), label: name }));

/** When someone can't work (RS2): for any employee (payroll) or, without `employees`, yourself. */
function UnavailabilityEditor({ organisationId, employeeId }: { organisationId: string; employeeId: string | null }) {
  const list = useApiData<{ unavailability: Unavailability[] }>("/api/payroll/unavailability", { organisationId, employeeId });
  const [kind, setKind] = useState<"weekday" | "dates">("weekday");
  const [weekday, setWeekday] = useState("6");
  const [fromDate, setFromDate] = useState(todayInBrowser());
  const [toDate, setToDate] = useState(todayInBrowser());
  const [note, setNote] = useState("");
  const { busy, error, run } = useRun();
  const add = () =>
    void run(
      () =>
        api("/api/payroll/unavailability", {
          method: "POST",
          body: { organisationId, employeeId, ...(kind === "weekday" ? { weekday: Number(weekday) } : { fromDate, toDate }), note: note || null },
        }),
      () => {
        setNote("");
        list.reload();
      },
    );
  const remove = (id: string) => void run(() => api(`/api/payroll/unavailability/${id}`, { method: "DELETE", body: { organisationId } }), () => list.reload());
  return (
    <>
      {error ?? list.error ? <Notice tone="error">{error ?? list.error}</Notice> : null}
      {list.data && list.data.unavailability.length === 0 ? <Empty>No times marked unavailable.</Empty> : null}
      {list.data && list.data.unavailability.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 6 }}>
          {list.data.unavailability.map((entry) => (
            <li key={entry.id}>
              {entry.text}
              {entry.note ? <span className={ui.muted}> · {entry.note}</span> : null}{" "}
              <Button size="small" variant="secondary" onClick={() => remove(entry.id)} disabled={busy}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Unavailable">
          <select value={kind} onChange={(event) => setKind(event.target.value as "weekday" | "dates")}>
            <option value="weekday">Every week on</option>
            <option value="dates">Between dates</option>
          </select>
        </Field>
        {kind === "weekday" ? (
          <Field label="Day">
            <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
              {WEEKDAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="From">
              <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </Field>
            <Field label="To">
              <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </Field>
          </>
        )}
        <Field label="Note">
          <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Button variant="secondary" onClick={add} disabled={busy}>
          Add
        </Button>
      </div>
    </>
  );
}

function UnavailabilityCard({ organisationId }: { organisationId: string }) {
  const employees = useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", { organisationId });
  const [employeeId, setEmployeeId] = useState("");
  const list = (employees.data?.employees ?? []).filter((employee) => !employee.isArchived);
  return (
    <Card title="Unavailability" description="When someone can't work. Rostering them then needs a reason. Employees with a login can add their own under My shifts.">
      <div className={ui.inlineForm}>
        <Field label="Employee">
          <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="">Choose…</option>
            {list.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.firstName} {employee.lastName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {employeeId ? <UnavailabilityEditor key={employeeId} organisationId={organisationId} employeeId={employeeId} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// My shifts (RS4)

export function MyShifts({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const shifts = useApiData<{ shifts: MyShift[] }>("/api/payroll/my-shifts", { organisationId, from: today, to: addDays(today, 27) });
  const own = useApiData<{ unavailability: Unavailability[]; linked: boolean }>("/api/payroll/unavailability", { organisationId });
  return (
    <>
      <Card title="Coming up" description="Your published shifts for the next four weeks.">
        {shifts.error ? <Notice tone="error">{shifts.error}</Notice> : null}
        {shifts.data && shifts.data.shifts.length === 0 ? <Empty>No published shifts.</Empty> : null}
        {shifts.data && shifts.data.shifts.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Time</th>
                  <th>Where</th>
                  <th className={ui.num}>Hours</th>
                </tr>
              </thead>
              <tbody>
                {shifts.data.shifts.map((shift) => (
                  <tr key={shift.startsAt + shift.areaName}>
                    <td data-label="Day">{dayName(shift.date)}</td>
                    <td data-label="Time">
                      {timeOf(shift.startsAt)}-{timeOf(shift.endsAt)}
                      {shift.breakMinutes ? <span className={ui.muted}> · {shift.breakMinutes} min break</span> : null}
                    </td>
                    <td data-label="Where">{shift.areaName}</td>
                    <td data-label="Hours" className={ui.num}>
                      {shift.hours}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <Card title="When I can't work">
        {own.error ? <Notice tone="error">{own.error}</Notice> : null}
        {own.data?.linked === false ? <Notice tone="info">Your login isn&apos;t linked to an employee record, so you have no shifts here. Ask whoever runs payroll to link it.</Notice> : null}
        {own.data?.linked ? <UnavailabilityEditor organisationId={organisationId} employeeId={null} /> : null}
      </Card>
    </>
  );
}
