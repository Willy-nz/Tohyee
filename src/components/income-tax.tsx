"use client";

import { type FormEvent, useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, personName } from "@/lib/format";
import { EXPENSE_TREATMENTS, INCOME_TREATMENTS, incomeYearLabel, TAXPAYER_TYPE_LABELS, TREATMENT_LABELS, type TaxpayerType, type Treatment } from "@/lib/tax/income/rules";
import type { IncomeTaxReport, IncomeTaxSettings, IncomeTaxYear, ReportAccount, TaxPayment } from "@/lib/tax/income/service";

/**
 * Income tax, stage 1 (examples ITX1-ITX10, decision 545): taxable income
 * from the books and the overall budget, standard provisional tax,
 * end-of-year tax and due dates, with IRD's figures typed in. Owners and
 * admins only. Nothing here posts, files, pays or elects anything.
 */

/** "-140.00" for "140.00"; nothing stays "0.00". */
function negated(value: string): string {
  if (/^-?0*(\.0*)?$/.test(value)) return value.replace(/^-/, "");
  return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

type Status = { tone: "success" | "error"; text: string } | null;
type Supported = Extract<IncomeTaxReport, { supported: true }>;

function Settings({ organisationId, settings, onSaved }: { organisationId: string; settings: IncomeTaxSettings; onSaved: () => void }) {
  const [type, setType] = useState<TaxpayerType | "">(settings.taxpayerType ?? "");
  const [extension, setExtension] = useState(settings.agentExtension);
  const [status, setStatus] = useState<Status>(null);
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/settings", { method: "PUT", body: { organisationId, taxpayerType: type, agentExtension: extension, version: settings.version } });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card title="Taxpayer" description="Who pays the tax, and whether a tax agent's extension of time moves end-of-year tax to 7 April.">
      <form className={ui.inlineForm} onSubmit={save}>
        <Field label="This organisation is">
          <select value={type} onChange={(event) => setType(event.target.value as TaxpayerType | "")} required>
            <option value="">Choose…</option>
            {(Object.keys(TAXPAYER_TYPE_LABELS) as TaxpayerType[]).map((value) => (
              <option key={value} value={value}>
                {TAXPAYER_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={extension} onChange={(event) => setExtension(event.target.checked)} /> A tax agent with an extension of time files the return
        </label>
        <Button type="submit">Save</Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}

function TreatmentCell({ organisationId, account, onSaved }: { organisationId: string; account: ReportAccount; onSaved: () => void }) {
  const [treatment, setTreatment] = useState<Treatment>(account.treatment);
  const [percent, setPercent] = useState(account.businessUsePercent ?? "");
  const [error, setError] = useState<string | null>(null);
  const choices = account.side === "income" ? INCOME_TREATMENTS : EXPENSE_TREATMENTS;
  async function save(next: Treatment, nextPercent: string) {
    try {
      setError(null);
      await api("/api/income-tax/treatments", { method: "PUT", body: { organisationId, accountId: account.accountId, treatment: next, businessUsePercent: next === "business_use" ? nextPercent : undefined } });
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  return (
    <>
      <select
        aria-label={`Tax treatment of ${account.code} ${account.name}`}
        value={treatment}
        onChange={(event) => {
          const next = event.target.value as Treatment;
          setTreatment(next);
          if (next !== "business_use") void save(next, "");
        }}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {TREATMENT_LABELS[choice]}
          </option>
        ))}
      </select>
      {treatment === "business_use" ? (
        <span>
          {" "}
          <input aria-label={`Business use % of ${account.code}`} inputMode="decimal" size={5} value={percent} onChange={(event) => setPercent(event.target.value)} />%{" "}
          <Button size="small" variant="secondary" onClick={() => void save("business_use", percent)}>
            Save
          </Button>
        </span>
      ) : null}
      {error ? <div className={ui.error}>{error}</div> : null}
    </>
  );
}

function Workpaper({ organisationId, report, onSaved }: { organisationId: string; report: Supported; onSaved: () => void }) {
  const paper = report.workpaper;
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("tax-adj"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/adjustments", { method: "POST", body: { organisationId, idempotencyKey: key, incomeYear: report.incomeYear, description, amount } });
      setDescription("");
      setAmount("");
      setKey(newIdempotencyKey("tax-adj"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/adjustments/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const typedIds = new Map(report.adjustments.map((entry) => [entry.description + "|" + entry.amount, entry.id]));
  const showBudget = report.budgetFrom !== null;
  return (
    <Card
      title="Taxable income"
      description={
        report.actualsTo
          ? `Actuals to ${formatDate(report.actualsTo)}${showBudget ? `, then the ${report.budgetName ?? "overall budget"} from ${formatDate(report.budgetFrom!)}` : ""}. Change how an account counts for tax in the Treatment column.`
          : `The ${report.budgetName ?? "overall budget"} for the whole year (nothing's happened yet).`
      }
    >
      {report.accounts.length === 0 ? (
        <Empty>No income or expenses for this year yet.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={ui.num}>Actual</th>
                {showBudget ? <th className={ui.num}>Budget</th> : null}
                <th className={ui.num}>For the year</th>
                <th>Treatment</th>
                <th className={ui.num}>Tax adjustment</th>
              </tr>
            </thead>
            <tbody>
              {report.accounts.map((account) => (
                <tr key={account.accountId}>
                  <td data-label="Account">
                    {account.code} {account.name} <span className={ui.muted}>({account.side})</span>
                  </td>
                  <td data-label="Actual" className={ui.num}>
                    <Money value={account.actual} blankZero />
                  </td>
                  {showBudget ? (
                    <td data-label="Budget" className={ui.num}>
                      <Money value={account.budget} blankZero />
                    </td>
                  ) : null}
                  <td data-label="For the year" className={ui.num}>
                    <Money value={account.total} />
                  </td>
                  <td data-label="Treatment">
                    <TreatmentCell key={`${account.accountId}-${account.treatment}-${account.businessUsePercent}`} organisationId={organisationId} account={account} onSaved={onSaved} />
                  </td>
                  <td data-label="Tax adjustment" className={ui.num}>
                    <Money value={account.adjustment} blankZero />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <table className={ui.reportTable}>
        <tbody>
          <tr className={ui.reportTotal}>
            <td>Net profit</td>
            <td className={ui.num}>
              <Money value={paper.netProfit} />
            </td>
          </tr>
          {paper.adjustments.map((entry, index) => {
            const typedId = entry.accountId === null ? typedIds.get(entry.description + "|" + entry.amount) : undefined;
            return (
              <tr key={`${entry.description}-${index}`}>
                <td>
                  {entry.description}{" "}
                  {typedId ? (
                    <>
                      <Badge>Typed</Badge>{" "}
                      <button type="button" className={ui.linkButton} onClick={() => void remove(typedId)}>
                        Remove
                      </button>
                    </>
                  ) : null}
                </td>
                <td className={ui.num}>
                  <Money value={entry.amount} />
                </td>
              </tr>
            );
          })}
          {report.settings.taxpayerType === "individual" ? (
            <tr>
              <td>Other income (typed)</td>
              <td className={ui.num}>
                <Money value={paper.otherIncome} />
              </td>
            </tr>
          ) : null}
          <tr className={ui.reportTotal}>
            <td>Taxable income before losses</td>
            <td className={ui.num}>
              <Money value={paper.beforeLosses} />
            </td>
          </tr>
          <tr>
            <td>
              Losses brought forward used (of <Money value={paper.lossesBroughtForward} />)
            </td>
            <td className={ui.num}>
              <Money value={negated(paper.lossesUsed)} />
            </td>
          </tr>
          <tr className={ui.reportTotal}>
            <td>Taxable income</td>
            <td className={ui.num}>
              <Money value={paper.taxableIncome} />
            </td>
          </tr>
          <tr>
            <td>Tax</td>
            <td className={ui.num}>
              <Money value={paper.tax} />
            </td>
          </tr>
          <tr>
            <td>Tax credits (typed)</td>
            <td className={ui.num}>
              <Money value={negated(paper.taxCredits)} />
            </td>
          </tr>
          <tr className={ui.reportTotal}>
            <td>Residual income tax (RIT)</td>
            <td className={ui.num}>
              <Money value={paper.rit} />
            </td>
          </tr>
          <tr>
            <td>Loss carried forward</td>
            <td className={ui.num}>
              <Money value={paper.lossCarriedForward} />
            </td>
          </tr>
        </tbody>
      </table>
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Other adjustment" hint="For example, holiday pay not paid within 63 days. Positive adds to taxable income; negative takes off.">
          <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} required />
        </Field>
        <Field label="Amount">
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        </Field>
        <Button type="submit" variant="secondary">
          Add adjustment
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}

function YearFigures({ organisationId, incomeYear, type, years, onSaved }: { organisationId: string; incomeYear: number; type: TaxpayerType; years: number[]; onSaved: () => void }) {
  const [year, setYear] = useState(incomeYear);
  const loaded = useApiData<{ report: IncomeTaxReport }>("/api/income-tax", { organisationId, incomeYear: year });
  const report = loaded.data?.report;
  return (
    <Card title="IRD's figures" description="Type what IRD has for a year: they're kept as typed, with who typed them. Last year's assessed RIT and filing date set this year's provisional tax.">
      <Field label="Income year">
        <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
          {years.map((value) => (
            <option key={value} value={value}>
              {incomeYearLabel(value)}
            </option>
          ))}
        </select>
      </Field>
      {report && report.supported ? (
        <>
          <YearForm key={`${year}-${report.typed.version}`} organisationId={organisationId} typed={report.typed} type={type} onSaved={() => { loaded.reload(); onSaved(); }} />
          <Payments key={`p-${year}`} organisationId={organisationId} incomeYear={year} payments={report.payments} total={report.paidTotal} onSaved={() => { loaded.reload(); onSaved(); }} />
        </>
      ) : loaded.error ? (
        <Notice tone="error">{loaded.error}</Notice>
      ) : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}

function YearForm({ organisationId, typed, type, onSaved }: { organisationId: string; typed: IncomeTaxYear; type: TaxpayerType; onSaved: () => void }) {
  const [form, setForm] = useState({
    assessedRit: typed.assessedRit ?? "",
    returnFiledOn: typed.returnFiledOn ?? "",
    lossesBroughtForward: typed.lossesBroughtForward,
    taxCredits: typed.taxCredits,
    otherIncome: typed.otherIncome,
  });
  const [status, setStatus] = useState<Status>(null);
  const set = (name: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/years", { method: "PUT", body: { organisationId, incomeYear: typed.incomeYear, ...form, version: typed.version } });
      setStatus({ tone: "success", text: "Saved." });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <form onSubmit={save}>
      <div className={ui.grid}>
        <Field label="Assessed RIT (from IRD)" hint="Leave blank until the return's filed and assessed.">
          <input inputMode="decimal" value={form.assessedRit} onChange={(event) => set("assessedRit")(event.target.value)} />
        </Field>
        <Field label="Return filed on">
          <DateInput value={form.returnFiledOn} onChange={(event) => set("returnFiledOn")(event.target.value)} />
        </Field>
        <Field label="Losses brought forward">
          <input inputMode="decimal" value={form.lossesBroughtForward} onChange={(event) => set("lossesBroughtForward")(event.target.value)} />
        </Field>
        <Field label="Tax credits" hint="PAYE, RWT and imputation credits for the year.">
          <input inputMode="decimal" value={form.taxCredits} onChange={(event) => set("taxCredits")(event.target.value)} />
        </Field>
        {type === "individual" ? (
          <Field label="Other income" hint="Wages, interest, dividends and other income outside the business.">
            <input inputMode="decimal" value={form.otherIncome} onChange={(event) => set("otherIncome")(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <Button type="submit">Save figures</Button>
      {typed.updatedByEmail ? (
        <span className={ui.muted}>
          {" "}
          Typed by {personName(typed, "updatedBy")}
        </span>
      ) : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}

function Payments({ organisationId, incomeYear, payments, total, onSaved }: { organisationId: string; incomeYear: number; payments: TaxPayment[]; total: string; onSaved: () => void }) {
  const [form, setForm] = useState({ paidOn: "", amount: "", note: "" });
  const [key, setKey] = useState(() => newIdempotencyKey("tax-pay"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/payments", { method: "POST", body: { organisationId, idempotencyKey: key, incomeYear, ...form } });
      setForm({ paidOn: "", amount: "", note: "" });
      setKey(newIdempotencyKey("tax-pay"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/payments/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <>
      <h3>Payments to IRD towards the {incomeYear} income year</h3>
      {payments.length === 0 ? (
        <Empty>None typed yet.</Empty>
      ) : (
        <ul>
          {payments.map((payment) => (
            <li key={payment.id}>
              {formatDate(payment.paidOn)} · <Money value={payment.amount} />
              {payment.note ? ` · ${payment.note}` : ""}{" "}
              <button type="button" className={ui.linkButton} onClick={() => void remove(payment.id)}>
                Remove
              </button>
            </li>
          ))}
          <li>
            <strong>
              Total <Money value={total} />
            </strong>
          </li>
        </ul>
      )}
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Paid on">
          <DateInput value={form.paidOn} onChange={(event) => setForm((current) => ({ ...current, paidOn: event.target.value }))} required />
        </Field>
        <Field label="Amount">
          <input inputMode="decimal" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} required />
        </Field>
        <Field label="Note">
          <input value={form.note} maxLength={200} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} />
        </Field>
        <Button type="submit" variant="secondary">
          Add payment
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </>
  );
}

function Provisional({ report }: { report: Supported }) {
  const schedule = report.provisional;
  return (
    <Card
      title="Provisional tax (standard option)"
      description={`Based on the ${report.lastYear.incomeYear} income year's RIT${report.lastYear.rit ? ` of ${formatMoney(report.lastYear.rit)}` : ""} (${report.lastYear.typed ? "typed from IRD" : "Tohyee estimate"}). Showing this isn't choosing an option with IRD.`}
    >
      {schedule.kind === "schedule" ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Instalment</th>
                <th>Due</th>
                <th className={ui.num}>Amount</th>
                <th>How it&apos;s worked out</th>
              </tr>
            </thead>
            <tbody>
              {schedule.instalments.map((instalment) => (
                <tr key={instalment.number}>
                  <td data-label="Instalment">{instalment.number}</td>
                  <td data-label="Due">
                    {formatDate(instalment.dueDate)}
                    {instalment.onTimeBy.date !== instalment.dueDate ? <span className={ui.muted}> (on time by {formatDate(instalment.onTimeBy.date)})</span> : null}
                  </td>
                  <td data-label="Amount" className={ui.num}>
                    <Money value={instalment.amount} /> {instalment.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                  </td>
                  <td data-label="How">{instalment.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {schedule.notes.map((text) => (
        <Notice key={text} tone={schedule.kind === "unknown" ? "warning" : "info"}>
          {text}
        </Notice>
      ))}
    </Card>
  );
}

function Report({ organisationId, report, reload }: { organisationId: string; report: Supported; reload: () => void }) {
  return (
    <>
      <div className={ui.statRow}>
        <Stat label="Taxable income" value={<Money value={report.workpaper.taxableIncome} />} />
        <Stat label="Tax" value={<Money value={report.workpaper.tax} />} />
        <Stat label="Residual income tax" value={<Money value={report.workpaper.rit} />} />
        <Stat label="Provisional tax" value={<Money value={report.endOfYear.provisional} />} />
        <Stat label={Number(report.endOfYear.amount) < 0 ? "Expected refund" : "Expected end-of-year tax"} value={<Money value={report.endOfYear.amount.replace(/^-/, "")} />} />
      </div>
      <Card title="Due dates" description="Payments to IRD for this year and last year's end-of-year tax. A date on a weekend or public holiday is on time the next business day.">
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Due</th>
                <th>What</th>
                <th className={ui.num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {report.dueDates.map((entry) => (
                <tr key={entry.key}>
                  <td data-label="Due">
                    {formatDate(entry.dueDate)}
                    {entry.onTimeBy.date !== entry.dueDate ? <span className={ui.muted}> (on time by {formatDate(entry.onTimeBy.date)})</span> : null}
                  </td>
                  <td data-label="What">{entry.label}</td>
                  <td data-label="Amount" className={ui.num}>
                    {entry.amount === null ? <span className={ui.muted}>Not known yet</span> : <Money value={entry.amount} />} {entry.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Workpaper organisationId={organisationId} report={report} onSaved={reload} />
      <Provisional report={report} />
      <YearFigures organisationId={organisationId} incomeYear={report.incomeYear} type={report.settings.taxpayerType} years={report.years} onSaved={reload} />
      <Card title="Notes">
        <ul>
          {report.notes.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function IncomeTaxView({ organisationId }: { organisationId: string }) {
  const [incomeYear, setIncomeYear] = useState<number | null>(null);
  const loaded = useApiData<{ report: IncomeTaxReport }>("/api/income-tax", { organisationId, incomeYear });
  const report = loaded.data?.report;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!report) return <p className={ui.muted}>Loading…</p>;
  return (
    <>
      <div className={ui.toolbar}>
        <Field label="Income year">
          <select value={report.incomeYear} onChange={(event) => setIncomeYear(Number(event.target.value))}>
            {report.years.map((value) => (
              <option key={value} value={value}>
                {incomeYearLabel(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Notice tone="warning">
        These figures follow IRD&apos;s published rules as Tohyee reads them. They haven&apos;t been reviewed by an accountant yet, so check them before relying on them. Nothing here files a return or pays IRD.
      </Notice>
      {report.supported ? <Report organisationId={organisationId} report={report} reload={loaded.reload} /> : <Notice tone="info">{report.reason}</Notice>}
      <Settings key={`${report.settings.version}`} organisationId={organisationId} settings={report.settings} onSaved={loaded.reload} />
    </>
  );
}
