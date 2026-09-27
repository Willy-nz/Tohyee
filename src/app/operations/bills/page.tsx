"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { PaidStatusBadge } from "@/components/invoices/invoice-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BillStatus, BillSummary } from "@/lib/bills/service";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";

type BillPage = { bills: BillSummary[]; nextBeforeId: string | null };

type Filter = { label: string; status: BillStatus | null; awaitingPayment: boolean; empty: string };

const FILTERS: Filter[] = [
  { label: "All", status: null, awaitingPayment: false, empty: "No bills yet." },
  { label: "Drafts", status: "draft", awaitingPayment: false, empty: "No draft bills." },
  { label: "Approved", status: "approved", awaitingPayment: false, empty: "No approved bills." },
  { label: "Awaiting payment", status: null, awaitingPayment: true, empty: "No approved bills are awaiting payment." },
  { label: "Voided", status: "voided", awaitingPayment: false, empty: "No voided bills." },
];

function BillList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const awaitingPayment = filter.awaitingPayment ? "true" : null;
  const list = useApiData<BillPage>("/api/bills", { organisationId, status, awaitingPayment });
  const [more, setMore] = useState<BillPage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const bills = [...(list.data?.bills ?? []), ...(more?.bills ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<BillPage>("/api/bills", {
        query: { organisationId, status, awaitingPayment, beforeId: nextBeforeId },
      });
      setMore((current) => ({ bills: [...(current?.bills ?? []), ...page.bills], nextBeforeId: page.nextBeforeId }));
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
  if (bills.length === 0) {
    return <Empty>{filter.empty}</Empty>;
  }
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Supplier&apos;s invoice number</th>
              <th>Supplier</th>
              <th>Date</th>
              <th>Due</th>
              <th>Status</th>
              <th>Payment</th>
              <th className={ui.num}>Total</th>
              <th className={ui.num}>Amount due</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((bill) => (
              <tr key={bill.id}>
                <td>
                  <Link href={`/operations/bills/${bill.id}`}>{bill.supplierInvoiceNumber}</Link>
                </td>
                <td>{bill.contactName}</td>
                <td>{formatDate(bill.billDate)}</td>
                <td>{formatDate(bill.dueDate)}</td>
                <td>
                  <BillStatusBadge status={bill.status} />
                </td>
                <td>{bill.paidStatus ? <PaidStatusBadge status={bill.paidStatus} /> : null}</td>
                <td className={ui.num}>
                  <Money value={bill.total} />
                </td>
                <td className={ui.num}>{bill.amountDue !== null ? <Money value={bill.amountDue} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older bills
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Bills({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Bills"
      description="Newest first. Drafts post nothing; approving posts the bill to accounts payable on its bill date. Amount due is the total less the bill's payments."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/bills/new")}>New bill</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Bill status">
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
      <BillList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function BillsPage() {
  return (
    <Page>
      <PageHeader title="Bills" description="Bills from your suppliers, with GST worked out per line." />
      <RequireOrganisation>{(organisationId) => <Bills organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
