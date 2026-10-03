"use client";

import Link from "next/link";
import { type FormEvent, Fragment, useState } from "react";
import { Money } from "@/components/books";
import { ReportExport } from "@/components/reports/report-export";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, todayInBrowser } from "@/lib/format";
import type { SalesBySalesperson, SalesDocument } from "@/lib/reports/sales-by-salesperson";
import type { SalespeopleSetup } from "@/lib/salespeople/service";

/**
 * Salespeople on screen (examples SR1-SR8): the list hook, the select used on
 * customers, invoices and credit notes, the settings screen and the report.
 * Nothing shows unless advanced features are on (or a document already has
 * a salesperson).
 */
export function useSalespeople(organisationId: string | null) {
  return useApiData<SalespeopleSetup>(organisationId ? "/api/salespeople" : null, { organisationId });
}

/** Whether to show the salesperson field: advanced features on, or a value already set. */
export function showSalesperson(setup: SalespeopleSetup | null | undefined, value: string | null | undefined): boolean {
  return Boolean(setup && (setup.advancedFeatures || value));
}

/** The default for a customer: their salesperson if they have an active one and advanced features are on. */
export function customerDefault(setup: SalespeopleSetup | null | undefined, defaultId: string | null | undefined): string {
  if (!setup?.advancedFeatures || !defaultId) return "";
  return setup.salespeople.some((person) => person.id === defaultId && person.isActive) ? defaultId : "";
}

/** A salesperson select; archived ones show only when already chosen. `value` "" is none. */
export function SalespersonField({
  setup,
  value,
  onChange,
  label = "Salesperson",
  hint,
}: {
  setup: SalespeopleSetup | null | undefined;
  value: string;
  onChange: (id: string) => void;
  label?: string;
  hint?: string;
}) {
  if (!showSalesperson(setup, value)) return null;
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">None</option>
        {(setup?.salespeople ?? [])
          .filter((person) => person.isActive || person.id === value)
          .map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.isActive ? "" : " (archived)"}
            </option>
          ))}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Settings › Salespeople (SR1, SR6)

function SalespersonRow({
  organisationId,
  person,
  onSaved,
}: {
  organisationId: string;
  person: SalespeopleSetup["salespeople"][number];
  onSaved: (setup: SalespeopleSetup, message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function patch(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<SalespeopleSetup>(`/api/salespeople/${person.id}`, { method: "PATCH", body: { organisationId, ...body } }), message);
      setEditing(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  if (editing) {
    return (
      <tr>
        <td colSpan={4}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <form
            className={ui.actions}
            onSubmit={(event) => {
              event.preventDefault();
              void patch({ name, email: email || null }, `Saved ${name.trim()}.`);
            }}
          >
            <input aria-label="Name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
            <input aria-label="Email" type="email" placeholder="Email (optional)" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
            <Button type="submit" size="small" disabled={busy}>
              Save
            </Button>
            <Button size="small" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>
        {person.name}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </td>
      <td>{person.email ?? ""}</td>
      <td>{person.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>}</td>
      <td className={ui.num}>
        <span className={ui.rowButtons}>
          <Button size="small" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={busy}
            onClick={() => void patch({ isActive: !person.isActive }, person.isActive ? `Archived ${person.name}.` : `Restored ${person.name}.`)}
          >
            {person.isActive ? "Archive" : "Restore"}
          </Button>
        </span>
      </td>
    </tr>
  );
}

export function SalespeopleManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useSalespeople(organisationId);
  const [current, setCurrent] = useState<SalespeopleSetup | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const setup = current ?? loaded.data;
  if (!setup.advancedFeatures) return <Notice tone="info">Advanced reporting is off. Turn it on in Settings › Modules to use salespeople.</Notice>;
  if (!can("admin")) return <Notice tone="warning">Only organisation admins and owners can change salespeople.</Notice>;
  const saved = (next: SalespeopleSetup, text: string) => {
    setCurrent(next);
    setMessage(text);
  };
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      saved(await api<SalespeopleSetup>("/api/salespeople", { method: "POST", body: { organisationId, name, email: email || null } }), `Added ${name.trim()}.`);
      setName("");
      setEmail("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title="Salespeople"
        description="Put on invoices and credit notes, with a default for each customer. They never change an amount or GST. Archived, never deleted."
      >
        {setup.salespeople.length === 0 ? <Empty>No salespeople yet.</Empty> : null}
        {setup.salespeople.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {setup.salespeople.map((person) => (
                  <SalespersonRow key={person.id} organisationId={organisationId} person={person} onSaved={saved} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <form className={ui.actions} onSubmit={(event) => void add(event)}>
          <Field label="Name">
            <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} required />
          </Field>
          <Field label="Email (optional)">
            <input type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add salesperson"}
          </Button>
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reporting › Sales by salesperson (SR3-SR5, SR8)

const KIND_LABELS: Record<SalesDocument["kind"], string> = {
  invoice: "Invoice",
  invoice_void: "Invoice voided",
  credit_note: "Credit note",
  credit_note_void: "Credit note voided",
};

function documentHref(document: SalesDocument): string {
  return document.kind.startsWith("invoice") ? `/operations/invoices/${document.id}` : `/operations/credit-notes/${document.id}`;
}

export function SalesBySalespersonReport({ organisationId }: { organisationId: string }) {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState(todayInBrowser);
  const [open, setOpen] = useState<string | null>(null);
  const report = useApiData<SalesBySalesperson>("/api/reports/sales-by-salesperson", { organisationId, from, to });
  return (
    <Card
      title="Sales by salesperson"
      description="Invoices and credit notes excluding GST, on their date once approved; voids count on their void date. Drafts don't count."
      actions={
        <div className={ui.inlineForm}>
          <Field label="From">
            <input type="date" value={from ?? report.data?.from ?? ""} onChange={(event) => setFrom(event.target.value || null)} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {report.data && report.data.rows.length === 0 ? <Empty>No approved invoices or credit notes in this period.</Empty> : null}
      {report.data && report.data.rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <ReportExport
            organisationId={organisationId}
            report="sales-by-salesperson"
            title="Sales by salesperson"
            period={`${formatDate(report.data.from)} to ${formatDate(report.data.to)}`}
            tables={[{ id: "sales-by-salesperson-report" }]}
          />
          <table id="sales-by-salesperson-report" className={ui.table}>
            <thead>
              <tr>
                <th>Salesperson</th>
                <th className={ui.num}>Invoices</th>
                <th className={ui.num}>Sales</th>
                <th className={ui.num}>Credit notes</th>
                <th className={ui.num}>Net sales</th>
              </tr>
            </thead>
            <tbody>
              {report.data.rows.map((row) => {
                const key = row.salespersonId ?? "none";
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>
                        <button type="button" className={ui.linkButton} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                          {open === key ? "▾" : "▸"} {row.name}
                        </button>
                      </td>
                      <td className={ui.num}>{row.invoices}</td>
                      <td className={ui.num}>
                        <Money value={row.sales} />
                      </td>
                      <td className={ui.num}>
                        <Money value={row.creditNotes} />
                      </td>
                      <td className={ui.num}>
                        <Money value={row.netSales} />
                      </td>
                    </tr>
                    {open === key
                      ? row.documents.map((document) => (
                          <tr key={`${document.kind}-${document.id}`} className={ui.reportSection}>
                            <td colSpan={2}>
                              {formatDate(document.date)} · {KIND_LABELS[document.kind]}{" "}
                              <Link href={documentHref(document)}>{document.number ?? `#${document.id}`}</Link> · {document.contactName}
                            </td>
                            <td className={ui.num}>{document.kind.startsWith("invoice") ? <Money value={document.amount} /> : null}</td>
                            <td className={ui.num}>{document.kind.startsWith("credit") ? <Money value={document.amount} /> : null}</td>
                            <td />
                          </tr>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total ({report.data.currencyCode})</td>
                <td className={ui.num}>{report.data.total.invoices}</td>
                <td className={ui.num}>
                  <Money value={report.data.total.sales} />
                </td>
                <td className={ui.num}>
                  <Money value={report.data.total.creditNotes} />
                </td>
                <td className={ui.num}>
                  <Money value={report.data.total.netSales} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
