"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { ReportExport } from "@/components/reports/report-export";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import type { BudgetRate, RateOverride } from "@/lib/consolidation/groups";
import type { IntercompanySettings } from "@/lib/consolidation/intercompany";
import type { ConsolidatedBudgetVsActual, ConsolidatedReport, ConsolidationAdjustment, ConsolidationGroup, MonthRates } from "@/lib/consolidation/types";
import type { Contact } from "@/lib/contacts/service";
import type { EcbSettings } from "@/lib/fx/ecb";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney, todayInBrowser } from "@/lib/format";

/**
 * Consolidation on screen (CO1-CO11, FX1): the groups, a group's
 * consolidated reports, its rates and adjustments, each member's
 * intercompany settings, and ECB rates on the exchange rates page.
 */

const TABS = [
  ["profit_and_loss", "Profit and loss"],
  ["balance_sheet", "Balance sheet"],
  ["budget_vs_actual", "Budget vs actual"],
  ["rates", "Rates"],
  ["adjustments", "Adjustments"],
  ["intercompany", "Intercompany"],
  ["settings", "Group"],
] as const;
type Tab = (typeof TABS)[number][0];

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Reports › Consolidation: the groups you can see, and making one. */
export function ConsolidationGroups() {
  const { organisations } = useWorkspace();
  const loaded = useApiData<{ groups: ConsolidationGroup[] }>("/api/consolidation/groups");
  const adminOf = organisations.filter((organisation) => organisation.role === "admin" || organisation.role === "owner");
  const [name, setName] = useState("");
  const [parent, setParent] = useState(adminOf[0]?.id ?? "");
  const [others, setOthers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Card title="Consolidation groups" description="Organisations on this server reported together in the parent's currency, with intercompany amounts eliminated. You see a group when you're a member of every organisation in it.">
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {loaded.data && loaded.data.groups.length === 0 ? <Empty>No consolidation groups you can see.</Empty> : null}
        {loaded.data && loaded.data.groups.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Currency</th>
                  <th>Organisations</th>
                </tr>
              </thead>
              <tbody>
                {loaded.data.groups.map((group) => (
                  <tr key={group.id}>
                    <td data-label="Group">
                      <Link href={`/operations/reports/consolidation/${group.id}`}>{group.name}</Link>
                    </td>
                    <td data-label="Currency">{group.currencyCode}</td>
                    <td data-label="Organisations">{group.members.map((member) => `${member.name} (${member.currencyCode})`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {adminOf.length >= 2 ? (
        <Card title="Make a group" description="The parent's currency and year end are the group's. You need to be an admin or owner of every organisation in it.">
          {error ? <Notice tone="error">{error}</Notice> : null}
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await api("/api/consolidation/groups", { method: "POST", body: { name, parentOrganisationId: parent, organisationIds: others } });
                setName("");
                setOthers([]);
                loaded.reload();
              } catch (caught) {
                setError(errorMessage(caught));
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className={ui.inlineForm}>
              <Field label="Name">
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
              </Field>
              <Field label="Parent">
                <select value={parent} onChange={(event) => setParent(event.target.value)}>
                  {adminOf.map((organisation) => (
                    <option key={organisation.id} value={organisation.id}>
                      {organisation.displayName} ({organisation.baseCurrency})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className={ui.choiceList} aria-label="Organisations in the group">
              {adminOf
                .filter((organisation) => organisation.id !== parent)
                .map((organisation) => (
                  <label key={organisation.id} className={ui.checkbox}>
                    <input
                      type="checkbox"
                      checked={others.includes(organisation.id)}
                      onChange={(event) => setOthers(event.target.checked ? [...others, organisation.id] : others.filter((id) => id !== organisation.id))}
                    />{" "}
                    {organisation.displayName} ({organisation.baseCurrency})
                  </label>
                ))}
            </div>
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" disabled={busy || others.length === 0}>
                Make the group
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function ReportTable({ report, id, showOwn }: { report: ConsolidatedReport; id: string; showOwn: boolean }) {
  const members = report.group.members;
  const foreign = members.filter((member) => member.currencyCode !== report.currencyCode);
  const cells = (line: ConsolidatedReport["sections"][number]["lines"][number]) => (
    <>
      {members.map((member) => (
        <td key={member.organisationId} data-label={member.name} className={ui.num}>
          <Money value={line.amounts[member.organisationId]} blankZero />
          {showOwn && line.ownAmounts && line.ownAmounts[member.organisationId] !== undefined ? (
            <div className={ui.muted}>
              {member.currencyCode} {formatMoney(line.ownAmounts[member.organisationId])}
            </div>
          ) : null}
        </td>
      ))}
      <td data-label="Eliminations" className={ui.num}>
        <Money value={line.eliminations} blankZero />
      </td>
      <td data-label="Consolidated" className={ui.num}>
        <Money value={line.consolidated} />
      </td>
    </>
  );
  return (
    <div className={ui.tableWrap}>
      <table id={id} className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Account</th>
            {members.map((member) => (
              <th key={member.organisationId} className={ui.num}>
                {member.name}
                {foreign.includes(member) ? ` (${member.currencyCode} in ${report.currencyCode})` : ""}
              </th>
            ))}
            <th className={ui.num}>Eliminations</th>
            <th className={ui.num}>Consolidated ({report.currencyCode})</th>
          </tr>
        </thead>
        <tbody>
          {report.sections.map((section) => (
            <SectionRows key={section.key} section={section} cells={cells} colSpan={members.length + 3} />
          ))}
          {report.totals.map((line) => (
            <tr key={line.name} className={ui.reportTotal}>
              <td data-label="Account">{line.name}</td>
              {cells(line)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionRows({
  section,
  cells,
  colSpan,
}: {
  section: ConsolidatedReport["sections"][number];
  cells: (line: ConsolidatedReport["sections"][number]["lines"][number]) => React.ReactNode;
  colSpan: number;
}) {
  return (
    <>
      <tr className={ui.reportHeading}>
        <td colSpan={colSpan}>{section.label}</td>
      </tr>
      {section.lines.map((line) => (
        <tr key={`${section.key}-${line.code}-${line.name}`}>
          <td data-label="Account">{line.code ? `${line.code} ${line.name}` : line.name}</td>
          {cells(line)}
        </tr>
      ))}
      {section.key !== "intercompany_differences" ? (
        <tr className={ui.reportTotal}>
          <td data-label="Account">{section.total.name}</td>
          {cells(section.total)}
        </tr>
      ) : null}
    </>
  );
}

function Reports({ group, kind }: { group: ConsolidationGroup; kind: "profit_and_loss" | "balance_sheet" }) {
  const today = todayInBrowser();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [showOwn, setShowOwn] = useState(false);
  const loaded = useApiData<{ report: ConsolidatedReport }>(`/api/consolidation/groups/${group.id}/reports`, kind === "balance_sheet" ? { report: kind, asAt: to } : { report: kind, from, to });
  const report = loaded.data?.report;
  const title = kind === "balance_sheet" ? "Consolidated balance sheet" : "Consolidated profit and loss";
  const period = kind === "balance_sheet" ? `As at ${formatDate(to)}` : `${formatDate(from)} to ${formatDate(to)}`;
  return (
    <Card
      title={title}
      actions={
        <div className={ui.inlineForm}>
          {kind === "profit_and_loss" ? (
            <Field label="From">
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
          ) : null}
          <Field label={kind === "balance_sheet" ? "As at" : "To"}>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          {group.members.some((member) => member.currencyCode !== group.currencyCode) ? (
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showOwn} onChange={(event) => setShowOwn(event.target.checked)} /> Own currencies too
            </label>
          ) : null}
        </div>
      }
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {!report && !loaded.error ? <p className={ui.muted}>Loading…</p> : null}
      {report ? (
        <>
          {report.notices.map((notice) => (
            <Notice key={notice} tone="warning">
              {notice}
            </Notice>
          ))}
          <ReportExport
            organisationId={group.parentOrganisationId}
            report={kind === "balance_sheet" ? "consolidated-balance-sheet" : "consolidated-profit-and-loss"}
            title={`${title}: ${group.name}`}
            period={period}
            filters={[`In ${report.currencyCode}; the group's year starts ${formatDate(report.yearStart)}`]}
            tables={[{ id: `consolidated-${kind}` }]}
          />
          <ReportTable report={report} id={`consolidated-${kind}`} showOwn={showOwn} />
        </>
      ) : null}
    </Card>
  );
}

function BudgetVsActual({ group }: { group: ConsolidationGroup }) {
  const today = todayInBrowser();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const loaded = useApiData<{ report: ConsolidatedBudgetVsActual }>(`/api/consolidation/groups/${group.id}/reports`, { report: "budget_vs_actual", from, to });
  const report = loaded.data?.report;
  return (
    <Card
      title="Consolidated budget vs actual"
      description="Each organisation's overall budget at the month's budget exchange rate, against the consolidated actuals."
      actions={
        <div className={ui.inlineForm}>
          <Field label="From">
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>
      }
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {report ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Account</th>
                <th className={ui.num}>Actual</th>
                <th className={ui.num}>Budget</th>
                <th className={ui.num}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {report.lines.map((line) => (
                <tr key={line.code}>
                  <td data-label="Account">
                    {line.code} {line.name}
                  </td>
                  <td data-label="Actual" className={ui.num}>
                    <Money value={line.actual} />
                  </td>
                  <td data-label="Budget" className={ui.num}>
                    <Money value={line.budget} />
                  </td>
                  <td data-label="Variance" className={ui.num}>
                    <Money value={line.variance} />
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

type GroupDetail = { group: ConsolidationGroup; adjustments: ConsolidationAdjustment[]; rateOverrides: RateOverride[]; budgetRates: BudgetRate[] };

function Rates({ detail, canAdmin, onChanged }: { detail: GroupDetail; canAdmin: boolean; onChanged: () => void }) {
  const { group } = detail;
  const today = todayInBrowser();
  const loaded = useApiData<{ rates: MonthRates[] }>(`/api/consolidation/groups/${group.id}/reports`, { report: "rates", to: today });
  const foreign = [...new Set(group.members.filter((member) => member.currencyCode !== group.currencyCode).map((member) => member.currencyCode))];
  const [form, setForm] = useState({ currencyCode: foreign[0] ?? "", month: today.slice(0, 7), kind: "average", rate: "", reason: "" });
  const [budget, setBudget] = useState({ currencyCode: foreign[0] ?? "", month: today.slice(0, 7), rate: "" });
  const [error, setError] = useState<string | null>(null);
  const save = async (path: string, body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(path, { method: "PUT", body });
      onChanged();
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  if (foreign.length === 0) return <Card title="Rates">Every organisation is in {group.currencyCode}, so nothing is translated.</Card>;
  const name = (id: string) => group.members.find((member) => member.organisationId === id)?.name ?? id;
  return (
    <>
      <Card
        title="Consolidation rates"
        description={`${group.currencyCode} per 1 unit, worked out from the parent's exchange rates list: current is the rate at the month's end (balance sheet), average is weighted by the month's profit and loss amounts, historical by its equity amounts (NetSuite's consolidated exchange rates).`}
      >
        {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loaded.data ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Month</th>
                  <th className={ui.num}>Current</th>
                  <th className={ui.num}>Average</th>
                  <th className={ui.num}>Historical</th>
                </tr>
              </thead>
              <tbody>
                {loaded.data.rates.map((row) => (
                  <tr key={`${row.organisationId}-${row.month}`}>
                    <td data-label="Organisation">
                      {name(row.organisationId)} ({row.currencyCode})
                    </td>
                    <td data-label="Month">{formatDate(row.month).replace(/^\d+\s/, "")}</td>
                    {(["current", "average", "historical"] as const).map((kind) => (
                      <td key={kind} data-label={kind} className={ui.num}>
                        {row[kind] ?? <span className={ui.muted}>-</span>} {row.changed.includes(kind) ? <Badge tone="amber">Changed</Badge> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {detail.rateOverrides.length > 0 ? (
          <ul className={ui.relatedList}>
            {detail.rateOverrides.map((entry) => (
              <li key={`${entry.currencyCode}-${entry.month}-${entry.kind}`}>
                {entry.currencyCode} {entry.month.slice(0, 7)} {entry.kind}: {entry.rate} ({entry.reason}; {entry.changedByEmail}, {formatDateTime(entry.changedAt)})
              </li>
            ))}
          </ul>
        ) : null}
        {canAdmin ? (
          <form
            className={ui.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void save(`/api/consolidation/groups/${group.id}/rates`, form);
            }}
          >
            <Field label="Currency">
              <select value={form.currencyCode} onChange={(event) => setForm({ ...form, currencyCode: event.target.value })}>
                {foreign.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </Field>
            <Field label="Month">
              <input type="month" value={form.month} onChange={(event) => setForm({ ...form, month: event.target.value })} required />
            </Field>
            <Field label="Rate">
              <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
                <option value="current">Current</option>
                <option value="average">Average</option>
                <option value="historical">Historical</option>
              </select>
            </Field>
            <Field label="Change to" hint="Blank goes back to the worked-out rate.">
              <input value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} inputMode="decimal" />
            </Field>
            <Field label="Reason">
              <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} maxLength={200} />
            </Field>
            <Button type="submit">Save rate</Button>
          </form>
        ) : null}
      </Card>
      <Card title="Budget exchange rates" description="One rate a month for each organisation's currency, for the consolidated budget vs actual. Typed by an admin (NetSuite's budget exchange rates).">
        {detail.budgetRates.length === 0 ? <Empty>No budget exchange rates yet.</Empty> : null}
        {detail.budgetRates.length > 0 ? (
          <ul className={ui.relatedList}>
            {detail.budgetRates.map((entry) => (
              <li key={`${entry.currencyCode}-${entry.month}`}>
                {entry.currencyCode} {entry.month.slice(0, 7)}: {entry.rate}
              </li>
            ))}
          </ul>
        ) : null}
        {canAdmin ? (
          <form
            className={ui.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void save(`/api/consolidation/groups/${group.id}/budget-rates`, budget);
            }}
          >
            <Field label="Currency">
              <select value={budget.currencyCode} onChange={(event) => setBudget({ ...budget, currencyCode: event.target.value })}>
                {foreign.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </Field>
            <Field label="Month">
              <input type="month" value={budget.month} onChange={(event) => setBudget({ ...budget, month: event.target.value })} required />
            </Field>
            <Field label={`Rate (${group.currencyCode} per 1)`}>
              <input value={budget.rate} onChange={(event) => setBudget({ ...budget, rate: event.target.value })} inputMode="decimal" />
            </Field>
            <Button type="submit">Save budget rate</Button>
          </form>
        ) : null}
      </Card>
    </>
  );
}

function Adjustments({ detail, canEdit, onChanged }: { detail: GroupDetail; canEdit: boolean; onChanged: () => void }) {
  const { group } = detail;
  const confirm = useConfirm();
  const blankLine = { organisationId: group.parentOrganisationId, accountCode: "", debit: "", credit: "" };
  const [date, setDate] = useState(todayInBrowser());
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState([blankLine, { ...blankLine }]);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => group.members.find((member) => member.organisationId === id)?.name ?? id;
  return (
    <Card title="Elimination adjustments" description={`Lines by organisation and account code, in ${group.currencyCode}, e.g. an investment in a subsidiary against its share capital. They're only in the consolidation: nothing is posted in any organisation.`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {detail.adjustments.length === 0 ? <Empty>No adjustments.</Empty> : null}
      {detail.adjustments.map((adjustment) => (
        <div key={adjustment.id} className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <caption style={{ textAlign: "left", fontWeight: 600, padding: "8px 0" }}>
              {formatDate(adjustment.date)}: {adjustment.description}{" "}
              {canEdit ? (
                <Button
                  size="small"
                  variant="danger"
                  onClick={async () => {
                    if (!(await confirm(`Remove "${adjustment.description}"?`))) return;
                    try {
                      await api(`/api/consolidation/groups/${group.id}/adjustments/${adjustment.id}`, { method: "DELETE" });
                      onChanged();
                    } catch (caught) {
                      setError(errorMessage(caught));
                    }
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </caption>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Account</th>
                <th className={ui.num}>Debit</th>
                <th className={ui.num}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {adjustment.lines.map((line, index) => (
                <tr key={index}>
                  <td data-label="Organisation">{name(line.organisationId)}</td>
                  <td data-label="Account">{line.accountCode}</td>
                  <td data-label="Debit" className={ui.num}>
                    <Money value={line.debit} blankZero />
                  </td>
                  <td data-label="Credit" className={ui.num}>
                    <Money value={line.credit} blankZero />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {canEdit ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await api(`/api/consolidation/groups/${group.id}/adjustments`, { method: "POST", body: { date, description, lines } });
              setDescription("");
              setLines([blankLine, { ...blankLine }]);
              onChanged();
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        >
          <div className={ui.inlineForm}>
            <Field label="Date">
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
            </Field>
            <Field label="Description">
              <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={200} required />
            </Field>
          </div>
          {lines.map((line, index) => (
            <div key={index} className={ui.inlineForm}>
              <Field label="Organisation">
                <select value={line.organisationId} onChange={(event) => setLines(lines.map((item, at) => (at === index ? { ...item, organisationId: event.target.value } : item)))}>
                  {group.members.map((member) => (
                    <option key={member.organisationId} value={member.organisationId}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Account code">
                <input value={line.accountCode} onChange={(event) => setLines(lines.map((item, at) => (at === index ? { ...item, accountCode: event.target.value } : item)))} size={8} required />
              </Field>
              <Field label="Debit">
                <input value={line.debit} onChange={(event) => setLines(lines.map((item, at) => (at === index ? { ...item, debit: event.target.value } : item)))} inputMode="decimal" size={10} />
              </Field>
              <Field label="Credit">
                <input value={line.credit} onChange={(event) => setLines(lines.map((item, at) => (at === index ? { ...item, credit: event.target.value } : item)))} inputMode="decimal" size={10} />
              </Field>
            </div>
          ))}
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button variant="secondary" onClick={() => setLines([...lines, { ...blankLine }])}>
              Add a line
            </Button>
            <Button type="submit">Add adjustment</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

function MemberIntercompany({ group, organisationId, name, canEdit }: { group: ConsolidationGroup; organisationId: string; name: string; canEdit: boolean }) {
  const loaded = useApiData<{ intercompany: IntercompanySettings }>("/api/intercompany", { organisationId });
  const accounts = useApiData<{ accounts: Account[] }>(canEdit ? "/api/accounts" : null, { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>(canEdit ? "/api/contacts" : null, { organisationId });
  const [accountId, setAccountId] = useState("");
  const [contactId, setContactId] = useState("");
  const others = group.members.filter((member) => member.organisationId !== organisationId);
  const [counterpart, setCounterpart] = useState(others[0]?.organisationId ?? "");
  const [error, setError] = useState<string | null>(null);
  const current = loaded.data?.intercompany;
  const memberName = (id: string) => group.members.find((member) => member.organisationId === id)?.name ?? id;
  const save = async (next: IntercompanySettings) => {
    setError(null);
    try {
      await api("/api/intercompany", {
        method: "PUT",
        body: {
          organisationId,
          accounts: next.accounts.map((entry) => ({ accountId: entry.accountId, counterpartOrganisationId: entry.counterpartOrganisationId })),
          contacts: next.contacts.map((entry) => ({ contactId: entry.contactId, counterpartOrganisationId: entry.counterpartOrganisationId })),
        },
      });
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title={name} description="Accounts that hold amounts with another organisation in the group (eliminated), and the contact that stands for each other organisation (what's owed between them).">
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {current ? (
        <ul className={ui.relatedList}>
          {current.accounts.map((entry) => (
            <li key={entry.accountId}>
              Account {entry.code} {entry.name}: with {memberName(entry.counterpartOrganisationId)}{" "}
              {canEdit ? (
                <Button size="small" variant="secondary" onClick={() => save({ ...current, accounts: current.accounts.filter((item) => item.accountId !== entry.accountId) })}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
          {current.contacts.map((entry) => (
            <li key={entry.contactId}>
              Contact {entry.name}: is {memberName(entry.counterpartOrganisationId)}{" "}
              {canEdit ? (
                <Button size="small" variant="secondary" onClick={() => save({ ...current, contacts: current.contacts.filter((item) => item.contactId !== entry.contactId) })}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
          {current.accounts.length + current.contacts.length === 0 ? <li className={ui.muted}>Nothing marked.</li> : null}
        </ul>
      ) : null}
      {canEdit && current ? (
        <div className={ui.inlineForm}>
          <Field label="With">
            <select value={counterpart} onChange={(event) => setCounterpart(event.target.value)}>
              {others.map((member) => (
                <option key={member.organisationId} value={member.organisationId}>
                  {member.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Account">
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">Choose an account</option>
              {(accounts.data?.accounts ?? [])
                .filter((account) => account.isActive)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} {account.name}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            variant="secondary"
            disabled={!accountId}
            onClick={() => {
              const account = accounts.data?.accounts.find((item) => item.id === accountId);
              if (account) void save({ ...current, accounts: [...current.accounts, { accountId, code: account.code, name: account.name, counterpartOrganisationId: counterpart }] });
            }}
          >
            Mark account
          </Button>
          <Field label="Contact">
            <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
              <option value="">Choose a contact</option>
              {(contacts.data?.contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="secondary"
            disabled={!contactId}
            onClick={() => {
              const contact = contacts.data?.contacts.find((item) => item.id === contactId);
              if (contact) void save({ ...current, contacts: [...current.contacts.filter((item) => item.counterpartOrganisationId !== counterpart), { contactId, name: contact.name, counterpartOrganisationId: counterpart }] });
            }}
          >
            Link contact
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function GroupSettings({ detail, onChanged }: { detail: GroupDetail; onChanged: () => void }) {
  const { group } = detail;
  const { organisations } = useWorkspace();
  const adminOf = organisations.filter((organisation) => organisation.role === "admin" || organisation.role === "owner");
  const [name, setName] = useState(group.name);
  const [members, setMembers] = useState(group.members.map((member) => member.organisationId));
  const [error, setError] = useState<string | null>(null);
  const canAdmin = group.members.every((member) => adminOf.some((organisation) => organisation.id === member.organisationId));
  return (
    <Card title="Group" description={`Reports in ${group.currencyCode} with the parent's year end. Made by ${group.createdByEmail}, ${formatDateTime(group.createdAt)}.`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className={ui.relatedList}>
        {group.members.map((member, index) => (
          <li key={member.organisationId}>
            {member.name} ({member.currencyCode}){index === 0 ? " · parent" : ""}
          </li>
        ))}
      </ul>
      {canAdmin ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await api(`/api/consolidation/groups/${group.id}`, { method: "PUT", body: { name, organisationIds: members, version: group.version } });
              onChanged();
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
          </Field>
          <div className={ui.choiceList} aria-label="Organisations">
            {adminOf.map((organisation) => (
              <label key={organisation.id} className={ui.checkbox}>
                <input
                  type="checkbox"
                  disabled={organisation.id === group.parentOrganisationId}
                  checked={members.includes(organisation.id)}
                  onChange={(event) => setMembers(event.target.checked ? [...members, organisation.id] : members.filter((id) => id !== organisation.id))}
                />{" "}
                {organisation.displayName} ({organisation.baseCurrency})
              </label>
            ))}
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button type="submit">Save group</Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

/** Reports › Consolidation › a group. */
export function ConsolidationGroupView({ groupId }: { groupId: string }) {
  const { organisations } = useWorkspace();
  const loaded = useApiData<GroupDetail>(`/api/consolidation/groups/${groupId}`);
  const [tab, setTab] = useState<Tab>("profit_and_loss");
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const detail = loaded.data;
  const roleIn = (id: string) => organisations.find((organisation) => organisation.id === id)?.role;
  const everyAtLeast = (roles: string[]) => detail.group.members.every((member) => roles.includes(roleIn(member.organisationId) ?? ""));
  return (
    <>
      <div className={ui.tabs} role="tablist" aria-label="Consolidation">
        {TABS.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className={`${ui.tab} ${tab === value ? ui.tabActive : ""}`} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "profit_and_loss" || tab === "balance_sheet" ? <Reports key={tab} group={detail.group} kind={tab} /> : null}
      {tab === "budget_vs_actual" ? <BudgetVsActual group={detail.group} /> : null}
      {tab === "rates" ? <Rates detail={detail} canAdmin={everyAtLeast(["admin", "owner"])} onChanged={loaded.reload} /> : null}
      {tab === "adjustments" ? <Adjustments detail={detail} canEdit={everyAtLeast(["bookkeeper", "admin", "owner"])} onChanged={loaded.reload} /> : null}
      {tab === "intercompany"
        ? detail.group.members.map((member) => (
            <MemberIntercompany key={member.organisationId} group={detail.group} organisationId={member.organisationId} name={member.name} canEdit={["admin", "owner"].includes(roleIn(member.organisationId) ?? "")} />
          ))
        : null}
      {tab === "settings" ? <GroupSettings detail={detail} onChanged={loaded.reload} /> : null}
    </>
  );
}

/** On Exchange rates: daily rates from the European Central Bank (FX1). */
export function EcbRatesCard({ organisationId, canAdmin, onChanged }: { organisationId: string; canAdmin: boolean; onChanged: () => void }) {
  const loaded = useApiData<{ settings: EcbSettings }>("/api/exchange-rates/ecb", { organisationId });
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings = loaded.data?.settings;
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      loaded.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Rates from the European Central Bank"
      description="Each working day, the ECB's euro reference rates are added to this list for the currencies you use, worked out through the euro (rounded to 6 decimal places). A rate already in the list for a date is never replaced. Free, no account; the ECB says its rates are for information. Source: European Central Bank."
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      {settings ? (
        <>
          <p>
            {settings.enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>} Currencies: {settings.currencies.join(", ") || "none yet"}.
            {settings.lastRunAt ? ` Last checked ${formatDateTime(settings.lastRunAt)}${settings.lastRatesDate ? `, rates for ${formatDate(settings.lastRatesDate)}` : ""}.` : ""}
          </p>
          {settings.lastError ? <Notice tone="warning">{settings.lastError}</Notice> : null}
          {canAdmin ? (
            <div className={ui.inlineForm}>
              <Field label="Other currencies" hint="Comma separated, e.g. AUD for a consolidation member's currency.">
                <input value={extra || settings.extraCurrencies.join(", ")} onChange={(event) => setExtra(event.target.value)} />
              </Field>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/api/exchange-rates/ecb", {
                      method: "PUT",
                      body: { organisationId, enabled: !settings.enabled, extraCurrencies: (extra || settings.extraCurrencies.join(",")).split(",").map((code) => code.trim()).filter(Boolean) },
                    });
                    return settings.enabled ? "ECB rates are off." : "ECB rates are on.";
                  })
                }
              >
                {settings.enabled ? "Turn off" : "Turn on"}
              </Button>
              {settings.enabled ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api<{ added: number; error: string | null }>("/api/exchange-rates/ecb/check", { method: "POST", body: { organisationId } });
                      if (result.error) throw new Error(result.error);
                      return `${result.added} rate${result.added === 1 ? "" : "s"} added.`;
                    })
                  }
                >
                  Check now
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
