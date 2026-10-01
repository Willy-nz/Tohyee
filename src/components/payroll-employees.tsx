"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { describePay, EmployeeAllocation, EmployeePayRates } from "@/components/payroll-employee-pay";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Employee, EmployeeSummary } from "@/lib/payroll/employees";
import type { EmployeeGroup, PayGroup } from "@/lib/payroll/groups";
import styles from "./payroll-employees.module.css";

/** Shown beside the employee, not saved from the form. */
type ReadOnly = "reportsToName" | "payGroupName" | "employeeGroupName" | "primaryDepartment";

type Draft = Omit<Employee, "id" | "isArchived" | "kiwiSaverStatus" | "payFrequency" | "payBasis" | "studentLoan" | ReadOnly> & {
  kiwiSaverStatus: Employee["kiwiSaverStatus"] | "";
  payFrequency: Employee["payFrequency"] | "";
  payBasis: Employee["payBasis"] | "";
  studentLoan: boolean | null;
};

const EMPTY_DRAFT: Draft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  postalAddress: "",
  dateOfBirth: "",
  taxCode: "",
  irdNumber: "",
  kiwiSaverStatus: "",
  kiwiSaverEmployeeRate: "",
  kiwiSaverEmployerRate: "",
  studentLoan: null,
  payFrequency: "",
  payBasis: "",
  annualSalary: "",
  hourlyRate: null,
  ordinaryHoursPerWeek: null,
  startDate: "",
  finishDate: "",
  bankAccount: "",
  jobTitle: "",
  reportsToId: null,
  payGroupId: null,
  employeeGroupId: null,
};

const STATUS_LABELS: Record<Employee["kiwiSaverStatus"], string> = {
  enrolled: "Enrolled",
  not_enrolled: "Not enrolled",
  opted_out: "Opted out",
  savings_suspension: "Savings suspension",
  not_eligible: "Not eligible",
};

const FREQUENCY_LABELS: Record<Employee["payFrequency"], string> = {
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  four_weekly: "Every four weeks",
  monthly: "Monthly",
};

function draftFrom(employee: Employee): Draft {
  const draft = { ...employee } as Partial<Employee>;
  delete draft.id;
  delete draft.isArchived;
  delete draft.reportsToName;
  delete draft.payGroupName;
  delete draft.employeeGroupName;
  delete draft.primaryDepartment;
  return draft as Draft;
}

/** A new employee's pay is their starting pay; after that pay changes under Pay rates (PR7). */
function fieldsFrom(draft: Draft, isNew: boolean) {
  const job = {
    jobTitle: draft.jobTitle || null,
    reportsToId: draft.reportsToId || null,
    payGroupId: draft.payGroupId || null,
    employeeGroupId: draft.employeeGroupId || null,
  };
  if (!isNew) {
    const rest: Partial<Draft> = { ...draft };
    delete rest.payBasis;
    delete rest.annualSalary;
    delete rest.hourlyRate;
    delete rest.ordinaryHoursPerWeek;
    return {
      ...rest,
      ...job,
      email: draft.email || null,
      phone: draft.phone || null,
      postalAddress: draft.postalAddress || null,
      dateOfBirth: draft.dateOfBirth || null,
      finishDate: draft.finishDate || null,
    };
  }
  return {
    ...draft,
    ...job,
    email: draft.email || null,
    phone: draft.phone || null,
    postalAddress: draft.postalAddress || null,
    dateOfBirth: draft.dateOfBirth || null,
    finishDate: draft.finishDate || null,
    annualSalary: draft.payBasis === "salary" ? draft.annualSalary : null,
    hourlyRate: draft.payBasis === "hourly" ? draft.hourlyRate : null,
    ordinaryHoursPerWeek: draft.payBasis === "hourly" ? draft.ordinaryHoursPerWeek : null,
  };
}

export function PayrollEmployees({ organisationId }: { organisationId: string }) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const { data, error, loading, reload } = useApiData<{ employees: EmployeeSummary[] }>("/api/payroll/employees", {
    organisationId,
    includeArchived,
  });
  const groups = useApiData<{ payGroups: PayGroup[]; employeeGroups: EmployeeGroup[] }>("/api/payroll/groups", {
    organisationId,
    includeArchived: true,
  });
  const [current, setCurrent] = useState<Employee | null>(null);

  const change = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const startNew = () => {
    setSelectedId(null);
    setCurrent(null);
    setDraft(EMPTY_DRAFT);
    setMessage(null);
  };

  const edit = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await api<{ employee: Employee }>(`/api/payroll/employees/${id}`, {
        query: { organisationId },
      });
      setSelectedId(id);
      setCurrent(response.employee);
      setDraft(draftFrom(response.employee));
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const fields = fieldsFrom(draft, !selectedId);
      const response = selectedId
        ? await api<{ employee: Employee }>(`/api/payroll/employees/${selectedId}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ employee: Employee; created: boolean }>("/api/payroll/employees", {
            method: "POST",
            body: { organisationId, idempotencyKey: newIdempotencyKey("employee"), ...fields },
          });
      setSelectedId(response.employee.id);
      setCurrent(response.employee);
      setDraft(draftFrom(response.employee));
      setMessage({ tone: "success", text: "Employee details saved." });
      reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const archive = async (employee: EmployeeSummary) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/payroll/employees/${employee.id}`, {
        method: "PATCH",
        body: { organisationId, isArchived: !employee.isArchived },
      });
      if (selectedId === employee.id) startNew();
      setMessage({ tone: "success", text: employee.isArchived ? "Employee restored." : "Employee archived." });
      reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.stack}>
      <Notice tone="warning">
        No payroll tax is calculated or filed here. Enter KiwiSaver rates from the employee&apos;s current instructions; Tohyee does not
        supply defaults.
      </Notice>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <Card title={selectedId ? "Edit employee" : "Add an employee"}>
        <form className={styles.stack} onSubmit={save}>
          <div className={ui.grid2}>
            <Field label="First name">
              <input autoComplete="given-name" maxLength={100} required value={draft.firstName} onChange={(event) => change("firstName", event.target.value)} />
            </Field>
            <Field label="Last name">
              <input autoComplete="family-name" maxLength={100} required value={draft.lastName} onChange={(event) => change("lastName", event.target.value)} />
            </Field>
            <Field label="Email">
              <input autoComplete="email" maxLength={320} type="email" value={draft.email ?? ""} onChange={(event) => change("email", event.target.value)} />
            </Field>
            <Field label="Phone">
              <input autoComplete="tel" maxLength={50} value={draft.phone ?? ""} onChange={(event) => change("phone", event.target.value)} />
            </Field>
            <Field label="Postal address">
              <textarea autoComplete="street-address" maxLength={1000} value={draft.postalAddress ?? ""} onChange={(event) => change("postalAddress", event.target.value)} />
            </Field>
            <Field label="Date of birth">
              <input autoComplete="bday" type="date" value={draft.dateOfBirth ?? ""} onChange={(event) => change("dateOfBirth", event.target.value)} />
            </Field>
            <Field label="IRD number" hint="Encrypted when saved. Only people with payroll access can see it.">
              <input autoComplete="off" inputMode="numeric" required value={draft.irdNumber} onChange={(event) => change("irdNumber", event.target.value)} />
            </Field>
            <Field label="Tax code">
              <input autoComplete="off" maxLength={20} required value={draft.taxCode} onChange={(event) => change("taxCode", event.target.value)} />
            </Field>
            <Field label="KiwiSaver status">
              <select required value={draft.kiwiSaverStatus} onChange={(event) => change("kiwiSaverStatus", event.target.value as Draft["kiwiSaverStatus"])}>
                <option value="">Choose a status</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="KiwiSaver employee rate (%)" hint="Enter the employee's current rate; no default is applied.">
              <input inputMode="decimal" required value={draft.kiwiSaverEmployeeRate} onChange={(event) => change("kiwiSaverEmployeeRate", event.target.value)} />
            </Field>
            <Field label="KiwiSaver employer rate (%)" hint="Enter the current rate; no default is applied.">
              <input inputMode="decimal" required value={draft.kiwiSaverEmployerRate} onChange={(event) => change("kiwiSaverEmployerRate", event.target.value)} />
            </Field>
            <Field label="Pay frequency">
              <select required value={draft.payFrequency} onChange={(event) => change("payFrequency", event.target.value as Draft["payFrequency"])}>
                <option value="">Choose a frequency</option>
                {Object.entries(FREQUENCY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            {selectedId ? (
              <Field label="Current pay" hint="Change pay under Pay rates below, with the date the new rate starts.">
                <input readOnly value={current ? describePay(current) : ""} />
              </Field>
            ) : (
              <>
                <Field label="Ordinary pay">
                  <select required value={draft.payBasis} onChange={(event) => change("payBasis", event.target.value as Draft["payBasis"])}>
                    <option value="">Choose a pay type</option>
                    <option value="salary">Salary</option>
                    <option value="hourly">Hourly</option>
                  </select>
                </Field>
                {draft.payBasis === "salary" ? (
                  <Field label="Annual salary (NZD)">
                    <input inputMode="decimal" required value={draft.annualSalary ?? ""} onChange={(event) => change("annualSalary", event.target.value)} />
                  </Field>
                ) : draft.payBasis === "hourly" ? (
                  <>
                    <Field label="Hourly rate (NZD)">
                      <input inputMode="decimal" required value={draft.hourlyRate ?? ""} onChange={(event) => change("hourlyRate", event.target.value)} />
                    </Field>
                    <Field label="Ordinary hours per week">
                      <input inputMode="decimal" required value={draft.ordinaryHoursPerWeek ?? ""} onChange={(event) => change("ordinaryHoursPerWeek", event.target.value)} />
                    </Field>
                  </>
                ) : null}
              </>
            )}
            <Field label="Start date">
              <input required type="date" value={draft.startDate} onChange={(event) => change("startDate", event.target.value)} />
            </Field>
            <Field label="Finish date">
              <input type="date" value={draft.finishDate ?? ""} onChange={(event) => change("finishDate", event.target.value)} />
            </Field>
            <Field label="Bank account" hint="Encrypted when saved. Leave blank if no account has been supplied.">
              <input autoComplete="off" value={draft.bankAccount ?? ""} onChange={(event) => change("bankAccount", event.target.value)} />
            </Field>
          </div>
          <h3>Job</h3>
          <div className={ui.grid2}>
            <Field label="Job title">
              <input maxLength={100} value={draft.jobTitle ?? ""} onChange={(event) => change("jobTitle", event.target.value)} />
            </Field>
            <Field label="Reports to">
              <select value={draft.reportsToId ?? ""} onChange={(event) => change("reportsToId", event.target.value || null)}>
                <option value="">No one</option>
                {(data?.employees ?? [])
                  .filter((employee) => employee.id !== selectedId && (!employee.isArchived || employee.id === draft.reportsToId))
                  .map((employee) => <option key={employee.id} value={employee.id}>{employee.firstName} {employee.lastName}</option>)}
                {draft.reportsToId && current?.reportsToId === draft.reportsToId && !data?.employees.some((employee) => employee.id === draft.reportsToId) ? (
                  <option value={draft.reportsToId}>{current.reportsToName}</option>
                ) : null}
              </select>
            </Field>
            <Field label="Pay group" hint="Everyone in a pay group is paid on its frequency.">
              <select value={draft.payGroupId ?? ""} onChange={(event) => change("payGroupId", event.target.value || null)}>
                <option value="">None</option>
                {(groups.data?.payGroups ?? [])
                  .filter((group) => !group.isArchived || group.id === draft.payGroupId)
                  .map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </Field>
            <Field label="Employee group" hint="For reporting.">
              <select value={draft.employeeGroupId ?? ""} onChange={(event) => change("employeeGroupId", event.target.value || null)}>
                <option value="">None</option>
                {(groups.data?.employeeGroups ?? [])
                  .filter((group) => !group.isArchived || group.id === draft.employeeGroupId)
                  .map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Student loan">
            <select
              required
              value={draft.studentLoan === null ? "" : String(draft.studentLoan)}
              onChange={(event) => change("studentLoan", event.target.value === "" ? null : event.target.value === "true")}
            >
              <option value="">Choose</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </Field>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">{busy ? "Saving…" : "Save employee"}</Button>
            {selectedId ? <Button disabled={busy} variant="secondary" onClick={startNew}>Add another</Button> : null}
          </div>
        </form>
      </Card>

      {selectedId ? (
        <>
          <EmployeePayRates
            key={`rates-${selectedId}`}
            organisationId={organisationId}
            employeeId={selectedId}
            onSaved={() => {
              reload();
              void edit(selectedId);
            }}
          />
          <EmployeeAllocation key={`allocation-${selectedId}`} organisationId={organisationId} employeeId={selectedId} onSaved={reload} />
        </>
      ) : null}

      <Card
        title="Employees"
        actions={
          <label className={ui.checkbox}>
            <input checked={includeArchived} type="checkbox" onChange={(event) => setIncludeArchived(event.target.checked)} />
            Include archived
          </label>
        }
      >
        {loading ? <Empty>Loading employees…</Empty> : data?.employees.length ? (
          <div className={ui.tableWrap}>
            <table className={ui.stackOnPhone}>
              <thead>
                <tr><th>Employee</th><th>Department</th><th>Pay</th><th>IRD details</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr key={employee.id}>
                    <td data-label="Employee">
                      {employee.firstName} {employee.lastName}
                      <br />
                      <small>{[employee.jobTitle, employee.reportsToName ? `reports to ${employee.reportsToName}` : null, `starts ${employee.startDate}`].filter(Boolean).join(" · ")}</small>
                    </td>
                    <td data-label="Department">{employee.primaryDepartment?.name ?? "—"}{employee.employeeGroupName ? <><br /><small>{employee.employeeGroupName}</small></> : null}</td>
                    <td data-label="Pay">{employee.payBasis === "salary" ? `$${employee.annualSalary} a year` : `$${employee.hourlyRate} an hour`}<br /><small>{FREQUENCY_LABELS[employee.payFrequency]}{employee.payGroupName ? ` · ${employee.payGroupName}` : ""}</small></td>
                    <td data-label="IRD details">{employee.hasIrdNumber ? "IRD number saved" : "No IRD number"}<br />{employee.hasBankAccount ? "Bank account saved" : "No bank account"}</td>
                    <td data-label="Status">{employee.isArchived ? <Badge tone="neutral">Archived</Badge> : <Badge tone="green">Active</Badge>}</td>
                    <td data-label="Actions">
                      <div className={ui.actions}>
                        <Button disabled={busy} size="small" variant="secondary" onClick={() => void edit(employee.id)}>Edit</Button>
                        <Button disabled={busy} size="small" variant="secondary" onClick={() => void archive(employee)}>
                          {employee.isArchived ? "Restore" : "Archive"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>{includeArchived ? "No employees found." : "No active employees yet."}</Empty>}
      </Card>
    </div>
  );
}
