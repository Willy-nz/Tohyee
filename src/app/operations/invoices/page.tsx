"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { InvoiceStatusBadge } from "@/components/invoices/invoice-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { InvoiceStatus, InvoiceSummary } from "@/lib/invoices/service";

type InvoicePage = { invoices: InvoiceSummary[]; nextBeforeId: string | null };

const FILTERS: Array<{ status: InvoiceStatus | null; label: string }> = [
  { status: null, label: "All" },
  { status: "draft", label: "Drafts" },
  { status: "approved", label: "Approved" },
  { status: "voided", label: "Voided" },
];

function InvoiceList({ organisationId, status }: { organisationId: string; status: InvoiceStatus | null }) {
  const list = useApiData<InvoicePage>("/api/invoices", { organisationId, status });
  const [more, setMore] = useState<InvoicePage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const invoices = [...(list.data?.invoices ?? []), ...(more?.invoices ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<InvoicePage>("/api/invoices", {
        query: { organisationId, status, beforeId: nextBeforeId },
      });
      setMore((current) => ({ invoices: [...(current?.invoices ?? []), ...page.invoices], nextBeforeId: page.nextBeforeId }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  if (list.error) {
    return <Notice tone="error">{list.error}</Notice>;
  }
  if (!list.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  if (invoices.length === 0) {
    return <Empty>{status ? `No ${status} invoices.` : "No invoices yet."}</Empty>;
  }
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Due</th>
              <th>Reference</th>
              <th>Status</th>
              <th className={ui.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link href={`/operations/invoices/${invoice.id}`}>{invoice.invoiceNumber ?? `Draft #${invoice.id}`}</Link>
                </td>
                <td>{invoice.contactName}</td>
                <td>{formatDate(invoice.invoiceDate)}</td>
                <td>{formatDate(invoice.dueDate)}</td>
                <td className={ui.muted}>{invoice.reference}</td>
                <td>
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
                <td className={ui.num}>
                  <Money value={invoice.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older invoices
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Invoices({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [status, setStatus] = useState<InvoiceStatus | null>(null);
  return (
    <Card
      title="Sales invoices"
      description="Newest first. Drafts post nothing; approving numbers the invoice and posts it."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/invoices/new")}>New invoice</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Invoice status">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={status === entry.status}
            className={`${ui.tab} ${status === entry.status ? ui.tabActive : ""}`}
            onClick={() => setStatus(entry.status)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <InvoiceList key={status ?? "all"} organisationId={organisationId} status={status} />
    </Card>
  );
}

export default function InvoicesPage() {
  return (
    <Page>
      <PageHeader title="Invoices" description="Sales invoices to your customers, with GST worked out per line." />
      <RequireOrganisation>{(organisationId) => <Invoices organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
