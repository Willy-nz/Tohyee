"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CustomValueCell, listColumns, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { useSalespeople } from "@/components/salespeople";
import { InvoiceStatusBadge, PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { InvoiceStatus, InvoiceSummary } from "@/lib/invoices/service";

type InvoicePage = { invoices: InvoiceSummary[]; nextBeforeId: string | null };

type Filter = { slug: string; label: string; status: InvoiceStatus | null; awaitingPayment: boolean; empty: string };

const FILTERS: Filter[] = [
  { slug: "all", label: "All", status: null, awaitingPayment: false, empty: "No invoices yet." },
  { slug: "drafts", label: "Drafts", status: "draft", awaitingPayment: false, empty: "No draft invoices." },
  { slug: "approved", label: "Approved", status: "approved", awaitingPayment: false, empty: "No approved invoices." },
  { slug: "awaiting", label: "Awaiting payment", status: null, awaitingPayment: true, empty: "No approved invoices are awaiting payment." },
  { slug: "voided", label: "Voided", status: "voided", awaitingPayment: false, empty: "No voided invoices." },
];

function InvoiceList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const awaitingPayment = filter.awaitingPayment ? "true" : null;
  const list = useApiData<InvoicePage>("/api/invoices", { organisationId, status, awaitingPayment });
  // The salesperson column shows while advanced features are on (SR1).
  const showSalesperson = useSalespeople(organisationId).data?.advancedFeatures ?? false;
  const columns = listColumns(useCustomFields(organisationId).data, "document", ["invoice"]);
  const [more, setMore] = useState<InvoicePage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const invoices = [...(list.data?.invoices ?? []), ...(more?.invoices ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<InvoicePage>("/api/invoices", {
        query: { organisationId, status, awaitingPayment, beforeId: nextBeforeId },
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
    return <Empty>{filter.empty}</Empty>;
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
              {showSalesperson ? <th>Salesperson</th> : null}
              {columns.map((field) => (
                <th key={field.id}>{field.label}</th>
              ))}
              <th>Status</th>
              <th>Payment</th>
              <th className={ui.num}>Total</th>
              <th className={ui.num}>Amount due</th>
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
                {showSalesperson ? <td>{invoice.salespersonName ?? ""}</td> : null}
                {columns.map((field) => (
                  <CustomValueCell key={field.id} field={field} values={invoice.customFields} />
                ))}
                <td>
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
                <td>{invoice.paidStatus ? <PaidStatusBadge status={invoice.paidStatus} /> : null}</td>
                <td className={ui.num}>
                  <Money value={invoice.total} />
                </td>
                <td className={ui.num}>{invoice.amountDue !== null ? <Money value={invoice.amountDue} /> : null}</td>
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
  const params = useSearchParams();
  // The list shown is in the address (?show=), so the menus can open "Awaiting payment".
  const filter = FILTERS.find((entry) => entry.slug === params.get("show")) ?? FILTERS[0];
  return (
    <Card
      title="Sales invoices"
      description="Newest first. Drafts post nothing; approving numbers the invoice and posts it. Amount due is the total less the invoice's payments and the credit applied to it."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/invoices/new")}>New invoice</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Invoice status">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => router.replace(entry.slug === "all" ? "/operations/invoices" : `/operations/invoices?show=${entry.slug}`, { scroll: false })}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <InvoiceList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function InvoicesPage() {
  return (
    <Page>
      <PageHeader title="Invoices" description="Sales invoices to your customers, with GST worked out per line." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <Invoices organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
