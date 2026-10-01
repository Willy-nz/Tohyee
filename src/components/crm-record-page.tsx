"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import {
  ActivityForm,
  amountIn,
  InvoiceAction,
  kindBadges,
  memberName,
  OpportunityCard,
  OpportunityForm,
  PersonForm,
  PeopleTable,
  STAGE_LABELS,
  STAGE_TONES,
  STAGES,
  TaskForm,
  TaskList,
  totalAmounts,
  useBaseCurrency,
  useBusy,
  useTeam,
} from "@/components/crm";
import { RecordDetails } from "@/components/crm-record-details";
import { useRecordTypes } from "@/components/crm-record-type-picker";
import { FieldInput, useCustomFields, visibleFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { type DetailField, detailSections, pastByMonth, upcomingAndOverdue } from "@/lib/crm/record-page";
import { customIdOf, LAYOUT_RECORD_NAMES, type LayoutRecord, type RecordType, standardFieldApplies } from "@/lib/crm/record-types/layout";
import type { Activity, ActivityKind, Opportunity, OpportunityStage, Person, RelatedDocument, Task, TimelineEntry } from "@/lib/crm/service";
import { contactUses, type CustomFieldUse, type CustomValue, type CustomValues, customValueText } from "@/lib/custom-fields/values";
import { formatDate, formatDateTime, formatMoney, todayInBrowser } from "@/lib/format";
import type { Invoice } from "@/lib/invoices/service";

/**
 * The CRM record page (CRM roadmap item 4, examples CRT6, CRT7, CRT11) for
 * companies, people and opportunities, after Salesforce's Lightning record
 * page: a header with the name, record type, owner and highlights; a
 * Details tab with the record type's layout sections and inline edit; a
 * Related tab with each related list, its count and "View all"; and an
 * Activity panel with "Upcoming & overdue", past activity by month, and
 * quick-add buttons. On a phone the panel goes below the tabs.
 */

type CompanyData = {
  contact: Contact;
  recordType: RecordType;
  people: Person[];
  opportunities: Opportunity[];
  tasks: Task[];
  activities: Activity[];
  timeline: TimelineEntry[];
  invoices: RelatedDocument[];
  invoiceCount: number;
  creditNotes: RelatedDocument[];
  creditNoteCount: number;
  notesCount: number;
  filesCount: number;
};

type PersonData = { person: Person; recordType: RecordType; opportunities: Opportunity[]; tasks: Task[]; activities: Activity[]; timeline: TimelineEntry[] };

type OpportunityData = {
  opportunity: Opportunity;
  recordType: RecordType;
  tasks: Task[];
  activities: Activity[];
  timeline: TimelineEntry[];
  invoice: Invoice | null;
};

/** A record's values by layout key: its standard fields and its custom values. */
type RecordValues = { standard: Record<string, string | null>; custom: CustomValues };

const PATCH_PATHS: Record<LayoutRecord, (id: string) => string> = {
  contact: (id) => `/api/contacts/${id}`,
  person: (id) => `/api/crm/people/${id}`,
  opportunity: (id) => `/api/crm/opportunities/${id}`,
};

// ---------------------------------------------------------------------------
// The frame: header, tabs and the Activity panel

function RecordFrame({
  header,
  details,
  related,
  activity,
}: {
  header: ReactNode;
  details: ReactNode;
  related: ReactNode;
  activity: ReactNode;
}) {
  const [tab, setTab] = useState<"details" | "related">("details");
  return (
    <>
      {header}
      <div className={ui.recordPage}>
        <div className={ui.recordMain}>
          <div className={ui.tabs} role="tablist" aria-label="Record">
            {(["details", "related"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                className={`${ui.tab} ${tab === entry ? ui.tabActive : ""}`}
                onClick={() => setTab(entry)}
              >
                {entry === "details" ? "Details" : "Related"}
              </button>
            ))}
          </div>
          {tab === "details" ? details : related}
        </div>
        <aside className={ui.recordAside} aria-label="Activity">
          {activity}
        </aside>
      </div>
    </>
  );
}

/** The header: back link, name, record type (changeable by bookkeepers and up, CRT5), highlights and actions. */
function RecordHeader({
  organisationId,
  record,
  recordId,
  name,
  recordType,
  highlights,
  actions,
  backHref,
  onChanged,
}: {
  organisationId: string;
  record: LayoutRecord;
  recordId: string;
  name: string;
  recordType: RecordType;
  highlights: [string, ReactNode][];
  actions?: ReactNode;
  backHref: string;
  onChanged: () => void;
}) {
  const { can } = useWorkspace();
  const types = useRecordTypes(organisationId, record);
  const { busy, error, run } = useBusy();
  const choices = (types.data?.recordTypes ?? []).filter((type) => type.isActive || type.id === recordType.id);
  return (
    <>
      <div className={ui.actions}>
        <Link href={backHref}>← {LAYOUT_RECORD_NAMES[record].title}</Link>
      </div>
      <Card
        title={name}
        description={
          <>
            <Badge tone="blue">{recordType.name}</Badge> <span className={ui.muted}>{LAYOUT_RECORD_NAMES[record].one} record type</span>
          </>
        }
        actions={
          <span className={ui.actions}>
            {can("bookkeeper") && choices.length > 1 ? (
              <label className={ui.inlineForm}>
                <span className={ui.muted}>Record type</span>{" "}
                <select
                  aria-label="Change record type"
                  value={recordType.id}
                  disabled={busy}
                  onChange={(event) =>
                    void run(async () => {
                      await api(PATCH_PATHS[record](recordId), { method: "PATCH", body: { organisationId, recordTypeId: event.target.value } });
                      onChanged();
                    })
                  }
                >
                  {choices.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                      {type.isActive ? "" : " (archived)"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {actions}
          </span>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <dl className={ui.recordHighlights}>
          {highlights.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || <span className={ui.muted}>—</span>}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Details: the layout's sections with inline edit (CRT6, CRT7)

function StandardEditor({
  organisationId,
  field,
  value,
  contactId,
  onChange,
}: {
  organisationId: string;
  field: DetailField;
  value: string;
  /** The opportunity's company, for its point of contact. */
  contactId: string | null;
  onChange: (value: string) => void;
}) {
  const kind = field.standard?.kind;
  const team = useTeam(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>(kind === "company" ? "/api/contacts" : null, { organisationId });
  const people = useApiData<{ people: Person[] }>(kind === "person" && contactId ? "/api/crm/people" : null, { organisationId, contactId });
  const common = { "aria-label": field.label, value, autoFocus: true };
  switch (kind) {
    case "long_text":
      return <textarea {...common} rows={3} maxLength={500} onChange={(event) => onChange(event.target.value)} />;
    case "email":
      return <input {...common} type="email" maxLength={254} onChange={(event) => onChange(event.target.value)} />;
    case "phone":
      return <input {...common} type="tel" maxLength={50} onChange={(event) => onChange(event.target.value)} />;
    case "money":
      return <input {...common} inputMode="decimal" className={ui.num} onChange={(event) => onChange(event.target.value)} />;
    case "date":
      return <input {...common} type="date" onChange={(event) => onChange(event.target.value)} />;
    case "member":
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">No one</option>
          {(team.data?.team ?? []).map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.displayName}
            </option>
          ))}
        </select>
      );
    case "company":
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">{field.required ? "Choose a company" : "None"}</option>
          {(contacts.data?.contacts ?? []).map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      );
    case "person":
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">None</option>
          {(people.data?.people ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.fullName}
            </option>
          ))}
        </select>
      );
    case "stage":
      return (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          {STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      );
    default:
      return <input {...common} maxLength={200} onChange={(event) => onChange(event.target.value)} />;
  }
}

/** One field's inline editor: Save sends just that field (CRT8); the server checks the layout and the role again. */
function InlineEditor({
  organisationId,
  record,
  recordId,
  field,
  values,
  contactId,
  onDone,
  onSaved,
}: {
  organisationId: string;
  record: LayoutRecord;
  recordId: string;
  field: DetailField;
  values: RecordValues;
  contactId: string | null;
  onDone: () => void;
  onSaved: () => void;
}) {
  const customId = customIdOf(field.key);
  const [text, setText] = useState(values.standard[field.key] ?? "");
  const [custom, setCustom] = useState<CustomValue | undefined>(customId ? values.custom[customId] : undefined);
  const { busy, error, run } = useBusy();
  function save() {
    void run(async () => {
      let change: Record<string, unknown>;
      if (customId) {
        const next: CustomValues = { ...values.custom };
        if (custom === undefined) delete next[customId];
        else next[customId] = custom;
        change = { customFields: next };
      } else if (field.key === "amount") {
        change = { amount: text.trim() || "0" };
      } else {
        change = { [field.key]: text.trim() === "" ? null : text };
      }
      await api(PATCH_PATHS[record](recordId), { method: "PATCH", body: { organisationId, ...change } });
      onDone();
      onSaved();
    });
  }
  return (
    <form
      style={{ display: "grid", gap: 6 }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {field.custom ? (
        <FieldInput field={field.custom} value={custom} onChange={setCustom} disabled={busy} ariaLabel={field.label} />
      ) : (
        <StandardEditor organisationId={organisationId} field={field} value={text} contactId={contactId} onChange={setText} />
      )}
      <span className={ui.rowButtons}>
        <Button type="submit" size="small" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="small" variant="secondary" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

function DetailsTab({
  organisationId,
  record,
  recordId,
  recordType,
  uses,
  values,
  display,
  contactId,
  standardApplies,
  onSaved,
}: {
  organisationId: string;
  record: LayoutRecord;
  recordId: string;
  recordType: RecordType;
  uses: readonly CustomFieldUse[];
  values: RecordValues;
  /** How a standard field shows, when not just its text. */
  display: (key: string) => ReactNode;
  contactId: string | null;
  /** Whether a standard field is used on this record (a company's delivery address only on customers, CRT4). */
  standardApplies?: (key: string) => boolean;
  onSaved: () => void;
}) {
  const { current, can } = useWorkspace();
  const setup = useCustomFields(organisationId);
  const [editing, setEditing] = useState<string | null>(null);
  const role = current?.role ?? "viewer";
  if (!setup.data) return <p className={ui.muted}>Loading…</p>;
  const sections = detailSections(record, recordType.layout, visibleFields(setup.data, record, uses, values.custom), role, standardApplies);
  return (
    <Card
      title="Details"
      description={`Laid out by the ${recordType.name} record type.`}
      actions={can("admin") ? <Link href="/crm/record-types">Set up record types</Link> : null}
    >
      {sections.length === 0 ? <Empty>No fields on this layout.</Empty> : null}
      <RecordDetails
        sections={sections}
        valueOf={(field) => (field.custom ? customValueText(field.custom, values.custom[field.custom.id]) : display(field.key))}
        editingKey={editing}
        onEdit={setEditing}
        renderEditor={(field) => (
          <InlineEditor
            key={field.key}
            organisationId={organisationId}
            record={record}
            recordId={recordId}
            field={field}
            values={values}
            contactId={contactId}
            onDone={() => setEditing(null)}
            onSaved={onSaved}
          />
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Related lists, each with its count and "View all"

const SHOWN = 5;

function RelatedCard<T>({
  title,
  count,
  items,
  render,
  actions,
  empty,
  children,
}: {
  title: string;
  count: number;
  items: readonly T[];
  render: (items: readonly T[]) => ReactNode;
  actions?: ReactNode;
  empty: string;
  children?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <Card
      title={`${title} (${count})`}
      actions={
        <span className={ui.actions}>
          {actions}
          {items.length > SHOWN ? (
            <Button size="small" variant="secondary" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : "View all"}
            </Button>
          ) : null}
        </span>
      }
    >
      {children}
      {items.length === 0 ? <Empty>{empty}</Empty> : render(shown)}
      {count > items.length && all ? <p className={ui.muted}>Showing the newest {items.length}.</p> : null}
    </Card>
  );
}

function DocumentList({ documents, href, label }: { documents: readonly RelatedDocument[]; href: (id: string) => string; label: string }) {
  const baseCurrency = useBaseCurrency();
  return (
    <ul className={ui.relatedList}>
      {documents.map((doc) => (
        <li key={doc.id}>
          <span>
            <Link href={href(doc.id)}>{doc.number ?? `Draft ${label}`}</Link> <span className={ui.muted}>{formatDate(doc.date)}</span>
          </span>
          <span>
            <Badge tone={doc.status === "approved" ? "green" : doc.status === "voided" ? "red" : "neutral"}>{doc.status[0].toUpperCase() + doc.status.slice(1)}</Badge>{" "}
            {amountIn(doc.total, doc.currencyCode, baseCurrency)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function OpportunityList({ organisationId, opportunities, onChanged }: { organisationId: string; opportunities: readonly Opportunity[]; onChanged: () => void }) {
  const team = useTeam(organisationId);
  const setup = useCustomFields(organisationId);
  return (
    <div className={ui.crmCards}>
      {opportunities.map((opportunity) => (
        <OpportunityCard
          key={`${opportunity.id}:${opportunity.updatedAt}`}
          organisationId={organisationId}
          opportunity={opportunity}
          team={team.data?.team}
          customSetup={setup.data}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function TasksRelated({
  organisationId,
  tasks,
  addForm,
  onChanged,
}: {
  organisationId: string;
  tasks: Task[];
  addForm: (done: () => void) => ReactNode;
  onChanged: () => void;
}) {
  const { can } = useWorkspace();
  const [adding, setAdding] = useState(false);
  return (
    <RelatedCard
      title="Tasks"
      count={tasks.length}
      items={tasks}
      empty="No tasks."
      actions={
        can("bookkeeper") && !adding ? (
          <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
            New task
          </Button>
        ) : null
      }
      render={(shown) => <TaskList organisationId={organisationId} tasks={[...shown]} onChanged={onChanged} showAbout />}
    >
      {adding ? addForm(() => setAdding(false)) : null}
    </RelatedCard>
  );
}

// ---------------------------------------------------------------------------
// The Activity panel

type QuickAdd = ActivityKind | "task";
const QUICK_ADD: [QuickAdd, string][] = [
  ["call", "Log a call"],
  ["meeting", "Log a meeting"],
  ["note", "Add a note"],
  ["task", "New task"],
];

function ActivityPanel({
  tasks,
  timeline,
  form,
}: {
  tasks: Task[];
  timeline: TimelineEntry[];
  /** The quick-add form for a call, meeting, note or task. */
  form: (kind: QuickAdd, done: () => void) => ReactNode;
}) {
  const { can } = useWorkspace();
  const [adding, setAdding] = useState<QuickAdd | null>(null);
  // Fixed for this render, so "upcoming" and "past" split at the same moment.
  const [now] = useState(() => new Date().toISOString());
  const upcoming = upcomingAndOverdue(tasks, timeline, todayInBrowser(), now);
  const past = pastByMonth(tasks, timeline, now);
  return (
    <Card title="Activity">
      {can("bookkeeper") ? (
        <div className={ui.actions}>
          {QUICK_ADD.map(([kind, label]) => (
            <Button key={kind} size="small" variant={adding === kind ? "primary" : "secondary"} onClick={() => setAdding(adding === kind ? null : kind)}>
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      {adding ? <div key={adding}>{form(adding, () => setAdding(null))}</div> : null}
      <details open className={ui.activityMonth}>
        <summary>Upcoming &amp; overdue ({upcoming.length})</summary>
        {upcoming.length === 0 ? <p className={ui.muted}>Nothing planned.</p> : null}
        <ul className={ui.relatedList}>
          {upcoming.map((item) => (
            <li key={item.key}>
              <span>
                {item.kind === "task" ? <Badge tone={item.overdue ? "red" : "neutral"}>{item.overdue ? "Overdue" : "Task"}</Badge> : <Badge tone="blue">Planned</Badge>}{" "}
                {item.task ? <Link href="/crm/tasks">{item.title}</Link> : item.title}
                {item.detail ? <span className={ui.muted}> · {item.detail}</span> : null}
              </span>
              <span className={ui.muted}>{item.when === null ? "No due date" : item.when.length === 10 ? formatDate(item.when) : formatDateTime(item.when)}</span>
            </li>
          ))}
        </ul>
      </details>
      {past.length === 0 ? <p className={ui.muted}>No past activity yet.</p> : null}
      {past.map((month, index) => (
        <details key={month.month} open={index < 3} className={ui.activityMonth}>
          <summary>{month.label}</summary>
          <ol className={ui.crmTimeline}>
            {month.entries.map((entry, entryIndex) => (
              <li key={`${entry.kind}-${entry.at}-${entryIndex}`}>
                <span className={ui.muted}>{formatDateTime(entry.at)}</span>
                <div>
                  {entry.href ? <Link href={entry.href}>{entry.title}</Link> : <strong>{entry.title}</strong>}
                  {entry.amount ? <> · {formatMoney(entry.amount)}</> : null}
                </div>
                {entry.detail ? <div className={ui.muted}>{entry.detail}</div> : null}
                {entry.by ? <div className={ui.muted}>by {entry.by}</div> : null}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Companies

export function CompanyRecordPage({ organisationId, contactId }: { organisationId: string; contactId: string }) {
  const { can } = useWorkspace();
  const data = useApiData<CompanyData>(`/api/crm/companies/${contactId}`, { organisationId });
  const baseCurrency = useBaseCurrency();
  const team = useTeam(organisationId);
  const setup = useCustomFields(organisationId);
  const [adding, setAdding] = useState<"person" | "opportunity" | null>(null);
  const { busy, error, run } = useBusy();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const page = data.data;
  const { contact, people, opportunities, tasks } = page;
  const editable = can("bookkeeper");
  const open = opportunities.filter((o) => ["new", "screening", "meeting", "proposal"].includes(o.stage));
  const values: RecordValues = {
    standard: {
      name: contact.name,
      ownerUserId: contact.ownerUserId,
      email: contact.email,
      phone: contact.phone,
      gstNumber: contact.gstNumber,
      postalAddress: contact.postalAddress,
      deliveryAddress: contact.deliveryAddress,
    },
    custom: contact.customFields,
  };
  const display = (key: string): ReactNode => {
    switch (key) {
      case "ownerUserId":
        return memberName(team.data?.team, contact.ownerUserId);
      case "email":
        return contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : "";
      case "phone":
        return contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : "";
      case "createdAt":
        return formatDateTime(contact.createdAt);
      case "updatedAt":
        return formatDateTime(contact.updatedAt);
      default:
        return values.standard[key] ?? "";
    }
  };
  const activePeople = people.filter((p) => !p.isArchived);
  return (
    <RecordFrame
      header={
        <RecordHeader
          organisationId={organisationId}
          record="contact"
          recordId={contact.id}
          name={contact.name}
          recordType={page.recordType}
          backHref="/crm/companies"
          onChanged={data.reload}
          highlights={[
            ["Type", kindBadges(contact)],
            ["Owner", memberName(team.data?.team, contact.ownerUserId)],
            ["Phone", display("phone")],
            ["Email", display("email")],
            ["Open opportunities", `${open.length} · ${totalAmounts(open, baseCurrency)}`],
            ["Open tasks", String(tasks.filter((t) => t.status !== "done").length)],
          ]}
          actions={
            <>
              {editable && !contact.isCustomer ? (
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { organisationId, isCustomer: true } });
                      data.reload();
                    })
                  }
                >
                  Mark as customer
                </Button>
              ) : null}
              <Link href="/operations/contacts">Contact details</Link>
              {error ? <Notice tone="error">{error}</Notice> : null}
            </>
          }
        />
      }
      details={
        <DetailsTab
          organisationId={organisationId}
          record="contact"
          recordId={contact.id}
          recordType={page.recordType}
          uses={contactUses(contact)}
          values={values}
          display={display}
          contactId={contact.id}
          standardApplies={(key) => standardFieldApplies("contact", key, contact)}
          onSaved={data.reload}
        />
      }
      related={
        <>
          <RelatedCard
            title="People"
            count={people.length}
            items={people}
            empty="No people yet."
            actions={
              editable && adding !== "person" ? (
                <Button size="small" variant="secondary" onClick={() => setAdding("person")}>
                  New person
                </Button>
              ) : null
            }
            render={(shown) => <PeopleTable organisationId={organisationId} people={[...shown]} showCompany={false} customSetup={setup.data} onChanged={data.reload} />}
          >
            {adding === "person" ? (
              <PersonForm
                organisationId={organisationId}
                fixedContactId={contact.id}
                onSaved={() => {
                  setAdding(null);
                  data.reload();
                }}
                onCancel={() => setAdding(null)}
              />
            ) : null}
          </RelatedCard>
          <RelatedCard
            title="Opportunities"
            count={opportunities.length}
            items={opportunities}
            empty="No opportunities yet."
            actions={
              editable && adding !== "opportunity" ? (
                <Button size="small" variant="secondary" onClick={() => setAdding("opportunity")}>
                  New opportunity
                </Button>
              ) : null
            }
            render={(shown) => <OpportunityList organisationId={organisationId} opportunities={shown} onChanged={data.reload} />}
          >
            {adding === "opportunity" ? (
              <OpportunityForm
                organisationId={organisationId}
                fixedContactId={contact.id}
                fixedCurrency={contact.currencyCode ?? baseCurrency}
                onSaved={() => {
                  setAdding(null);
                  data.reload();
                }}
                onCancel={() => setAdding(null)}
              />
            ) : null}
          </RelatedCard>
          <TasksRelated
            organisationId={organisationId}
            tasks={tasks}
            onChanged={data.reload}
            addForm={(done) => (
              <TaskForm
                organisationId={organisationId}
                contactId={contact.id}
                opportunities={opportunities}
                people={activePeople}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )}
          />
          <RelatedCard
            title="Invoices"
            count={page.invoiceCount}
            items={page.invoices}
            empty="No invoices."
            actions={<Link href="/operations/invoices">All invoices</Link>}
            render={(shown) => <DocumentList documents={shown} href={(id) => `/operations/invoices/${id}`} label="invoice" />}
          />
          <RelatedCard
            title="Credit notes"
            count={page.creditNoteCount}
            items={page.creditNotes}
            empty="No credit notes."
            render={(shown) => <DocumentList documents={shown} href={(id) => `/operations/credit-notes/${id}`} label="credit note" />}
          />
          <RecordExtrasPanel organisationId={organisationId} recordType="contact" recordId={contact.id} title={`Notes (${page.notesCount}) and files (${page.filesCount})`} />
        </>
      }
      activity={
        <ActivityPanel
          tasks={tasks}
          timeline={page.timeline}
          form={(kind, done) =>
            kind === "task" ? (
              <TaskForm
                organisationId={organisationId}
                contactId={contact.id}
                opportunities={opportunities}
                people={activePeople}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            ) : (
              <ActivityForm
                organisationId={organisationId}
                contactId={contact.id}
                initialKind={kind}
                people={people}
                opportunities={opportunities}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )
          }
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// People

export function PersonRecordPage({ organisationId, personId }: { organisationId: string; personId: string }) {
  const data = useApiData<PersonData>(`/api/crm/people/${personId}`, { organisationId });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const page = data.data;
  const { person, opportunities, tasks } = page;
  const values: RecordValues = {
    standard: {
      firstName: person.firstName,
      lastName: person.lastName,
      jobTitle: person.jobTitle,
      contactId: person.contactId,
      email: person.email,
      phone: person.phone,
    },
    custom: person.customFields,
  };
  const display = (key: string): ReactNode => {
    switch (key) {
      case "contactId":
        return person.contactId ? <Link href={`/crm/companies/${person.contactId}`}>{person.contactName}</Link> : "";
      case "email":
        return person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : "";
      case "phone":
        return person.phone ? <a href={`tel:${person.phone}`}>{person.phone}</a> : "";
      default:
        return values.standard[key] ?? "";
    }
  };
  const self = [person];
  return (
    <RecordFrame
      header={
        <RecordHeader
          organisationId={organisationId}
          record="person"
          recordId={person.id}
          name={person.fullName}
          recordType={page.recordType}
          backHref="/crm/people"
          onChanged={data.reload}
          highlights={[
            ["Company", display("contactId")],
            ["Job title", person.jobTitle ?? ""],
            ["Phone", display("phone")],
            ["Email", display("email")],
            [
              "Status",
              <span key="status" className={ui.rowButtons}>
                {person.isPrimary ? <Badge tone="green">Primary contact</Badge> : null}
                {person.isArchived ? <Badge>Archived</Badge> : null}
              </span>,
            ],
          ]}
        />
      }
      details={
        <DetailsTab
          organisationId={organisationId}
          record="person"
          recordId={person.id}
          recordType={page.recordType}
          uses={["person"]}
          values={values}
          display={display}
          contactId={person.contactId}
          onSaved={data.reload}
        />
      }
      related={
        <>
          {person.contactId ? (
            <Card title="Company">
              <Link href={`/crm/companies/${person.contactId}`}>{person.contactName}</Link>
            </Card>
          ) : null}
          <RelatedCard
            title="Opportunities"
            count={opportunities.length}
            items={opportunities}
            empty="Not the point of contact for any opportunity."
            render={(shown) => <OpportunityList organisationId={organisationId} opportunities={shown} onChanged={data.reload} />}
          />
          <TasksRelated
            organisationId={organisationId}
            tasks={tasks}
            onChanged={data.reload}
            addForm={(done) => (
              <TaskForm
                organisationId={organisationId}
                contactId={person.contactId}
                personId={person.id}
                opportunities={opportunities}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )}
          />
        </>
      }
      activity={
        <ActivityPanel
          tasks={tasks}
          timeline={page.timeline}
          form={(kind, done) =>
            kind === "task" ? (
              <TaskForm
                organisationId={organisationId}
                contactId={person.contactId}
                personId={person.id}
                opportunities={opportunities}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            ) : (
              <ActivityForm
                organisationId={organisationId}
                contactId={person.contactId}
                personId={person.id}
                initialKind={kind}
                people={self}
                opportunities={opportunities}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )
          }
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Opportunities

export function OpportunityRecordPage({ organisationId, opportunityId }: { organisationId: string; opportunityId: string }) {
  const data = useApiData<OpportunityData>(`/api/crm/opportunities/${opportunityId}`, { organisationId });
  const team = useTeam(organisationId);
  const baseCurrency = useBaseCurrency();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const page = data.data;
  const { opportunity, tasks, invoice } = page;
  const values: RecordValues = {
    standard: {
      name: opportunity.name,
      contactId: opportunity.contactId,
      pointOfContactId: opportunity.pointOfContactId,
      ownerUserId: opportunity.ownerUserId,
      amount: opportunity.amount,
      closeDate: opportunity.closeDate,
      stage: opportunity.stage,
    },
    custom: opportunity.customFields,
  };
  const stageBadge = (stage: OpportunityStage) => <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>;
  const display = (key: string): ReactNode => {
    switch (key) {
      case "contactId":
        return <Link href={`/crm/companies/${opportunity.contactId}`}>{opportunity.contactName}</Link>;
      case "pointOfContactId":
        return opportunity.pointOfContactId ? <Link href={`/crm/people/${opportunity.pointOfContactId}`}>{opportunity.pointOfContactName}</Link> : "";
      case "ownerUserId":
        return memberName(team.data?.team, opportunity.ownerUserId);
      case "amount":
        return amountIn(opportunity.amount, opportunity.currencyCode, baseCurrency);
      case "closeDate":
        return opportunity.closeDate ? formatDate(opportunity.closeDate) : "";
      case "stage":
        return stageBadge(opportunity.stage);
      case "createdAt":
        return formatDateTime(opportunity.createdAt);
      case "updatedAt":
        return formatDateTime(opportunity.updatedAt);
      default:
        return values.standard[key] ?? "";
    }
  };
  return (
    <RecordFrame
      header={
        <RecordHeader
          organisationId={organisationId}
          record="opportunity"
          recordId={opportunity.id}
          name={opportunity.name}
          recordType={page.recordType}
          backHref="/crm/pipeline"
          onChanged={data.reload}
          highlights={[
            ["Company", display("contactId")],
            ["Amount (excl. GST)", display("amount")],
            ["Stage", display("stage")],
            ["Expected close date", display("closeDate")],
            ["Owner", display("ownerUserId")],
          ]}
          actions={<InvoiceAction organisationId={organisationId} opportunity={opportunity} onChanged={data.reload} />}
        />
      }
      details={
        <DetailsTab
          organisationId={organisationId}
          record="opportunity"
          recordId={opportunity.id}
          recordType={page.recordType}
          uses={["opportunity"]}
          values={values}
          display={display}
          contactId={opportunity.contactId}
          onSaved={data.reload}
        />
      }
      related={
        <>
          <Card title="Company">
            <Link href={`/crm/companies/${opportunity.contactId}`}>{opportunity.contactName}</Link>
            {opportunity.pointOfContactId ? (
              <>
                {" · "}
                <Link href={`/crm/people/${opportunity.pointOfContactId}`}>{opportunity.pointOfContactName}</Link>
              </>
            ) : null}
          </Card>
          <RelatedCard
            title="Invoice"
            count={invoice ? 1 : 0}
            items={invoice ? [invoice] : []}
            empty="No invoice yet. A won opportunity can make one."
            render={(shown) => (
              <DocumentList
                documents={shown.map((entry) => ({
                  id: entry.id,
                  number: entry.invoiceNumber,
                  date: entry.invoiceDate,
                  dueDate: entry.dueDate,
                  status: entry.status,
                  currencyCode: entry.currencyCode,
                  total: entry.total,
                }))}
                href={(id) => `/operations/invoices/${id}`}
                label="invoice"
              />
            )}
          />
          <TasksRelated
            organisationId={organisationId}
            tasks={tasks}
            onChanged={data.reload}
            addForm={(done) => (
              <TaskForm
                organisationId={organisationId}
                contactId={opportunity.contactId}
                opportunityId={opportunity.id}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )}
          />
        </>
      }
      activity={
        <ActivityPanel
          tasks={tasks}
          timeline={page.timeline}
          form={(kind, done) =>
            kind === "task" ? (
              <TaskForm
                organisationId={organisationId}
                contactId={opportunity.contactId}
                opportunityId={opportunity.id}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            ) : (
              <ActivityForm
                organisationId={organisationId}
                contactId={opportunity.contactId}
                opportunityId={opportunity.id}
                initialKind={kind}
                people={[]}
                opportunities={[opportunity]}
                onSaved={() => {
                  done();
                  data.reload();
                }}
                onCancel={done}
              />
            )
          }
        />
      }
    />
  );
}
