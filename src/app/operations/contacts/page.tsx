"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useId, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { CustomFieldInputs, CustomValueCell, listColumns, startingValues, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import {
  ContactPeople,
  customerBody,
  type CustomerDraft,
  customerDraftFrom,
  CustomerFields,
  EMPTY_CUSTOMER_DRAFT,
  useCustomerSetup,
} from "@/components/customers";
import { useModules } from "@/components/modules";
import { SalespersonField, useSalespeople } from "@/components/salespeople";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { CustomerSetup } from "@/lib/customers/service";
import type { SalespeopleSetup } from "@/lib/salespeople/service";
import { type CustomFieldSetup, type CustomFieldUse, type CustomValues, fieldsFor } from "@/lib/custom-fields/values";
import { formatGstNumber } from "@/lib/format";
import { RecordExtrasPanel } from "@/components/records/record-extras";

type Draft = {
  name: string;
  isCustomer: boolean;
  isSupplier: boolean;
  email: string;
  phone: string;
  gstNumber: string;
  postalAddress: string;
  customFields: CustomValues;
  /** "" for none. */
  defaultSalespersonId: string;
  /** Only the CRM makes prospects (CRM1). */
  isProspect: boolean;
  /** Terms, delivery address, credit limit and so on (RC1-RC8). */
  customer: CustomerDraft;
  /** A supplier's payment terms (SPT1); "" for none. */
  supplierPaymentTermId: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  isCustomer: false,
  isSupplier: false,
  email: "",
  phone: "",
  gstNumber: "",
  postalAddress: "",
  customFields: {},
  defaultSalespersonId: "",
  isProspect: false,
  customer: EMPTY_CUSTOMER_DRAFT,
  supplierPaymentTermId: "",
};

function draftFrom(contact: Contact): Draft {
  return {
    name: contact.name,
    isCustomer: contact.isCustomer,
    isSupplier: contact.isSupplier,
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    gstNumber: formatGstNumber(contact.gstNumber),
    postalAddress: contact.postalAddress ?? "",
    customFields: contact.customFields,
    defaultSalespersonId: contact.defaultSalespersonId ?? "",
    isProspect: contact.isProspect,
    customer: customerDraftFrom(contact),
    supplierPaymentTermId: contact.supplierPaymentTermId ?? "",
  };
}

/**
 * What's sent: the customer details only for customers and the supplier's
 * terms only for suppliers (the server keeps a former customer's or supplier's).
 */
function bodyFrom(draft: Draft): Record<string, unknown> {
  const { customer, supplierPaymentTermId, ...rest } = draft;
  return {
    ...rest,
    ...(draft.isCustomer ? customerBody(customer) : {}),
    ...(draft.isSupplier ? { supplierPaymentTermId: supplierPaymentTermId || null } : {}),
  };
}

/** A prospect uses the customer fields, as on the server. */
function rolesOf(draft: { isCustomer: boolean; isSupplier: boolean; isProspect?: boolean }): CustomFieldUse[] {
  return [
    ...(draft.isCustomer || draft.isProspect ? (["customer"] as const) : []),
    ...(draft.isSupplier ? (["supplier"] as const) : []),
  ];
}

/**
 * The values to save: only fields for the contact's roles (a supplier-only
 * contact doesn't get a customer field's default, CF3), plus values it
 * already had.
 */
function valuesToSave(setup: CustomFieldSetup | null | undefined, draft: Draft, saved: CustomValues): CustomValues {
  if (!setup) return draft.customFields;
  const allowed = new Set(fieldsFor(setup.fields, "contact", rolesOf(draft), saved).map((field) => field.id));
  return Object.fromEntries(Object.entries(draft.customFields).filter(([id]) => allowed.has(id)));
}

function kind(contact: Contact): string {
  const kinds = [contact.isCustomer ? "Customer" : null, contact.isSupplier ? "supplier" : null, contact.isProspect ? "prospect" : null].filter(
    (entry): entry is string => entry !== null,
  );
  const text = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : (kinds[0] ?? "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ContactForm({
  initial,
  saved,
  customSetup,
  salespeople,
  customerSetup,
  customers,
  contactId,
  crm,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  /** The contact's stored custom field values ({} for a new one). */
  saved: CustomValues;
  customSetup: CustomFieldSetup | null | undefined;
  salespeople: SalespeopleSetup | null | undefined;
  customerSetup: CustomerSetup | null | undefined;
  /** Every contact, for the parent customer select. */
  customers: Contact[];
  contactId: string | null;
  /** Whether the CRM is on, so a contact can be a prospect. */
  crm: boolean;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typeLabelId = useId();
  // Values for fields the contact's roles use are shown; the rest (like a
  // customer field's default on a supplier) are kept aside and not saved.
  const shownIds = new Set(fieldsFor(customSetup?.fields ?? [], "contact", rolesOf(draft), saved).map((field) => field.id));
  const shown = Object.fromEntries(Object.entries(draft.customFields).filter(([id]) => shownIds.has(id)));
  const hidden = Object.fromEntries(Object.entries(draft.customFields).filter(([id]) => !shownIds.has(id)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...draft,
        customFields: valuesToSave(customSetup, draft, saved),
        // Only customers have a default salesperson (SR1).
        defaultSalespersonId: draft.isCustomer ? draft.defaultSalespersonId : initial.defaultSalespersonId,
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off" style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            maxLength={150}
            required
            autoFocus
          />
        </Field>
        <div className={ui.field} role="group" aria-labelledby={typeLabelId}>
          <span id={typeLabelId} className={ui.fieldLabel}>
            Type
          </span>
          <span className={ui.actions}>
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={draft.isCustomer}
                onChange={(event) => setDraft({ ...draft, isCustomer: event.target.checked })}
              />
              Customer
            </label>
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={draft.isSupplier}
                onChange={(event) => setDraft({ ...draft, isSupplier: event.target.checked })}
              />
              Supplier
            </label>
            {crm || draft.isProspect ? (
              <label className={ui.checkbox}>
                <input
                  type="checkbox"
                  checked={draft.isProspect}
                  onChange={(event) => setDraft({ ...draft, isProspect: event.target.checked })}
                />
                Prospect
              </label>
            ) : null}
          </span>
          <span className={ui.fieldHint}>{crm ? "Tick one or more. A prospect is someone you hope to sell to." : "Tick one or both."}</span>
        </div>
      </div>
      <div className={ui.grid3}>
        <Field label="Email">
          <input
            type="email"
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            maxLength={254}
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            value={draft.phone}
            onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
            maxLength={50}
          />
        </Field>
        <Field label="GST number" hint="8 or 9 digits, like 123-456-789.">
          <input
            value={draft.gstNumber}
            onChange={(event) => setDraft({ ...draft, gstNumber: event.target.value })}
            maxLength={20}
          />
        </Field>
      </div>
      <Field label={draft.isCustomer ? "Billing address" : "Postal address"}>
        <textarea
          value={draft.postalAddress}
          onChange={(event) => setDraft({ ...draft, postalAddress: event.target.value })}
          rows={3}
          maxLength={500}
        />
      </Field>
      {draft.isCustomer ? (
        <CustomerFields
          setup={customerSetup}
          draft={draft.customer}
          onChange={(customer) => setDraft({ ...draft, customer })}
          customers={customers}
          contactId={contactId}
        >
          <SalespersonField
            setup={salespeople}
            label="Default salesperson"
            hint="Put on this customer's new invoices and credit notes."
            value={draft.defaultSalespersonId}
            onChange={(id) => setDraft({ ...draft, defaultSalespersonId: id })}
          />
        </CustomerFields>
      ) : null}
      {draft.isSupplier ? (
        <div className={ui.grid3}>
          <Field label="Supplier payment terms" hint="New bills from this supplier take their due date from these.">
            <select value={draft.supplierPaymentTermId} onChange={(event) => setDraft({ ...draft, supplierPaymentTermId: event.target.value })}>
              <option value="">None</option>
              {(customerSetup?.paymentTerms ?? [])
                .filter((term) => term.isActive || term.id === draft.supplierPaymentTermId)
                .map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.name}
                    {term.isActive ? "" : " (archived)"}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      ) : null}
      <CustomFieldInputs
        setup={customSetup}
        record="contact"
        uses={rolesOf(draft)}
        value={shown}
        onChange={(values) => setDraft({ ...draft, customFields: { ...hidden, ...values } })}
      />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Contacts({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const canEdit = can("bookkeeper");
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", {
    organisationId,
    search,
    includeArchived: showArchived ? "true" : null,
  });
  // One idempotency key per "New contact" form, so a retried save can't add the contact twice.
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [viewing, setViewing] = useState<Contact | null>(null);
  const [peopleOf, setPeopleOf] = useState<Contact | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const customSetup = useCustomFields(organisationId);
  const salespeople = useSalespeople(organisationId);
  const modules = useModules(organisationId);
  const crm = modules?.crm ?? false;
  // Contact people are the CRM's people, shown with either module on (RC6).
  const showPeople = Boolean(modules?.crm || modules?.reporting);
  const customerSetup = useCustomerSetup(organisationId);
  // Every contact (archived too), for parent names and the parent select.
  const everyone = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId, includeArchived: "true" });
  const allContacts = everyone.data?.contacts ?? [];
  const nameOf = (id: string | null) => allContacts.find((contact) => contact.id === id)?.name ?? null;
  // Customers or suppliers only, from the Contacts menu (?type=).
  const type = useSearchParams().get("type");
  const columns = listColumns(customSetup.data, "contact", type === "customers" ? ["customer"] : type === "suppliers" ? ["supplier"] : ["customer", "supplier"]);
  const rows = (contacts.data?.contacts ?? []).filter((contact) =>
    type === "customers" ? contact.isCustomer : type === "suppliers" ? contact.isSupplier : true,
  );

  async function setArchived(contact: Contact, isArchived: boolean) {
    setStatus(null);
    try {
      await api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { organisationId, isArchived } });
      setStatus({ tone: "success", text: `${isArchived ? "Archived" : "Unarchived"} ${contact.name}.` });
      contacts.reload();
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchText.trim());
  }

  return (
    <>
      <Notice tone="info">
        Contacts marked as customers can be sent <Link href="/operations/invoices">sales invoices</Link>, and{" "}
        <Link href="/operations/bills">bills</Link> can be entered from contacts marked as suppliers.
      </Notice>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {/* Opens once the custom fields are known, so their defaults are filled in from the start. */}
      {canEdit && createKey && (customSetup.data || customSetup.error) ? (
        <Card title="New contact">
          <ContactForm
            initial={{ ...EMPTY_DRAFT, customFields: startingValues(customSetup.data, "contact", ["customer", "supplier"]) }}
            saved={{}}
            customSetup={customSetup.data}
            salespeople={salespeople.data}
            customerSetup={customerSetup.data}
            customers={allContacts}
            contactId={null}
            crm={crm}
            submitLabel="Add contact"
            onCancel={() => setCreateKey(null)}
            onSubmit={async (draft) => {
              const result = await api<{ contact: Contact }>("/api/contacts", {
                method: "POST",
                body: { organisationId, idempotencyKey: createKey, source: "ui", ...bodyFrom(draft) },
              });
              setCreateKey(null);
              setStatus({ tone: "success", text: `Added ${result.contact.name}.` });
              contacts.reload();
              everyone.reload();
            }}
          />
        </Card>
      ) : null}
      {canEdit && editing ? (
        <Card title={`Edit ${editing.name}`}>
          <ContactForm
            key={editing.id}
            initial={draftFrom(editing)}
            saved={editing.customFields}
            customSetup={customSetup.data}
            salespeople={salespeople.data}
            customerSetup={customerSetup.data}
            customers={allContacts}
            contactId={editing.id}
            crm={crm}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (draft) => {
              const result = await api<{ contact: Contact }>(`/api/contacts/${editing.id}`, {
                method: "PATCH",
                body: { organisationId, ...bodyFrom(draft) },
              });
              setEditing(null);
              setStatus({ tone: "success", text: `Saved ${result.contact.name}.` });
              contacts.reload();
              everyone.reload();
            }}
          />
        </Card>
      ) : null}
      <Card
        title={type === "customers" ? "Customers" : type === "suppliers" ? "Suppliers" : "Contacts"}
        actions={
          <>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              Show archived
            </label>
            {canEdit && !createKey ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setStatus(null);
                  setCreateKey(newIdempotencyKey("contact"));
                }}
              >
                New contact
              </Button>
            ) : null}
          </>
        }
      >
        <form className={ui.inlineForm} role="search" onSubmit={applySearch} style={{ marginBottom: 12 }}>
          <Field label="Name or email contains">
            <input type="search" value={searchText} onChange={(event) => setSearchText(event.target.value)} maxLength={100} />
          </Field>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {search ? (
            <Button
              variant="secondary"
              onClick={() => {
                setSearchText("");
                setSearch("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
        {contacts.error ? <Notice tone="error">{contacts.error}</Notice> : null}
        {contacts.data && rows.length === 0 ? (
          <Empty>
            {search ? `No contacts match "${search}".` : showArchived ? "No contacts yet." : "No active contacts."}
            {canEdit && !search ? " Use New contact to add a customer or supplier." : ""}
          </Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>GST number</th>
                  {columns.map((field) => (
                    <th key={field.id}>{field.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      {contact.name} {contact.isArchived ? <Badge>Archived</Badge> : null}
                      {contact.parentContactId ? <div className={ui.muted}>Part of {nameOf(contact.parentContactId) ?? `#${contact.parentContactId}`}</div> : null}
                      {contact.postalAddress ? (
                        <div className={ui.muted} style={{ whiteSpace: "pre-line" }}>
                          {contact.postalAddress}
                        </div>
                      ) : null}
                      {contact.primaryPerson ? <div className={ui.muted}>Attention: {contact.primaryPerson.name}</div> : null}
                    </td>
                    <td>{kind(contact)}</td>
                    <td>{contact.email ?? ""}</td>
                    <td>{contact.phone ?? ""}</td>
                    <td>{formatGstNumber(contact.gstNumber)}</td>
                    {columns.map((field) => (
                      <CustomValueCell key={field.id} field={field} values={contact.customFields} />
                    ))}
                    <td className={ui.num}>
                      <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
                        {contact.isCustomer ? (
                          <Link href={`/operations/customer-statements?contact=${contact.id}`} aria-label={`Statement for ${contact.name}`}>
                            Statement
                          </Link>
                        ) : null}
                        {showPeople ? (
                          <Button
                            variant="secondary"
                            size="small"
                            aria-label={`Contact people at ${contact.name}`}
                            onClick={() => setPeopleOf(peopleOf?.id === contact.id ? null : contact)}
                          >
                            People
                          </Button>
                        ) : null}
                        <Button
                          variant="secondary"
                          size="small"
                          aria-label={`Notes and files for ${contact.name}`}
                          onClick={() => setViewing(viewing?.id === contact.id ? null : contact)}
                        >
                          Notes &amp; files
                        </Button>
                        {canEdit ? (
                          <>
                            <Button
                              variant="secondary"
                              size="small"
                              aria-label={`Edit ${contact.name}`}
                              onClick={() => {
                                setCreateKey(null);
                                setStatus(null);
                                setEditing(contact);
                              }}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="secondary"
                              size="small"
                              aria-label={`${contact.isArchived ? "Unarchive" : "Archive"} ${contact.name}`}
                              onClick={() => void setArchived(contact, !contact.isArchived)}
                            >
                              {contact.isArchived ? "Unarchive" : "Archive"}
                            </Button>
                          </>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {peopleOf && showPeople ? <ContactPeople key={peopleOf.id} organisationId={organisationId} contact={peopleOf} /> : null}
      {viewing ? (
        <RecordExtrasPanel
          key={viewing.id}
          organisationId={organisationId}
          recordType="contact"
          recordId={viewing.id}
          title={`${viewing.name}: notes, files and history`}
        />
      ) : null}
    </>
  );
}

export default function ContactsPage() {
  return (
    <Page>
      <PageHeader
        title="Contacts"
        description="Your customers and suppliers. Contacts you no longer deal with can be archived; they're kept, never deleted."
      />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Contacts key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
