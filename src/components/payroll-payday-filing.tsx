"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatMoney } from "@/lib/format";
import type { PaydayFilingSettings, PayRunPaydayFiling, PayRunPaydayFilingFile } from "@/lib/payroll/payday-filing-service";
import styles from "./payroll-employees.module.css";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function withWeekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${formatDate(date)}`;
}

/** Saves text as a file in the browser (the file is made on the server). */
function saveText(fileName: string, contentType: string, content: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pay run › Payday filing (PF1-PF6): make IRD's employment information
 * file to upload in myIR, and see when it's due. Making it posts nothing
 * and marks nothing as filed.
 */
export function PayRunPaydayFilingCard({ organisationId, payRunId }: { organisationId: string; payRunId: string }) {
  const loaded = useApiData<{ filing: PayRunPaydayFiling }>(`/api/payroll/pay-runs/${payRunId}/payday-filing`, { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (loaded.loading) return <Card title="Payday filing"><Empty>Loading…</Empty></Card>;
  if (loaded.error) return <Card title="Payday filing"><Notice tone="error">{loaded.error}</Notice></Card>;
  const filing = loaded.data?.filing;
  if (!filing) return null;

  const make = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ file: PayRunPaydayFilingFile }>(`/api/payroll/pay-runs/${payRunId}/payday-filing`, {
        method: "POST",
        body: { organisationId },
      });
      saveText(result.file.fileName, result.file.contentType, result.file.content);
      setMessage({
        tone: "success",
        text: `${result.file.fileName} saved: ${result.file.employeeLines} employee${result.file.employeeLines === 1 ? "" : "s"}, gross earnings ${formatMoney(result.file.totals.grossEarnings)}, deductions ${formatMoney(result.file.totals.amountsDeducted)}. Upload it in myIR (Employment information › file upload) by ${withWeekday(result.file.dueDate)}. Tohyee doesn't know whether it was filed; myIR does.`,
      });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Payday filing"
      description="IRD's employment information file for this pay run, to upload in myIR. Making it posts nothing."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <p>
        <strong>Due {withWeekday(filing.dueDate)}</strong>: within 2 working days after the pay date ({formatDate(filing.payDate)}) (Tax
        Administration Act s 23E). Working days leave out weekends, the national public holidays (not anniversary days) and 25 December to 15
        January.
      </p>
      {filing.settingsComplete ? null : (
        <Notice tone="warning">
          Set up payday filing first: an admin enters the employer&apos;s IRD number and the payroll contact under{" "}
          <Link href="/operations/payroll/pay-items">Payroll › Pay items</Link>.
        </Notice>
      )}
      {filing.starting.length > 0 ? (
        <Notice tone="info">
          Starting in this pay period: {filing.starting.map((person) => `${person.name} (${formatDate(person.startDate)})`).join(", ")}. IRD wants a new
          employee&apos;s details (their address, and date of birth if they gave it) by their first payday. Tohyee doesn&apos;t make the employee
          details file yet, so enter them in myIR.
        </Notice>
      ) : null}
      <div className={ui.actions}>
        <Button disabled={busy || !filing.settingsComplete} onClick={() => void make()}>
          Make employment information file
        </Button>
      </div>
      <p className={ui.muted}>
        Check a new file with myIR&apos;s &quot;Check your employment information file&quot; service the first time. Don&apos;t open it in Excel
        before uploading: IRD says Excel adds commas to each line.
      </p>
    </Card>
  );
}

/** Payroll › Pay items › Payday filing (PF7): the employer's IRD number and payroll contact for the file. */
export function PaydayFilingSettingsCard({ organisationId }: { organisationId: string }) {
  const loaded = useApiData<{ settings: PaydayFilingSettings }>("/api/payroll/payday-filing-settings", { organisationId });
  const me = useApiData<{ canManagePayrollAccess: boolean }>("/api/payroll/access/me", { organisationId });
  const isAdmin = me.data?.canManagePayrollAccess ?? false;
  const [form, setForm] = useState<{ employerIrdNumber: string; contactName: string; contactPhone: string; contactEmail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (loaded.loading) return <Card title="Payday filing"><Empty>Loading…</Empty></Card>;
  if (loaded.error) return <Card title="Payday filing"><Notice tone="error">{loaded.error}</Notice></Card>;
  const settings = loaded.data?.settings;
  if (!settings) return null;
  const values = form ?? {
    employerIrdNumber: settings.employerIrdNumber ?? "",
    contactName: settings.contactName ?? "",
    contactPhone: settings.contactPhone ?? "",
    contactEmail: settings.contactEmail ?? "",
  };
  const change = (field: keyof typeof values, value: string) => setForm({ ...values, [field]: value });

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/payroll/payday-filing-settings", { method: "PUT", body: { organisationId, ...values } });
      setMessage({ tone: "success", text: "Payday filing details saved." });
      setForm(null);
      loaded.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Payday filing" description="Who IRD contacts about the employment information files Tohyee makes. They go in each file's first line.">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <form className={styles.stack} onSubmit={save}>
        <div className={ui.grid2}>
          <Field label="Employer's IRD number" hint="Usually the same as the GST number.">
            <input disabled={!isAdmin} required value={values.employerIrdNumber} onChange={(event) => change("employerIrdNumber", event.target.value)} />
          </Field>
          <Field label="Payroll contact" hint="Up to 20 characters, no commas.">
            <input disabled={!isAdmin} maxLength={20} required value={values.contactName} onChange={(event) => change("contactName", event.target.value)} />
          </Field>
          <Field label="Contact's work phone" hint="Up to 12 digits.">
            <input disabled={!isAdmin} required type="tel" value={values.contactPhone} onChange={(event) => change("contactPhone", event.target.value)} />
          </Field>
          <Field label="Contact's email" hint="Up to 60 characters: letters, digits and @ - _ . only.">
            <input disabled={!isAdmin} maxLength={60} required type="email" value={values.contactEmail} onChange={(event) => change("contactEmail", event.target.value)} />
          </Field>
        </div>
        {isAdmin ? (
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Save payday filing details</Button>
          </div>
        ) : (
          <p className={ui.muted}>Only admins can change these.</p>
        )}
      </form>
    </Card>
  );
}
