"use client";

import { type FormEvent, Fragment, useState } from "react";
import { DateInput } from "@/components/date-input";
import { Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, personName } from "@/lib/format";
import { ALLOCATION_STATUS_LABELS, ALLOCATION_STATUSES, type AllocationStatus, EXPENSE_TREATMENTS, INCOME_TREATMENTS, incomeYearLabel, TAXPAYER_TYPE_LABELS, TREATMENT_LABELS, type TaxpayerType, type Treatment } from "@/lib/tax/income/rules";
import type { TaxAsset } from "@/lib/tax/income/assets";
import type { Ir10, Ir10Account } from "@/lib/tax/income/ir10";
import type { Ica } from "@/lib/tax/income/ica";
import { IR3_BOX_LABELS, IR3_BOXES } from "@/lib/tax/income/ir3";
import { IR4_BOX_LABELS, IR4_BOXES } from "@/lib/tax/income/ir4";
import type { BookPayments as BookPaymentsData } from "@/lib/tax/income/book-payments";
import { APPLIES_TO, APPLIES_TO_LABELS, type AppliesToKey, type TaxAllocation } from "@/lib/tax/income/allocation-kinds";
import type { IrdDocument, IrdProposal } from "@/lib/tax/income/ird-documents";
import { postForm } from "@/components/rd";
import { IrdImports } from "@/components/ird-imports";
import { ICA_KIND_LABELS, ICA_KINDS, type IcaKind } from "@/lib/tax/income/ica-kinds";
import { IR10_BOX_LABELS, IR10_ROLE_LABELS } from "@/lib/tax/income/ir10-boxes";
import { TAX_DEPRECIATION_METHOD_LABELS, TAX_DEPRECIATION_METHODS, type TaxDepreciationMethod } from "@/lib/tax/income/depreciation";
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
          {paper.overseasTaxPaid !== "0.00" ? (
            <tr>
              <td>Overseas tax paid (typed; not below nil)</td>
              <td className={ui.num}>
                <Money value={negated(paper.overseasTaxPaid)} />
              </td>
            </tr>
          ) : null}
          {paper.imputationCredits !== "0.00" ? (
            <tr>
              <td>Imputation credits received (typed; not below nil)</td>
              <td className={ui.num}>
                <Money value={negated(paper.imputationCredits)} />
              </td>
            </tr>
          ) : null}
          <tr>
            <td>Tax credits: RWT, PAYE and others (typed)</td>
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
            <td>Loss carried forward{paper.imputationLoss !== "0.00" ? ` (including ${formatMoney(paper.imputationLoss)} from excess imputation credits)` : ""}</td>
            <td className={ui.num}>
              <Money value={paper.lossCarriedForward} />
            </td>
          </tr>
          {paper.excessImputationCredits !== "0.00" && paper.imputationLoss === "0.00" ? (
            <tr>
              <td>Excess imputation credits carried forward</td>
              <td className={ui.num}>
                <Money value={paper.excessImputationCredits} />
              </td>
            </tr>
          ) : null}
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

function YearFigures({ organisationId, incomeYear, type, years, endMonth, onSaved }: { organisationId: string; incomeYear: number; type: TaxpayerType; years: number[]; endMonth: number; onSaved: () => void }) {
  const [year, setYear] = useState(incomeYear);
  const loaded = useApiData<{ report: IncomeTaxReport }>("/api/income-tax", { organisationId, incomeYear: year });
  const report = loaded.data?.report;
  return (
    <Card title="IRD's figures" description="Type what IRD has for a year: they're kept as typed, with who typed them. Last year's assessed RIT and filing date set this year's provisional tax.">
      <Field label="Income year">
        <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
          {years.map((value) => (
            <option key={value} value={value}>
              {incomeYearLabel(value, endMonth)}
            </option>
          ))}
        </select>
      </Field>
      {report && report.supported ? (
        <>
          <YearForm key={`${year}-${report.typed.version}`} organisationId={organisationId} typed={report.typed} type={type} lastYearExcess={report.lastYearExcessImputation} onSaved={() => { loaded.reload(); onSaved(); }} />
          <Payments key={`p-${year}`} organisationId={organisationId} incomeYear={year} payments={report.payments} total={report.paidTotal} instalmentCount={report.provisional.kind === "schedule" ? report.provisional.instalments.length : 3} onSaved={() => { loaded.reload(); onSaved(); }} />
        </>
      ) : loaded.error ? (
        <Notice tone="error">{loaded.error}</Notice>
      ) : (
        <p className={ui.muted}>Loading…</p>
      )}
    </Card>
  );
}

function YearForm({ organisationId, typed, type, lastYearExcess, onSaved }: { organisationId: string; typed: IncomeTaxYear; type: TaxpayerType; lastYearExcess: string | null; onSaved: () => void }) {
  const [form, setForm] = useState({
    assessedRit: typed.assessedRit ?? "",
    returnFiledOn: typed.returnFiledOn ?? "",
    lossesBroughtForward: typed.lossesBroughtForward,
    taxCredits: typed.taxCredits,
    imputationCredits: typed.imputationCredits,
    overseasTaxPaid: typed.overseasTaxPaid,
    imputationBroughtForward: typed.imputationBroughtForward,
    otherIncome: typed.otherIncome,
    multipleActivity: typed.multipleActivity,
  });
  const [status, setStatus] = useState<Status>(null);
  const set = (name: Exclude<keyof typeof form, "multipleActivity">) => (value: string) => setForm((current) => ({ ...current, [name]: value }));
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
        <Field label="Tax credits" hint="PAYE, RWT and other credits that are refunded if more than the tax. Not imputation credits or overseas tax.">
          <input inputMode="decimal" value={form.taxCredits} onChange={(event) => set("taxCredits")(event.target.value)} />
        </Field>
        <Field label="Imputation credits received" hint="On dividends received. They can bring the tax to nil but aren't refunded.">
          <input inputMode="decimal" value={form.imputationCredits} onChange={(event) => set("imputationCredits")(event.target.value)} />
        </Field>
        <Field label="Overseas tax paid" hint="Tax paid overseas on overseas income. It can bring the tax to nil but isn't refunded.">
          <input inputMode="decimal" value={form.overseasTaxPaid} onChange={(event) => set("overseasTaxPaid")(event.target.value)} />
        </Field>
        {type === "individual" ? (
          <Field
            label="Excess imputation credits brought forward"
            hint={`From IRD's excess imputation credits letter for last year (IR3 box 34).${lastYearExcess ? ` Tohyee works out ${formatMoney(lastYearExcess)} from last year's books.` : ""}`}
          >
            <input inputMode="decimal" value={form.imputationBroughtForward} onChange={(event) => set("imputationBroughtForward")(event.target.value)} />
          </Field>
        ) : null}
        {type === "individual" ? (
          <Field label="Other income" hint="Wages, interest, dividends and other income outside the business.">
            <input inputMode="decimal" value={form.otherIncome} onChange={(event) => set("otherIncome")(event.target.value)} />
          </Field>
        ) : null}
      </div>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={form.multipleActivity} onChange={(event) => setForm((current) => ({ ...current, multipleActivity: event.target.checked }))} /> More than one line of business (IR10 box 1)
      </label>
      <div>
        <Button type="submit">Save figures</Button>
      </div>
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

const STATUS_TONES: Record<AllocationStatus, "green" | "blue" | "amber"> = { confirmed: "green", evidenced: "blue", forecast: "amber" };

function appliesToOptions(instalmentCount: number): AppliesToKey[] {
  return [...APPLIES_TO.filter((key) => key === "end_of_year" || Number(key.slice("instalment_".length)) <= instalmentCount)];
}

/** Where a payment goes and how sure that is (ITX6A-ITX6H). `replacing` reallocates an existing allocation. */
function AllocationForm({
  organisationId,
  payment,
  instalmentCount,
  documents,
  replacing,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  payment: TaxPayment;
  instalmentCount: number;
  documents: IrdDocument[];
  replacing: TaxAllocation | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    appliesTo: (replacing?.appliesTo ?? "instalment_1") as AppliesToKey,
    amount: replacing?.amount ?? payment.awaiting,
    status: (replacing?.status ?? "evidenced") as AllocationStatus,
    basis: "",
    irdDocumentId: "",
    reason: "",
  });
  const [key] = useState(() => newIdempotencyKey("tax-alloc"));
  const [status, setStatus] = useState<Status>(null);
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const body = { organisationId, idempotencyKey: key, appliesTo: form.appliesTo, amount: form.amount, status: form.status, basis: form.basis, irdDocumentId: form.status === "confirmed" ? form.irdDocumentId : null };
    try {
      if (replacing) await api(`/api/income-tax/allocations/${replacing.id}/replace`, { method: "POST", body: { ...body, reason: form.reason } });
      else await api(`/api/income-tax/payments/${payment.id}/allocations`, { method: "POST", body });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const live = documents.filter((document) => !document.removed);
  return (
    <form className={ui.inlineForm} onSubmit={save} aria-label={replacing ? "Change where this goes" : "Allocate this payment"}>
      <Field label="Towards">
        <select value={form.appliesTo} onChange={(event) => set("appliesTo", event.target.value as AppliesToKey)}>
          {appliesToOptions(instalmentCount).map((value) => (
            <option key={value} value={value}>
              {APPLIES_TO_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount">
        <input inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value)} required />
      </Field>
      <Field label="How sure" hint="Only IRD's own record is confirmed. A forecast assumption is shown but not counted as paid.">
        <select value={form.status} onChange={(event) => set("status", event.target.value as AllocationStatus)}>
          {ALLOCATION_STATUSES.map((value) => (
            <option key={value} value={value}>
              {ALLOCATION_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      {form.status === "confirmed" ? (
        <Field label="IRD document" hint={live.length === 0 ? "Add IRD's statement or letter under IRD documents first." : undefined}>
          <select value={form.irdDocumentId} onChange={(event) => set("irdDocumentId", event.target.value)} required>
            <option value="">Choose…</option>
            {live.map((document) => (
              <option key={document.id} value={document.id}>
                {document.fileName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={form.status === "forecast" ? "Assumption" : "Evidence"} hint={form.status === "forecast" ? "Why you expect it to go there." : "What shows it goes there, for example the reference it was paid with."}>
        <input value={form.basis} maxLength={300} onChange={(event) => set("basis", event.target.value)} required />
      </Field>
      {replacing ? (
        <Field label="Reason for the change">
          <input value={form.reason} maxLength={300} onChange={(event) => set("reason", event.target.value)} required />
        </Field>
      ) : null}
      <Button type="submit" variant="secondary">
        {replacing ? "Change" : "Allocate"}
      </Button>
      <Button type="button" variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}

function PaymentRow({ organisationId, payment, instalmentCount, documents, onSaved, onRemove }: { organisationId: string; payment: TaxPayment; instalmentCount: number; documents: IrdDocument[]; onSaved: () => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<"allocate" | "effective" | { replace: TaxAllocation } | { remove: TaxAllocation } | null>(null);
  const [effective, setEffective] = useState(payment.irdEffectiveOn ?? "");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const done = () => {
    setEditing(null);
    setStatus(null);
    onSaved();
  };
  async function run(work: () => Promise<unknown>) {
    try {
      await work();
      done();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const label = `the ${formatMoney(payment.amount)} payment on ${formatDate(payment.paidOn)}`;
  return (
    <>
      <tr>
        <td data-label="Payment">
          <strong>
            <Money value={payment.amount} />
          </strong>
          <div className={ui.muted}>Left the bank {formatDate(payment.paidOn)}</div>
          <div className={ui.muted}>{payment.irdEffectiveOn ? `IRD effective ${formatDate(payment.irdEffectiveOn)}` : "No IRD effective date yet"}</div>
          {payment.note ? <div className={ui.muted}>{payment.note}</div> : null}
        </td>
        <td data-label="Where it goes">
          {payment.reversed ? <Badge tone="red">Reversed in the books: not counted</Badge> : null}
          {payment.allocations.map((allocation) => (
            <div key={allocation.id}>
              {APPLIES_TO_LABELS[allocation.appliesTo]} · <Money value={allocation.amount} /> <Badge tone={STATUS_TONES[allocation.status]}>{ALLOCATION_STATUS_LABELS[allocation.status]}</Badge>
              <div className={ui.muted}>
                {allocation.basis}
                {allocation.irdDocumentName ? ` · ${allocation.irdDocumentName}` : ""}
              </div>
              {!payment.reversed ? (
                <div>
                  <button type="button" className={ui.linkButton} onClick={() => setEditing({ replace: allocation })} aria-label={`Change where ${formatMoney(allocation.amount)} of ${label} goes`}>
                    Change
                  </button>{" "}
                  <button type="button" className={ui.linkButton} onClick={() => setEditing({ remove: allocation })} aria-label={`Take off the ${formatMoney(allocation.amount)} allocation of ${label}`}>
                    Take off
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          {!payment.reversed && payment.awaiting !== "0.00" ? <Badge tone="amber">{`Awaiting reconciliation: ${formatMoney(payment.awaiting)}`}</Badge> : null}
          {payment.replacedAllocations.length > 0 ? (
            <details>
              <summary>Earlier allocations ({payment.replacedAllocations.length})</summary>
              <ul>
                {payment.replacedAllocations.map((allocation) => (
                  <li key={allocation.id} className={ui.muted}>
                    {APPLIES_TO_LABELS[allocation.appliesTo]} · {formatMoney(allocation.amount)} · {ALLOCATION_STATUS_LABELS[allocation.status]}
                    {allocation.replaced ? ` · changed ${formatDate(allocation.replaced.at.slice(0, 10))}: ${allocation.replaced.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </td>
        <td data-label="Actions">
          {!payment.reversed && payment.awaiting !== "0.00" ? (
            <div>
              <button type="button" className={ui.linkButton} onClick={() => setEditing("allocate")} aria-label={`Allocate ${label}`}>
                Allocate
              </button>
            </div>
          ) : null}
          {!payment.reversed ? (
            <div>
              <button type="button" className={ui.linkButton} onClick={() => setEditing("effective")} aria-label={`IRD effective date for ${label}`}>
                {payment.irdEffectiveOn ? "Change IRD date" : "Add IRD date"}
              </button>
            </div>
          ) : null}
          <div>
            <button type="button" className={ui.linkButton} onClick={onRemove} aria-label={`Remove ${label}`}>
              Remove
            </button>
          </div>
        </td>
      </tr>
      {editing !== null || status ? (
        <tr>
          <td colSpan={3}>
            {editing === "allocate" ? <AllocationForm organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={documents} replacing={null} onSaved={done} onCancel={() => setEditing(null)} /> : null}
            {editing !== null && typeof editing === "object" && "replace" in editing ? (
              <AllocationForm organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={documents} replacing={editing.replace} onSaved={done} onCancel={() => setEditing(null)} />
            ) : null}
            {editing !== null && typeof editing === "object" && "remove" in editing ? (
              <form
                className={ui.inlineForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => api(`/api/income-tax/allocations/${editing.remove.id}/remove`, { method: "POST", body: { organisationId, reason } }));
                }}
              >
                <Field label="Reason for taking it off">
                  <input value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} required />
                </Field>
                <Button type="submit" variant="secondary">
                  Take off
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
            {editing === "effective" ? (
              <form
                className={ui.inlineForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(() => api(`/api/income-tax/payments/${payment.id}`, { method: "PATCH", body: { organisationId, irdEffectiveOn: effective } }));
                }}
              >
                <Field label="IRD effective date" hint="From IRD's statement. Leave blank to use the bank date.">
                  <DateInput value={effective} onChange={(event) => setEffective(event.target.value)} />
                </Field>
                <Button type="submit" variant="secondary">
                  Save date
                </Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
            {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Payments({ organisationId, incomeYear, payments, total, instalmentCount, onSaved }: { organisationId: string; incomeYear: number; payments: TaxPayment[]; total: string; instalmentCount: number; onSaved: () => void }) {
  const empty = { paidOn: "", irdEffectiveOn: "", amount: "", note: "", appliesTo: "" as AppliesToKey | "", status: "evidenced" as AllocationStatus, basis: "", irdDocumentId: "" };
  const [form, setForm] = useState(empty);
  const [key, setKey] = useState(() => newIdempotencyKey("tax-pay"));
  const [status, setStatus] = useState<Status>(null);
  const documents = useApiData<{ documents: IrdDocument[] }>("/api/income-tax/documents", { organisationId });
  const docs = documents.data?.documents ?? [];
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/payments", {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: key,
          incomeYear,
          paidOn: form.paidOn,
          irdEffectiveOn: form.irdEffectiveOn,
          amount: form.amount,
          note: form.note,
          allocation: form.appliesTo ? { appliesTo: form.appliesTo, status: form.status, basis: form.basis, irdDocumentId: form.status === "confirmed" ? form.irdDocumentId : null } : null,
        },
      });
      setForm(empty);
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
  const live = docs.filter((document) => !document.removed);
  return (
    <>
      <h3>Payments to IRD towards the {incomeYear} income year</h3>
      <p className={ui.muted}>
        A payment counts against an instalment only once it&apos;s allocated: confirmed by IRD, or by you with the evidence. Until then it&apos;s awaiting reconciliation, whatever its date.
      </p>
      {payments.length === 0 ? (
        <Empty>None typed yet.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Payment</th>
                <th>Where it goes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <PaymentRow key={payment.id} organisationId={organisationId} payment={payment} instalmentCount={instalmentCount} documents={docs} onSaved={onSaved} onRemove={() => void remove(payment.id)} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>
                  <strong>
                    Total <Money value={total} />
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Left the bank on">
          <DateInput value={form.paidOn} onChange={(event) => set("paidOn", event.target.value)} required />
        </Field>
        <Field label="IRD effective date" hint="If you know it.">
          <DateInput value={form.irdEffectiveOn} onChange={(event) => set("irdEffectiveOn", event.target.value)} />
        </Field>
        <Field label="Amount">
          <input inputMode="decimal" value={form.amount} onChange={(event) => set("amount", event.target.value)} required />
        </Field>
        <Field label="Note">
          <input value={form.note} maxLength={200} onChange={(event) => set("note", event.target.value)} />
        </Field>
        <Field label="Towards">
          <select value={form.appliesTo} onChange={(event) => set("appliesTo", event.target.value as AppliesToKey | "")}>
            <option value="">Not allocated yet</option>
            {appliesToOptions(instalmentCount).map((value) => (
              <option key={value} value={value}>
                {APPLIES_TO_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {form.appliesTo ? (
          <>
            <Field label="How sure">
              <select value={form.status} onChange={(event) => set("status", event.target.value as AllocationStatus)}>
                {ALLOCATION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {ALLOCATION_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            {form.status === "confirmed" ? (
              <Field label="IRD document">
                <select value={form.irdDocumentId} onChange={(event) => set("irdDocumentId", event.target.value)} required>
                  <option value="">Choose…</option>
                  {live.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.fileName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label={form.status === "forecast" ? "Assumption" : "Evidence"}>
              <input value={form.basis} maxLength={300} onChange={(event) => set("basis", event.target.value)} required />
            </Field>
          </>
        ) : null}
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
                <th className={ui.num}>Paid towards it</th>
                <th className={ui.num}>Still needed by this date</th>
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
                    {instalment.catchUp !== "0.00" ? <div className={ui.muted}>Includes {formatMoney(instalment.catchUp)} not paid towards earlier instalments</div> : null}
                  </td>
                  <td data-label="Paid towards it" className={ui.num}>
                    <Money value={instalment.paid} />
                    {instalment.paidLate !== "0.00" ? <div><Badge tone="red">{`${formatMoney(instalment.paidLate)} late`}</Badge></div> : null}
                    {instalment.forecastPaid !== "0.00" ? <div className={ui.muted}>Plus {formatMoney(instalment.forecastPaid)} assumed (forecast)</div> : null}
                  </td>
                  <td data-label="Still needed" className={ui.num}>
                    <Money value={instalment.remaining} />
                    {instalment.remainingWithForecast !== instalment.remaining ? <div className={ui.muted}>{formatMoney(instalment.remainingWithForecast)} if the forecast holds</div> : null}
                    {instalment.creditAfter !== "0.00" ? <div className={ui.muted}>{formatMoney(instalment.creditAfter)} credit carried forward</div> : null}
                  </td>
                  <td data-label="How">
                    {instalment.basis}
                    {instalment.assumption ? <div className={ui.muted}>{instalment.assumption}</div> : null}
                  </td>
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

function TaxDetailsForm({ organisationId, asset, onSaved }: { organisationId: string; asset: TaxAsset; onSaved: () => void }) {
  const details = asset.details;
  const [form, setForm] = useState({
    method: (details?.method ?? (asset.bookMethod === "none" ? "not_depreciable" : asset.bookMethod)) as TaxDepreciationMethod,
    rate: details?.rate ?? asset.bookRate ?? "",
    taxCost: details?.taxCost ?? asset.cost,
    businessUsePercent: details?.businessUsePercent ?? "100",
    availableOn: details?.availableOn ?? asset.purchaseDate,
    newAsset: details?.newAsset ?? false,
    investmentBoost: details?.investmentBoost ?? false,
    openingIncomeYear: details?.openingIncomeYear ? String(details.openingIncomeYear) : "",
    openingAtv: details?.openingAtv ?? "",
  });
  const [status, setStatus] = useState<Status>(null);
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [name]: value }));
  const depreciating = form.method === "dv" || form.method === "sl";
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/api/income-tax/assets/${asset.assetId}`, {
        method: "PUT",
        body: { organisationId, ...form, rate: depreciating ? form.rate : null, investmentBoost: depreciating && form.investmentBoost, version: details?.version ?? 0 },
      });
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <form onSubmit={save}>
      <div className={ui.grid}>
        <Field label="Tax method">
          <select value={form.method} onChange={(event) => set("method", event.target.value as TaxDepreciationMethod)}>
            {TAX_DEPRECIATION_METHODS.map((method) => (
              <option key={method} value={method}>
                {TAX_DEPRECIATION_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </Field>
        {depreciating ? (
          <Field label="IRD rate %" hint="From IRD's depreciation rate finder.">
            <input inputMode="decimal" value={form.rate} onChange={(event) => set("rate", event.target.value)} required />
          </Field>
        ) : null}
        <Field label="Tax cost" hint="Excluding GST when registered.">
          <input inputMode="decimal" value={form.taxCost} onChange={(event) => set("taxCost", event.target.value)} />
        </Field>
        <Field label="Business use %">
          <input inputMode="decimal" value={form.businessUsePercent} onChange={(event) => set("businessUsePercent", event.target.value)} />
        </Field>
        <Field label="First available for use">
          <DateInput value={form.availableOn} onChange={(event) => set("availableOn", event.target.value)} />
        </Field>
        <Field label="Tax history from before Tohyee" hint="The income year and its opening adjusted tax value (ATV). Leave blank for an asset bought while using Tohyee.">
          <span>
            <input aria-label="Opening income year" placeholder="Year, e.g. 2026" inputMode="numeric" size={6} value={form.openingIncomeYear} onChange={(event) => set("openingIncomeYear", event.target.value)} />{" "}
            <input aria-label="Opening adjusted tax value" placeholder="ATV" inputMode="decimal" size={10} value={form.openingAtv} onChange={(event) => set("openingAtv", event.target.value)} />
          </span>
        </Field>
      </div>
      {depreciating ? (
        <>
          <div>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={form.newAsset} onChange={(event) => set("newAsset", event.target.checked)} /> New, or new to New Zealand (not second-hand from New Zealand)
            </label>
          </div>
          <div>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={form.investmentBoost} onChange={(event) => set("investmentBoost", event.target.checked)} /> Claim Investment Boost (20% for new assets first available for use on or after 22 May 2025)
            </label>
          </div>
        </>
      ) : null}
      {form.method === "low_value" ? <p className={ui.muted}>Assets bought together from one supplier at the same depreciation rate don&apos;t count as low-value.</p> : null}
      <Button type="submit" size="small">
        Save tax details
      </Button>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </form>
  );
}

function TaxAssets({ organisationId, assets, incomeYear, onSaved }: { organisationId: string; assets: TaxAsset[]; incomeYear: number; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Card
      title="Tax depreciation"
      description={`The tax side of the fixed asset register for the ${incomeYear} income year. Book depreciation keeps posting; for assets with tax details, these figures replace it in taxable income. Type each rate from IRD's rate finder.`}
    >
      {assets.length === 0 ? (
        <Empty>No fixed assets in the register.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Tax method</th>
                <th className={ui.num}>Opening ATV</th>
                <th className={ui.num}>Investment Boost</th>
                <th className={ui.num}>Depreciation</th>
                <th className={ui.num}>Recovered or (loss)</th>
                <th className={ui.num}>Closing ATV</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const year = asset.year;
                const result = year ? (Number(year.loss) > 0 ? negated(year.loss) : year.recovered) : null;
                return (
                  <Fragment key={asset.assetId}>
                    <tr>
                      <td data-label="Asset">
                        {asset.assetNumber} {asset.name} <span className={ui.muted}>({asset.typeName})</span>
                        {asset.disposal ? <span className={ui.muted}> · sold {formatDate(asset.disposal.date)}</span> : null}
                      </td>
                      <td data-label="Tax method">
                        {asset.details ? (
                          <>
                            {TAX_DEPRECIATION_METHOD_LABELS[asset.details.method]}
                            {asset.details.rate ? ` ${asset.details.rate}%` : ""}
                            {asset.details.businessUsePercent !== "100" ? ` · ${asset.details.businessUsePercent}% business` : ""} {asset.details.investmentBoost ? <Badge tone="green">Investment Boost</Badge> : null}
                          </>
                        ) : (
                          <Badge tone="amber">No tax details: book used</Badge>
                        )}
                      </td>
                      <td data-label="Opening ATV" className={ui.num}>
                        {year ? <Money value={year.openingAtv} /> : null}
                      </td>
                      <td data-label="Investment Boost" className={ui.num}>
                        {year ? <Money value={year.boostClaimed} blankZero /> : null}
                      </td>
                      <td data-label="Depreciation" className={ui.num}>
                        {year ? <Money value={year.depreciationClaimed} blankZero /> : null}
                      </td>
                      <td data-label="Recovered or (loss)" className={ui.num}>
                        {result ? <Money value={result} blankZero /> : null}
                      </td>
                      <td data-label="Closing ATV" className={ui.num}>
                        {year ? <Money value={year.closingAtv} /> : null}
                      </td>
                      <td>
                        <button type="button" className={ui.linkButton} onClick={() => setEditing(editing === asset.assetId ? null : asset.assetId)}>
                          {editing === asset.assetId ? "Close" : asset.details ? "Change" : "Add tax details"}
                        </button>
                      </td>
                    </tr>
                    {editing === asset.assetId ? (
                      <tr>
                        <td colSpan={8}>
                          <TaxDetailsForm
                            key={`${asset.assetId}-${asset.details?.version ?? 0}`}
                            organisationId={organisationId}
                            asset={asset}
                            onSaved={() => {
                              setEditing(null);
                              onSaved();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className={ui.muted}>
        Depreciation and Investment Boost shown are the business-use share that&apos;s deducted. No depreciation is claimed in the year an asset is sold. Where IRD&apos;s pages don&apos;t say (rounding to the cent, the ATV of an asset used partly privately), Tohyee&apos;s reading is in decision 546.
      </p>
    </Card>
  );
}

function downloadIr10(incomeYear: number, ir10: Ir10) {
  const rows = [["Box", "Label", "Amount"], ...Object.keys(ir10.labels).map((key) => [key, ir10.labels[Number(key)], ir10.boxes[Number(key)] ?? ""])];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `IR10-${incomeYear}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const IR10_SECTIONS: Array<{ title: string; from: number; to: number }> = [
  { title: "Profit and loss", from: 1, to: 29 },
  { title: "Balance sheet", from: 30, to: 51 },
  { title: "Other information", from: 52, to: 60 },
];
const IR10_TOTALS = new Set([6, 11, 25, 27, 29, 43, 48, 50, 51]);

function Ir10Accounts({ organisationId, onSaved }: { organisationId: string; onSaved: () => void }) {
  const loaded = useApiData<{ accounts: Ir10Account[] }>("/api/income-tax/ir10", { organisationId });
  const [error, setError] = useState<string | null>(null);
  async function save(account: Ir10Account, box: number, role: string) {
    try {
      setError(null);
      await api("/api/income-tax/ir10", { method: "PUT", body: { organisationId, accountId: account.accountId, box, role: role || null } });
      loaded.reload();
      onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Account</th>
              <th>IR10 box</th>
              <th>Also</th>
            </tr>
          </thead>
          <tbody>
            {loaded.data.accounts
              .filter((account) => account.isActive || account.isSet)
              .map((account) => (
                <tr key={account.accountId}>
                  <td data-label="Account">
                    {account.code} {account.name} {account.isSet ? null : <span className={ui.muted}>(default)</span>}
                  </td>
                  <td data-label="IR10 box">
                    {account.allowedBoxes.length === 1 ? (
                      `${account.box} ${IR10_BOX_LABELS[account.box]}`
                    ) : (
                      <select aria-label={`IR10 box for ${account.code}`} value={account.box} onChange={(event) => void save(account, Number(event.target.value), account.role ?? "")}>
                        {account.allowedBoxes.map((number) => (
                          <option key={number} value={number}>
                            {number} {IR10_BOX_LABELS[number]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td data-label="Also">
                    {account.allowedRoles.length > 0 ? (
                      <select aria-label={`IR10 role for ${account.code}`} value={account.role ?? ""} onChange={(event) => void save(account, account.box, event.target.value)}>
                        <option value="">Nothing else</option>
                        {account.allowedRoles.map((role) => (
                          <option key={role} value={role}>
                            {IR10_ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Ir10Card({ organisationId, report, ir10, onSaved }: { organisationId: string; report: Supported; ir10: Ir10; onSaved: () => void }) {
  const [showAccounts, setShowAccounts] = useState(false);
  return (
    <Card
      title="IR10 financial statements summary"
      description={`The ${report.incomeYear} income year's IR10 from the books, to copy into myIR or attach to the return. Tohyee doesn't file it.`}
      actions={
        <Button variant="secondary" size="small" onClick={() => downloadIr10(report.incomeYear, ir10)}>
          Download CSV
        </Button>
      }
    >
      {ir10.checks.map((check) => (
        <Notice key={check.label} tone={check.ok ? "success" : "error"}>
          {check.ok ? "✓" : "✗"} {check.label}. {check.detail}.
        </Notice>
      ))}
      {IR10_SECTIONS.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          <table className={ui.reportTable}>
            <tbody>
              {Array.from({ length: section.to - section.from + 1 }, (_, index) => section.from + index).map((number) => (
                <tr key={number} className={IR10_TOTALS.has(number) ? ui.reportTotal : undefined}>
                  <td>
                    <span className={ui.muted}>{number}</span> {ir10.labels[number]}
                  </td>
                  <td className={ui.num}>{number === 1 ? ir10.boxes[1] : ir10.boxes[number] === null ? <span className={ui.muted}>blank</span> : <Money value={ir10.boxes[number]} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <ul className={ui.muted}>
        {ir10.notes.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <button type="button" className={ui.linkButton} onClick={() => setShowAccounts((value) => !value)}>
        {showAccounts ? "Hide which box each account goes in" : "Change which box each account goes in"}
      </button>
      {showAccounts ? <Ir10Accounts organisationId={organisationId} onSaved={onSaved} /> : null}
    </Card>
  );
}

type TaxReturnBoxes = { boxes: Record<string, string>; residual: "credit" | "debit"; outcome: "refund" | "tax_to_pay"; nextYear: { incomeYear: number; option: "S"; amount: string } | null; notes: string[] };

function TaxReturnCard({ title, source, order, labels, result, residualBox, outcomeBox, provisionalBox }: { title: string; source: string; order: readonly string[]; labels: Record<string, string>; result: TaxReturnBoxes; residualBox: string; outcomeBox: string; provisionalBox: string }) {
  return (
    <Card title={title}>
      <Notice tone="warning">From {source}, read by Claude and not yet reviewed by an accountant. Check every box before filing.</Notice>
      <table className={ui.reportTable}>
        <tbody>
          {order.map((box) => (
            <tr key={box}>
              <td>
                {box === "other" || /^W\d/.test(box) ? null : <span className={ui.muted}>{box}</span>} {labels[box]}
                {box === residualBox ? <> ({result.residual})</> : null}
                {box === outcomeBox ? <> ({result.outcome === "refund" ? "refund" : "tax to pay"})</> : null}
              </td>
              <td className={ui.num}>
                <Money value={result.boxes[box]} />
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <span className={ui.muted}>{provisionalBox}A, {provisionalBox}B</span>{" "}
              {result.nextYear ? `${result.nextYear.incomeYear} provisional tax, standard option (S): RIT plus 5%` : "Next year's provisional tax: none required (RIT 5,000.00 or less)"}
            </td>
            <td className={ui.num}>{result.nextYear ? <Money value={result.nextYear.amount} /> : null}</td>
          </tr>
        </tbody>
      </table>
      <ul>
        {result.notes.map((note) => (
          <li key={note} className={ui.muted}>
            {note}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function IcaCard({ organisationId, ica, onSaved }: { organisationId: string; ica: Ica; onSaved: () => void }) {
  const [form, setForm] = useState({ entryDate: "", kind: "dividend_paid" as IcaKind, amount: "", dividendAmount: "", description: "" });
  const [key, setKey] = useState(() => newIdempotencyKey("ica"));
  const [status, setStatus] = useState<Status>(null);
  async function add(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/income-tax/ica", { method: "POST", body: { organisationId, idempotencyKey: key, ...form, dividendAmount: form.kind === "dividend_paid" ? form.dividendAmount : undefined } });
      setForm((current) => ({ ...current, amount: "", dividendAmount: "", description: "" }));
      setKey(newIdempotencyKey("ica"));
      setStatus(null);
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove(id: string) {
    try {
      await api(`/api/income-tax/ica/${id}`, { method: "DELETE", query: { organisationId } });
      onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card
      title="Imputation credit account"
      description={`The ${ica.icaYear} ICA year, ${formatDate(ica.start)} to ${formatDate(ica.end)}. Income tax paid comes from the payments typed below; type dividends, refunds and other entries here. Credits are positive, debits negative.`}
    >
      {ica.debitBalance ? (
        <Notice tone="error">
          Debit balance at 31 March: further income tax <Money value={ica.debitBalance.furtherIncomeTax} /> and imputation penalty tax <Money value={ica.debitBalance.penalty} /> are due{" "}
          {formatDate(ica.debitBalance.dueDate)}
          {ica.debitBalance.onTimeBy.date !== ica.debitBalance.dueDate ? ` (on time by ${formatDate(ica.debitBalance.onTimeBy.date)})` : ""}.
        </Notice>
      ) : null}
      <table className={ui.reportTable}>
        <tbody>
          <tr>
            <td>Balance at {formatDate(ica.start)}</td>
            <td />
            <td className={ui.num}>
              <Money value={ica.opening} />
            </td>
          </tr>
          {ica.rows.map((row, index) => (
            <tr key={`${row.kind}-${row.id ?? index}`}>
              <td>
                {formatDate(row.date)} · {row.label}
                {row.dividendAmount ? (
                  <>
                    {" "}
                    on <Money value={row.dividendAmount} />
                  </>
                ) : null}
                {row.description ? <span className={ui.muted}> · {row.description}</span> : null} {row.ratioDiffers ? <Badge tone="amber">Different ratio</Badge> : null}{" "}
                {row.id !== null && row.kind !== "tax_paid" ? (
                  <button type="button" className={ui.linkButton} onClick={() => void remove(row.id!)}>
                    Remove
                  </button>
                ) : null}
              </td>
              <td className={ui.num}>
                <Money value={row.amount} />
              </td>
              <td className={ui.num}>
                <Money value={row.balance} />
              </td>
            </tr>
          ))}
          <tr className={ui.reportTotal}>
            <td>Balance at {formatDate(ica.end)}</td>
            <td />
            <td className={ui.num}>
              <Money value={ica.closing} />
            </td>
          </tr>
        </tbody>
      </table>
      <details>
        <summary>IR4 annual imputation return (page 7) boxes</summary>
        <table className={ui.reportTable}>
          <tbody>
            {(
              [
                ["41", "Opening balance (credit; debit negative)"],
                ["42A", "Income tax and provisional tax paid"],
                ["42B", "RWT on interest received"],
                ["42C", "Imputation credits on dividends received"],
                ["42D", "Other credits"],
                ["43A", "Income tax refunded"],
                ["43B", "Imputation credits on dividends paid"],
                ["43C", "Other debits"],
                ["44B", "Closing balance (credit; debit negative)"],
                ["45", "Imputation penalty tax"],
              ] as const
            ).map(([box, label]) => (
              <tr key={box}>
                <td>
                  <span className={ui.muted}>{box}</span> {label}
                </td>
                <td className={ui.num}>
                  <Money value={ica.ir4[box]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <form className={ui.inlineForm} onSubmit={add}>
        <Field label="Date">
          <DateInput value={form.entryDate} onChange={(event) => setForm((current) => ({ ...current, entryDate: event.target.value }))} required />
        </Field>
        <Field label="Entry">
          <select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as IcaKind }))}>
            {ICA_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ICA_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === "dividend_paid" ? (
          <Field label="Cash dividend">
            <input inputMode="decimal" value={form.dividendAmount} onChange={(event) => setForm((current) => ({ ...current, dividendAmount: event.target.value }))} required />
          </Field>
        ) : null}
        <Field label={form.kind === "dividend_paid" ? "Credits attached" : form.kind === "opening" ? "Balance (debit negative)" : "Amount"} hint={form.kind === "dividend_paid" ? "Blank for the most allowed: 28/72 of the dividend." : undefined}>
          <input inputMode="decimal" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} required={form.kind !== "dividend_paid"} />
        </Field>
        <Field label="Note">
          <input value={form.description} maxLength={200} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
        </Field>
        <Button type="submit" variant="secondary">
          Add entry
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      <ul className={ui.muted}>
        {ica.notes.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </Card>
  );
}

const PROPOSED_FIELDS: Array<{ key: "assessedRit" | "returnFiledOn" | "lossesBroughtForward" | "taxCredits" | "imputationCredits" | "overseasTaxPaid" | "imputationBroughtForward" | "otherIncome"; label: string; date?: boolean }> = [
  { key: "assessedRit", label: "Assessed RIT" },
  { key: "returnFiledOn", label: "Return filed on", date: true },
  { key: "lossesBroughtForward", label: "Losses brought forward" },
  { key: "taxCredits", label: "Tax credits" },
  { key: "imputationCredits", label: "Imputation credits received" },
  { key: "overseasTaxPaid", label: "Overseas tax paid" },
  { key: "imputationBroughtForward", label: "Excess imputation credits brought forward" },
  { key: "otherIncome", label: "Other income" },
];

function ProposalCard({ organisationId, proposal, endMonth, onDone }: { organisationId: string; proposal: IrdProposal; endMonth: number; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(action: "accept" | "decline") {
    try {
      setError(null);
      await api(`/api/income-tax/proposals/${proposal.id}/${action}`, { method: "POST", body: { organisationId, reason: action === "decline" ? reason : undefined } });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const show = (value: string | null | undefined, date?: boolean) => (value == null ? <span className={ui.muted}>none</span> : date ? formatDate(value) : <Money value={value} />);
  return (
    <div className={ui.reportBlock}>
      <p>
        <strong>{incomeYearLabel(proposal.incomeYear, endMonth)}</strong> · proposed by {proposal.aiKeyName ?? proposal.proposedByEmail} on {formatDate(proposal.createdAt.slice(0, 10))}
        {proposal.documentId ? (
          <>
            {" "}
            from{" "}
            <a href={`/api/income-tax/documents/${proposal.documentId}/file?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
              {proposal.documentName}
            </a>
          </>
        ) : null}
      </p>
      {proposal.note ? <p className={ui.muted}>“{proposal.note}”</p> : null}
      <table className={ui.reportTable}>
        <thead>
          <tr>
            <th />
            <th className={ui.num}>Now</th>
            <th className={ui.num}>Proposed</th>
          </tr>
        </thead>
        <tbody>
          {PROPOSED_FIELDS.filter((field) => proposal.figures[field.key] !== undefined).map((field) => (
            <tr key={field.key}>
              <td>{field.label}</td>
              <td className={ui.num}>{show(proposal.current[field.key], field.date)}</td>
              <td className={ui.num}>
                <strong>{show(proposal.figures[field.key], field.date)}</strong>
              </td>
            </tr>
          ))}
          {proposal.payments.map((payment, index) => (
            <tr key={`payment-${index}`}>
              <td>
                Payment on {formatDate(payment.paidOn)}
                {payment.note ? <span className={ui.muted}> · {payment.note}</span> : null}
              </td>
              <td className={ui.num}>{payment.alreadyTyped ? <Badge>Already typed</Badge> : null}</td>
              <td className={ui.num}>
                <strong>
                  <Money value={payment.amount} />
                </strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {declining ? (
        <div className={ui.inlineForm}>
          <Field label="Why decline?">
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <Button variant="secondary" size="small" onClick={() => void decide("decline")}>
            Decline
          </Button>
          <Button variant="secondary" size="small" onClick={() => setDeclining(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className={ui.rowButtons}>
          <Button size="small" onClick={() => void decide("accept")}>
            Accept: I&apos;ve checked them against the document
          </Button>
          <Button variant="secondary" size="small" onClick={() => setDeclining(true)}>
            Decline…
          </Button>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function IrdDocuments({ organisationId, incomeYear, years, endMonth, onChanged }: { organisationId: string; incomeYear: number; years: number[]; endMonth: number; onChanged: () => void }) {
  const loaded = useApiData<{ documents: IrdDocument[]; proposals: IrdProposal[] }>("/api/income-tax/documents", { organisationId });
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(incomeYear));
  const [note, setNote] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("ird-doc"));
  const [removing, setRemoving] = useState<{ id: string; reason: string } | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const refresh = () => {
    loaded.reload();
    onChanged();
  };
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setStatus({ tone: "error", text: `${file.name} is more than 10 MB.` });
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", key);
    form.set("file", file);
    if (year) form.set("incomeYear", year);
    if (note) form.set("note", note);
    try {
      await postForm("/api/income-tax/documents", form);
      setFile(null);
      setNote("");
      setKey(newIdempotencyKey("ird-doc"));
      setStatus(null);
      refresh();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function remove() {
    if (!removing) return;
    try {
      await api(`/api/income-tax/documents/${removing.id}/remove`, { method: "POST", body: { organisationId, reason: removing.reason } });
      setRemoving(null);
      refresh();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  const data = loaded.data;
  return (
    <Card
      title="IRD documents"
      description="Upload IRD's assessments, statements of account and letters (downloaded from myIR). Your connected AI can read them and propose the figures; nothing changes until you check and accept them. Tohyee never asks for your myIR password."
    >
      {data && data.proposals.length > 0 ? (
        <>
          <h3>Proposed figures to check</h3>
          {data.proposals.map((proposal) => (
            <ProposalCard key={proposal.id} organisationId={organisationId} proposal={proposal} endMonth={endMonth} onDone={refresh} />
          ))}
        </>
      ) : null}
      {!data ? (
        <p className={ui.muted}>Loading…</p>
      ) : data.documents.length === 0 ? (
        <Empty>No IRD documents yet.</Empty>
      ) : (
        <ul>
          {data.documents.map((document) => (
            <li key={document.id}>
              <a href={`/api/income-tax/documents/${document.id}/file?organisationId=${encodeURIComponent(organisationId)}`} target="_blank" rel="noreferrer">
                {document.fileName}
              </a>
              {document.incomeYear ? ` · ${document.incomeYear} income year` : ""}
              {document.note ? ` · ${document.note}` : ""}
              <span className={ui.muted}> · added {formatDate(document.createdAt.slice(0, 10))}</span>{" "}
              {removing?.id === document.id ? (
                <span className={ui.inlineForm}>
                  <input aria-label="Why remove it?" placeholder="Why remove it?" value={removing.reason} onChange={(event) => setRemoving({ id: document.id, reason: event.target.value })} />
                  <Button size="small" variant="secondary" onClick={() => void remove()}>
                    Remove
                  </Button>
                </span>
              ) : (
                <button type="button" className={ui.linkButton} onClick={() => setRemoving({ id: document.id, reason: "" })}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className={ui.inlineForm} onSubmit={upload}>
        <Field label="IRD file" hint="PDF, JPG, PNG or HEIC, up to 10 MB.">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.heic" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required />
        </Field>
        <Field label="Income year">
          <select value={year} onChange={(event) => setYear(event.target.value)}>
            <option value="">Not sure</option>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <Button type="submit" variant="secondary">
          Upload
        </Button>
      </form>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
    </Card>
  );
}

function BookPayments({ organisationId, years, onChanged }: { organisationId: string; years: number[]; onChanged: () => void }) {
  const loaded = useApiData<BookPaymentsData>("/api/income-tax/book-payments", { organisationId });
  const accounts = useAccounts(organisationId);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [yearFor, setYearFor] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>(null);
  const data = loaded.data;
  const selected = chosen ?? data?.accounts.map((account) => account.accountId) ?? [];
  const balanceSheet = (accounts.data?.accounts ?? []).filter((account) => ["asset", "liability", "equity"].includes(account.accountClass) && account.isActive);
  async function saveAccounts() {
    try {
      await api("/api/income-tax/book-payments/accounts", { method: "PUT", body: { organisationId, accountIds: selected } });
      setChosen(null);
      setStatus(null);
      loaded.reload();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  async function count(journalLineId: string, incomeYear: string) {
    try {
      await api("/api/income-tax/book-payments/count", { method: "POST", body: { organisationId, journalLineId, incomeYear: Number(incomeYear) } });
      setStatus(null);
      loaded.reload();
      onChanged();
    } catch (error) {
      setStatus({ tone: "error", text: errorMessage(error) });
    }
  }
  return (
    <Card title="Payments to IRD in the books" description="Choose the accounts you code income tax payments to. Payments to them from a bank or credit card show here to count towards an income year, so you don't type them twice.">
      <Field label="Income tax payments are coded to" hint="Hold Ctrl (or Cmd) to choose more than one.">
        <select multiple size={Math.min(6, Math.max(3, balanceSheet.length))} value={selected} onChange={(event) => setChosen(Array.from(event.target.selectedOptions, (option) => option.value))}>
          {balanceSheet.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </select>
      </Field>
      {chosen !== null ? (
        <Button size="small" variant="secondary" onClick={() => void saveAccounts()}>
          Save accounts
        </Button>
      ) : null}
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {!data ? (
        <p className={ui.muted}>Loading…</p>
      ) : data.accounts.length === 0 ? (
        <Empty>Choose an account to see payments to IRD from the books.</Empty>
      ) : data.payments.length === 0 ? (
        <Empty>Every payment to IRD in the books is counted.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th className={ui.num}>Amount</th>
                <th>Towards</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.payments.map((line) => {
                const year = yearFor[line.journalLineId] ?? String(line.typedMatch?.incomeYear ?? line.suggestedIncomeYear ?? "");
                return (
                  <tr key={line.journalLineId}>
                    <td data-label="Date">{formatDate(line.date)}</td>
                    <td data-label="Reference">
                      {line.reference}
                      {line.description ? <span className={ui.muted}> · {line.description}</span> : null}
                      <span className={ui.muted}> · {line.account}</span>
                      {line.typedMatch ? <div className={ui.muted}>Matches a payment typed for {line.typedMatch.incomeYear}: counting links them.</div> : null}
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      <Money value={line.amount} />
                    </td>
                    <td data-label="Towards">
                      <select aria-label={`Income year for the payment on ${line.date}`} value={year} onChange={(event) => setYearFor((current) => ({ ...current, [line.journalLineId]: event.target.value }))}>
                        <option value="">Choose…</option>
                        {years.map((value) => (
                          <option key={value} value={value}>
                            {value} income year{line.suggestedIncomeYear === value ? " (suggested)" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Button size="small" variant="secondary" disabled={!year} onClick={() => void count(line.journalLineId, year)}>
                        Count it
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.refunds.length > 0 ? (
        <>
          <h3>Money in on those accounts</h3>
          <p className={ui.muted}>Possible refunds from IRD. They aren&apos;t counted as payments; a company types a refund into its imputation credit account.</p>
          <ul>
            {data.refunds.map((line) => (
              <li key={line.journalLineId}>
                {formatDate(line.date)} · {line.reference} · <Money value={line.amount} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

function InterestCard({ report }: { report: Supported }) {
  const interest = report.interest;
  return (
    <Card
      title="Use-of-money interest (estimate)"
      description={`On ${interest.ritTyped ? "IRD's assessed" : "Tohyee's forecast"} RIT of ${formatMoney(interest.rit)}, at IRD's rates (latest from ${formatDate(interest.ratesKnownTo)}, used for future days too). IRD works out what it actually charges.`}
    >
      <div className={ui.statRow}>
        <Stat label={`So far, to ${formatDate(interest.soFar.asAt)}`} value={<Money value={interest.soFar.amount} />} />
        <Stat label="If everything's paid on its due date" value={interest.ifPaidOnTime === null ? <span className={ui.muted}>Not worked out</span> : <Money value={interest.ifPaidOnTime} />} />
      </div>
      {interest.soFar.periods.length > 0 ? (
        <ul>
          {interest.soFar.periods.map((period) => (
            <li key={period.from}>
              {formatDate(period.from)} to {formatDate(period.to)} ({period.days} days): <Money value={period.outstanding} /> unpaid at {period.rate}% = <Money value={period.interest} />
            </li>
          ))}
        </ul>
      ) : null}
      <p className={ui.muted}>Simple daily interest (rate × days ÷ 365), from the day after each amount was due to the day it&apos;s paid; nothing while $100 or less is unpaid. Interest IRD pays on overpayments isn&apos;t worked out.</p>
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
      <TaxAssets organisationId={organisationId} assets={report.taxAssets} incomeYear={report.incomeYear} onSaved={reload} />
      <Provisional report={report} />
      <InterestCard report={report} />
      {report.ica ? <IcaCard organisationId={organisationId} ica={report.ica} onSaved={reload} /> : null}
      {report.ir4 ? (
        <TaxReturnCard title={`IR4 company return: income and tax (${report.incomeYear})`} source="IRD's 2026 IR4 form and guide" order={IR4_BOXES} labels={IR4_BOX_LABELS} result={report.ir4} residualBox="30J" outcomeBox="30L" provisionalBox="33" />
      ) : null}
      {report.ir3 ? (
        <TaxReturnCard title={`IR3 individual return: income and tax (${report.incomeYear})`} source="IRD's 2026 IR3 form and guide (the Question 36 worksheet)" order={IR3_BOXES} labels={IR3_BOX_LABELS} result={report.ir3} residualBox="W14" outcomeBox="W16" provisionalBox="39" />
      ) : null}
      {report.ir10 ? <Ir10Card organisationId={organisationId} report={report} ir10={report.ir10} onSaved={reload} /> : (
        <Card title="IR10 financial statements summary">
          <p className={ui.muted}>The IR10 is shown once the {report.incomeYear} income year has ended (31 March {report.incomeYear}).</p>
        </Card>
      )}
      <BookPayments organisationId={organisationId} years={report.years} onChanged={reload} />
      <IrdDocuments organisationId={organisationId} incomeYear={report.incomeYear} years={report.years} endMonth={report.endMonth} onChanged={reload} />
      <IrdImports organisationId={organisationId} incomeYear={report.incomeYear} years={report.years} onChanged={reload} />
      <YearFigures key={`${report.typed.version}-${report.paidTotal}-${report.lastYear.rit}`} organisationId={organisationId} incomeYear={report.incomeYear} type={report.settings.taxpayerType} years={report.years} endMonth={report.endMonth} onSaved={reload} />
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
                {incomeYearLabel(value, report.endMonth)}
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
