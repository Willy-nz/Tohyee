"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { QuoteStatusBadge } from "@/components/quotes/quote-editor";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { QuoteSummary } from "@/lib/quotes/service";

type QuotePage = { quotes: QuoteSummary[]; nextBeforeId: string | null };

type Filter = { label: string; status: string | null; empty: string };

const FILTERS: Filter[] = [
  { label: "All", status: null, empty: "No quotes yet." },
  { label: "Drafts", status: "draft", empty: "No draft quotes." },
  { label: "Finalised", status: "finalised", empty: "No finalised quotes waiting for an answer." },
  { label: "Expired", status: "expired", empty: "No expired quotes." },
  { label: "Accepted", status: "accepted", empty: "No accepted quotes." },
  { label: "Declined", status: "declined", empty: "No declined quotes." },
];

function QuoteList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const list = useApiData<QuotePage>("/api/quotes", { organisationId, status });
  const [more, setMore] = useState<QuotePage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const quotes = [...(list.data?.quotes ?? []), ...(more?.quotes ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<QuotePage>("/api/quotes", { query: { organisationId, status, beforeId: nextBeforeId } });
      setMore((current) => ({ quotes: [...(current?.quotes ?? []), ...page.quotes], nextBeforeId: page.nextBeforeId }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  if (quotes.length === 0) return <Empty>{filter.empty}</Empty>;
  return (
    <>
      {moreError ? <Notice tone="error">{moreError}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Expires</th>
              <th>Reference</th>
              <th>Status</th>
              <th>Invoice</th>
              <th className={ui.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((quote) => (
              <tr key={quote.id}>
                <td data-label="Number">
                  <Link href={`/operations/quotes/${quote.id}`}>{quote.quoteNumber ?? `Draft #${quote.id}`}</Link>
                </td>
                <td data-label="Customer">{quote.contactName}</td>
                <td data-label="Date">{formatDate(quote.quoteDate)}</td>
                <td data-label="Expires">{quote.expiryDate ? formatDate(quote.expiryDate) : ""}</td>
                <td data-label="Reference" className={ui.muted}>
                  {quote.reference}
                </td>
                <td data-label="Status">
                  <QuoteStatusBadge quote={quote} />
                </td>
                <td data-label="Invoice">
                  {quote.invoiceId ? (
                    <Link href={`/operations/invoices/${quote.invoiceId}`}>{quote.invoiceNumber ?? `Draft #${quote.invoiceId}`}</Link>
                  ) : null}
                </td>
                <td data-label="Total" className={ui.num}>
                  <Money value={quote.total} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older quotes
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Quotes({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Quotes"
      description="Latest entered first. Quotes post nothing. Finalising numbers a quote; accepting it makes a draft invoice with the same lines."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/quotes/new")}>New quote</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Quote status">
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
      <QuoteList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function QuotesPage() {
  return (
    <Page>
      <PageHeader title="Quotes" description="Prices offered to customers. An accepted quote becomes a draft invoice." />
      <RequireOrganisation>{(organisationId) => <Quotes organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
