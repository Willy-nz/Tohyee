"use client";

import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { cmp, dec, parseDecimalInput, sub, sum, toFixedString } from "@/lib/money/decimal";
import type { CostAllocation } from "@/lib/payroll/allocations";
import type { PayRate } from "@/lib/payroll/pay-rates";
import type { ProjectSummary } from "@/lib/projects/service";
import type { TrackingSetup } from "@/lib/tracking/service";
import styles from "./payroll-employees.module.css";

type Message = { tone: "success" | "error"; text: string } | null;

export function describePay(rate: Pick<PayRate, "payBasis" | "annualSalary" | "hourlyRate" | "ordinaryHoursPerWeek">): string {
  return rate.payBasis === "salary"
    ? `$${rate.annualSalary} a year`
    : `$${rate.hourlyRate} an hour, ${rate.ordinaryHoursPerWeek} hours a week`;
}

/** Pay rate history and adding a new rate from a date (example PE7). */
export function EmployeePayRates({ organisationId, employeeId, onSaved }: { organisationId: string; employeeId: string; onSaved: () => void }) {
  const { data, error, loading, reload } = useApiData<{ payRates: PayRate[] }>(`/api/payroll/employees/${employeeId}/pay-rates`, {
    organisationId,
  });
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [payBasis, setPayBasis] = useState<PayRate["payBasis"] | "">("");
  const [annualSalary, setAnnualSalary] = useState("");
  const [hourlyRate, setHourlyRate] = useState("");
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/payroll/employees/${employeeId}/pay-rates`, {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: newIdempotencyKey("pay-rate"),
          effectiveFrom,
          payBasis,
          annualSalary: payBasis === "salary" ? annualSalary : null,
          hourlyRate: payBasis === "hourly" ? hourlyRate : null,
          ordinaryHoursPerWeek: payBasis === "hourly" ? hours : null,
          reason: reason.trim() || null,
        },
      });
      setMessage({ tone: "success", text: `New pay rate saved from ${formatDate(effectiveFrom)}.` });
      setEffectiveFrom("");
      setReason("");
      reload();
      onSaved();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const rates = [...(data?.payRates ?? [])].reverse();
  return (
    <Card title="Pay rates">
      <p>A new rate starts on its date; earlier pay keeps the rate it had. To fix a mistake, save a new rate with the same date.</p>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <Empty>Loading pay rates…</Empty> : rates.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>From</th><th>Pay</th><th>Reason</th><th>Saved by</th></tr></thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.id}>
                  <td data-label="From">{formatDate(rate.effectiveFrom)}</td>
                  <td data-label="Pay">{describePay(rate)}</td>
                  <td data-label="Reason">{rate.reason ?? ""}</td>
                  <td data-label="Saved by">{rate.createdByEmail === "system" ? "Tohyee" : rate.createdByEmail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No pay rates yet.</Empty>}
      <form className={styles.stack} onSubmit={save}>
        <div className={ui.grid2}>
          <Field label="New rate from">
            <input required type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
          </Field>
          <Field label="Ordinary pay">
            <select required value={payBasis} onChange={(event) => setPayBasis(event.target.value as PayRate["payBasis"] | "")}>
              <option value="">Choose a pay type</option>
              <option value="salary">Salary</option>
              <option value="hourly">Hourly</option>
            </select>
          </Field>
          {payBasis === "salary" ? (
            <Field label="Annual salary (NZD)">
              <input inputMode="decimal" required value={annualSalary} onChange={(event) => setAnnualSalary(event.target.value)} />
            </Field>
          ) : payBasis === "hourly" ? (
            <>
              <Field label="Hourly rate (NZD)">
                <input inputMode="decimal" required value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} />
              </Field>
              <Field label="Ordinary hours per week">
                <input inputMode="decimal" required value={hours} onChange={(event) => setHours(event.target.value)} />
              </Field>
            </>
          ) : null}
          <Field label="Reason" hint="Optional, e.g. Annual review.">
            <input maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
        <div className={ui.actions}>
          <Button disabled={busy} type="submit">{busy ? "Saving…" : "Save new rate"}</Button>
        </div>
      </form>
    </Card>
  );
}

type LineDraft = { percentage: string; departmentId: string; classId: string; locationId: string; projectId: string };
const EMPTY_LINE: LineDraft = { percentage: "", departmentId: "", classId: "", locationId: "", projectId: "" };

function lineTotal(lines: LineDraft[]): string | null {
  try {
    return toFixedString(sum(lines.map((line) => dec(parseDecimalInput(line.percentage || "0", "Percentage", { maxScale: 2, allowZero: true })))), 2);
  } catch {
    return null;
  }
}

function describeLine(line: CostAllocation["lines"][number]): string {
  return [line.departmentName, line.className, line.locationName, line.projectName].filter(Boolean).join(" · ") || "Not tagged";
}

/** Cost allocation: where the employee's pay is charged, split by % (examples PE3-PE6). */
export function EmployeeAllocation({ organisationId, employeeId, onSaved }: { organisationId: string; employeeId: string; onSaved: () => void }) {
  const { data, error, loading, reload } = useApiData<{ allocations: CostAllocation[] }>(
    `/api/payroll/employees/${employeeId}/allocations`,
    { organisationId },
  );
  const tracking = useApiData<TrackingSetup>("/api/tracking", { organisationId });
  const projects = useApiData<{ projects: ProjectSummary[] }>("/api/projects", { organisationId, status: "in_progress" });
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE, percentage: "100" }]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const categories = tracking.data?.advancedFeatures ? tracking.data.categories : [];
  const category = (kind: "department" | "class" | "location") => categories.find((each) => each.kind === kind);
  const total = lineTotal(lines);
  const totalIsRight = total !== null && cmp(dec(total), dec("100")) === 0;

  const changeLine = (index: number, key: keyof LineDraft, value: string) =>
    setLines((current) => current.map((line, at) => (at === index ? { ...line, [key]: value } : line)));

  const startFrom = (allocation: CostAllocation) =>
    setLines(
      allocation.lines.map((line) => ({
        percentage: line.percentage,
        departmentId: line.departmentId ?? "",
        classId: line.classId ?? "",
        locationId: line.locationId ?? "",
        projectId: line.projectId ?? "",
      })),
    );

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/payroll/employees/${employeeId}/allocations`, {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: newIdempotencyKey("allocation"),
          effectiveFrom,
          lines: lines.map((line) => ({
            percentage: line.percentage,
            departmentId: line.departmentId || null,
            classId: line.classId || null,
            locationId: line.locationId || null,
            projectId: line.projectId || null,
          })),
        },
      });
      setMessage({ tone: "success", text: `Allocation saved from ${formatDate(effectiveFrom)}.` });
      setEffectiveFrom("");
      reload();
      onSaved();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const valueSelect = (index: number, kind: "department" | "class" | "location", key: "departmentId" | "classId" | "locationId") => {
    const found = category(kind);
    if (!found) return null;
    return (
      <Field label={found.name}>
        <select value={lines[index][key]} onChange={(event) => changeLine(index, key, event.target.value)}>
          <option value="">None</option>
          {found.values
            .filter((value) => value.isActive || value.id === lines[index][key])
            .map((value) => <option key={value.id} value={value.id}>{value.path}</option>)}
        </select>
      </Field>
    );
  };

  const allocations = [...(data?.allocations ?? [])].reverse();
  return (
    <Card title="Allocation">
      <p>
        Where this employee&apos;s pay is charged, split by %. Lines must total exactly 100%. A new allocation starts on its date;
        earlier pay stays charged the way it was.
      </p>
      {tracking.data && !tracking.data.advancedFeatures ? (
        <Notice tone="info">Turn on advanced reporting in Settings to split pay by Department, Class or Location. Projects work either way.</Notice>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <Empty>Loading allocations…</Empty> : allocations.length ? (
        <div className={ui.tableWrap}>
          <table className={ui.stackOnPhone}>
            <thead><tr><th>From</th><th>Split</th><th>Actions</th></tr></thead>
            <tbody>
              {allocations.map((allocation) => (
                <tr key={allocation.id}>
                  <td data-label="From">{formatDate(allocation.effectiveFrom)}</td>
                  <td data-label="Split">
                    {allocation.lines.map((line) => (
                      <div key={line.lineNumber}>{line.percentage}% {describeLine(line)}</div>
                    ))}
                  </td>
                  <td data-label="Actions">
                    <Button size="small" variant="secondary" onClick={() => startFrom(allocation)}>Copy to new</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No allocation yet.</Empty>}

      <form className={styles.stack} onSubmit={save}>
        <Field label="New allocation from">
          <input required type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
        </Field>
        {lines.map((line, index) => (
          <fieldset className={styles.stack} key={index}>
            <legend>Line {index + 1}</legend>
            <div className={ui.grid2}>
              <Field label="Percentage">
                <input inputMode="decimal" required value={line.percentage} onChange={(event) => changeLine(index, "percentage", event.target.value)} />
              </Field>
              {valueSelect(index, "department", "departmentId")}
              {valueSelect(index, "class", "classId")}
              {valueSelect(index, "location", "locationId")}
              <Field label="Project">
                <select value={line.projectId} onChange={(event) => changeLine(index, "projectId", event.target.value)}>
                  <option value="">None</option>
                  {(projects.data?.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </Field>
            </div>
            {lines.length > 1 ? (
              <div className={ui.actions}>
                <Button size="small" variant="secondary" onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>
                  Remove line {index + 1}
                </Button>
              </div>
            ) : null}
          </fieldset>
        ))}
        <p>
          Total: <strong>{total === null ? "—" : `${total}%`}</strong>
          {total !== null && !totalIsRight
            ? cmp(dec(total), dec("100")) < 0
              ? ` (${toFixedString(sub(dec("100"), dec(total)), 2)}% still to allocate)`
              : ` (${toFixedString(sub(dec(total), dec("100")), 2)}% too much)`
            : null}
        </p>
        <div className={ui.actions}>
          <Button disabled={busy} variant="secondary" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>Add a line</Button>
          <Button disabled={busy || !totalIsRight} type="submit">{busy ? "Saving…" : "Save allocation"}</Button>
        </div>
      </form>
    </Card>
  );
}
