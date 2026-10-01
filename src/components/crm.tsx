"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import {
  CustomFieldInputs,
  CustomValueCell,
  CustomValuesList,
  listColumns,
  startingValues,
  useCustomFields,
  visibleFields,
} from "@/components/custom-fields";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type {
  Activity,
  ActivityKind,
  CompanySummary,
  Opportunity,
  OpportunityStage,
  Person,
  Task,
  TaskStatus,
  TeamMember,
  TimelineEntry,
} from "@/lib/crm/service";
import { contactUses, type CustomFieldSetup, type CustomValues, customValueText } from "@/lib/custom-fields/values";
import { formatDate, formatDateTime, formatMoney, todayInBrowser } from "@/lib/format";
import type { Invoice } from "@/lib/invoices/service";
import { add, dec, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * The total of some opportunities' amounts, exactly (never floating point),
 * per currency (MC68): "2,400.00" when all are in the base currency, else
 * like "NZD 1,000.00 + USD 2,400.00". Amounts in different currencies are
 * never added together.
 */
function totalAmounts(opportunities: readonly Opportunity[], base: string): string {
  const sums = new Map<string, ReturnType<typeof dec>>();
  for (const opportunity of opportunities) sums.set(opportunity.currencyCode, add(sums.get(opportunity.currencyCode) ?? ZERO_DECIMAL, dec(opportunity.amount)));
  const codes = [...sums.keys()].sort((a, b) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)));
  if (codes.length === 0 || (codes.length === 1 && codes[0] === base)) return formatMoney(toFixedString(sums.get(base) ?? ZERO_DECIMAL, 2));
  return codes.map((code) => `${code} ${formatMoney(toFixedString(sums.get(code)!, 2))}`).join(" + ");
}

/** An amount in a currency: prefixed with it unless it's the base currency. */
function amountIn(amount: string, currency: string, base: string): string {
  return currency === base ? formatMoney(amount) : `${currency} ${formatMoney(amount)}`;
}

function useBaseCurrency(): string {
  return useWorkspace().current?.baseCurrency ?? "NZD";
}

/**
 * The CRM screens (examples CRM1-CRM9), after Twenty's companies, people,
 * opportunities board, tasks and timeline.
 */

// These mirror the server's lists (src/lib/crm/service.ts), which can't be imported into the browser.
export const STAGES: OpportunityStage[] = ["new", "screening", "meeting", "proposal", "won", "lost"];
export const STAGE_LABELS: Record<OpportunityStage, string> = {
  new: "New",
  screening: "Screening",
  meeting: "Meeting",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};
const STAGE_TONES: Record<OpportunityStage, "neutral" | "blue" | "green" | "amber" | "red"> = {
  new: "neutral",
  screening: "blue",
  meeting: "blue",
  proposal: "amber",
  won: "green",
  lost: "red",
};
const TASK_LABELS: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };
const ACTIVITY_LABELS: Record<ActivityKind, string> = { call: "Call", meeting: "Meeting", note: "Note" };

export function useTeam(organisationId: string) {
  return useApiData<{ crmEnabled: boolean; team: TeamMember[] }>("/api/crm/team", { organisationId });
}

function memberName(team: TeamMember[] | undefined, userId: string | null): string {
  if (!userId) return "";
  return team?.find((member) => member.userId === userId)?.displayName ?? "Former member";
}

/** Shows the page only while the CRM is on (MOD1). */
export function RequireCrm({ organisationId, children }: { organisationId: string; children: ReactNode }) {
  const modules = useModules(organisationId);
  const { can } = useWorkspace();
  if (!modules) return <p className={ui.muted}>Loading…</p>;
  if (!modules.crm) {
    return (
      <Notice tone="info">
        The CRM is off.{" "}
        {can("admin") ? (
          <>
            Turn it on in <Link href="/operations/settings">Settings › Modules</Link>.
          </>
        ) : (
          "An admin can turn it on in Settings."
        )}
      </Notice>
    );
  }
  return <>{children}</>;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function kindBadges(company: { isCustomer: boolean; isSupplier: boolean; isProspect: boolean }) {
  return (
    <span className={ui.rowButtons}>
      {company.isProspect ? <Badge tone="amber">Prospect</Badge> : null}
      {company.isCustomer ? <Badge tone="green">Customer</Badge> : null}
      {company.isSupplier ? <Badge tone="blue">Supplier</Badge> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Companies (CRM1, CRM8)

function NewProspectForm({ organisationId, onSaved }: { organisationId: string; onSaved: (contact: Contact) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [key] = useState(() => newIdempotencyKey("prospect"));
  const customSetup = useCustomFields(organisationId);
  // Each prospect field's default, until someone changes a value (CRMF3).
  const [custom, setCustom] = useState<CustomValues | null>(null);
  const customFields = custom ?? startingValues(customSetup.data, "contact", ["prospect"]);
  const { busy, error, run } = useBusy();
  return (
    <form
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const result = await api<{ contact: Contact }>("/api/contacts", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey: key, name, email: email || null, phone: phone || null, isProspect: true, customFields },
          });
          onSaved(result.contact);
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        <Field label="Company name">
          <input value={name} maxLength={150} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Email">
          <input type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Phone">
          <input type="tel" value={phone} maxLength={50} onChange={(event) => setPhone(event.target.value)} />
        </Field>
      </div>
      <CustomFieldInputs setup={customSetup.data} record="contact" uses={["prospect"]} value={customFields} onChange={setCustom} disabled={busy} />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add prospect"}
        </Button>
      </div>
    </form>
  );
}

export function CompaniesPage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const baseCurrency = useBaseCurrency();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const companies = useApiData<{ companies: CompanySummary[] }>("/api/crm/companies", { organisationId, search: search || null });
  const customSetup = useCustomFields(organisationId);
  // Contact fields marked "show in lists", for whichever roles are switched on (CRMF7).
  const columns = listColumns(customSetup.data, "contact", ["customer", "supplier", "prospect"]);
  return (
    <>
      <Card
        title="Companies"
        description="Everyone you deal with: prospects, customers and suppliers. Open one for its people, opportunities, tasks and timeline."
        actions={
          can("bookkeeper") && !adding ? (
            <Button size="small" onClick={() => setAdding(true)}>
              New prospect
            </Button>
          ) : null
        }
      >
        {adding ? (
          <NewProspectForm
            organisationId={organisationId}
            onSaved={(contact) => router.push(`/operations/crm/companies/${contact.id}`)}
          />
        ) : null}
        <div className={ui.inlineForm}>
          <Field label="Search">
            <input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} />
          </Field>
        </div>
        {companies.error ? <Notice tone="error">{companies.error}</Notice> : null}
        {companies.data && companies.data.companies.length === 0 ? <Empty>No companies yet.</Empty> : null}
        {companies.data && companies.data.companies.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Type</th>
                  <th className={ui.num}>People</th>
                  <th className={ui.num}>Open tasks</th>
                  <th className={ui.num}>Open pipeline</th>
                  <th>Last activity</th>
                  {columns.map((field) => (
                    <th key={field.id}>{field.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {companies.data.companies.map((company) => (
                  <tr key={company.contactId}>
                    <td>
                      <Link href={`/operations/crm/companies/${company.contactId}`}>{company.name}</Link>
                    </td>
                    <td>{kindBadges(company)}</td>
                    <td className={ui.num}>{company.people}</td>
                    <td className={ui.num}>{company.openTasks}</td>
                    <td className={ui.num}>
                      {company.currencyCode !== baseCurrency && company.openPipeline !== "0.00" ? (
                        <span className={ui.num}>{amountIn(company.openPipeline, company.currencyCode, baseCurrency)}</span>
                      ) : (
                        <Money value={company.openPipeline} blankZero />
                      )}
                    </td>
                    <td>{company.lastActivityAt ? formatDateTime(company.lastActivityAt) : ""}</td>
                    {columns.map((field) => (
                      <CustomValueCell key={field.id} field={field} values={company.customFields} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// People (CRM2)

type PersonDraft = { contactId: string; firstName: string; lastName: string; jobTitle: string; email: string; phone: string };

function PersonForm({
  organisationId,
  person,
  fixedContactId,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  person?: Person;
  fixedContactId?: string;
  onSaved: (person: Person) => void;
  onCancel?: () => void;
}) {
  const contacts = useApiData<{ contacts: Contact[] }>(fixedContactId ? null : "/api/contacts", { organisationId });
  const [draft, setDraft] = useState<PersonDraft>({
    contactId: person?.contactId ?? fixedContactId ?? "",
    firstName: person?.firstName ?? "",
    lastName: person?.lastName ?? "",
    jobTitle: person?.jobTitle ?? "",
    email: person?.email ?? "",
    phone: person?.phone ?? "",
  });
  const customSetup = useCustomFields(organisationId);
  // A new person starts with each field's default (CRMF4).
  const [custom, setCustom] = useState<CustomValues | null>(person ? person.customFields : null);
  const customFields = custom ?? startingValues(customSetup.data, "person", ["person"]);
  const { busy, error, run } = useBusy();
  const set = (patch: Partial<PersonDraft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const body = {
            organisationId,
            contactId: draft.contactId || null,
            firstName: draft.firstName,
            lastName: draft.lastName || null,
            jobTitle: draft.jobTitle || null,
            email: draft.email || null,
            phone: draft.phone || null,
            customFields,
          };
          const result = person
            ? await api<{ person: Person }>(`/api/crm/people/${person.id}`, { method: "PATCH", body })
            : await api<{ person: Person }>("/api/crm/people", { method: "POST", body });
          onSaved(result.person);
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="First name">
          <input value={draft.firstName} maxLength={100} onChange={(event) => set({ firstName: event.target.value })} required />
        </Field>
        <Field label="Last name">
          <input value={draft.lastName} maxLength={100} onChange={(event) => set({ lastName: event.target.value })} />
        </Field>
        <Field label="Job title">
          <input value={draft.jobTitle} maxLength={100} onChange={(event) => set({ jobTitle: event.target.value })} />
        </Field>
        <Field label="Email">
          <input type="email" value={draft.email} maxLength={254} onChange={(event) => set({ email: event.target.value })} />
        </Field>
        <Field label="Phone">
          <input type="tel" value={draft.phone} maxLength={50} onChange={(event) => set({ phone: event.target.value })} />
        </Field>
        {fixedContactId ? null : (
          <Field label="Company">
            <select value={draft.contactId} onChange={(event) => set({ contactId: event.target.value })}>
              <option value="">None</option>
              {(contacts.data?.contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <CustomFieldInputs setup={customSetup.data} record="person" uses={["person"]} value={customFields} onChange={setCustom} disabled={busy} />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !draft.firstName.trim()}>
          {busy ? "Saving…" : person ? "Save" : "Add person"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PeopleTable({
  organisationId,
  people,
  showCompany,
  customSetup,
  onChanged,
}: {
  organisationId: string;
  people: Person[];
  showCompany: boolean;
  customSetup: CustomFieldSetup | null | undefined;
  onChanged: () => void;
}) {
  const { can } = useWorkspace();
  const [editing, setEditing] = useState<string | null>(null);
  const { error, run } = useBusy();
  // People fields marked "show in lists" (CRMF7).
  const columns = listColumns(customSetup, "person", ["person"]);
  if (people.length === 0) return <Empty>No people yet.</Empty>;
  return (
    <div className={ui.tableWrap}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Job title</th>
            {showCompany ? <th>Company</th> : null}
            <th>Email</th>
            <th>Phone</th>
            {columns.map((field) => (
              <th key={field.id}>{field.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {people.map((person) =>
            editing === person.id ? (
              <tr key={person.id}>
                <td colSpan={(showCompany ? 6 : 5) + columns.length}>
                  <PersonForm
                    organisationId={organisationId}
                    person={person}
                    fixedContactId={showCompany ? undefined : (person.contactId ?? undefined)}
                    onSaved={() => {
                      setEditing(null);
                      onChanged();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr key={person.id}>
                <td>
                  {person.fullName} {person.isArchived ? <Badge>Archived</Badge> : null}
                </td>
                <td>{person.jobTitle ?? ""}</td>
                {showCompany ? (
                  <td>{person.contactId ? <Link href={`/operations/crm/companies/${person.contactId}`}>{person.contactName}</Link> : ""}</td>
                ) : null}
                <td>{person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : ""}</td>
                <td>{person.phone ? <a href={`tel:${person.phone}`}>{person.phone}</a> : ""}</td>
                {columns.map((field) => (
                  <CustomValueCell key={field.id} field={field} values={person.customFields} />
                ))}
                <td className={ui.num}>
                  {can("bookkeeper") ? (
                    <span className={ui.rowButtons}>
                      <Button size="small" variant="secondary" onClick={() => setEditing(person.id)}>
                        Edit
                      </Button>
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() =>
                          void run(async () => {
                            await api(`/api/crm/people/${person.id}`, {
                              method: "PATCH",
                              body: { organisationId, isArchived: !person.isArchived },
                            });
                            onChanged();
                          })
                        }
                      >
                        {person.isArchived ? "Restore" : "Archive"}
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function PeoplePage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const customSetup = useCustomFields(organisationId);
  const people = useApiData<{ people: Person[] }>("/api/crm/people", {
    organisationId,
    search: search || null,
    includeArchived: showArchived ? "true" : null,
  });
  return (
    <Card
      title="People"
      description="The people you deal with, at the companies they work for."
      actions={
        <>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
          </label>
          {can("bookkeeper") && !adding ? (
            <Button size="small" onClick={() => setAdding(true)}>
              New person
            </Button>
          ) : null}
        </>
      }
    >
      {adding ? (
        <PersonForm
          organisationId={organisationId}
          onSaved={() => {
            setAdding(false);
            people.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      <div className={ui.inlineForm}>
        <Field label="Search">
          <input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} />
        </Field>
      </div>
      {people.error ? <Notice tone="error">{people.error}</Notice> : null}
      {people.data ? <PeopleTable organisationId={organisationId} people={people.data.people} showCompany customSetup={customSetup.data} onChanged={people.reload} /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Opportunities (CRM3-CRM5, CRM9)

type OpportunityDraft = {
  name: string;
  contactId: string;
  pointOfContactId: string;
  ownerUserId: string;
  amount: string;
  closeDate: string;
  stage: OpportunityStage;
};

function OpportunityForm({
  organisationId,
  opportunity,
  fixedContactId,
  fixedCurrency,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  opportunity?: Opportunity;
  fixedContactId?: string;
  /** The fixed company's currency, when there's one. */
  fixedCurrency?: string;
  onSaved: (opportunity: Opportunity) => void;
  onCancel?: () => void;
}) {
  const { user } = useWorkspace();
  const baseCurrency = useBaseCurrency();
  const team = useTeam(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>(fixedContactId ? null : "/api/contacts", { organisationId });
  const [draft, setDraft] = useState<OpportunityDraft>({
    name: opportunity?.name ?? "",
    contactId: opportunity?.contactId ?? fixedContactId ?? "",
    pointOfContactId: opportunity?.pointOfContactId ?? "",
    ownerUserId: opportunity ? (opportunity.ownerUserId ?? "") : user.id,
    amount: opportunity?.amount ?? "",
    closeDate: opportunity?.closeDate ?? "",
    stage: opportunity?.stage ?? "new",
  });
  const people = useApiData<{ people: Person[] }>(draft.contactId ? "/api/crm/people" : null, { organisationId, contactId: draft.contactId });
  const customSetup = useCustomFields(organisationId);
  // A new opportunity starts with each field's default (CRMF5).
  const [custom, setCustom] = useState<CustomValues | null>(opportunity ? opportunity.customFields : null);
  const customFields = custom ?? startingValues(customSetup.data, "opportunity", ["opportunity"]);
  const { busy, error, run } = useBusy();
  const set = (patch: Partial<OpportunityDraft>) => setDraft({ ...draft, ...patch });
  // The amount is in the company's currency (MC68).
  const chosen = contacts.data?.contacts.find((contact) => contact.id === draft.contactId);
  const amountCurrency = chosen ? (chosen.currencyCode ?? baseCurrency) : draft.contactId === opportunity?.contactId ? opportunity?.currencyCode : fixedCurrency;
  return (
    <form
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const body = {
            organisationId,
            name: draft.name,
            contactId: draft.contactId,
            pointOfContactId: draft.pointOfContactId || null,
            ownerUserId: draft.ownerUserId || null,
            amount: draft.amount || "0",
            closeDate: draft.closeDate || null,
            stage: draft.stage,
            customFields,
          };
          const result = opportunity
            ? await api<{ opportunity: Opportunity }>(`/api/crm/opportunities/${opportunity.id}`, { method: "PATCH", body })
            : await api<{ opportunity: Opportunity }>("/api/crm/opportunities", { method: "POST", body });
          onSaved(result.opportunity);
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Opportunity">
          <input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} required />
        </Field>
        {fixedContactId ? null : (
          <Field label="Company">
            <select value={draft.contactId} onChange={(event) => set({ contactId: event.target.value, pointOfContactId: "" })} required>
              <option value="">Choose a company</option>
              {(contacts.data?.contacts ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Point of contact">
          <select value={draft.pointOfContactId} onChange={(event) => set({ pointOfContactId: event.target.value })}>
            <option value="">None</option>
            {(people.data?.people ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Amount (excl. GST${amountCurrency && amountCurrency !== baseCurrency ? `, ${amountCurrency}` : ""})`} hint="In the company's currency.">
          <input inputMode="decimal" className={ui.num} value={draft.amount} onChange={(event) => set({ amount: event.target.value })} />
        </Field>
        <Field label="Expected close date">
          <input type="date" value={draft.closeDate} onChange={(event) => set({ closeDate: event.target.value })} />
        </Field>
        <Field label="Owner">
          <select value={draft.ownerUserId} onChange={(event) => set({ ownerUserId: event.target.value })}>
            <option value="">No one</option>
            {(team.data?.team ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stage">
          <select value={draft.stage} disabled={Boolean(opportunity?.invoiceId)} onChange={(event) => set({ stage: event.target.value as OpportunityStage })}>
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <CustomFieldInputs setup={customSetup.data} record="opportunity" uses={["opportunity"]} value={customFields} onChange={setCustom} disabled={busy} />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !draft.name.trim() || !draft.contactId}>
          {busy ? "Saving…" : opportunity ? "Save" : "Add opportunity"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** "Make invoice" on a won opportunity, or a link to the invoice it made (CRM5). */
function InvoiceAction({ organisationId, opportunity, onChanged }: { organisationId: string; opportunity: Opportunity; onChanged: () => void }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const { busy, error, run } = useBusy();
  // A company in another currency gets an invoice in it, at a rate for today (MC69).
  const baseCurrency = useBaseCurrency();
  const foreign = opportunity.currencyCode !== baseCurrency;
  const [askingRate, setAskingRate] = useState(false);
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, opportunity.currencyCode, baseCurrency, askingRate ? todayInBrowser() : "");
  if (opportunity.invoiceId) {
    return <Link href={`/operations/invoices/${opportunity.invoiceId}`}>{opportunity.invoiceNumber ?? "Draft invoice"}</Link>;
  }
  if (opportunity.stage !== "won" || !can("bookkeeper")) return null;
  const make = () =>
    void run(async () => {
      const result = await api<{ invoice: Invoice }>(`/api/crm/opportunities/${opportunity.id}/invoice`, {
        method: "POST",
        body: { organisationId, ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}) },
      });
      onChanged();
      router.push(`/operations/invoices/${result.invoice.id}`);
    });
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {foreign && askingRate ? (
        <ExchangeRateField currencyCode={opportunity.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
      ) : null}
      <Button size="small" disabled={busy} onClick={() => (foreign && !askingRate ? setAskingRate(true) : make())}>
        {busy ? "Making…" : foreign && !askingRate ? `Make ${opportunity.currencyCode} invoice` : "Make invoice"}
      </Button>
    </>
  );
}

/** An opportunity's "show in lists" values on its card, like "Lead source: Website" (CRMF7). */
function CardValues({ setup, values }: { setup: CustomFieldSetup | null | undefined; values: CustomValues }) {
  const shown = listColumns(setup, "opportunity", ["opportunity"]).filter((field) => values[field.id] !== undefined);
  if (shown.length === 0) return null;
  return <div className={ui.muted}>{shown.map((field) => `${field.label}: ${customValueText(field, values[field.id])}`).join(" · ")}</div>;
}

function OpportunityCard({
  organisationId,
  opportunity,
  team,
  customSetup,
  onChanged,
  onDragStart,
}: {
  organisationId: string;
  opportunity: Opportunity;
  team: TeamMember[] | undefined;
  customSetup: CustomFieldSetup | null | undefined;
  onChanged: () => void;
  onDragStart?: () => void;
}) {
  const { can } = useWorkspace();
  const baseCurrency = useBaseCurrency();
  const [editing, setEditing] = useState(false);
  const { error, run } = useBusy();
  const editable = can("bookkeeper");
  if (editing) {
    return (
      <div className={ui.crmCard}>
        <OpportunityForm
          organisationId={organisationId}
          opportunity={opportunity}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }
  return (
    <div
      className={ui.crmCard}
      draggable={editable && !opportunity.invoiceId}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", opportunity.id);
        onDragStart?.();
      }}
    >
      <strong>{opportunity.name}</strong>
      <div>
        <Link href={`/operations/crm/companies/${opportunity.contactId}`}>{opportunity.contactName}</Link>
        {opportunity.pointOfContactName ? <span className={ui.muted}> · {opportunity.pointOfContactName}</span> : null}
      </div>
      <div className={ui.muted}>
        {amountIn(opportunity.amount, opportunity.currencyCode, baseCurrency)}
        {opportunity.closeDate ? ` · closes ${formatDate(opportunity.closeDate)}` : ""}
        {opportunity.ownerUserId ? ` · ${memberName(team, opportunity.ownerUserId)}` : ""}
      </div>
      <CardValues setup={customSetup} values={opportunity.customFields} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        {editable && !opportunity.invoiceId ? (
          <select
            aria-label={`Stage of ${opportunity.name}`}
            value={opportunity.stage}
            onChange={(event) =>
              void run(async () => {
                await api(`/api/crm/opportunities/${opportunity.id}`, { method: "PATCH", body: { organisationId, stage: event.target.value } });
                onChanged();
              })
            }
          >
            {STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        ) : (
          <Badge tone={STAGE_TONES[opportunity.stage]}>{STAGE_LABELS[opportunity.stage]}</Badge>
        )}
        {editable ? (
          <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
        <InvoiceAction organisationId={organisationId} opportunity={opportunity} onChanged={onChanged} />
      </div>
    </div>
  );
}

/** The pipeline board: a column per stage with its total; drag a card or pick its stage to move it (CRM4, CRM9). */
export function PipelinePage({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState<OpportunityStage | null>(null);
  const opportunities = useApiData<{ opportunities: Opportunity[] }>("/api/crm/opportunities", { organisationId });
  const customSetup = useCustomFields(organisationId);
  const team = useTeam(organisationId);
  const { error, run } = useBusy();
  const all = opportunities.data?.opportunities ?? [];
  const baseCurrency = useBaseCurrency();
  const total = (stage: OpportunityStage) => totalAmounts(all.filter((o) => o.stage === stage), baseCurrency);
  function drop(stage: OpportunityStage, id: string) {
    const card = all.find((o) => o.id === id);
    setOver(null);
    if (!card || card.stage === stage) return;
    void run(async () => {
      await api(`/api/crm/opportunities/${id}`, { method: "PATCH", body: { organisationId, stage } });
      opportunities.reload();
    });
  }
  return (
    <>
      <Card
        title="Pipeline"
        description="Opportunities by stage, amounts excluding GST. Drag a card to another stage, or pick its stage. A won opportunity can make its invoice."
        actions={
          can("bookkeeper") && !adding ? (
            <Button size="small" onClick={() => setAdding(true)}>
              New opportunity
            </Button>
          ) : null
        }
      >
        {adding ? (
          <OpportunityForm
            organisationId={organisationId}
            onSaved={() => {
              setAdding(false);
              opportunities.reload();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {opportunities.error ? <Notice tone="error">{opportunities.error}</Notice> : null}
      </Card>
      <div className={ui.crmBoard}>
        {STAGES.map((stage) => {
          const cards = all.filter((o) => o.stage === stage);
          return (
            <section
              key={stage}
              className={`${ui.crmColumn} ${over === stage ? ui.crmColumnOver : ""}`}
              aria-label={STAGE_LABELS[stage]}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((current) => (current === stage ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                drop(stage, event.dataTransfer.getData("text/plain"));
              }}
            >
              <header className={ui.crmColumnHeader}>
                <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>
                <span className={ui.muted}>
                  {cards.length} · {total(stage)}
                </span>
              </header>
              {cards.map((opportunity) => (
                <OpportunityCard
                  key={`${opportunity.id}:${opportunity.updatedAt}`}
                  organisationId={organisationId}
                  opportunity={opportunity}
                  team={team.data?.team}
                  customSetup={customSetup.data}
                  onChanged={opportunities.reload}
                />
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Tasks (CRM6)

type TaskDraft = { title: string; body: string; dueDate: string; assigneeUserId: string; opportunityId: string; personId: string };

function TaskForm({
  organisationId,
  contactId,
  opportunities,
  people,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  contactId?: string;
  opportunities?: Opportunity[];
  people?: Person[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { user } = useWorkspace();
  const team = useTeam(organisationId);
  const [draft, setDraft] = useState<TaskDraft>({ title: "", body: "", dueDate: "", assigneeUserId: user.id, opportunityId: "", personId: "" });
  const { busy, error, run } = useBusy();
  const set = (patch: Partial<TaskDraft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api("/api/crm/tasks", {
            method: "POST",
            body: {
              organisationId,
              title: draft.title,
              body: draft.body || null,
              dueDate: draft.dueDate || null,
              assigneeUserId: draft.assigneeUserId || null,
              contactId: contactId ?? null,
              opportunityId: draft.opportunityId || null,
              personId: draft.personId || null,
            },
          });
          setDraft({ ...draft, title: "", body: "", dueDate: "" });
          onSaved();
        });
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Task">
          <input value={draft.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} required />
        </Field>
        <Field label="Due">
          <input type="date" value={draft.dueDate} onChange={(event) => set({ dueDate: event.target.value })} />
        </Field>
        <Field label="Assigned to">
          <select value={draft.assigneeUserId} onChange={(event) => set({ assigneeUserId: event.target.value })}>
            <option value="">No one</option>
            {(team.data?.team ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.displayName}
              </option>
            ))}
          </select>
        </Field>
        {opportunities && opportunities.length > 0 ? (
          <Field label="About the opportunity">
            <select value={draft.opportunityId} onChange={(event) => set({ opportunityId: event.target.value })}>
              <option value="">None</option>
              {opportunities.map((opportunity) => (
                <option key={opportunity.id} value={opportunity.id}>
                  {opportunity.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {people && people.length > 0 ? (
          <Field label="About the person">
            <select value={draft.personId} onChange={(event) => set({ personId: event.target.value })}>
              <option value="">None</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Details">
          <input value={draft.body} maxLength={4000} onChange={(event) => set({ body: event.target.value })} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !draft.title.trim()}>
          {busy ? "Adding…" : "Add task"}
        </Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function TaskList({ organisationId, tasks, onChanged, showAbout }: { organisationId: string; tasks: Task[]; onChanged: () => void; showAbout: boolean }) {
  const { can } = useWorkspace();
  const team = useTeam(organisationId);
  const { error, run } = useBusy();
  const today = todayInBrowser();
  if (tasks.length === 0) return <Empty>No tasks.</Empty>;
  return (
    <div className={ui.tableWrap}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Task</th>
            {showAbout ? <th>About</th> : null}
            <th>Due</th>
            <th>Assigned to</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                {task.status === "done" ? <s>{task.title}</s> : task.title}
                {task.body ? <div className={ui.muted}>{task.body}</div> : null}
              </td>
              {showAbout ? (
                <td>
                  {task.contactId ? <Link href={`/operations/crm/companies/${task.contactId}`}>{task.contactName}</Link> : null}
                  {[task.personName, task.opportunityName].filter(Boolean).length > 0 ? (
                    <div className={ui.muted}>{[task.personName, task.opportunityName].filter(Boolean).join(" · ")}</div>
                  ) : null}
                </td>
              ) : null}
              <td>
                {task.dueDate ? formatDate(task.dueDate) : ""}{" "}
                {task.dueDate && task.status !== "done" && task.dueDate < today ? <Badge tone="red">Overdue</Badge> : null}
              </td>
              <td>{memberName(team.data?.team, task.assigneeUserId)}</td>
              <td>
                {can("bookkeeper") ? (
                  <select
                    aria-label={`Status of ${task.title}`}
                    value={task.status}
                    onChange={(event) =>
                      void run(async () => {
                        await api(`/api/crm/tasks/${task.id}`, { method: "PATCH", body: { organisationId, status: event.target.value } });
                        onChanged();
                      })
                    }
                  >
                    {(Object.keys(TASK_LABELS) as TaskStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {TASK_LABELS[status]}
                      </option>
                    ))}
                  </select>
                ) : (
                  TASK_LABELS[task.status]
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TasksPage({ organisationId }: { organisationId: string }) {
  const { user, can } = useWorkspace();
  const [filter, setFilter] = useState<"mine" | "open" | "all">("mine");
  const [adding, setAdding] = useState(false);
  const tasks = useApiData<{ tasks: Task[] }>("/api/crm/tasks", {
    organisationId,
    open: filter === "all" ? null : "true",
    assigneeUserId: filter === "mine" ? user.id : null,
  });
  return (
    <Card
      title="Tasks"
      actions={
        <>
          <select aria-label="Show" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="mine">My open tasks</option>
            <option value="open">Everyone&apos;s open tasks</option>
            <option value="all">All tasks, including done</option>
          </select>
          {can("bookkeeper") && !adding ? (
            <Button size="small" onClick={() => setAdding(true)}>
              New task
            </Button>
          ) : null}
        </>
      }
    >
      {adding ? (
        <TaskForm
          organisationId={organisationId}
          onSaved={() => {
            setAdding(false);
            tasks.reload();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {tasks.error ? <Notice tone="error">{tasks.error}</Notice> : null}
      {tasks.data ? <TaskList organisationId={organisationId} tasks={tasks.data.tasks} onChanged={tasks.reload} showAbout /> : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A company's page: people, opportunities, tasks, activities and timeline (CRM7, CRM8)

type CompanyData = {
  contact: Contact;
  people: Person[];
  opportunities: Opportunity[];
  tasks: Task[];
  activities: Activity[];
  timeline: TimelineEntry[];
};

function nowForInput(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function ActivityForm({ organisationId, contactId, people, opportunities, onSaved }: { organisationId: string; contactId: string; people: Person[]; opportunities: Opportunity[]; onSaved: () => void }) {
  const [kind, setKind] = useState<ActivityKind>("call");
  const [happenedAt, setHappenedAt] = useState(nowForInput);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [personId, setPersonId] = useState("");
  const [opportunityId, setOpportunityId] = useState("");
  const { busy, error, run } = useBusy();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      await api("/api/crm/activities", {
        method: "POST",
        body: {
          organisationId,
          kind,
          happenedAt: new Date(happenedAt).toISOString(),
          subject,
          body: body || null,
          contactId,
          personId: personId || null,
          opportunityId: opportunityId || null,
        },
      });
      setSubject("");
      setBody("");
      setHappenedAt(nowForInput());
      onSaved();
    });
  }
  return (
    <form style={{ display: "grid", gap: 10 }} onSubmit={(event) => void submit(event)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Log a">
          <select value={kind} onChange={(event) => setKind(event.target.value as ActivityKind)}>
            {(Object.keys(ACTIVITY_LABELS) as ActivityKind[]).map((entry) => (
              <option key={entry} value={entry}>
                {ACTIVITY_LABELS[entry]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When">
          <input type="datetime-local" value={happenedAt} onChange={(event) => setHappenedAt(event.target.value)} required />
        </Field>
        <Field label="Subject">
          <input value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} required />
        </Field>
        {people.length > 0 ? (
          <Field label="With">
            <select value={personId} onChange={(event) => setPersonId(event.target.value)}>
              <option value="">No one in particular</option>
              {people
                .filter((person) => !person.isArchived)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName}
                  </option>
                ))}
            </select>
          </Field>
        ) : null}
        {opportunities.length > 0 ? (
          <Field label="About the opportunity">
            <select value={opportunityId} onChange={(event) => setOpportunityId(event.target.value)}>
              <option value="">None</option>
              {opportunities.map((opportunity) => (
                <option key={opportunity.id} value={opportunity.id}>
                  {opportunity.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <Field label="Notes">
        <textarea rows={3} value={body} maxLength={10000} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !subject.trim()}>
          {busy ? "Saving…" : `Log ${ACTIVITY_LABELS[kind].toLowerCase()}`}
        </Button>
      </div>
    </form>
  );
}

/** The company's custom field values in their sections, and a form to change them (CRMF3, CRMF6). */
function CompanyFields({
  organisationId,
  contact,
  setup,
  editing,
  onEdit,
  onSaved,
}: {
  organisationId: string;
  contact: Contact;
  setup: CustomFieldSetup | null | undefined;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onSaved: () => void;
}) {
  const { can } = useWorkspace();
  const [values, setValues] = useState<CustomValues>(contact.customFields);
  const { busy, error, run } = useBusy();
  const uses = contactUses(contact);
  const hasValues = Object.keys(contact.customFields).length > 0;
  const canEdit = can("bookkeeper") && visibleFields(setup, "contact", uses, contact.customFields).length > 0;
  const admin = can("admin");
  if (!hasValues && !canEdit && !admin) return null;
  return (
    <Card
      title="Fields"
      description="Your organisation's own fields on this company. They never change an amount, an account or a GST box."
      actions={
        <span className={ui.actions}>
          {canEdit && !editing ? (
            <Button size="small" variant="secondary" onClick={() => onEdit(true)}>
              Edit fields
            </Button>
          ) : null}
          {admin ? <Link href="/operations/settings/custom-fields">Set up fields</Link> : null}
        </span>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing ? (
        <form
          style={{ display: "grid", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { organisationId, customFields: values } });
              onSaved();
            });
          }}
        >
          <CustomFieldInputs setup={setup} record="contact" uses={uses} value={values} onChange={setValues} disabled={busy} />
          <div className={ui.actions}>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setValues(contact.customFields);
                onEdit(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : hasValues ? (
        <CustomValuesList setup={setup} record="contact" values={contact.customFields} />
      ) : (
        <Empty>{canEdit ? "None filled in yet." : "No fields for this company yet."}</Empty>
      )}
    </Card>
  );
}

export function CompanyPage({ organisationId, contactId }: { organisationId: string; contactId: string }) {
  const { can } = useWorkspace();
  const data = useApiData<CompanyData>(`/api/crm/companies/${contactId}`, { organisationId });
  const baseCurrency = useBaseCurrency();
  const team = useTeam(organisationId);
  const customSetup = useCustomFields(organisationId);
  const [adding, setAdding] = useState<"person" | "opportunity" | "task" | null>(null);
  const [editingFields, setEditingFields] = useState(false);
  const { busy, error, run } = useBusy();
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading…</p>;
  const { contact, people, opportunities, tasks, timeline } = data.data;
  const editable = can("bookkeeper");
  const openPipeline = opportunities.filter((o) => ["new", "screening", "meeting", "proposal"].includes(o.stage));
  return (
    <>
      <div className={ui.actions}>
        <Link href="/operations/crm/companies">← Companies</Link>
      </div>
      <Card
        title={contact.name}
        description={[contact.email, contact.phone].filter(Boolean).join(" · ") || undefined}
        actions={
          <span className={ui.actions}>
            {kindBadges(contact)}
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
          </span>
        }
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className={ui.statRow}>
          <div>
            <span className={ui.muted}>People</span> <strong>{people.filter((p) => !p.isArchived).length}</strong>
          </div>
          <div>
            <span className={ui.muted}>Open opportunities</span> <strong>{openPipeline.length}</strong>{" "}
            <span className={ui.muted}>({totalAmounts(openPipeline, baseCurrency)})</span>
          </div>
          <div>
            <span className={ui.muted}>Open tasks</span> <strong>{tasks.filter((t) => t.status !== "done").length}</strong>
          </div>
        </div>
      </Card>

      <CompanyFields
        key={JSON.stringify(contact.customFields)}
        organisationId={organisationId}
        contact={contact}
        setup={customSetup.data}
        editing={editingFields}
        onEdit={setEditingFields}
        onSaved={() => {
          setEditingFields(false);
          data.reload();
        }}
      />

      {editable ? (
        <Card title="Log a call, meeting or note">
          <ActivityForm organisationId={organisationId} contactId={contact.id} people={people} opportunities={opportunities} onSaved={data.reload} />
        </Card>
      ) : null}

      <Card
        title="People"
        actions={
          editable && adding !== "person" ? (
            <Button size="small" variant="secondary" onClick={() => setAdding("person")}>
              Add person
            </Button>
          ) : null
        }
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
        <PeopleTable organisationId={organisationId} people={people} showCompany={false} customSetup={customSetup.data} onChanged={data.reload} />
      </Card>

      <Card
        title="Opportunities"
        actions={
          editable && adding !== "opportunity" ? (
            <Button size="small" variant="secondary" onClick={() => setAdding("opportunity")}>
              Add opportunity
            </Button>
          ) : null
        }
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
        {opportunities.length === 0 ? <Empty>No opportunities yet.</Empty> : null}
        <div className={ui.crmCards}>
          {opportunities.map((opportunity) => (
            <OpportunityCard
              key={`${opportunity.id}:${opportunity.updatedAt}`}
              organisationId={organisationId}
              opportunity={opportunity}
              team={team.data?.team}
              customSetup={customSetup.data}
              onChanged={data.reload}
            />
          ))}
        </div>
      </Card>

      <Card
        title="Tasks"
        actions={
          editable && adding !== "task" ? (
            <Button size="small" variant="secondary" onClick={() => setAdding("task")}>
              Add task
            </Button>
          ) : null
        }
      >
        {adding === "task" ? (
          <TaskForm
            organisationId={organisationId}
            contactId={contact.id}
            opportunities={opportunities}
            people={people.filter((p) => !p.isArchived)}
            onSaved={() => {
              setAdding(null);
              data.reload();
            }}
            onCancel={() => setAdding(null)}
          />
        ) : null}
        <TaskList organisationId={organisationId} tasks={tasks} onChanged={data.reload} showAbout={false} />
      </Card>

      <Card title="Timeline" description="Everything that happened with this company, newest first: calls, meetings, notes, tasks, opportunities, invoices and payments.">
        {timeline.length === 0 ? <Empty>Nothing yet.</Empty> : null}
        <ol className={ui.crmTimeline}>
          {timeline.map((entry, index) => (
            <li key={`${entry.kind}-${entry.at}-${index}`}>
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
      </Card>
    </>
  );
}
