"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { EmployeeGroup, PayFrequency, PayGroup } from "@/lib/payroll/groups";
import styles from "./payroll-employees.module.css";

export const PAY_FREQUENCY_LABELS: Record<PayFrequency, string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  four_weekly: "Every four weeks",
  monthly: "Monthly",
};

type Groups = { payGroups: PayGroup[]; employeeGroups: EmployeeGroup[] };

/** Pay groups and employee groups (example PR8), for people with payroll access. */
export function PayrollGroups({ organisationId }: { organisationId: string }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, loading, reload } = useApiData<Groups>("/api/payroll/groups", { organisationId, includeArchived });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [payName, setPayName] = useState("");
  const [payFrequency, setPayFrequency] = useState<PayFrequency | "">("");
  const [employeeName, setEmployeeName] = useState("");

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage({ tone: "success", text: success });
      reload();
      return true;
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addPayGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = payName.trim();
    const saved = await run(
      () =>
        api("/api/payroll/groups", {
          method: "POST",
          body: { organisationId, kind: "pay", idempotencyKey: newIdempotencyKey("pay-group"), name, payFrequency },
        }),
      `Pay group ${name} added.`,
    );
    if (saved) {
      setPayName("");
      setPayFrequency("");
    }
  };

  const addEmployeeGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = employeeName.trim();
    const saved = await run(
      () =>
        api("/api/payroll/groups", {
          method: "POST",
          body: { organisationId, kind: "employee", idempotencyKey: newIdempotencyKey("employee-group"), name },
        }),
      `Employee group ${name} added.`,
    );
    if (saved) setEmployeeName("");
  };

  const rename = (kind: "pay" | "employee", group: PayGroup | EmployeeGroup) => {
    const name = window.prompt("New name", group.name)?.trim();
    if (!name || name === group.name) return;
    void run(
      () => api(`/api/payroll/groups/${group.id}`, { method: "PATCH", body: { organisationId, kind, name } }),
      `Renamed to ${name}.`,
    );
  };

  const archive = (kind: "pay" | "employee", group: PayGroup | EmployeeGroup) =>
    void run(
      () => api(`/api/payroll/groups/${group.id}`, { method: "PATCH", body: { organisationId, kind, isArchived: !group.isArchived } }),
      group.isArchived ? `${group.name} restored.` : `${group.name} archived.`,
    );

  const actions = (kind: "pay" | "employee", group: PayGroup | EmployeeGroup) => (
    <div className={ui.actions}>
      <Button disabled={busy} size="small" variant="secondary" onClick={() => rename(kind, group)}>Rename</Button>
      <Button disabled={busy} size="small" variant="secondary" onClick={() => archive(kind, group)}>
        {group.isArchived ? "Restore" : "Archive"}
      </Button>
    </div>
  );

  return (
    <div className={styles.stack}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <label className={ui.checkbox}>
        <input checked={includeArchived} type="checkbox" onChange={(event) => setIncludeArchived(event.target.checked)} />
        Include archived
      </label>

      <Card title="Pay groups">
        <p>Everyone in a pay group is paid on the group&apos;s frequency. A group&apos;s frequency can&apos;t change while employees are in it.</p>
        <form className={styles.stack} onSubmit={addPayGroup}>
          <div className={ui.grid2}>
            <Field label="Name">
              <input maxLength={100} placeholder="Weekly wages" required value={payName} onChange={(event) => setPayName(event.target.value)} />
            </Field>
            <Field label="Pay frequency">
              <select required value={payFrequency} onChange={(event) => setPayFrequency(event.target.value as PayFrequency | "")}>
                <option value="">Choose a frequency</option>
                {Object.entries(PAY_FREQUENCY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Add pay group</Button>
          </div>
        </form>
        {loading ? <Empty>Loading…</Empty> : data?.payGroups.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Pay group</th><th>Frequency</th><th>Employees</th><th>Actions</th></tr></thead>
              <tbody>
                {data.payGroups.map((group) => (
                  <tr key={group.id}>
                    <td data-label="Pay group">{group.name} {group.isArchived ? <Badge tone="neutral">Archived</Badge> : null}</td>
                    <td data-label="Frequency">{PAY_FREQUENCY_LABELS[group.payFrequency]}</td>
                    <td data-label="Employees">{group.employeeCount}</td>
                    <td data-label="Actions">{actions("pay", group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No pay groups yet.</Empty>}
      </Card>

      <Card title="Employee groups">
        <p>Group employees for reporting, for example by office or team.</p>
        <form className={styles.stack} onSubmit={addEmployeeGroup}>
          <Field label="Name">
            <input maxLength={100} placeholder="Wellington office" required value={employeeName} onChange={(event) => setEmployeeName(event.target.value)} />
          </Field>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Add employee group</Button>
          </div>
        </form>
        {loading ? <Empty>Loading…</Empty> : data?.employeeGroups.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead><tr><th>Employee group</th><th>Employees</th><th>Actions</th></tr></thead>
              <tbody>
                {data.employeeGroups.map((group) => (
                  <tr key={group.id}>
                    <td data-label="Employee group">{group.name} {group.isArchived ? <Badge tone="neutral">Archived</Badge> : null}</td>
                    <td data-label="Employees">{group.employeeCount}</td>
                    <td data-label="Actions">{actions("employee", group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No employee groups yet.</Empty>}
      </Card>
    </div>
  );
}
