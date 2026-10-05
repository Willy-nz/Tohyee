"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useApiData } from "@/components/hooks";
import { OrganisationLogo } from "@/components/organisation/logo";
import { PrintButton } from "@/components/reports/ledger-reports";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney, todayInBrowser } from "@/lib/format";
import type { BankFileSettings, PayRunBankFile } from "@/lib/payroll/bank-file-service";
import { payslipLayout } from "@/lib/payroll/payslip-layout";
import type { Payslip, PayslipSummary } from "@/lib/payroll/payslips";
import styles from "./payroll-employees.module.css";

/** Saves text as a file in the browser (the bank file, made on the server). */
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
 * Pay run › Bank file (PBF1-PBF6): make the direct credit file of the net
 * wages still to pay, for the chosen bank account's bank, then record the
 * payment below once it's uploaded. Making a file posts nothing.
 */
export function PayRunBankFileCard({ organisationId, payRunId, payDate }: { organisationId: string; payRunId: string; payDate: string }) {
  const settings = useApiData<BankFileSettings>("/api/payroll/bank-file-settings", { organisationId });
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(() => (todayInBrowser() > payDate ? todayInBrowser() : payDate));
  const [statementLines, setStatementLines] = useState<"one" | "each">("one");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);

  const ready = (settings.data?.accounts ?? []).filter((account) => account.format !== null);
  const chosen = ready.find((account) => account.code === accountCode) ?? ready[0] ?? null;

  const make = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ file: PayRunBankFile }>(`/api/payroll/pay-runs/${payRunId}/bank-file`, {
        method: "POST",
        body: { organisationId, bankAccountCode: chosen.code, dueDate, statementLines },
      });
      saveText(result.file.fileName, result.file.contentType, result.file.content);
      setMessage({
        tone: result.file.warnings.length > 0 ? "warning" : "success",
        text: [
          `${result.file.fileName} saved: ${result.file.count} payment${result.file.count === 1 ? "" : "s"}, ${formatMoney(result.file.total)}, hash total ${result.file.hashTotal}. Upload it in your bank's business internet banking, then record the payment below. Nothing is marked paid until you do.`,
          ...result.file.warnings,
        ].join(" "),
      });
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Bank file"
      description="Step 1: make a direct credit file of the net pay still to pay, to upload in your bank. Step 2: record it as paid under Wages paid."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {settings.error ? <Notice tone="error">{settings.error}</Notice> : null}
      {settings.data && ready.length === 0 ? (
        <Notice tone="warning">
          No bank account is set up for bank files yet. An admin enters its account number and bank under{" "}
          <Link href="/operations/settings/bank-files">Settings › Bank files</Link>.
        </Notice>
      ) : null}
      {chosen ? (
        <form className={styles.stack} onSubmit={make}>
          <div className={ui.grid3}>
            <Field label="From">
              <select value={chosen.code} onChange={(event) => setAccountCode(event.target.value)}>
                {ready.map((account) => (
                  <option key={account.code} value={account.code}>
                    {account.code} · {account.name} ({account.formatLabel})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Due date" hint="The day the bank pays it.">
              <input required type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            </Field>
            {chosen.format === "bnz_ib4b" ? (
              <Field label="On your statement">
                <select value={statementLines} onChange={(event) => setStatementLines(event.target.value as "one" | "each")}>
                  <option value="one">One line for the whole file</option>
                  <option value="each">A line for each employee</option>
                </select>
              </Field>
            ) : null}
          </div>
          <div className={ui.actions}>
            <Button disabled={busy} type="submit">Make bank file</Button>
          </div>
        </form>
      ) : null}
      {settings.data ? (
        <p className={ui.muted}>
          Tohyee makes ANZ, ASB and BNZ files. {settings.data.refused.map((bank) => bank.bank).join(" and ")}: not supported yet, because they don&apos;t publish their file layouts.
        </p>
      ) : null}
    </Card>
  );
}

function EmailStatus({ email }: { email: PayslipSummary["lastEmail"] }) {
  if (!email) return <span className={ui.muted}>Not emailed</span>;
  if (email.status === "sent") return <Badge tone="green">Emailed {formatDateTime(email.createdAt)}</Badge>;
  if (email.status === "failed") return <Badge tone="red">Failed: {email.lastError ?? "not sent"}</Badge>;
  return <Badge tone="neutral">Sending</Badge>;
}

/** Pay run › Payslips (PSLIP1-PSLIP5): view, PDF and email each employee's payslip, or email them all. */
export function PayRunPayslips({ organisationId, payRunId }: { organisationId: string; payRunId: string }) {
  const loaded = useApiData<{ reference: string; payslips: PayslipSummary[] }>(`/api/payroll/pay-runs/${payRunId}/payslips`, { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);

  if (loaded.loading) return <Card title="Payslips"><Empty>Loading…</Empty></Card>;
  if (loaded.error) return <Card title="Payslips"><Notice tone="error">{loaded.error}</Notice></Card>;
  if (!loaded.data) return null;

  const email = async (employeeIds?: string[]) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ emails: Array<{ name: string }>; skipped: Array<{ reason: string }> }>(`/api/payroll/pay-runs/${payRunId}/payslips`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: newIdempotencyKey("payslips"), ...(employeeIds ? { employeeIds } : {}) },
      });
      const sent = `Emailing ${result.emails.map((entry) => entry.name).join(", ")}.`;
      setMessage(result.skipped.length ? { tone: "warning", text: `${sent} ${result.skipped.map((entry) => entry.reason).join(" ")}` } : { tone: "success", text: sent });
      loaded.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  const pdf = (employeeId: string) => `/api/payroll/pay-runs/${payRunId}/payslips/${employeeId}/pdf?organisationId=${encodeURIComponent(organisationId)}&download=true`;

  return (
    <Card
      title="Payslips"
      description="Each employee's payslip, with the year to date. Emails go from your organisation's email account with the PDF attached; the email itself shows no pay figures."
      actions={<Button disabled={busy} size="small" onClick={() => void email()}>Email all</Button>}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.stackOnPhone}>
          <thead><tr><th>Employee</th><th>Net pay</th><th>Email</th><th /></tr></thead>
          <tbody>
            {loaded.data.payslips.map((entry) => (
              <tr key={entry.employeeId}>
                <td data-label="Employee">
                  <Link href={`/operations/payroll/pay-runs/${payRunId}/payslips/${entry.employeeId}`}>{entry.name}</Link>
                </td>
                <td data-label="Net pay">{formatMoney(entry.netPay)}</td>
                <td data-label="Email">{entry.hasEmail ? <EmailStatus email={entry.lastEmail} /> : <span className={ui.muted}>No email address</span>}</td>
                <td>
                  <span className={ui.actions}>
                    <a href={pdf(entry.employeeId)}>PDF</a>
                    {entry.hasEmail ? (
                      <Button disabled={busy} size="small" variant="secondary" onClick={() => void email([entry.employeeId])}>Email</Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Rows({ heading, rows, total }: { heading: string; rows: Array<[string, string]>; total?: [string, string] }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead><tr><th>{heading}</th><th className={ui.num}>Amount</th></tr></thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}><td>{label}</td><td className={ui.num}>{value}</td></tr>
          ))}
        </tbody>
        {total ? (
          <tfoot><tr><th>{total[0]}</th><th className={ui.num}>{total[1]}</th></tr></tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** One payslip as it prints (PSLIP1-PSLIP4), from the same layout as the PDF. */
export function PayslipView({ organisationId, payRunId, employeeId }: { organisationId: string; payRunId: string; employeeId: string }) {
  const loaded = useApiData<{ payslip: Payslip }>(`/api/payroll/pay-runs/${payRunId}/payslips/${employeeId}`, { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const payslip = loaded.data.payslip;
  const layout = payslipLayout(payslip);
  const pdf = `/api/payroll/pay-runs/${payRunId}/payslips/${employeeId}/pdf?organisationId=${encodeURIComponent(organisationId)}&download=true`;
  return (
    <>
      <div data-print="hide">
        <Card
          title={`Payslip: ${payslip.employee.name}`}
          description={`${payslip.payRunReference}, paid ${formatDate(payslip.payDate)}.`}
          actions={
            <>
              <PrintButton />
              <a href={pdf}>Download PDF</a>
              <Link href={`/operations/payroll/pay-runs/${payRunId}`}>Back to the pay run</Link>
            </>
          }
        >
          <span />
        </Card>
      </div>
      <article className={ui.reportPaper}>
        <header className={ui.reportPaperHeader} style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div>
            <OrganisationLogo organisationId={organisationId} />
            <h2 className={ui.reportPaperTitle}>{layout.title}</h2>
          </div>
          <div style={{ whiteSpace: "pre-line" }}>
            <strong>{payslip.employer.name}</strong>
            {payslip.employer.postalAddress ? `\n${payslip.employer.postalAddress}` : ""}
          </div>
        </header>
        <dl style={{ margin: "0 0 16px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px" }}>
          {layout.details.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt className={ui.muted}>{label}</dt>
              <dd style={{ margin: 0 }}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead><tr><th>Earnings</th><th className={ui.num}>Hours</th><th className={ui.num}>Rate</th><th className={ui.num}>Amount</th></tr></thead>
            <tbody>
              {layout.earnings.map((row, index) => (
                <tr key={`${row.label}-${index}`}>
                  <td data-label="Earnings">{row.label}</td>
                  <td data-label="Hours" className={ui.num}>{row.hours}</td>
                  <td data-label="Rate" className={ui.num}>{row.rate}</td>
                  <td data-label="Amount" className={ui.num}>{row.amount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>{layout.gross.label}</th><th className={ui.num}>{layout.gross.hours}</th><th /><th className={ui.num}>{layout.gross.amount}</th></tr>
            </tfoot>
          </table>
        </div>
        <Rows heading="Deductions" rows={layout.deductions} total={["Net pay", layout.netPay]} />
        {layout.employer.length ? <Rows heading="Paid by your employer" rows={layout.employer} /> : null}
        <Rows heading={layout.yearToDateHeading} rows={layout.yearToDate} />
        {layout.leave.length > 0 ? <Rows heading={layout.leaveHeading} rows={layout.leave} /> : null}
        {layout.notes.map((note) => (
          <p key={note} className={ui.muted}>{note}</p>
        ))}
      </article>
    </>
  );
}

/** Settings › Bank files (PBF7): each bank account's number and bank file format. Admins change them. */
export function BankFileSettingsView({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const loaded = useApiData<BankFileSettings>("/api/payroll/bank-file-settings", { organisationId });
  const [drafts, setDrafts] = useState<Record<string, { format: string; accountNumber: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const data = loaded.data;

  const save = async (accountId: string, code: string) => {
    const draft = drafts[accountId];
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("/api/payroll/bank-file-settings", {
        method: "PUT",
        body: { organisationId, accountId, format: draft.format || null, accountNumber: draft.accountNumber },
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      setMessage({ tone: "success", text: `${code} saved.` });
      loaded.reload();
    } catch (cause) {
      setMessage({ tone: "error", text: errorMessage(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Bank accounts"
      description="Pay runs make a direct credit file of the wages to pay in the bank's own format. Enter the account number and choose the bank for each account wages are paid from."
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {data.accounts.length === 0 ? <Empty>There are no bank accounts in NZD.</Empty> : null}
      <div className={styles.stack}>
        {data.accounts.map((account) => {
          const draft = drafts[account.accountId] ?? { format: account.format ?? "", accountNumber: account.accountNumber ?? "" };
          const change = (patch: Partial<typeof draft>) => setDrafts((current) => ({ ...current, [account.accountId]: { ...draft, ...patch } }));
          return (
            <form
              key={account.accountId}
              className={ui.grid3}
              onSubmit={(event) => {
                event.preventDefault();
                void save(account.accountId, account.code);
              }}
            >
              <Field label={`${account.code} · ${account.name}`} hint={account.updatedByEmail ? `Changed by ${account.updatedByEmail}` : undefined}>
                <select disabled={!canEdit} value={draft.format} onChange={(event) => change({ format: event.target.value })}>
                  <option value="">No bank files</option>
                  {data.formats.map((format) => (
                    <option key={format.format} value={format.format}>{format.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Account number" hint="Like 12-3456-0123456-00.">
                <input
                  disabled={!canEdit || !draft.format}
                  inputMode="numeric"
                  value={draft.accountNumber}
                  onChange={(event) => change({ accountNumber: event.target.value })}
                />
              </Field>
              {canEdit ? (
                <div className={ui.actions} style={{ alignSelf: "end" }}>
                  <Button disabled={busy || !drafts[account.accountId]} type="submit" variant="secondary">Save</Button>
                </div>
              ) : null}
            </form>
          );
        })}
      </div>
      {!canEdit ? <p className={ui.muted}>Only admins can change these.</p> : null}
      {data.refused.map((bank) => (
        <p key={bank.bank} className={ui.muted}>{bank.bank}: {bank.reason}</p>
      ))}
    </Card>
  );
}
