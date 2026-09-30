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
import type { RepeatingBillSummary } from "@/lib/repeating/bills";
import type { RepeatingStatus } from "@/lib/repeating/runner";
import { describeSchedule } from "@/lib/repeating/schedule";

type Filter = { label: string; status: RepeatingStatus | null; empty: string };

const FILTERS: Filter[] = [
  { label: "Active", status: "active", empty: "No active repeating bills." },
  { label: "Paused", status: "paused", empty: "No paused repeating bills." },
  { label: "Ended", status: "ended", empty: "No ended repeating bills." },
  { label: "All", status: null, empty: "No repeating bills yet." },
];

function RepeatingBillList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const list = useApiData<{ repeatingBills: RepeatingBillSummary[] }>("/api/repeating-bills", { organisationId, status: filter.status });
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const templates = list.data.repeatingBills;
  if (templates.length === 0) return <Empty>{filter.empty}</Empty>;
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Supplier</th>
            <th>Supplier&apos;s invoice number</th>
            <th>How often</th>
            <th>Next bill</th>
            <th>End date</th>
            <th>Each bill</th>
            <th>Status</th>
            <th className={ui.num}>Total</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => (
            <tr key={template.id}>
              <td data-label="Supplier">
                <Link href={`/operations/repeating-bills/${template.id}`}>{template.contactName}</Link>
                {template.lastError ? (
                  <div>
                    <small className={ui.muted}>Stopped: {template.lastError}</small>
                  </div>
                ) : null}
              </td>
              <td data-label="Supplier's invoice number" className={ui.muted}>
                {template.nextSupplierInvoiceNumber ?? template.supplierInvoiceNumber}
              </td>
              <td data-label="How often">{describeSchedule(template)}</td>
              <td data-label="Next bill">{template.nextDate ? formatDate(template.nextDate) : "—"}</td>
              <td data-label="End date">{template.endDate ? formatDate(template.endDate) : "—"}</td>
              <td data-label="Each bill">{template.saveAs === "approve" ? "Approved" : "Draft"}</td>
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

function RepeatingBills({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Repeating bills"
      description="Each template makes a bill on every scheduled date, once, by the hourly job. Missed dates are caught up the next time it runs. Nothing is paid automatically."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/repeating-bills/new")}>New repeating bill</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Repeating bill status">
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
      <RepeatingBillList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function RepeatingBillsPage() {
  return (
    <Page>
      <PageHeader title="Repeating bills" description="Bills from suppliers made for you every so many weeks or months, such as rent or subscriptions." />
      <RequireOrganisation>{(organisationId) => <RepeatingBills organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
