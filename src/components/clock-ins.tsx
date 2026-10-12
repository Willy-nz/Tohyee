"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui, WarningNote } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { ClockDevice, ClockPinState, ClockRecord } from "@/lib/payroll/clock";

/**
 * Payroll > Clock-ins (examples RS5-RS8): who clocked in and out, the
 * missed clock-outs a manager needs to finish, the shared devices, and
 * employees' PINs.
 */

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" });
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function mondayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function ClockIns({ organisationId }: { organisationId: string }) {
  const [from, setFrom] = useState(() => mondayOf(todayInBrowser()));
  const records = useApiData<{ records: ClockRecord[]; needsAttention: ClockRecord[] }>("/api/payroll/clock/records", { organisationId, from, to: addDays(from, 6) });
  return (
    <>
      {records.data && records.data.needsAttention.length > 0 ? (
        <Card title="Needs attention" description="Not clocked out by midnight, or not on the timesheet yet. Nothing goes to the timesheet until it's sorted.">
          {records.data.needsAttention.map((record) => (
            <AttentionRow key={record.id} organisationId={organisationId} record={record} onDone={() => records.reload()} />
          ))}
        </Card>
      ) : null}
      <Card
        title={`Week of ${formatDate(from)}`}
        description="Clocked time goes onto each person's timesheet as other work, marked from clock-in, for their approver to approve. Exact minutes, no rounding."
        actions={
          <div className={ui.actions}>
            <Button variant="secondary" onClick={() => setFrom(addDays(from, -7))}>
              Previous week
            </Button>
            <Button variant="secondary" onClick={() => setFrom(addDays(from, 7))}>
              Next week
            </Button>
          </div>
        }
      >
        {records.error ? <Notice tone="error">{records.error}</Notice> : null}
        {records.data && records.data.records.length === 0 ? <Empty>No one clocked in this week.</Empty> : null}
        {records.data && records.data.records.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Day</th>
                  <th>In</th>
                  <th>Out</th>
                  <th className={ui.num}>Break</th>
                  <th className={ui.num}>Hours</th>
                  <th>Timesheet</th>
                </tr>
              </thead>
              <tbody>
                {records.data.records.map((record) => (
                  <tr key={record.id}>
                    <td data-label="Who">{record.employeeName}</td>
                    <td data-label="Day">{formatDate(record.date)}</td>
                    <td data-label="In">{timeOf(record.clockInAt)}</td>
                    <td data-label="Out">
                      {record.clockOutAt ? timeOf(record.clockOutAt) : record.status === "needs_attention" ? <Badge tone="red">Not clocked out</Badge> : <Badge tone="blue">Still in</Badge>}
                      {record.outEnteredByEmail ? <div className={ui.muted}>Entered by {record.outEnteredByEmail}: {record.outReason}</div> : null}
                    </td>
                    <td data-label="Break" className={ui.num}>
                      {record.breakMinutes ? `${record.breakMinutes} min` : ""}
                    </td>
                    <td data-label="Hours" className={ui.num}>
                      {record.hours ?? ""}
                    </td>
                    <td data-label="Timesheet">{record.onTimesheet ? <Badge tone="green">On timesheet</Badge> : record.timesheetProblem ? <WarningNote text={record.timesheetProblem} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <DevicesCard organisationId={organisationId} />
      <PinsCard organisationId={organisationId} />
    </>
  );
}

function AttentionRow({ organisationId, record, onDone }: { organisationId: string; record: ClockRecord; onDone: () => void }) {
  const [out, setOut] = useState("17:00");
  const [breakMinutes, setBreakMinutes] = useState(String(record.breakMinutes || ""));
  const [reason, setReason] = useState("");
  const { busy, error, run } = useRun();
  const post = (body: Record<string, unknown>) => void run(() => api(`/api/payroll/clock/records/${record.id}`, { method: "POST", body: { organisationId, ...body } }), onDone);
  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "12px 0" }}>
      <p style={{ margin: "0 0 8px" }}>
        <strong>{record.employeeName}</strong>, {formatDate(record.date)}: clocked in at {timeOf(record.clockInAt)}
        {record.clockOutAt ? `, out at ${timeOf(record.clockOutAt)} (${record.hours} hours)` : ", never clocked out"}.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {record.status === "needs_attention" ? (
        <div className={ui.inlineForm}>
          <Field label="Out at">
            <input type="time" value={out} onChange={(event) => setOut(event.target.value)} />
          </Field>
          <Field label="Break (minutes)">
            <input inputMode="numeric" value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} />
          </Field>
          <Field label="Reason">
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Button
            onClick={() => post({ clockOutAt: new Date(`${record.date}T${out}`).toISOString(), breakMinutes: breakMinutes || null, reason })}
            disabled={busy || !reason.trim()}
          >
            Enter out time
          </Button>
        </div>
      ) : (
        <>
          <WarningNote text={record.timesheetProblem ?? ""} />
          <div className={ui.actions} style={{ marginTop: 8 }}>
            <Button variant="secondary" onClick={() => post({ retry: true })} disabled={busy}>
              Try the timesheet again
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function DevicesCard({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const devices = useApiData<{ devices: ClockDevice[] }>("/api/payroll/clock/devices", { organisationId });
  const [name, setName] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const add = async () => {
    if (!(await confirm(`Set up this device as "${name}" for clocking in? Then open the clock-in page here and sign out of Tohyee on it.`))) return;
    void run(() => api<{ device: ClockDevice }>("/api/payroll/clock/devices", { method: "POST", body: { organisationId, name } }), (result) => {
      setName("");
      setDone(result.device.name);
      devices.reload();
    });
  };
  const stop = async (device: ClockDevice) => {
    if (!(await confirm(`Stop ${device.name}? It won't be able to clock anyone in.`))) return;
    void run(() => api(`/api/payroll/clock/devices/${device.id}`, { method: "DELETE", body: { organisationId } }), () => devices.reload());
  };
  return (
    <Card title="Clock-in devices" description="A shared device at the shop, such as a tablet. Set it up on the device itself; it can only clock people in and out, and no one needs to be signed in on it.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? (
        <Notice tone="success">
          This device is now &ldquo;{done}&rdquo;. <a href="/clock">Open the clock-in page</a>, then sign out of Tohyee here.
        </Notice>
      ) : null}
      {devices.data && devices.data.devices.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 6 }}>
          {devices.data.devices.map((device) => (
            <li key={device.id}>
              <strong>{device.name}</strong>
              <span className={ui.muted}>
                {" "}
                · set up {formatDate(device.createdAt.slice(0, 10))} by {device.createdByEmail}
                {device.lastUsedAt ? ` · last used ${formatDate(device.lastUsedAt.slice(0, 10))}` : ""}
              </span>{" "}
              {device.revokedAt ? (
                <Badge tone="neutral">Stopped</Badge>
              ) : (
                <Button size="small" variant="secondary" onClick={() => void stop(device)} disabled={busy}>
                  Stop
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Name for this device">
          <input value={name} maxLength={100} placeholder="Shop iPad" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button onClick={() => void add()} disabled={busy || !name.trim()}>
          Set up this device
        </Button>
      </div>
    </Card>
  );
}

function PinsCard({ organisationId }: { organisationId: string }) {
  const pins = useApiData<{ pins: ClockPinState[] }>("/api/payroll/clock/pins", { organisationId });
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { busy, error, run } = useRun();
  const save = (employeeId: string, pin: string | null) =>
    void run(() => api("/api/payroll/clock/pins", { method: "PUT", body: { organisationId, employeeId, pin } }), () => {
      setTyped({ ...typed, [employeeId]: "" });
      pins.reload();
    });
  return (
    <Card title="PINs" description="Each person types their PIN on the device: 4 to 8 digits, kept only as a hash. Five wrong tries lock it for 15 minutes; setting a new PIN unlocks it.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {pins.data && pins.data.pins.length === 0 ? <Empty>No employees yet.</Empty> : null}
      {pins.data && pins.data.pins.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Employee</th>
                <th>PIN</th>
                <th>New PIN</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pins.data.pins.map((entry) => (
                <tr key={entry.employeeId}>
                  <td data-label="Employee">{entry.name}</td>
                  <td data-label="PIN">
                    {entry.hasPin ? <Badge tone="green">Set</Badge> : <span className={ui.muted}>None</span>}
                    {entry.lockedUntil ? (
                      <>
                        {" "}
                        <Badge tone="red">Locked</Badge>
                      </>
                    ) : null}
                  </td>
                  <td data-label="New PIN">
                    <input
                      aria-label={`New PIN for ${entry.name}`}
                      type="password"
                      inputMode="numeric"
                      autoComplete="new-password"
                      maxLength={8}
                      size={10}
                      value={typed[entry.employeeId] ?? ""}
                      onChange={(event) => setTyped({ ...typed, [entry.employeeId]: event.target.value.replace(/\D/g, "") })}
                    />
                  </td>
                  <td>
                    <div className={ui.actions}>
                      <Button size="small" onClick={() => save(entry.employeeId, typed[entry.employeeId] ?? "")} disabled={busy || (typed[entry.employeeId] ?? "").length < 4}>
                        Save
                      </Button>
                      {entry.hasPin ? (
                        <Button size="small" variant="secondary" onClick={() => save(entry.employeeId, null)} disabled={busy}>
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
