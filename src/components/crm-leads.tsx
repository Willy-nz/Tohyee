"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { SimilarRecords } from "@/components/crm-similar";
import { readFileAsBase64 } from "@/components/bank/common";
import { memberName, useBusy, useTeam } from "@/components/crm";
import { LeadSources } from "@/components/crm-lead-sources";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, newIdempotencyKey } from "@/lib/client/api";
import type { Activity, Task } from "@/lib/crm/service";
import { LEAD_SOURCE_LABELS, LEAD_STATUS_LABELS, type Lead, type LeadImportResult } from "@/lib/crm/lead-types";
import { formatDateTime } from "@/lib/format";

type LeadForm = { firstName: string; lastName: string; companyName: string; email: string; phone: string; jobTitle: string; description: string };

const EMPTY: LeadForm = { firstName: "", lastName: "", companyName: "", email: "", phone: "", jobTitle: "", description: "" };

function fromLead(lead: Lead): LeadForm {
  return {
    firstName: lead.firstName ?? "",
    lastName: lead.lastName ?? "",
    companyName: lead.companyName ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    jobTitle: lead.jobTitle ?? "",
    description: lead.description ?? "",
  };
}

const blankToNull = (form: LeadForm) => Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]));

function LeadFields({ form, onChange }: { form: LeadForm; onChange: (form: LeadForm) => void }) {
  const field = (key: keyof LeadForm, label: string, type = "text") => (
    <Field label={label}>
      <input type={type} value={form[key]} onChange={(event) => onChange({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <>
      <div className={ui.inlineForm}>
        {field("firstName", "First name")}
        {field("lastName", "Last name")}
        {field("companyName", "Company")}
        {field("jobTitle", "Job title")}
      </div>
      <div className={ui.inlineForm}>
        {field("email", "Email", "email")}
        {field("phone", "Phone", "tel")}
      </div>
      <Field label="Notes">
        <textarea rows={3} value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} />
      </Field>
    </>
  );
}

function NewLead({ organisationId, onDone }: { organisationId: string; onDone: (lead: Lead | null) => void }) {
  const [form, setForm] = useState<LeadForm>(EMPTY);
  const [key] = useState(() => newIdempotencyKey());
  const { busy, error, run } = useBusy();
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ lead: Lead }>("/api/crm/leads", { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, ...blankToNull(form) } });
      onDone(result.lead);
    });
  }
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <LeadFields form={form} onChange={setForm} />
      <SimilarRecords organisationId={organisationId} name={form.companyName} email={form.email} phone={form.phone} />
      <span className={ui.rowButtons}>
        <Button type="submit" disabled={busy}>
          Add lead
        </Button>
        <Button type="button" variant="secondary" onClick={() => onDone(null)} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function ImportLeads({ organisationId, onDone }: { organisationId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [key] = useState(() => newIdempotencyKey());
  const [result, setResult] = useState<LeadImportResult | null>(null);
  const { busy, error, run } = useBusy();
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        A CSV or Excel file whose first row is headings: First name, Last name (or Name), Company, Email, Phone, Job title, Source and Notes. Each row
        becomes a lead you own. Rows whose email is already an open lead are skipped.
      </p>
      <input type="file" accept=".csv,.txt,.xlsx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <span className={ui.rowButtons}>
        <Button
          disabled={!file || busy}
          onClick={() =>
            void run(async () => {
              if (!file) return;
              const imported = await api<LeadImportResult>("/api/crm/leads/import", {
                method: "POST",
                body: { organisationId, source: "ui", idempotencyKey: key, fileName: file.name, fileBase64: await readFileAsBase64(file) },
              });
              setResult(imported);
            })
          }
        >
          Import
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={busy}>
          {result ? "Done" : "Cancel"}
        </Button>
      </span>
      {result ? (
        <Notice tone={result.skipped.length > 0 ? "warning" : "success"}>
          Added {result.created} lead{result.created === 1 ? "" : "s"}.
          {result.skipped.length > 0 ? (
            <ul>
              {result.skipped.slice(0, 20).map((skip) => (
                <li key={skip.row}>
                  Row {skip.row}: {skip.reason}
                </li>
              ))}
              {result.skipped.length > 20 ? <li>…and {result.skipped.length - 20} more.</li> : null}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "review", label: "To review" },
  { key: "unqualified", label: "Unqualified" },
  { key: "converted", label: "Converted" },
  { key: "", label: "All" },
] as const;

/** CRM › Leads (decision 492): enquiries to work, qualify and convert. */
export function LeadsPage({ organisationId }: { organisationId: string }) {
  const { canCrm } = useWorkspace();
  const team = useTeam(organisationId).data?.team;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("open");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<"lead" | "import" | null>(null);
  const leads = useApiData<{ leads: Lead[] }>("/api/crm/leads", {
    organisationId,
    status: filter === "review" ? "open" : filter,
    needsReview: filter === "review" ? "true" : "",
    search,
  });
  return (
    <>
      {leads.error ? <Notice tone="error">{leads.error}</Notice> : null}
      <Card
        title="Leads"
        description="Enquiries before they're customers. Work them, then convert the good ones into a company, a person and an opportunity."
        actions={
          canCrm("write") && !adding ? (
            <span className={ui.rowButtons}>
              <Button size="small" onClick={() => setAdding("lead")}>
                New lead
              </Button>
              <Button size="small" variant="secondary" onClick={() => setAdding("import")}>
                Import
              </Button>
            </span>
          ) : null
        }
      >
        {adding === "lead" ? (
          <NewLead
            organisationId={organisationId}
            onDone={() => {
              setAdding(null);
              leads.reload();
            }}
          />
        ) : null}
        {adding === "import" ? (
          <ImportLeads
            organisationId={organisationId}
            onDone={() => {
              setAdding(null);
              leads.reload();
            }}
          />
        ) : null}
        <div className={ui.inlineForm}>
          <Field label="Show">
            <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              {FILTERS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, company, email or phone" />
          </Field>
        </div>
        {leads.data && leads.data.leads.length === 0 ? <Empty>No leads here.</Empty> : null}
        {leads.data && leads.data.leads.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Company</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Owner</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {leads.data.leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link href={`/crm/leads/${lead.id}`}>{lead.name}</Link> {lead.needsReview ? <Badge>To review</Badge> : null}
                    </td>
                    <td>{lead.companyName ?? ""}</td>
                    <td>{lead.email ?? ""}</td>
                    <td>{LEAD_STATUS_LABELS[lead.status]}</td>
                    <td>{LEAD_SOURCE_LABELS[lead.source]}</td>
                    <td>{lead.ownerUserId ? memberName(team, lead.ownerUserId) : "Unassigned"}</td>
                    <td>{formatDateTime(lead.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <LeadSources organisationId={organisationId} onChecked={() => leads.reload()} />
    </>
  );
}

type LeadPage = { lead: Lead; tasks: Task[]; activities: Activity[] };

function ConvertLead({ organisationId, lead, onDone }: { organisationId: string; lead: Lead; onDone: () => void }) {
  const [opportunity, setOpportunity] = useState(true);
  const [opportunityName, setOpportunityName] = useState(lead.companyName ?? lead.name);
  const [amount, setAmount] = useState("");
  const [closeDate, setCloseDate] = useState("");
  const { busy, error, run } = useBusy();
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Makes a new prospect company{lead.companyName ? ` called ${lead.companyName}` : ""} and a person there from this lead. Its tasks and activities
        go with it.
      </p>
      <label>
        <input type="checkbox" checked={opportunity} onChange={(event) => setOpportunity(event.target.checked)} /> Also make an opportunity
      </label>
      {opportunity ? (
        <div className={ui.inlineForm}>
          <Field label="Opportunity">
            <input value={opportunityName} maxLength={200} onChange={(event) => setOpportunityName(event.target.value)} />
          </Field>
          <Field label="Amount (excluding GST)">
            <input value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label="Expected close">
            <input type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />
          </Field>
        </div>
      ) : null}
      <span className={ui.rowButtons}>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api(`/api/crm/leads/${lead.id}/convert`, {
                method: "POST",
                body: { organisationId, opportunity, opportunityName, amount: amount || null, closeDate: closeDate || null },
              });
              onDone();
            })
          }
        >
          Convert
        </Button>
      </span>
    </div>
  );
}

/** One lead (decision 492): its details, status, owner, history, and converting it. */
export function LeadRecordPage({ organisationId, leadId }: { organisationId: string; leadId: string }) {
  const { canCrm } = useWorkspace();
  const team = useTeam(organisationId).data?.team ?? [];
  const data = useApiData<LeadPage>(`/api/crm/leads/${leadId}`, { organisationId });
  const [editing, setEditing] = useState<LeadForm | null>(null);
  const [converting, setConverting] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useBusy();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const { lead, tasks, activities } = data.data;
  const editable = canCrm("write") && lead.status !== "converted";
  const patch = (body: Record<string, unknown>) =>
    run(async () => {
      await api(`/api/crm/leads/${lead.id}`, { method: "PATCH", body: { organisationId, ...body } });
      data.reload();
    });
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {lead.needsReview && editable ? (
        <Notice tone="info">
          This lead came from {lead.source === "web_form" ? "the website form" : "an email"} and nobody has looked at it yet.{" "}
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void patch({ reviewed: true })}>
            Mark as looked at
          </Button>
        </Notice>
      ) : null}
      {lead.status === "converted" ? (
        <Notice tone="success">
          Converted {lead.convertedAt ? formatDateTime(lead.convertedAt) : ""}:{" "}
          {lead.convertedContactId ? <Link href={`/crm/companies/${lead.convertedContactId}`}>company</Link> : null}
          {lead.convertedPersonId ? (
            <>
              , <Link href={`/crm/people/${lead.convertedPersonId}`}>person</Link>
            </>
          ) : null}
          {lead.convertedOpportunityId ? (
            <>
              , <Link href={`/crm/opportunities/${lead.convertedOpportunityId}`}>opportunity</Link>
            </>
          ) : null}
          .
        </Notice>
      ) : null}
      <Card
        title={lead.name}
        description={`${LEAD_STATUS_LABELS[lead.status]} · ${LEAD_SOURCE_LABELS[lead.source]}${lead.sourceDetail ? ` (${lead.sourceDetail})` : ""}`}
        actions={
          editable && !editing && !converting ? (
            <span className={ui.rowButtons}>
              <Button size="small" onClick={() => setConverting(true)}>
                Convert
              </Button>
              <Button size="small" variant="secondary" onClick={() => setEditing(fromLead(lead))}>
                Edit
              </Button>
            </span>
          ) : null
        }
      >
        {converting ? (
          <ConvertLead
            organisationId={organisationId}
            lead={lead}
            onDone={() => {
              setConverting(false);
              data.reload();
            }}
          />
        ) : null}
        {editing ? (
          <form
            style={{ display: "grid", gap: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              void patch(blankToNull(editing)).then(() => setEditing(null));
            }}
          >
            <LeadFields form={editing} onChange={setEditing} />
            <span className={ui.rowButtons}>
              <Button type="submit" disabled={busy}>
                Save
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </span>
          </form>
        ) : (
          <dl className={ui.muted} style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px" }}>
            <dt>Company</dt>
            <dd>{lead.companyName ?? "—"}</dd>
            <dt>Job title</dt>
            <dd>{lead.jobTitle ?? "—"}</dd>
            <dt>Email</dt>
            <dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "—"}</dd>
            <dt>Phone</dt>
            <dd>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : "—"}</dd>
            <dt>Notes</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{lead.description ?? "—"}</dd>
            {lead.unqualifiedReason ? (
              <>
                <dt>Not qualified because</dt>
                <dd>{lead.unqualifiedReason}</dd>
              </>
            ) : null}
          </dl>
        )}
        {editable ? (
          <div className={ui.inlineForm}>
            <Field label="Owner">
              <select value={lead.ownerUserId ?? ""} disabled={busy} onChange={(event) => void patch({ ownerUserId: event.target.value || null })}>
                <option value="">Unassigned</option>
                {team.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select value={lead.status} disabled={busy} onChange={(event) => (event.target.value === "unqualified" ? setReason(" ") : void patch({ status: event.target.value }))}>
                <option value="new">New</option>
                <option value="working">Working</option>
                <option value="unqualified">Unqualified</option>
              </select>
            </Field>
            {reason ? (
              <Field label="Why isn't it qualified?">
                <span className={ui.rowButtons}>
                  <input value={reason.trimStart()} maxLength={500} onChange={(event) => setReason(event.target.value || " ")} />
                  <Button size="small" disabled={busy || reason.trim() === ""} onClick={() => void patch({ status: "unqualified", unqualifiedReason: reason.trim() }).then(() => setReason(""))}>
                    Save
                  </Button>
                </span>
              </Field>
            ) : null}
          </div>
        ) : (
          <p className={ui.muted}>Owner: {lead.ownerUserId ? memberName(team, lead.ownerUserId) : "Unassigned"}</p>
        )}
      </Card>
      <Card title="Activity" description="Calls, meetings and notes about this lead, and its tasks. They stay with it when it's converted.">
        {canCrm("write") ? (
          <form
            className={ui.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api("/api/crm/activities", { method: "POST", body: { organisationId, kind: "note", subject: note.slice(0, 200), body: note.length > 200 ? note : null, leadId: lead.id } });
                setNote("");
                data.reload();
              });
            }}
          >
            <Field label="Add a note">
              <input value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <Button type="submit" disabled={busy || note.trim() === ""}>
              Add
            </Button>
          </form>
        ) : null}
        {activities.length === 0 && tasks.length === 0 ? <Empty>Nothing yet.</Empty> : null}
        <ul>
          {tasks.map((task) => (
            <li key={`task-${task.id}`}>
              Task: {task.title} {task.dueDate ? `(due ${task.dueDate})` : ""} {task.status === "done" ? <Badge>Done</Badge> : null}
            </li>
          ))}
          {activities.map((activity) => (
            <li key={`activity-${activity.id}`}>
              {formatDateTime(activity.happenedAt)}: {activity.subject}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
