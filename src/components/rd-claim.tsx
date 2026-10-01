"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { activityText, fileUrl, postForm, tooBig, useRdActivities } from "@/components/rd";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import { RD_CATEGORY_LABELS, RD_LATE_AFTER_DAYS, RD_OVERHEAD_BASES, RD_PAYROLL_NOTE, RD_OVERHEAD_BASIS_CODES, type RdOverheadBasis } from "@/lib/rd/amounts";
import type { RdClaimActivity, RdClaimItem, RdClaimReport } from "@/lib/rd/claim";
import { RD_CLAIM_CATEGORIES, type ClaimStatus } from "@/lib/rd/claim-figures";
import type { RdReminder } from "@/lib/rd/deadlines";
import type { RdOverheadRule } from "@/lib/rd/overheads";

/**
 * The RDTI claim report (stage R3; examples RD16-RD42): the claim worked out
 * from tags, tax depreciation, overhead rules and posted pay runs, the
 * supplementary return's figures per project, what's left out and why, the
 * overhead rules, deadlines and the CSV export. Read-only apart from the
 * overhead rules; nothing here records that anything was filed.
 */

const STATUS_TEXT: Record<ClaimStatus, string> = {
  meets_minimum: "Meets the $50,000 minimum (LY 4(1)(a)).",
  approved_research_provider_only: "Under the $50,000 minimum: only approved research provider expenditure is claimed (LY 4(1)(b); Sch 21B B cl 24).",
  under_minimum: "Under the $50,000 minimum after the overseas limit: no credit (LY 4(1)(a); decision 31).",
  nothing: "Nothing counts for this year yet.",
};

const SOURCE_LABELS: Record<RdClaimItem["source"], string> = { tag: "Tag", asset: "Tax depreciation", overhead: "Overhead rule", payroll: "Pay" };



function ItemList({ items }: { items: RdClaimItem[] }) {
  if (items.length === 0) return null;
  return (
    <details>
      <summary className={ui.muted}>{items.length === 1 ? "1 item" : `${items.length} items`}</summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.source}-${item.recordId}-${index}`}>
            {formatDate(item.date)} · {SOURCE_LABELS[item.source]} · {item.activityCode} · {item.employeeName ? `${item.employeeName}: ` : ""}
            {item.label}
            {item.payCount != null ? ` (${item.payCount} pay${item.payCount === 1 ? "" : "s"})` : ""} · <Money value={item.amount} />{" "}
            {item.carriedIn ? <Badge tone="blue">From the year before</Badge> : null} {item.overseas ? <Badge tone="amber">Overseas</Badge> : null}{" "}
            {item.enteredLate ? <Badge tone="amber">Entered late</Badge> : null} {item.timelinessText ? <span className={ui.muted}>{item.timelinessText}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Reminders({ reminders }: { reminders: RdReminder[] }) {
  if (reminders.length === 0) return null;
  return (
    <Notice tone="warning">
      <strong>R&amp;D Tax Incentive deadlines</strong>
      <ul>
        {reminders.map((reminder) => (
          <li key={`${reminder.kind}-${reminder.incomeYear}`}>{reminder.text}.</li>
        ))}
      </ul>
      File in <a href="https://myir.ird.govt.nz/" target="_blank" rel="noreferrer">myIR</a>. Tohyee doesn&apos;t record that anything was filed.
    </Notice>
  );
}

/** Reminders for owners and admins on the home page (RD25, RD41; decision 48). */
export function RdDeadlineReminders({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ reminders: RdReminder[] }>(can("admin") ? "/api/rd/reminders" : null, { organisationId });
  if (!loaded.data) return null;
  return <Reminders reminders={loaded.data.reminders} />;
}

function ActivityCard({ row }: { row: RdClaimActivity }) {
  return (
    <Card
      title={activityText(row.activity)}
      description={
        <>
          {row.activity.projectName} · <Badge tone={row.activity.kind === "core" ? "blue" : "neutral"}>{row.activity.kind === "core" ? "Core" : "Supporting"}</Badge>{" "}
          {row.activity.place === "overseas" ? <Badge tone="amber">Overseas</Badge> : null}{" "}
          {row.approved ? <Badge tone="green">Approval entered</Badge> : <Badge tone="amber">No approval entered for this year</Badge>}{" "}
          {row.activity.changedSinceApproval ? <Badge tone="amber">Changed since approval was entered</Badge> : null}
          {row.activity.supports.length > 0 ? <span className={ui.muted}> · supports {row.activity.supports.join(", ")}</span> : null}
        </>
      }
    >
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Category</th>
              <th className={ui.num}>Counts (before the overseas limit)</th>
            </tr>
          </thead>
          <tbody>
            {RD_CLAIM_CATEGORIES.filter((category) => row.categories[category] !== "0.00").map((category) => (
              <tr key={category}>
                <td data-label="Category">
                  {RD_CATEGORY_LABELS[category]}
                  <ItemList items={row.items.filter((item) => item.category === category)} />
                </td>
                <td data-label="Counts" className={ui.num}>
                  <Money value={row.categories[category]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.statRow}>
        <Stat label="Counts" value={<Money value={row.counted} />} />
        <Stat label="Listed, not counted" value={<Money value={row.notCounted} />} />
      </div>
    </Card>
  );
}

async function downloadCsv(organisationId: string, incomeYear: number): Promise<void> {
  const response = await fetch("/api/rd/claim/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organisationId, incomeYear }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Export failed (${response.status}).`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "rd-claim.csv";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function RdClaimView({ organisationId }: { organisationId: string }) {
  const [incomeYear, setIncomeYear] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useApiData<{ report: RdClaimReport }>("/api/rd/claim", { organisationId, incomeYear: incomeYear || null });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const report = loaded.data.report;
  const f = report.figures;

  async function exportCsv() {
    setBusy(true);
    setError(null);
    try {
      await downloadCsv(organisationId, report.incomeYear);
      setMessage("Exported. Tohyee has kept the export's figures, so later changes show below.");
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {report.reminders ? <Reminders reminders={report.reminders} /> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice tone="info">
        This works the claim out from what&apos;s recorded; it posts nothing, and it doesn&apos;t decide whether anything is R&amp;D (IRD does, when it approves
        activities). Only activities with an approval covering the year count. {RD_PAYROLL_NOTE}
      </Notice>
      <Card
        title={`R&D claim, ${report.incomeYearLabel} income year`}
        description={`${formatDate(report.start)} to ${formatDate(report.end)}. Excludes GST. Every figure is rounded down to the cent.`}
        actions={
          <>
            <Field label="Income year">
              <select value={String(report.incomeYear)} onChange={(event) => setIncomeYear(event.target.value)}>
                {report.years.map((year) => (
                  <option key={year.incomeYear} value={year.incomeYear}>
                    {year.label}
                  </option>
                ))}
              </select>
            </Field>
            <Button variant="secondary" disabled={busy} onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          </>
        }
      >
        <div className={ui.statRow}>
          <Stat label="Total eligible" value={<Money value={f.totalEligible} />} />
          <Stat label="Claimed" value={<Money value={f.claimed} />} />
          <Stat label="R&D tax credit (15%)" value={<Money value={f.credit} />} />
          <Stat label="Core activities' share" value={f.coreShare == null ? "–" : `${f.coreShare}%`} />
        </div>
        <p>{STATUS_TEXT[f.status]}</p>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>NZ eligible</td>
                <td className={ui.num}>
                  <Money value={f.nzTotal} />
                </td>
              </tr>
              <tr>
                <td>Overseas spent</td>
                <td className={ui.num}>
                  <Money value={f.overseasSpent} />
                </td>
              </tr>
              <tr>
                <td>Overseas limit: 0.1 × NZ eligible ÷ 0.9, rounded down (LY 7(5))</td>
                <td className={ui.num}>
                  <Money value={f.overseasLimit} />
                </td>
              </tr>
              <tr>
                <td>Overseas over the limit (not eligible)</td>
                <td className={ui.num}>
                  <Money value={f.overseasOverLimit} />
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Total eligible R&amp;D expenditure</strong>
                </td>
                <td className={ui.num}>
                  <Money value={f.totalEligible} />
                </td>
              </tr>
              {f.overMaximum !== "0.00" ? (
                <tr>
                  <td>Over the $120 million maximum (LY 4(3))</td>
                  <td className={ui.num}>
                    <Money value={f.overMaximum} />
                  </td>
                </tr>
              ) : null}
              <tr>
                <td>Claimed</td>
                <td className={ui.num}>
                  <Money value={f.claimed} />
                </td>
              </tr>
              <tr>
                <td>
                  <strong>R&amp;D tax credit: 15% of what&apos;s claimed, rounded down (LY 4(2))</strong>
                </td>
                <td className={ui.num}>
                  <Money value={f.credit} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {report.lastExport ? (
          <div>
            <p className={ui.muted}>
              Last exported by {personName(report.lastExport, "exportedBy")} on {formatDateTime(report.lastExport.exportedAt)}.{" "}
              {report.lastExport.differences.length === 0 ? "Nothing has changed since." : "Changed since:"}
            </p>
            {report.lastExport.differences.length > 0 ? (
              <ul>
                {report.lastExport.differences.map((difference) => (
                  <li key={difference.figure}>
                    {difference.figure}: {difference.before ?? "–"} → {difference.after ?? "–"}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>

      {report.materialChanges.map((text) => (
        <Notice key={text} tone="warning">
          {text}
        </Notice>
      ))}

      {f.projects.map((project) => (
        <Card key={project.projectName} title={`Supplementary return: ${project.projectName}`} description="The figures the return asks for per project (IR1240 p 104-105; IR1060).">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <tbody>
                {RD_CLAIM_CATEGORIES.map((category) => (
                  <tr key={category}>
                    <td>{RD_CATEGORY_LABELS[category]}</td>
                    <td className={ui.num}>
                      <Money value={project.categories[category]} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td className={ui.num}>
                    <Money value={project.total} />
                  </td>
                </tr>
                <tr>
                  <td>Of which overseas (spent {project.overseasSpent}; {project.overseasOverLimit} over the limit)</td>
                  <td className={ui.num}>
                    <Money value={project.overseasCounted} />
                  </td>
                </tr>
                <tr>
                  <td>Of which internal software development</td>
                  <td className={ui.num}>
                    <Money value={project.internalSoftware} />
                  </td>
                </tr>
                <tr>
                  <td>Of which commercial production</td>
                  <td className={ui.num}>
                    <Money value={project.commercialProduction} />
                  </td>
                </tr>
                <tr>
                  <td>Of which supporting activity from the year before (RD4)</td>
                  <td className={ui.num}>
                    <Money value={project.carriedIn} />
                  </td>
                </tr>
                <tr>
                  <td>Core activities&apos; share (supporting is the rest)</td>
                  <td className={ui.num}>{project.coreShare == null ? "–" : `${project.coreShare}%`}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {report.activities.length === 0 ? (
        <Card title="Activities">
          <Empty>
            Nothing recorded for this year. Tag costs on <Link href="/operations/rd/costs">Tagged R&amp;D costs</Link>.
          </Empty>
        </Card>
      ) : null}
      {report.activities.map((row) => (
        <ActivityCard key={row.activity.id} row={row} />
      ))}

      {report.notCounted.length > 0 ? (
        <Card title="Listed, not counted" description="Recorded against R&D but left out of the claim, and why.">
          <ul>
            {report.notCounted.map((group) => (
              <li key={group.reason}>
                {group.label}: <Money value={group.amount} />
                {group.note ? <div className={ui.muted}>{group.note}</div> : null}
                <ItemList items={group.items} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {report.ineligible.length > 0 ? (
        <Card title="Ineligible expenditure tagged to R&D" description="For the return's evaluation questions; not part of the claim.">
          <ul>
            {report.ineligible.map((group) => (
              <li key={group.reason}>
                {group.label} {group.source ? <span className={ui.muted}>({group.source})</span> : null}: <Money value={group.amount} />
                <ItemList items={group.items} />
              </li>
            ))}
          </ul>
          <p>
            Total: <Money value={report.ineligibleTotal} />, plus <Money value={f.overseasOverLimit} /> overseas over the limit.
          </p>
        </Card>
      ) : null}

      <Card title="Pay" description={RD_PAYROLL_NOTE}>
        <div className={ui.statRow}>
          <Stat label="Counts" value={<Money value={report.payroll.counted} />} />
          <Stat label="Default split, no time record" value={<Money value={report.payroll.defaultSplit} />} />
          <Stat label="Pays entered late" value={report.payroll.lateCount} />
        </div>
        {report.payroll.detail && report.payroll.pays ? (
          report.payroll.pays.length === 0 ? (
            <Empty>No approved pay runs this year.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Pay</th>
                    <th>Employee</th>
                    <th className={ui.num}>Employee cost</th>
                    <th>R&amp;D shares</th>
                    <th>Time record</th>
                  </tr>
                </thead>
                <tbody>
                  {report.payroll.pays.map((pay) => (
                    <tr key={`${pay.payRunId}-${pay.employeeId}`}>
                      <td data-label="Pay">
                        {pay.payRunReference} paid {formatDate(pay.payDate)}
                      </td>
                      <td data-label="Employee">{pay.employeeName}</td>
                      <td data-label="Employee cost" className={ui.num}>
                        <Money value={pay.cost} />
                      </td>
                      <td data-label="R&D shares">
                        {pay.shares.length === 0 ? <span className={ui.muted}>Not R&amp;D</span> : null}
                        {pay.shares.map((share) => (
                          <div key={`${share.source}-${share.activityId}`}>
                            {share.percentage}%{share.hours ? ` (${share.hours} h on timesheets)` : ""}: <Money value={share.amount} />{" "}
                            {share.counts ? null : <Badge tone="amber">Default split, no time record</Badge>}
                          </div>
                        ))}
                        {pay.laterTimesheets.map((later) => (
                          <div key={later.weekStart} className={ui.muted}>
                            Timesheet for the week of {formatDate(later.weekStart)} approved after this pay: {later.rdHours} R&amp;D hours not used
                          </div>
                        ))}
                      </td>
                      <td data-label="Time record">
                        {pay.shares.map((share) => (
                          <div key={`${share.source}-${share.activityId}`}>
                            {share.enteredLate ? <Badge tone="amber">Entered late</Badge> : null} <span className={ui.muted}>{share.timelinessText}</span>
                          </div>
                        ))}
                        {pay.shares.length === 0 ? <span className={ui.muted}>{pay.timelinessText}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <p className={ui.muted}>Each employee&apos;s pay is shown only to people with payroll access; these are totals.</p>
        )}
      </Card>

      <OverheadRules organisationId={organisationId} report={report} onChanged={loaded.reload} />

      <Card title="Deadlines" description={report.deadlines.note}>
        {report.deadlines.supported ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Due</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {report.deadlines.deadlines.map((deadline) => (
                  <tr key={deadline.kind}>
                    <td data-label="What">{deadline.label}</td>
                    <td data-label="Due">
                      {deadline.dueWeekday} {formatDate(deadline.dueDate)}
                      {deadline.onTimeBy !== deadline.dueDate ? ` (on time if received ${deadline.onTimeByWeekday} ${formatDate(deadline.onTimeBy)})` : ""}
                    </td>
                    <td data-label="Source" className={ui.muted}>
                      {deadline.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card title="Notes">
        <ul>
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>
            Records entered more than {RD_LATE_AFTER_DAYS} days after the work are flagged “entered late” ({report.lateCount} this year); they still count. Tags
            changed after they were entered: {report.changedCount}.
          </li>
          <li>Not worked out here: refundability and labour-related taxes, the previous year&apos;s figures, feedstock output values, joint ventures.</li>
        </ul>
      </Card>
    </>
  );
}

type RuleDraft = { accountCode: string; activityId: string; percentage: string; basis: RdOverheadBasis | ""; basisDetail: string; effectiveFrom: string; effectiveTo: string };

function RuleForm({
  organisationId,
  rule,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  /** Changing this rule, or a new one. */
  rule: RdOverheadRule | null;
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const activities = useRdActivities(organisationId);
  const [idempotencyKey] = useState(() => newIdempotencyKey("rd-rule"));
  const [draft, setDraft] = useState<RuleDraft>({
    accountCode: rule?.accountCode ?? "",
    activityId: rule?.activity.id ?? "",
    percentage: rule?.percentage ?? "",
    basis: rule?.basis ?? "",
    basisDetail: rule?.basisDetail ?? "",
    effectiveFrom: rule?.effectiveFrom ?? "",
    effectiveTo: "",
  });
  const [workings, setWorkings] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workings) {
      setError("Attach the workings that show how the % was worked out (IR1240 p 15, p 102).");
      return;
    }
    const problem = tooBig(workings);
    if (problem) {
      setError(problem);
      return;
    }
    const form = new FormData();
    form.set("organisationId", organisationId);
    form.set("idempotencyKey", idempotencyKey);
    form.set("percentage", draft.percentage);
    form.set("basis", draft.basis);
    form.set("basisDetail", draft.basisDetail);
    form.set("effectiveFrom", draft.effectiveFrom);
    if (!rule) {
      form.set("accountCode", draft.accountCode);
      form.set("activityId", draft.activityId);
      form.set("effectiveTo", draft.effectiveTo);
    }
    form.set("file", workings, workings.name);
    setBusy(true);
    setError(null);
    try {
      const saved = (await postForm<{ rule: RdOverheadRule }>(rule ? `/api/rd/overhead-rules/${rule.id}/change` : "/api/rd/overhead-rules", form)).rule;
      onSaved(`${rule ? "Changed" : "Set"} the rule: ${saved.percentage}% of ${saved.accountCode} to ${saved.activity.code} from ${formatDate(saved.effectiveFrom)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<RuleDraft>) => setDraft({ ...draft, ...patch });
  return (
    <form onSubmit={(event) => void submit(event)} className={ui.fieldSection}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {rule ? (
        <p className={ui.muted}>
          Changing keeps this rule. From its start date ({formatDate(rule.effectiveFrom)}) the new rule replaces it; from a later date this one ends the day before.
        </p>
      ) : null}
      <div className={ui.grid3}>
        {rule ? null : (
          <>
            <Field label="Account">
              <AccountSelect
                accounts={accounts.data?.accounts ?? []}
                filter={(account) => account.accountClass === "expense" && account.accountType !== "depreciation"}
                value={draft.accountCode}
                required
                onChange={(accountCode) => set({ accountCode })}
              />
            </Field>
            <Field label="R&D activity">
              <select value={draft.activityId} required onChange={(event) => set({ activityId: event.target.value })}>
                <option value="">Choose an activity</option>
                {(activities.data?.activities ?? []).map((activity) => (
                  <option key={activity.id} value={activity.id}>
                    {activityText(activity)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="% of the account">
          <input inputMode="decimal" value={draft.percentage} required onChange={(event) => set({ percentage: event.target.value })} />
        </Field>
        <Field label="Basis" hint="IR1240 p 15">
          <select value={draft.basis} required onChange={(event) => set({ basis: event.target.value as RdOverheadBasis })}>
            <option value="">Choose a basis</option>
            {RD_OVERHEAD_BASIS_CODES.map((code) => (
              <option key={code} value={code}>
                {RD_OVERHEAD_BASES[code]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How it was worked out" hint="e.g. lab 30 m² of 200 m²">
          <input value={draft.basisDetail} maxLength={500} required onChange={(event) => set({ basisDetail: event.target.value })} />
        </Field>
        <Field label={rule ? "Change from" : "From"}>
          <input type="date" value={draft.effectiveFrom} required onChange={(event) => set({ effectiveFrom: event.target.value })} />
        </Field>
        {rule ? null : (
          <Field label="To (optional)">
            <input type="date" value={draft.effectiveTo} onChange={(event) => set({ effectiveTo: event.target.value })} />
          </Field>
        )}
        <Field label="Workings" hint="Required: the calculation, e.g. a floor plan. Up to 10 MB.">
          <input type="file" required onChange={(event) => setWorkings(event.target.files?.[0] ?? null)} />
        </Field>
      </div>
      <p className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {rule ? "Change the rule" : "Set the rule"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </p>
    </form>
  );
}

function EndRuleForm({ organisationId, rule, onSaved, onCancel }: { organisationId: string; rule: RdOverheadRule; onSaved: (text: string) => void; onCancel: () => void }) {
  const [effectiveTo, setEffectiveTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rd/overhead-rules/${rule.id}/end`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, effectiveTo }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? `Couldn't end the rule (${response.status}).`);
      onSaved(`The rule ends on ${formatDate(effectiveTo)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className={ui.inlineForm}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Last day">
        <input type="date" value={effectiveTo} required onChange={(event) => setEffectiveTo(event.target.value)} />
      </Field>
      <Button type="submit" disabled={busy}>
        End the rule
      </Button>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function OverheadRules({ organisationId, report, onChanged }: { organisationId: string; report: RdClaimReport; onChanged: () => void }) {
  const { can } = useWorkspace();
  const rules = useApiData<{ rules: RdOverheadRule[] }>("/api/rd/overhead-rules", { organisationId });
  const [editing, setEditing] = useState<{ mode: "new" | "change" | "end"; rule: RdOverheadRule | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const saved = (text: string) => {
    setEditing(null);
    setMessage(text);
    rules.reload();
    onChanged();
  };
  const applied = new Map(report.overheads.map((entry) => [entry.rule.id, entry]));
  const list = rules.data?.rules ?? [];
  return (
    <Card
      title="Overhead rules"
      description="A % of an expense account to an activity, with its basis and workings (IR1240 p 15, p 63; decision 46). Applied when this report runs; a line with its own tag keeps it."
      actions={can("bookkeeper") && !editing ? <Button onClick={() => setEditing({ mode: "new", rule: null })}>Set a rule</Button> : null}
    >
      {message ? <Notice tone="success">{message}</Notice> : null}
      {rules.error ? <Notice tone="error">{rules.error}</Notice> : null}
      {editing?.mode === "new" ? <RuleForm organisationId={organisationId} rule={null} onSaved={saved} onCancel={() => setEditing(null)} /> : null}
      {list.length === 0 ? <Empty>No overhead rules.</Empty> : null}
      {list.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Period</th>
                <th>Basis</th>
                <th className={ui.num}>{report.incomeYearLabel}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((rule) => {
                const entry = applied.get(rule.id);
                return (
                  <tr key={rule.id}>
                    <td data-label="Rule">
                      {rule.percentage}% of {rule.accountCode} {rule.accountName} to {rule.activity.code}{" "}
                      {rule.status === "replaced" ? <Badge>Replaced</Badge> : null} {rule.timeliness.enteredLate ? <Badge tone="amber">Entered late</Badge> : null}
                      <div className={ui.muted}>
                        Entered by {personName(rule, "createdBy")} on {formatDateTime(rule.createdAt)}
                        {rule.replacesId && rule.enteredAfterStart ? "; changed after the period it covers began" : ""}
                      </div>
                      {rule.files.map((file) => (
                        <div key={file.id}>
                          <a href={fileUrl(organisationId, file.id)} target="_blank" rel="noreferrer">
                            {file.fileName}
                          </a>
                        </div>
                      ))}
                    </td>
                    <td data-label="Period">
                      {formatDate(rule.effectiveFrom)} – {rule.effectiveTo ? formatDate(rule.effectiveTo) : "open"}
                    </td>
                    <td data-label="Basis">
                      {rule.basisLabel}: {rule.basisDetail}
                    </td>
                    <td data-label={report.incomeYearLabel} className={ui.num}>
                      {entry ? <Money value={entry.amount} /> : rule.status === "replaced" ? <span className={ui.muted}>replaced</span> : "–"}
                      {entry?.previous ? (
                        <div className={ui.muted}>
                          previously <Money value={entry.previous.amount} />
                        </div>
                      ) : null}
                      {entry && entry.skipped.length > 0 ? <div className={ui.muted}>{entry.skipped.length} line(s) with their own tag skipped</div> : null}
                    </td>
                    <td>
                      {can("bookkeeper") && rule.status === "active" && !rule.replacedById && !editing ? (
                        <span className={ui.rowButtons}>
                          <Button variant="secondary" size="small" onClick={() => setEditing({ mode: "change", rule })}>
                            Change
                          </Button>
                          <Button variant="secondary" size="small" onClick={() => setEditing({ mode: "end", rule })}>
                            End
                          </Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing?.mode === "change" && editing.rule ? <RuleForm organisationId={organisationId} rule={editing.rule} onSaved={saved} onCancel={() => setEditing(null)} /> : null}
      {editing?.mode === "end" && editing.rule ? <EndRuleForm organisationId={organisationId} rule={editing.rule} onSaved={saved} onCancel={() => setEditing(null)} /> : null}
    </Card>
  );
}
