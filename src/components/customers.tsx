"use client";

import Link from "next/link";
import { type FormEvent, Fragment, type ReactNode, useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { Person } from "@/lib/crm/service";
import type { CreditLimitAction, CustomerSetup, PaymentTerm } from "@/lib/customers/service";
import { describeTerm, dueDateFor, PAYMENT_TERM_KIND_LABELS, PAYMENT_TERM_KINDS, type PaymentTermKind } from "@/lib/customers/terms";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { AgedAmounts, AgedReceivables, AgeBucket } from "@/lib/reports/aged-receivables";

/**
 * Richer customers on screen (examples RC1-RC12): the setup hook, the
 * customer fields on the contact form, contact people, Settings › Customers
 * and the aged receivables report. Payment terms and delivery addresses show
 * for everyone; the rest while Advanced reporting is on (or a value is set).
 */
export function useCustomerSetup(organisationId: string | null) {
  return useApiData<CustomerSetup>(organisationId ? "/api/customers" : null, { organisationId });
}

/** The due date for a customer's new invoice from its terms (RC1), or null. */
export function dueFromTerms(setup: CustomerSetup | null | undefined, customer: Contact | undefined, invoiceDate: string): string | null {
  const term = setup?.paymentTerms.find((entry) => entry.id === customer?.paymentTermId && entry.isActive);
  if (!term || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  return dueDateFor(invoiceDate, term);
}

export type CustomerDraft = {
  deliveryAddress: string;
  paymentTermId: string;
  creditLimit: string;
  customerGroupId: string;
  priceLevelId: string;
  parentContactId: string;
};

export const EMPTY_CUSTOMER_DRAFT: CustomerDraft = {
  deliveryAddress: "",
  paymentTermId: "",
  creditLimit: "",
  customerGroupId: "",
  priceLevelId: "",
  parentContactId: "",
};

export function customerDraftFrom(contact: Contact): CustomerDraft {
  return {
    deliveryAddress: contact.deliveryAddress ?? "",
    paymentTermId: contact.paymentTermId ?? "",
    creditLimit: contact.creditLimit ?? "",
    customerGroupId: contact.customerGroupId ?? "",
    priceLevelId: contact.priceLevelId ?? "",
    parentContactId: contact.parentContactId ?? "",
  };
}

/** What to send: blanks as null, so a cleared field is cleared. */
export function customerBody(draft: CustomerDraft): Record<string, string | null> {
  return Object.fromEntries(Object.entries(draft).map(([field, value]) => [field, value.trim() === "" ? null : value.trim()]));
}

type Option = { id: string; name: string; isActive: boolean };

function ListSelect({ label, hint, options, value, onChange }: { label: string; hint?: string; options: Option[]; value: string; onChange: (id: string) => void }) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">None</option>
        {options
          .filter((option) => option.isActive || option.id === value)
          .map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
              {option.isActive ? "" : " (archived)"}
            </option>
          ))}
      </select>
    </Field>
  );
}

/** The customer fields on the contact form (RC1, RC3, RC6-RC8). */
export function CustomerFields({
  setup,
  draft,
  onChange,
  customers,
  contactId,
  children,
}: {
  setup: CustomerSetup | null | undefined;
  draft: CustomerDraft;
  onChange: (draft: CustomerDraft) => void;
  /** Other customers, for the parent select. */
  customers: Contact[];
  contactId: string | null;
  /** More fields for the same row (like the default salesperson). */
  children?: ReactNode;
}) {
  const advanced = Boolean(setup?.advancedFeatures);
  const set = (patch: Partial<CustomerDraft>) => onChange({ ...draft, ...patch });
  const terms: Option[] = (setup?.paymentTerms ?? []).map((term) => ({ id: term.id, name: term.name, isActive: term.isActive }));
  const parents: Option[] = customers
    .filter((contact) => contact.isCustomer && contact.id !== contactId)
    .map((contact) => ({ id: contact.id, name: contact.name, isActive: !contact.isArchived }));
  return (
    <>
      <Field label="Delivery address" hint="Where goods go, if not the billing address.">
        <textarea value={draft.deliveryAddress} onChange={(event) => set({ deliveryAddress: event.target.value })} rows={3} maxLength={500} />
      </Field>
      <div className={ui.grid3}>
        <ListSelect
          label="Payment terms"
          hint="New invoices take their due date from these."
          options={terms}
          value={draft.paymentTermId}
          onChange={(id) => set({ paymentTermId: id })}
        />
        {advanced || draft.creditLimit ? (
          <Field label="Credit limit" hint="Checked when an invoice is approved. Blank for none.">
            <input inputMode="decimal" value={draft.creditLimit} onChange={(event) => set({ creditLimit: event.target.value })} maxLength={20} />
          </Field>
        ) : null}
        {advanced || draft.parentContactId ? (
          <ListSelect label="Parent customer" hint="For head offices and branches." options={parents} value={draft.parentContactId} onChange={(id) => set({ parentContactId: id })} />
        ) : null}
        {advanced || draft.customerGroupId ? (
          <ListSelect label="Customer group" options={setup?.customerGroups ?? []} value={draft.customerGroupId} onChange={(id) => set({ customerGroupId: id })} />
        ) : null}
        {advanced || draft.priceLevelId ? (
          <ListSelect
            label="Price level"
            hint="Used for item prices once items arrive."
            options={setup?.priceLevels ?? []}
            value={draft.priceLevelId}
            onChange={(id) => set({ priceLevelId: id })}
          />
        ) : null}
        {children}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Contact people (RC6): the CRM's people at a company

function PersonForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Partial<Person>;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState(initial.firstName ?? "");
  const [lastName, setLastName] = useState(initial.lastName ?? "");
  const [jobTitle, setJobTitle] = useState(initial.jobTitle ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [isPrimary, setIsPrimary] = useState(initial.isPrimary ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ firstName, lastName: lastName || null, jobTitle: jobTitle || null, email: email || null, phone: phone || null, isPrimary });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 10 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="First name">
          <input value={firstName} onChange={(event) => setFirstName(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="Last name">
          <input value={lastName} onChange={(event) => setLastName(event.target.value)} maxLength={100} />
        </Field>
        <Field label="Role">
          <input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} maxLength={100} placeholder="Accounts payable" />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} />
        </Field>
        <Field label="Phone">
          <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} maxLength={50} />
        </Field>
        <label className={ui.checkbox} style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />
          Primary contact for invoices
        </label>
      </div>
      <div className={ui.actions}>
        <Button type="submit" size="small" disabled={busy}>
          {submitLabel}
        </Button>
        <Button size="small" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A company's contact people, from the CRM's people (RC6). Shown while the CRM or Advanced reporting is on. */
export function ContactPeople({ organisationId, contact }: { organisationId: string; contact: Contact }) {
  const { can } = useWorkspace();
  const people = useApiData<{ people: Person[] }>("/api/crm/people", { organisationId, contactId: contact.id, includeArchived: "true" });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const canEdit = can("bookkeeper");
  const save = async (path: string, method: "POST" | "PATCH", body: Record<string, unknown>, text: string) => {
    await api(path, { method, body: { organisationId, ...body } });
    setMessage({ tone: "success", text });
    setAdding(false);
    setEditing(null);
    people.reload();
  };
  const list = people.data?.people ?? [];
  return (
    <Card
      title={`${contact.name}: contact people`}
      description="The people you deal with there. The primary contact is who invoices are for. They're the same people as in the CRM."
      actions={
        canEdit && !adding ? (
          <Button size="small" onClick={() => setAdding(true)}>
            Add person
          </Button>
        ) : null
      }
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {people.error ? <Notice tone="error">{people.error}</Notice> : null}
      {adding ? (
        <PersonForm
          initial={{ isPrimary: !list.some((person) => person.isPrimary) }}
          submitLabel="Add person"
          onCancel={() => setAdding(false)}
          onSubmit={(values) => save("/api/crm/people", "POST", { contactId: contact.id, ...values }, `Added ${String(values.firstName)}.`)}
        />
      ) : null}
      {people.data && list.length === 0 && !adding ? <Empty>No contact people yet.</Empty> : null}
      {list.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Phone</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((person) =>
                editing === person.id ? (
                  <tr key={person.id}>
                    <td colSpan={5}>
                      <PersonForm
                        initial={person}
                        submitLabel="Save"
                        onCancel={() => setEditing(null)}
                        onSubmit={(values) => save(`/api/crm/people/${person.id}`, "PATCH", values, `Saved ${person.fullName}.`)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={person.id}>
                    <td>
                      {person.fullName} {person.isPrimary ? <Badge tone="green">Primary</Badge> : null}{" "}
                      {person.isArchived ? <Badge>Archived</Badge> : null}
                    </td>
                    <td>{person.jobTitle ?? ""}</td>
                    <td>{person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : ""}</td>
                    <td>{person.phone ?? ""}</td>
                    <td className={ui.num}>
                      {canEdit ? (
                        <span className={ui.rowButtons}>
                          {!person.isPrimary && !person.isArchived ? (
                            <Button
                              size="small"
                              variant="secondary"
                              onClick={() =>
                                void save(`/api/crm/people/${person.id}`, "PATCH", { isPrimary: true }, `${person.fullName} is now the primary contact.`).catch((caught) =>
                                  setMessage({ tone: "error", text: errorMessage(caught) }),
                                )
                              }
                            >
                              Make primary
                            </Button>
                          ) : null}
                          <Button size="small" variant="secondary" onClick={() => setEditing(person.id)}>
                            Edit
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() =>
                              void save(
                                `/api/crm/people/${person.id}`,
                                "PATCH",
                                { isArchived: !person.isArchived },
                                person.isArchived ? `Restored ${person.fullName}.` : `Archived ${person.fullName}.`,
                              ).catch((caught) => setMessage({ tone: "error", text: errorMessage(caught) }))
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
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings › Customers (RC1-RC4, RC7)

type ListKind = "payment-terms" | "groups" | "price-levels";

function ListRow({
  organisationId,
  kind,
  row,
  cells,
  editor,
  onSaved,
}: {
  organisationId: string;
  kind: ListKind;
  row: { id: string; name: string; isActive: boolean };
  cells: ReactNode;
  editor: (done: (body: Record<string, unknown>) => Promise<void>, cancel: () => void) => ReactNode;
  onSaved: (setup: CustomerSetup, message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function patch(body: Record<string, unknown>, message: string) {
    setError(null);
    try {
      onSaved(await api<CustomerSetup>(`/api/customers/${kind}/${row.id}`, { method: "PATCH", body: { organisationId, ...body } }), message);
      setEditing(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  if (editing) {
    return (
      <tr>
        <td colSpan={4}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {editor((body) => patch(body, `Saved ${String(body.name ?? row.name)}.`), () => setEditing(false))}
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        {row.name}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </td>
      {cells}
      <td>{row.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>}</td>
      <td className={ui.num}>
        <span className={ui.rowButtons}>
          <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button size="small" variant="secondary" onClick={() => void patch({ isActive: !row.isActive }, row.isActive ? `Archived ${row.name}.` : `Restored ${row.name}.`)}>
            {row.isActive ? "Archive" : "Restore"}
          </Button>
        </span>
      </td>
    </tr>
  );
}

function TermInputs({ initial, submitLabel, onSubmit, onCancel }: { initial?: PaymentTerm; submitLabel: string; onSubmit: (body: Record<string, unknown>) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<PaymentTermKind>(initial?.kind ?? "days_after_invoice");
  const [days, setDays] = useState(String(initial?.days ?? 20));
  const [busy, setBusy] = useState(false);
  const example = /^\d{1,3}$/.test(days) ? `An invoice dated today is due ${formatDate(dueDateFor(todayInBrowser(), { kind, days: Number.parseInt(days, 10) }))}.` : "";
  return (
    <form
      className={ui.actions}
      style={{ alignItems: "end" }}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSubmit({ name, kind, days }).finally(() => setBusy(false));
        if (!initial) setName("");
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="Net 20" />
      </Field>
      <Field label={kind === "day_of_next_month" ? "Day" : "Days"} hint={example}>
        <input inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} maxLength={3} required style={{ width: 80 }} />
      </Field>
      <Field label="Counted as">
        <select value={kind} onChange={(event) => setKind(event.target.value as PaymentTermKind)}>
          {PAYMENT_TERM_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {PAYMENT_TERM_KIND_LABELS[entry]}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" size="small" disabled={busy || !name.trim()}>
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="small" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

function NameInputs({
  initial,
  withPercent,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: { name: string; markupPercent?: string };
  withPercent: boolean;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [percent, setPercent] = useState(initial?.markupPercent ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={ui.actions}
      style={{ alignItems: "end" }}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSubmit(withPercent ? { name, markupPercent: percent } : { name }).finally(() => setBusy(false));
        if (!initial) {
          setName("");
          setPercent("");
        }
      }}
    >
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
      </Field>
      {withPercent ? (
        <Field label="Percent on base price" hint="-10 is 10% off; 5 is 5% on.">
          <input inputMode="decimal" value={percent} onChange={(event) => setPercent(event.target.value)} maxLength={12} required style={{ width: 110 }} />
        </Field>
      ) : null}
      <Button type="submit" size="small" disabled={busy || !name.trim()}>
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="small" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </form>
  );
}

function percentLabel(value: string): string {
  return value.startsWith("-") ? `${value.slice(1)}% off` : value === "0" ? "Base price" : `${value}% on`;
}

export function CustomerSettings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useCustomerSetup(organisationId);
  const [current, setCurrent] = useState<CustomerSetup | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can change these settings.</Notice>;
  const setup = current ?? loaded.data;
  const saved = (next: CustomerSetup, text: string) => {
    setCurrent(next);
    setMessage({ tone: "success", text });
  };
  const add = (kind: ListKind, what: string) => async (body: Record<string, unknown>) => {
    try {
      saved(await api<CustomerSetup>(`/api/customers/${kind}`, { method: "POST", body: { organisationId, ...body } }), `Added ${String(body.name ?? what)}.`);
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  };
  async function setAction(action: CreditLimitAction) {
    try {
      saved(await api<CustomerSetup>("/api/customers", { method: "PATCH", body: { organisationId, creditLimitAction: action } }), "Saved.");
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    }
  }
  const header = (extra: ReactNode) => (
    <thead>
      <tr>
        <th>Name</th>
        {extra}
        <th>Status</th>
        <th />
      </tr>
    </thead>
  );
  return (
    <>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card title="Payment terms" description="Each customer can have default terms; new invoices take their due date from them, and it can still be changed on the draft. Archived, never deleted.">
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            {header(<th>Due</th>)}
            <tbody>
              {setup.paymentTerms.map((term) => (
                <ListRow
                  key={term.id}
                  organisationId={organisationId}
                  kind="payment-terms"
                  row={term}
                  cells={<td>{describeTerm(term)}</td>}
                  onSaved={saved}
                  editor={(done, cancel) => <TermInputs initial={term} submitLabel="Save" onSubmit={done} onCancel={cancel} />}
                />
              ))}
            </tbody>
          </table>
        </div>
        <TermInputs submitLabel="Add payment term" onSubmit={add("payment-terms", "the term")} />
      </Card>
      {!setup.advancedFeatures ? (
        <Notice tone="info">
          Credit limits, customer groups, price levels and parent customers come with Advanced reporting. Turn it on in <Link href="/operations/settings">Settings › Modules</Link>.
        </Notice>
      ) : (
        <>
          <Card title="Credit limits" description="A customer's balance (unpaid invoices less unused credit) plus the invoice being approved is compared with their credit limit.">
            <div className={ui.actions}>
              {(["warn", "block"] as const).map((action) => (
                <label key={action} className={ui.checkbox}>
                  <input type="radio" name="credit-limit-action" checked={setup.creditLimitAction === action} onChange={() => void setAction(action)} />
                  {action === "warn" ? "Warn: approve the invoice and say it's over" : "Block: refuse to approve it"}
                </label>
              ))}
            </div>
          </Card>
          <Card title="Customer groups" description="Like NetSuite's customer categories: Retail, Wholesale and so on.">
            {setup.customerGroups.length === 0 ? <Empty>No customer groups yet.</Empty> : null}
            {setup.customerGroups.length > 0 ? (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  {header(null)}
                  <tbody>
                    {setup.customerGroups.map((group) => (
                      <ListRow
                        key={group.id}
                        organisationId={organisationId}
                        kind="groups"
                        row={group}
                        cells={null}
                        onSaved={saved}
                        editor={(done, cancel) => <NameInputs initial={group} withPercent={false} submitLabel="Save" onSubmit={done} onCancel={cancel} />}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <NameInputs withPercent={false} submitLabel="Add group" onSubmit={add("groups", "the group")} />
          </Card>
          <Card
            title="Price levels"
            description="A percent off or on the base price, with a default for each customer. Item prices come with items; invoices don't use them yet."
          >
            {setup.priceLevels.length === 0 ? <Empty>No price levels yet.</Empty> : null}
            {setup.priceLevels.length > 0 ? (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  {header(<th>Price</th>)}
                  <tbody>
                    {setup.priceLevels.map((level) => (
                      <ListRow
                        key={level.id}
                        organisationId={organisationId}
                        kind="price-levels"
                        row={level}
                        cells={<td>{percentLabel(level.markupPercent)}</td>}
                        onSaved={saved}
                        editor={(done, cancel) => <NameInputs initial={level} withPercent submitLabel="Save" onSubmit={done} onCancel={cancel} />}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <NameInputs withPercent submitLabel="Add price level" onSubmit={add("price-levels", "the price level")} />
          </Card>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reporting › Aged receivables (RC9-RC11)

const BUCKET_LABELS: Record<AgeBucket, string> = {
  current: "Current",
  days1to30: "1-30 days",
  days31to60: "31-60 days",
  days61to90: "61-90 days",
  over90: "Over 90 days",
};
const BUCKETS = Object.keys(BUCKET_LABELS) as AgeBucket[];

function AmountCells({ amounts, strong }: { amounts: AgedAmounts; strong?: boolean }) {
  const Wrap = strong ? "strong" : Fragment;
  return (
    <>
      {BUCKETS.map((bucket) => (
        <td key={bucket} className={ui.num}>
          <Wrap>
            <Money value={amounts[bucket]} blankZero />
          </Wrap>
        </td>
      ))}
      <td className={ui.num}>
        <Wrap>{amounts.credit === "0.00" ? null : <Money value={`-${amounts.credit}`} />}</Wrap>
      </td>
      <td className={ui.num}>
        <Wrap>
          <Money value={amounts.total} />
        </Wrap>
      </td>
    </>
  );
}

export function AgedReceivablesReport({ organisationId }: { organisationId: string }) {
  const [asAt, setAsAt] = useState(todayInBrowser);
  const [rollUp, setRollUp] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const report = useApiData<AgedReceivables>("/api/reports/aged-receivables", { organisationId, asAt, rollUp: rollUp ? "true" : null });
  return (
    <Card
      title="Aged receivables"
      description="What each customer owes, by days past the due date, less credit not yet used. The total matches accounts receivable on the balance sheet."
      actions={
        <div className={ui.inlineForm}>
          <Field label="As at">
            <input type="date" value={asAt} onChange={(event) => setAsAt(event.target.value)} />
          </Field>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={rollUp} onChange={(event) => setRollUp(event.target.checked)} />
            Roll up sub-customers
          </label>
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data && report.data.rows.length === 0 ? <Empty>No customer owes anything on this date.</Empty> : null}
      {report.data && report.data.rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Customer</th>
                {BUCKETS.map((bucket) => (
                  <th key={bucket} className={ui.num}>
                    {BUCKET_LABELS[bucket]}
                  </th>
                ))}
                <th className={ui.num}>Credit</th>
                <th className={ui.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {report.data.rows.map((row) => (
                <Fragment key={row.contactId}>
                  <tr>
                    <td style={{ paddingLeft: 10 + row.depth * 18 }}>
                      {row.invoices.length > 0 ? (
                        <button
                          type="button"
                          className={ui.linkButton}
                          aria-expanded={open === row.contactId}
                          onClick={() => setOpen(open === row.contactId ? null : row.contactId)}
                        >
                          {open === row.contactId ? "▾" : "▸"} {row.name}
                        </button>
                      ) : (
                        row.name
                      )}
                    </td>
                    <AmountCells amounts={row.amounts} />
                  </tr>
                  {open === row.contactId
                    ? row.invoices.map((invoice) => (
                        <tr key={invoice.id} className={ui.reportSection}>
                          <td colSpan={BUCKETS.length + 2} style={{ paddingLeft: 28 + row.depth * 18 }}>
                            <Link href={`/operations/invoices/${invoice.id}`}>{invoice.invoiceNumber ?? `#${invoice.id}`}</Link> · dated{" "}
                            {formatDate(invoice.invoiceDate)} · due {formatDate(invoice.dueDate)}
                            {invoice.daysOverdue > 0 ? ` · ${invoice.daysOverdue} days overdue` : ""}
                          </td>
                          <td className={ui.num}>
                            <Money value={invoice.amountDue} />
                          </td>
                        </tr>
                      ))
                    : null}
                  {row.rolledUp ? (
                    <tr className={ui.reportTotal}>
                      <td style={{ paddingLeft: 10 + row.depth * 18 }}>Total {row.name} and its sub-customers</td>
                      <AmountCells amounts={row.rolledUp} strong />
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total ({report.data.currencyCode})</td>
                <AmountCells amounts={report.data.total} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
