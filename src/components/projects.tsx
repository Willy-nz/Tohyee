"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, todayInBrowser, personName } from "@/lib/format";
import { CHARGE_TYPE_LABELS, CHARGE_TYPES, type ChargeType, formatMinutes, minutesAsHours, timeAmount } from "@/lib/projects/amounts";
import type {
  BilledOn,
  ExpenseSource,
  ExpenseSourceType,
  ProfitabilityReport,
  Project,
  ProjectStatus,
  ProjectSummary,
  StaffRate,
  TimeEntry,
  TimeReport,
} from "@/lib/projects/service";
import type { TaxCode } from "@/lib/tax/codes";

/**
 * Projects and time tracking (examples PJ1-PJ13): projects for a customer,
 * their tasks, time and linked expenses, invoicing what's unbilled, closing
 * and reopening, and the profitability and time reports.
 */

const STATUS_LABELS: Record<ProjectStatus, { label: string; tone: "blue" | "neutral" }> = {
  in_progress: { label: "In progress", tone: "blue" },
  closed: { label: "Closed", tone: "neutral" },
};

const SOURCE_LABELS: Record<ExpenseSourceType, string> = {
  bill_line: "Bill",
  expense_claim_receipt: "Expense claim",
  bank_transaction_line: "Spend money",
};

function StatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={STATUS_LABELS[status].tone}>{STATUS_LABELS[status].label}</Badge>;
}

function BilledBadge({ billed, writtenOff }: { billed: BilledOn | null; writtenOff?: string | null }) {
  if (billed) {
    return (
      <Link href={`/operations/invoices/${billed.invoiceId}`}>
        <Badge tone={billed.invoiceStatus === "approved" ? "green" : "amber"}>{billed.invoiceNumber ?? "Draft invoice"}</Badge>
      </Link>
    );
  }
  if (writtenOff) return <Badge tone="neutral">Written off</Badge>;
  return null;
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      done?.(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

// ---------------------------------------------------------------------------
// List and new project

const FILTERS: Array<{ label: string; status: ProjectStatus | null; empty: string }> = [
  { label: "In progress", status: "in_progress", empty: "No projects in progress." },
  { label: "Closed", status: "closed", empty: "No closed projects." },
  { label: "All", status: null, empty: "No projects yet." },
];

export function ProjectList({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState(FILTERS[0]);
  const list = useApiData<{ projects: ProjectSummary[] }>("/api/projects", { organisationId, status: filter.status });
  return (
    <Card
      title="Projects"
      description="Work for customers: time, expenses and what's still to invoice."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/projects/new")}>New project</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Projects">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => setFilter(entry)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.projects.length === 0 ? <Empty>{filter.empty}</Empty> : null}
      {list.data && list.data.projects.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Project</th>
                <th>Customer</th>
                <th>Deadline</th>
                <th>Status</th>
                <th className={ui.num}>Time</th>
                <th className={ui.num}>Unbilled</th>
                <th className={ui.num}>Invoiced</th>
                <th className={ui.num}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {list.data.projects.map((project) => (
                <tr key={project.id}>
                  <td data-label="Project">
                    <Link href={`/operations/projects/${project.id}`}>{project.name}</Link>
                  </td>
                  <td data-label="Customer">{project.contactName}</td>
                  <td data-label="Deadline">{project.deadline ? formatDate(project.deadline) : ""}</td>
                  <td data-label="Status">
                    <StatusBadge status={project.status} />
                  </td>
                  <td data-label="Time" className={ui.num}>
                    {formatMinutes(project.figures.minutes)}
                  </td>
                  <td data-label="Unbilled" className={ui.num}>
                    <Money value={project.figures.unbilled} />
                  </td>
                  <td data-label="Invoiced" className={ui.num}>
                    <Money value={project.figures.invoiced} />
                  </td>
                  <td data-label="Profit" className={ui.num}>
                    <Money value={project.figures.profit} />
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

/** A new project's details, or an open project's (the status only changes by closing or reopening). */
export function ProjectEditor({
  organisationId,
  project,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  project?: Project;
  onSaved: (project: Project) => void;
  onCancel: () => void;
}) {
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const [name, setName] = useState(project?.name ?? "");
  const [contactId, setContactId] = useState(project?.contactId ?? "");
  const [estimate, setEstimate] = useState(project?.estimate ?? "");
  const [deadline, setDeadline] = useState(project?.deadline ?? "");
  const [createKey] = useState(() => newIdempotencyKey("project"));
  const { busy, error, run } = useRun();
  if (contacts.error) return <Notice tone="error">{contacts.error}</Notice>;
  if (!contacts.data) return <p className={ui.muted}>Loading…</p>;
  const customers = contacts.data.contacts.filter((contact) => contact.isCustomer && !contact.isArchived);
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const body = { organisationId, name, contactId, estimate: estimate.trim() || null, deadline: deadline || null };
    void run(
      () =>
        project
          ? api<{ project: Project }>(`/api/projects/${project.id}`, { method: "PUT", body })
          : api<{ project: Project }>("/api/projects", { method: "POST", body: { ...body, source: "ui", idempotencyKey: createKey } }),
      (result) => onSaved(result.project),
    );
  };
  return (
    <form onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Project name">
          <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Customer" hint={project && project.invoices.length > 0 ? "It has invoices, so the customer can't change." : undefined}>
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required disabled={Boolean(project && project.invoices.length > 0)}>
            <option value="">Choose a customer</option>
            {customers.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimate (optional)" hint="What you expect to invoice, excluding GST.">
          <input inputMode="decimal" value={estimate} onChange={(event) => setEstimate(event.target.value)} />
        </Field>
        <Field label="Deadline (optional)">
          <input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : project ? "Save" : "Create project"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One project

function FiguresCard({ project }: { project: Project }) {
  const f = project.figures;
  return (
    <Card title={project.name} description={`For ${project.contactName}${project.deadline ? `, due ${formatDate(project.deadline)}` : ""}`} actions={<StatusBadge status={project.status} />}>
      <div className={ui.grid4}>
        <Stat label="Invoiced" value={<Money value={f.invoiced} />} />
        <Stat label="Costs" value={<Money value={f.costs} />} />
        <Stat label="Profit" value={<Money value={f.profit} />} />
        <Stat label="Unbilled" value={<Money value={f.unbilled} />} />
        <Stat label="Time" value={`${formatMinutes(f.minutes)} (cost ${f.timeCost})`} />
        <Stat label="Expenses at cost" value={<Money value={f.expenseCost} />} />
        {f.onDraftInvoices !== "0.00" ? <Stat label="On draft invoices" value={<Money value={f.onDraftInvoices} />} /> : null}
        {f.writtenOff !== "0.00" ? <Stat label="Written off" value={<Money value={f.writtenOff} />} /> : null}
        {project.estimate ? <Stat label="Estimate" value={<Money value={project.estimate} />} /> : null}
        {f.estimateLeft !== null ? <Stat label="Estimate left" value={<Money value={f.estimateLeft} />} /> : null}
      </div>
      <p className={ui.muted}>
        Projects post nothing: only their invoices do. Costs are expenses excluding GST plus time at each person&apos;s staff cost rate.
      </p>
    </Card>
  );
}

function TasksCard({ organisationId, project, onChanged }: { organisationId: string; project: Project; onChanged: (project: Project) => void }) {
  const { can } = useWorkspace();
  const open = project.status === "in_progress" && can("bookkeeper");
  const [name, setName] = useState("");
  const [chargeType, setChargeType] = useState<ChargeType>("hourly");
  const [rate, setRate] = useState("");
  const [estimateHours, setEstimateHours] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("task"));
  const { busy, error, run } = useRun();
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api<{ project: Project }>(`/api/projects/${project.id}/tasks`, {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey: key, name, chargeType, rate: chargeType === "non_chargeable" ? null : rate, estimateHours: estimateHours || null },
        }),
      (result) => {
        setName("");
        setRate("");
        setEstimateHours("");
        setKey(newIdempotencyKey("task"));
        onChanged(result.project);
      },
    );
  };
  const archive = (taskId: string) =>
    void run(() => api<{ project: Project }>(`/api/project-tasks/${taskId}/archive`, { method: "POST", body: { organisationId } }), (result) => onChanged(result.project));
  return (
    <Card title="Tasks">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {project.tasks.length === 0 ? <Empty>No tasks yet. Add one to start recording time.</Empty> : null}
      {project.tasks.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Task</th>
                <th>Charged</th>
                <th className={ui.num}>Estimate</th>
                <th className={ui.num}>Time</th>
                <th className={ui.num}>Unbilled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {project.tasks.map((task) => (
                <tr key={task.id}>
                  <td data-label="Task">
                    {task.name} {task.status === "archived" ? <Badge tone="neutral">Archived</Badge> : null}
                  </td>
                  <td data-label="Charged">
                    {CHARGE_TYPE_LABELS[task.chargeType]}
                    {task.chargeType === "hourly" ? ` · ${task.rate} an hour` : task.chargeType === "fixed" ? ` · ${task.rate}` : ""}{" "}
                    <BilledBadge billed={task.billedOn} writtenOff={task.writtenOffAt} />
                  </td>
                  <td data-label="Estimate" className={ui.num}>
                    {task.estimateMinutes ? formatMinutes(task.estimateMinutes) : ""}
                  </td>
                  <td data-label="Time" className={ui.num}>
                    {formatMinutes(task.minutes)}
                  </td>
                  <td data-label="Unbilled" className={ui.num}>
                    <Money value={task.unbilledAmount} blankZero />
                  </td>
                  <td>
                    {open && task.status === "active" ? (
                      <Button size="small" variant="secondary" disabled={busy} onClick={() => archive(task.id)}>
                        Archive
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <form className={ui.inlineForm} onSubmit={add}>
          <Field label="New task">
            <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Charged">
            <select value={chargeType} onChange={(event) => setChargeType(event.target.value as ChargeType)}>
              {CHARGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CHARGE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          {chargeType !== "non_chargeable" ? (
            <Field label={chargeType === "hourly" ? "Rate per hour" : "Price"}>
              <input inputMode="decimal" size={8} value={rate} onChange={(event) => setRate(event.target.value)} required />
            </Field>
          ) : null}
          <Field label="Estimate (hours)">
            <input inputMode="numeric" size={5} value={estimateHours} onChange={(event) => setEstimateHours(event.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            Add task
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function TimeCard({ organisationId, project, onChanged }: { organisationId: string; project: Project; onChanged: () => void }) {
  const { can, user } = useWorkspace();
  const open = project.status === "in_progress" && can("bookkeeper");
  const team = useApiData<{ rates: StaffRate[] }>(can("admin") ? "/api/project-staff-rates" : null, { organisationId });
  const activeTasks = project.tasks.filter((task) => task.status === "active");
  const [taskId, setTaskId] = useState(activeTasks[0]?.id ?? "");
  const [entryDate, setEntryDate] = useState(todayInBrowser());
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [description, setDescription] = useState("");
  const [userId, setUserId] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("time"));
  const [showRemoved, setShowRemoved] = useState(false);
  const { busy, error, run } = useRun();
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api(`/api/projects/${project.id}/time`, {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey: key, taskId, entryDate, hours, minutes, description: description || null, userId: userId || null },
        }),
      () => {
        setHours("");
        setMinutes("");
        setDescription("");
        setKey(newIdempotencyKey("time"));
        onChanged();
      },
    );
  };
  const remove = (entry: TimeEntry) => {
    if (!window.confirm(`Remove ${formatMinutes(entry.minutes)} on ${entry.taskName}?`)) return;
    void run(() => api(`/api/project-time/${entry.id}/remove`, { method: "POST", body: { organisationId } }), onChanged);
  };
  const entries = project.timeEntries.filter((entry) => showRemoved || entry.status === "active");
  const mayChange = (entry: TimeEntry) => open && entry.status === "active" && !entry.billedOn && !entry.writtenOffAt && (entry.userId === user.id || can("admin"));
  return (
    <Card title="Time" description="Recorded in hours and minutes. Each entry's cost uses the person's staff cost rate when it was entered.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {open && activeTasks.length > 0 ? (
        <form className={ui.inlineForm} onSubmit={add}>
          <Field label="Task">
            <select value={taskId} onChange={(event) => setTaskId(event.target.value)} required>
              {activeTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
          </Field>
          <Field label="Hours">
            <input inputMode="numeric" size={3} value={hours} onChange={(event) => setHours(event.target.value)} />
          </Field>
          <Field label="Minutes">
            <input inputMode="numeric" size={3} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          </Field>
          <Field label="Description">
            <input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          {team.data ? (
            <Field label="Whose time">
              <select value={userId} onChange={(event) => setUserId(event.target.value)}>
                <option value="">Mine</option>
                {team.data.rates
                  .filter((member) => member.userId !== user.id)
                  .map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.displayName || member.email}
                    </option>
                  ))}
              </select>
            </Field>
          ) : null}
          <Button type="submit" disabled={busy || !taskId}>
            Add time
          </Button>
        </form>
      ) : null}
      {entries.length === 0 ? <Empty>No time recorded.</Empty> : null}
      {entries.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Who</th>
                <th>Task</th>
                <th>Description</th>
                <th className={ui.num}>Time</th>
                <th className={ui.num}>Cost</th>
                <th>Invoice</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td data-label="Date">{formatDate(entry.entryDate)}</td>
                  <td data-label="Who">{personName(entry, "user")}</td>
                  <td data-label="Task">{entry.taskName}</td>
                  <td data-label="Description" className={ui.muted}>
                    {entry.description}
                  </td>
                  <td data-label="Time" className={ui.num}>
                    {formatMinutes(entry.minutes)}
                  </td>
                  <td data-label="Cost" className={ui.num}>
                    <Money value={entry.cost} />
                  </td>
                  <td data-label="Invoice">
                    {entry.status === "removed" ? <Badge tone="red">Removed</Badge> : null}
                    {entry.chargeType !== "hourly" && entry.status === "active" ? <span className={ui.muted}>Not billed by the hour</span> : null}
                    <BilledBadge billed={entry.billedOn} writtenOff={entry.writtenOffAt} />
                  </td>
                  <td>
                    {mayChange(entry) ? (
                      <Button size="small" variant="secondary" disabled={busy} onClick={() => remove(entry)}>
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {project.timeEntries.some((entry) => entry.status === "removed") ? (
        <label className={ui.checkbox}>
          <input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} /> Show removed entries
        </label>
      ) : null}
    </Card>
  );
}

function ExpensesCard({ organisationId, project, onChanged }: { organisationId: string; project: Project; onChanged: (project: Project) => void }) {
  const { can } = useWorkspace();
  const open = project.status === "in_progress" && can("bookkeeper");
  const [search, setSearch] = useState("");
  const sources = useApiData<{ sources: ExpenseSource[] }>(open ? "/api/project-expense-sources" : null, { organisationId, search: search.trim() || null });
  const [chosen, setChosen] = useState("");
  const [chargeable, setChargeable] = useState(true);
  const [markup, setMarkup] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("project-expense"));
  const { busy, error, run } = useRun();
  const picked = sources.data?.sources.find((source) => `${source.sourceType}:${source.lineId}` === chosen);
  const link = (event: React.FormEvent) => {
    event.preventDefault();
    if (!picked) return;
    void run(
      () =>
        api<{ project: Project }>(`/api/projects/${project.id}/expenses`, {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey: key, sourceType: picked.sourceType, lineId: picked.lineId, chargeable, markupPercent: chargeable ? markup || null : null },
        }),
      (result) => {
        setChosen("");
        setMarkup("");
        setKey(newIdempotencyKey("project-expense"));
        sources.reload();
        onChanged(result.project);
      },
    );
  };
  const remove = (expenseId: string) =>
    void run(() => api<{ project: Project }>(`/api/project-expenses/${expenseId}/remove`, { method: "POST", body: { organisationId } }), (result) => {
      sources.reload();
      onChanged(result.project);
    });
  const toggle = (expenseId: string, value: boolean) =>
    void run(() => api<{ project: Project }>(`/api/project-expenses/${expenseId}`, { method: "PUT", body: { organisationId, chargeable: value } }), (result) => onChanged(result.project));
  const expenses = project.expenses.filter((expense) => expense.status === "active");
  return (
    <Card title="Expenses" description="Lines of approved bills, expense claims and spend money, linked at their cost excluding GST. Linking doesn't post anything.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {expenses.length === 0 ? <Empty>No expenses on this project.</Empty> : null}
      {expenses.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>From</th>
                <th>Description</th>
                <th className={ui.num}>Cost</th>
                <th>Chargeable</th>
                <th className={ui.num}>Charge</th>
                <th>Invoice</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => {
                const changeable = open && !expense.billedOn && !expense.writtenOffAt;
                return (
                  <tr key={expense.id}>
                    <td data-label="Date">{formatDate(expense.date)}</td>
                    <td data-label="From">
                      {expense.documentLabel} · {expense.contactName}
                    </td>
                    <td data-label="Description">
                      {expense.description} <span className={ui.muted}>({expense.accountCode})</span>
                    </td>
                    <td data-label="Cost" className={ui.num}>
                      <Money value={expense.cost} />
                    </td>
                    <td data-label="Chargeable">
                      {changeable ? (
                        <label className={ui.checkbox}>
                          <input type="checkbox" checked={expense.chargeable} disabled={busy} onChange={(event) => toggle(expense.id, event.target.checked)} />
                          {expense.chargeable && expense.markupPercent !== "0" ? `+${expense.markupPercent}%` : ""}
                        </label>
                      ) : expense.chargeable ? (
                        `Yes${expense.markupPercent !== "0" ? `, +${expense.markupPercent}%` : ""}`
                      ) : (
                        "No"
                      )}
                    </td>
                    <td data-label="Charge" className={ui.num}>
                      <Money value={expense.charge} blankZero />
                    </td>
                    <td data-label="Invoice">
                      <BilledBadge billed={expense.billedOn} writtenOff={expense.writtenOffAt} />
                    </td>
                    <td>
                      {changeable ? (
                        <Button size="small" variant="secondary" disabled={busy} onClick={() => remove(expense.id)}>
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <form className={ui.inlineForm} onSubmit={link}>
          <Field label="Find a line">
            <input value={search} placeholder="Supplier, description or document" onChange={(event) => setSearch(event.target.value)} />
          </Field>
          <Field label="Line">
            <select value={chosen} onChange={(event) => setChosen(event.target.value)} required>
              <option value="">{sources.data ? `Choose (${sources.data.sources.length} available)` : "Loading…"}</option>
              {(sources.data?.sources ?? []).map((source) => (
                <option key={`${source.sourceType}:${source.lineId}`} value={`${source.sourceType}:${source.lineId}`}>
                  {formatDate(source.date)} · {SOURCE_LABELS[source.sourceType]} · {source.contactName} · {source.description} · {source.cost}
                </option>
              ))}
            </select>
          </Field>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={chargeable} onChange={(event) => setChargeable(event.target.checked)} /> Chargeable
          </label>
          {chargeable ? (
            <Field label="Markup %">
              <input inputMode="decimal" size={5} value={markup} onChange={(event) => setMarkup(event.target.value)} />
            </Field>
          ) : null}
          <Button type="submit" disabled={busy || !picked}>
            Add to project
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

/** Choose unbilled items and make a draft invoice from them (PJ6). */
function InvoiceCard({ organisationId, project, onChanged }: { organisationId: string; project: Project; onChanged: (project: Project, message: string) => void }) {
  const { can } = useWorkspace();
  const accounts = useAccounts(organisationId);
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const router = useRouter();
  const time = project.timeEntries.filter((entry) => entry.status === "active" && entry.chargeType === "hourly" && !entry.billedOn && !entry.writtenOffAt);
  const fixed = project.tasks.filter((task) => task.chargeType === "fixed" && task.status === "active" && !task.billedOn && !task.writtenOffAt);
  const expenses = project.expenses.filter((expense) => expense.status === "active" && expense.chargeable && !expense.billedOn && !expense.writtenOffAt);
  const all = [...time.map((entry) => `time:${entry.id}`), ...fixed.map((task) => `task:${task.id}`), ...expenses.map((expense) => `expense:${expense.id}`)];
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [invoiceDate, setInvoiceDate] = useState(todayInBrowser());
  const [dueDate, setDueDate] = useState("");
  const [accountCode, setAccountCode] = useState<string | null>(null);
  const [taxCode, setTaxCode] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey("project-invoice"));
  const { busy, error, run } = useRun();
  if (project.status !== "in_progress" || !can("bookkeeper") || all.length === 0) return null;
  const activeTax = (taxCodes.data?.taxCodes ?? []).filter((code) => code.isActive);
  const account = accountCode ?? (accounts.data?.accounts ?? []).find((entry) => entry.isActive && entry.accountClass === "revenue")?.code ?? "";
  const tax = taxCode ?? (activeTax.find((code) => code.category === "standard") ?? activeTax[0])?.code ?? "";
  const ticked = (id: string) => !unticked.has(id);
  const flip = (id: string) => {
    const next = new Set(unticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setUnticked(next);
  };
  const submit = () =>
    void run(
      () =>
        api<{ project: Project; invoice: { id: string } }>(`/api/projects/${project.id}/invoice`, {
          method: "POST",
          body: {
            organisationId,
            source: "ui",
            idempotencyKey: key,
            invoiceDate,
            dueDate: dueDate || null,
            accountCode: account,
            taxCode: tax || null,
            timeEntryIds: time.filter((entry) => ticked(`time:${entry.id}`)).map((entry) => entry.id),
            taskIds: fixed.filter((task) => ticked(`task:${task.id}`)).map((task) => task.id),
            expenseIds: expenses.filter((expense) => ticked(`expense:${expense.id}`)).map((expense) => expense.id),
          },
        }),
      (result) => {
        setKey(newIdempotencyKey("project-invoice"));
        onChanged(result.project, "Draft invoice made.");
        router.push(`/operations/invoices/${result.invoice.id}`);
      },
    );
  const row = (id: string, label: string, detail: string, amount: string) => (
    <tr key={id}>
      <td>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={ticked(id)} onChange={() => flip(id)} /> {label}
        </label>
      </td>
      <td className={ui.muted}>{detail}</td>
      <td className={ui.num}>
        <Money value={amount} />
      </td>
    </tr>
  );
  return (
    <Card title="Invoice" description="Makes a draft invoice for the ticked items: time grouped per task at its rate, fixed prices, and chargeable expenses with their markup.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <tbody>
            {time.map((entry) => {
              const task = project.tasks.find((t) => t.id === entry.taskId);
              return row(
                `time:${entry.id}`,
                `${entry.taskName}: ${formatMinutes(entry.minutes)}`,
                `${formatDate(entry.entryDate)} · ${personName(entry, "user")} · ${minutesAsHours(entry.minutes)} h at ${task?.rate ?? ""}`,
                timeAmount(entry.minutes, task?.rate ?? "0"),
              );
            })}
            {fixed.map((task) => row(`task:${task.id}`, task.name, "Fixed price", task.rate ?? "0"))}
            {expenses.map((expense) => row(`expense:${expense.id}`, expense.description, `${expense.documentLabel}${expense.markupPercent !== "0" ? ` +${expense.markupPercent}%` : ""}`, expense.charge))}
          </tbody>
        </table>
      </div>
      <div className={ui.inlineForm}>
        <Field label="Invoice date">
          <input type="date" value={invoiceDate} onChange={(event) => setInvoiceDate(event.target.value)} />
        </Field>
        <Field label="Due date" hint="Blank: the customer's payment terms.">
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </Field>
        <Field label="Account">
          <AccountSelect accounts={accounts.data?.accounts ?? []} value={account} onChange={setAccountCode} filter={(entry) => entry.accountClass === "revenue"} ariaLabel="Income account" />
        </Field>
        <Field label="GST">
          <select value={tax} onChange={(event) => setTaxCode(event.target.value)}>
            <option value="">No GST</option>
            {activeTax.map((code) => (
              <option key={code.id} value={code.code}>
                {code.code} · {code.label}
              </option>
            ))}
          </select>
        </Field>
        <Button onClick={submit} disabled={busy || !account || all.every((id) => !ticked(id))}>
          {busy ? "Making…" : "Make draft invoice"}
        </Button>
      </div>
    </Card>
  );
}

function InvoicesCard({ project }: { project: Project }) {
  if (project.invoices.length === 0) return null;
  return (
    <Card title="Invoices from this project">
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Status</th>
              <th className={ui.num}>Excl. GST</th>
              <th className={ui.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {project.invoices.map((invoice) => (
              <tr key={invoice.invoiceId}>
                <td data-label="Invoice">
                  <Link href={`/operations/invoices/${invoice.invoiceId}`}>{invoice.invoiceNumber ?? `Draft #${invoice.invoiceId}`}</Link>
                </td>
                <td data-label="Date">{formatDate(invoice.invoiceDate)}</td>
                <td data-label="Status">
                  <Badge tone={invoice.status === "approved" ? "green" : invoice.status === "voided" ? "red" : "amber"}>{invoice.status}</Badge>
                </td>
                <td data-label="Excl. GST" className={ui.num}>
                  <Money value={invoice.subtotal} />
                </td>
                <td data-label="Total" className={ui.num}>
                  <Money value={invoice.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={ui.muted}>Voiding an invoice, or deleting a draft, makes what it billed unbilled again.</p>
    </Card>
  );
}

function StatusActions({ organisationId, project, onChanged }: { organisationId: string; project: Project; onChanged: (project: Project, message: string) => void }) {
  const { can } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useRun();
  if (!can("bookkeeper")) return null;
  const post = (path: string, body: Record<string, unknown>, message: string) =>
    void run(() => api<{ project: Project }>(`/api/projects/${project.id}/${path}`, { method: "POST", body: { organisationId, ...body } }), (result) => onChanged(result.project, message));
  const unbilled = project.figures.unbilled !== "0.00";
  return (
    <Card title="Project">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing ? (
        <ProjectEditor
          organisationId={organisationId}
          project={project}
          onSaved={(saved) => {
            setEditing(false);
            onChanged(saved, "Saved.");
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className={ui.actions}>
          {project.status === "in_progress" ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit details
              </Button>
              <Button onClick={() => post("close", {}, "Closed.")} disabled={busy || unbilled}>
                Close project
              </Button>
              {unbilled ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Write off ${project.figures.unbilled} unbilled and close? Written-off items are never invoiced.`)) return;
                    post("close", { writeOff: true }, "Closed, with the unbilled items written off.");
                  }}
                >
                  Write off unbilled and close
                </Button>
              ) : null}
            </>
          ) : (
            <Button onClick={() => post("reopen", {}, "Reopened.")} disabled={busy}>
              Reopen project
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function ProjectView({ organisationId, projectId }: { organisationId: string; projectId: string }) {
  const loaded = useApiData<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, { organisationId });
  const [updated, setUpdated] = useState<Project | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const project = updated ?? loaded.data?.project;
  if (!project) return <p className={ui.muted}>Loading…</p>;
  const changed = (next: Project, text: string | null = null) => {
    setUpdated(next);
    setMessage(text);
  };
  const reload = () => {
    setUpdated(null);
    setMessage(null);
    loaded.reload();
  };
  const version = `${project.updatedAt}-${project.timeEntries.length}-${project.expenses.length}-${project.invoices.length}-${project.status}`;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <FiguresCard project={project} />
      <StatusActions key={`status-${version}`} organisationId={organisationId} project={project} onChanged={changed} />
      <TasksCard key={`tasks-${version}`} organisationId={organisationId} project={project} onChanged={changed} />
      <TimeCard key={`time-${version}`} organisationId={organisationId} project={project} onChanged={reload} />
      <ExpensesCard key={`expenses-${version}`} organisationId={organisationId} project={project} onChanged={changed} />
      <InvoiceCard key={`invoice-${version}`} organisationId={organisationId} project={project} onChanged={changed} />
      <InvoicesCard project={project} />
      <p>
        <Link href="/operations/projects">Back to projects</Link>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff cost rates

export function StaffRates({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const list = useApiData<{ rates: StaffRate[] }>("/api/project-staff-rates", { organisationId });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<StaffRate[] | null>(null);
  const { busy, error, run } = useRun();
  const rates = saved ?? list.data?.rates;
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!rates) return <p className={ui.muted}>Loading…</p>;
  const save = (userId: string) =>
    void run(
      () => api<{ rates: StaffRate[] }>("/api/project-staff-rates", { method: "PUT", body: { organisationId, userId, costRate: edits[userId] } }),
      (result) => {
        setSaved(result.rates);
        const next = { ...edits };
        delete next[userId];
        setEdits(next);
      },
    );
  return (
    <Card title="Staff cost rates" description="What an hour of each person's time costs, for project profitability. It's copied onto time when it's entered, so changing it doesn't change earlier time. Nothing is posted.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th className={ui.num}>Cost per hour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rate.userId}>
                <td data-label="Person">
                  {rate.displayName} <span className={ui.muted}>{rate.email}</span>
                </td>
                <td data-label="Role">{rate.role}</td>
                <td data-label="Cost per hour" className={ui.num}>
                  {can("admin") ? (
                    <input
                      aria-label={`Cost per hour for ${rate.email}`}
                      inputMode="decimal"
                      size={8}
                      value={edits[rate.userId] ?? rate.costRate}
                      onChange={(event) => setEdits({ ...edits, [rate.userId]: event.target.value })}
                    />
                  ) : (
                    <Money value={rate.costRate} />
                  )}
                </td>
                <td>
                  {can("admin") && edits[rate.userId] !== undefined ? (
                    <Button size="small" disabled={busy} onClick={() => save(rate.userId)}>
                      Save
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reports

export function ProfitabilityReportView({ organisationId }: { organisationId: string }) {
  const [status, setStatus] = useState<string>("");
  const report = useApiData<{ report: ProfitabilityReport }>("/api/reports/project-profitability", { organisationId, status: status || null });
  const data = report.data?.report;
  return (
    <Card
      title="Project profitability"
      description="Invoiced (approved invoices, excluding GST) less costs (expenses at cost and time at staff cost rates), with what's still to invoice."
      actions={
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      }
    >
      <div className={ui.inlineForm} data-print="hide">
        <Field label="Projects">
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            <option value="in_progress">In progress</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
      </div>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {!data && !report.error ? <p className={ui.muted}>Loading…</p> : null}
      {data && data.projects.length === 0 ? <Empty>No projects.</Empty> : null}
      {data && data.projects.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Project</th>
                <th className={ui.num}>Time</th>
                <th className={ui.num}>Invoiced</th>
                <th className={ui.num}>Time cost</th>
                <th className={ui.num}>Expenses</th>
                <th className={ui.num}>Profit</th>
                <th className={ui.num}>Draft invoices</th>
                <th className={ui.num}>Unbilled</th>
                <th className={ui.num}>Estimate</th>
                <th className={ui.num}>Estimate left</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((project) => (
                <tr key={project.id}>
                  <td data-label="Project">
                    <Link href={`/operations/projects/${project.id}`}>{project.name}</Link> <span className={ui.muted}>{project.contactName}</span>
                  </td>
                  <td data-label="Time" className={ui.num}>
                    {formatMinutes(project.figures.minutes)}
                  </td>
                  <td data-label="Invoiced" className={ui.num}>
                    <Money value={project.figures.invoiced} />
                  </td>
                  <td data-label="Time cost" className={ui.num}>
                    <Money value={project.figures.timeCost} />
                  </td>
                  <td data-label="Expenses" className={ui.num}>
                    <Money value={project.figures.expenseCost} />
                  </td>
                  <td data-label="Profit" className={ui.num}>
                    <Money value={project.figures.profit} />
                  </td>
                  <td data-label="Draft invoices" className={ui.num}>
                    <Money value={project.figures.onDraftInvoices} blankZero />
                  </td>
                  <td data-label="Unbilled" className={ui.num}>
                    <Money value={project.figures.unbilled} />
                  </td>
                  <td data-label="Estimate" className={ui.num}>
                    {project.estimate ? <Money value={project.estimate} /> : ""}
                  </td>
                  <td data-label="Estimate left" className={ui.num}>
                    {project.figures.estimateLeft !== null ? <Money value={project.figures.estimateLeft} /> : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th className={ui.num}>{formatMinutes(data.totals.minutes)}</th>
                <th className={ui.num}>
                  <Money value={data.totals.invoiced} />
                </th>
                <th className={ui.num}>
                  <Money value={data.totals.timeCost} />
                </th>
                <th className={ui.num}>
                  <Money value={data.totals.expenseCost} />
                </th>
                <th className={ui.num}>
                  <Money value={data.totals.profit} />
                </th>
                <th className={ui.num}>
                  <Money value={data.totals.onDraftInvoices} blankZero />
                </th>
                <th className={ui.num}>
                  <Money value={data.totals.unbilled} />
                </th>
                <th />
                <th />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function TimeReportView({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [userId, setUserId] = useState("");
  const [projectId, setProjectId] = useState("");
  const team = useApiData<{ rates: StaffRate[] }>("/api/project-staff-rates", { organisationId });
  const projects = useApiData<{ projects: ProjectSummary[] }>("/api/projects", { organisationId });
  const report = useApiData<{ report: TimeReport }>(from && to ? "/api/reports/project-time" : null, {
    organisationId,
    from,
    to,
    userId: userId || null,
    projectId: projectId || null,
  });
  const data = report.data?.report;
  const groups = (title: string, rows: TimeReport["byPerson"]) => (
    <div>
      <h3 className={ui.reportHeading}>{title}</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className={ui.num}>{formatMinutes(row.minutes)}</td>
                <td className={ui.num}>{minutesAsHours(row.minutes)} h</td>
                <td className={ui.num}>
                  <Money value={row.cost} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
  return (
    <Card
      title="Time report"
      description="Time recorded on projects, by person, project and task, with its cost at staff cost rates."
      actions={
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      }
    >
      <div className={ui.inlineForm} data-print="hide">
        <Field label="From">
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Field label="Person">
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Everyone</option>
            {(team.data?.rates ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName || member.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {!data && !report.error ? <p className={ui.muted}>Loading…</p> : null}
      {data && data.entries.length === 0 ? <Empty>No time in this range.</Empty> : null}
      {data && data.entries.length > 0 ? (
        <>
          <div className={ui.grid3}>
            <Stat label="Total time" value={`${formatMinutes(data.totalMinutes)} (${minutesAsHours(data.totalMinutes)} h)`} />
            <Stat label="Cost" value={<Money value={data.totalCost} />} />
            <Stat label="Entries" value={String(data.entries.length)} />
          </div>
          <div className={ui.grid3}>
            {groups("By person", data.byPerson)}
            {groups("By project", data.byProject)}
            {groups("By task", data.byTask)}
          </div>
          <h3 className={ui.reportHeading}>Entries</h3>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Who</th>
                  <th>Project</th>
                  <th>Task</th>
                  <th>Description</th>
                  <th className={ui.num}>Time</th>
                  <th className={ui.num}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="Date">{formatDate(entry.entryDate)}</td>
                    <td data-label="Who">{personName(entry, "user")}</td>
                    <td data-label="Project">
                      <Link href={`/operations/projects/${entry.projectId}`}>{entry.projectName}</Link>
                    </td>
                    <td data-label="Task">{entry.taskName}</td>
                    <td data-label="Description" className={ui.muted}>
                      {entry.description}
                    </td>
                    <td data-label="Time" className={ui.num}>
                      {formatMinutes(entry.minutes)}
                    </td>
                    <td data-label="Cost" className={ui.num}>
                      <Money value={entry.cost} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Card>
  );
}
