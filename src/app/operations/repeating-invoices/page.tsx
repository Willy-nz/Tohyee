"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RepeatingStatusBadge } from "@/components/repeating/repeating-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatDate } from "@/lib/format";
import { describeSchedule } from "@/lib/repeating/schedule";
import type { RepeatingInvoiceSummary, RepeatingStatus } from "@/lib/repeating/service";

type Filter = { label: string; status: RepeatingStatus | null; empty: string };

const FILTERS: Filter[] = [
  { label: "Active", status: "active", empty: "No active repeating invoices." },
  { label: "Paused", status: "paused", empty: "No paused repeating invoices." },
  { label: "Ended", status: "ended", empty: "No ended repeating invoices." },
  { label: "All", status: null, empty: "No repeating invoices yet." },
];

function RepeatingList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const list = useApiData<{ repeatingInvoices: RepeatingInvoiceSummary[] }>("/api/repeating-invoices", {
    organisationId,
    status: filter.status,
  });
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const templates = list.data.repeatingInvoices;
  if (templates.length === 0) return <Empty>{filter.empty}</Empty>;
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Customer</th>
            <th>Reference</th>
            <th>How often</th>
            <th>Next invoice</th>
            <th>End date</th>
            <th>Each invoice</th>
            <th>Status</th>
            <th className={ui.num}>Total</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr key={template.id}>
              <td data-label="Customer">
                <Link href={`/operations/repeating-invoices/${template.id}`}>{template.contactName}</Link>
                {template.lastError ? (
                  <div>
                    <small className={ui.muted}>Stopped: {template.lastError}</small>
                  </div>
                ) : null}
              </td>
              <td data-label="Reference" className={ui.muted}>
                {template.reference}
              </td>
              <td data-label="How often">{describeSchedule(template)}</td>
              <td data-label="Next invoice">{template.nextDate ? formatDate(template.nextDate) : "—"}</td>
              <td data-label="End date">{template.endDate ? formatDate(template.endDate) : "—"}</td>
              <td data-label="Each invoice">{template.saveAs === "approve" ? "Approved" : "Draft"}</td>
              <td data-label="Status">
                <RepeatingStatusBadge status={template.status} />
              </td>
              <td data-label="Total" className={ui.num}>
                <Money value={template.total} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RepeatingInvoices({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Repeating invoices"
      description="Each template makes an invoice on every scheduled date, once, by the hourly job. Missed dates are caught up the next time it runs."
      actions={
        can("bookkeeper") ? <Button onClick={() => router.push("/operations/repeating-invoices/new")}>New repeating invoice</Button> : null
      }
    >
      <div className={ui.tabs} role="tablist" aria-label="Repeating invoice status">
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
      <RepeatingList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function RepeatingInvoicesPage() {
  return (
    <Page>
      <PageHeader title="Repeating invoices" description="Invoices made for you every so many weeks or months." />
      <RequireOrganisation>{(organisationId) => <RepeatingInvoices organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
