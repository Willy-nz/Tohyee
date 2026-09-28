"use client";

import Link from "next/link";
import { type FormEvent, useId, useState } from "react";
import { RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
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
};

const EMPTY_DRAFT: Draft = {
  name: "",
  isCustomer: false,
  isSupplier: false,
  email: "",
  phone: "",
  gstNumber: "",
  postalAddress: "",
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
  };
}

function kind(contact: Contact): string {
  if (contact.isCustomer && contact.isSupplier) return "Customer and supplier";
  return contact.isCustomer ? "Customer" : "Supplier";
}

function ContactForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typeLabelId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(draft);
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
          </span>
          <span className={ui.fieldHint}>Tick one or both.</span>
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
      <Field label="Postal address">
        <textarea
          value={draft.postalAddress}
          onChange={(event) => setDraft({ ...draft, postalAddress: event.target.value })}
          rows={3}
          maxLength={500}
        />
      </Field>
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
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const rows = contacts.data?.contacts ?? [];

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
      {canEdit && createKey ? (
        <Card title="New contact">
          <ContactForm
            initial={EMPTY_DRAFT}
            submitLabel="Add contact"
            onCancel={() => setCreateKey(null)}
            onSubmit={async (draft) => {
              const result = await api<{ contact: Contact }>("/api/contacts", {
                method: "POST",
                body: { organisationId, idempotencyKey: createKey, source: "ui", ...draft },
              });
              setCreateKey(null);
              setStatus({ tone: "success", text: `Added ${result.contact.name}.` });
              contacts.reload();
            }}
          />
        </Card>
      ) : null}
      {canEdit && editing ? (
        <Card title={`Edit ${editing.name}`}>
          <ContactForm
            key={editing.id}
            initial={draftFrom(editing)}
            submitLabel="Save changes"
            onCancel={() => setEditing(null)}
            onSubmit={async (draft) => {
              const result = await api<{ contact: Contact }>(`/api/contacts/${editing.id}`, {
                method: "PATCH",
                body: { organisationId, ...draft },
              });
              setEditing(null);
              setStatus({ tone: "success", text: `Saved ${result.contact.name}.` });
              contacts.reload();
            }}
          />
        </Card>
      ) : null}
      <Card
        title="Contacts"
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
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      {contact.name} {contact.isArchived ? <Badge>Archived</Badge> : null}
                      {contact.postalAddress ? (
                        <div className={ui.muted} style={{ whiteSpace: "pre-line" }}>
                          {contact.postalAddress}
                        </div>
                      ) : null}
                    </td>
                    <td>{kind(contact)}</td>
                    <td>{contact.email ?? ""}</td>
                    <td>{contact.phone ?? ""}</td>
                    <td>{formatGstNumber(contact.gstNumber)}</td>
                    <td className={ui.num}>
                      <span className={ui.actions} style={{ justifyContent: "flex-end" }}>
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
      <RequireOrganisation>{(organisationId) => <Contacts key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
