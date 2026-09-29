"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CreditNoteStatusBadge, CreditStatusBadge } from "@/components/credit-notes/credit-note-editor";
import { CustomValueCell, listColumns, useCustomFields } from "@/components/custom-fields";
import { useApiData } from "@/components/hooks";
import { useSalespeople } from "@/components/salespeople";
import { Button, Card, Empty, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { CreditNoteStatus, CreditNoteSummary } from "@/lib/credit-notes/service";
import { formatDate } from "@/lib/format";

type CreditNotePage = { creditNotes: CreditNoteSummary[]; nextBeforeId: string | null };

type Filter = { label: string; status: CreditNoteStatus | null; hasRemainingCredit: boolean; empty: string };

const FILTERS: Filter[] = [
  { label: "All", status: null, hasRemainingCredit: false, empty: "No credit notes yet." },
  { label: "Drafts", status: "draft", hasRemainingCredit: false, empty: "No draft credit notes." },
  { label: "Approved", status: "approved", hasRemainingCredit: false, empty: "No approved credit notes." },
  {
    label: "With credit remaining",
    status: null,
    hasRemainingCredit: true,
    empty: "No approved credit notes have credit left to apply or refund.",
  },
  { label: "Voided", status: "voided", hasRemainingCredit: false, empty: "No voided credit notes." },
];

function CreditNoteList({ organisationId, filter }: { organisationId: string; filter: Filter }) {
  const { status } = filter;
  const hasRemainingCredit = filter.hasRemainingCredit ? "true" : null;
  const list = useApiData<CreditNotePage>("/api/credit-notes", { organisationId, status, hasRemainingCredit });
  // The salesperson column shows while advanced features are on (SR1).
  const showSalesperson = useSalespeople(organisationId).data?.advancedFeatures ?? false;
  const columns = listColumns(useCustomFields(organisationId).data, "document", ["credit_note"]);
  const [more, setMore] = useState<CreditNotePage | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const creditNotes = [...(list.data?.creditNotes ?? []), ...(more?.creditNotes ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<CreditNotePage>("/api/credit-notes", {
        query: { organisationId, status, hasRemainingCredit, beforeId: nextBeforeId },
      });
      setMore((current) => ({
        creditNotes: [...(current?.creditNotes ?? []), ...page.creditNotes],
        nextBeforeId: page.nextBeforeId,
      }));
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
  if (creditNotes.length === 0) {
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
              <th>Reference</th>
              {showSalesperson ? <th>Salesperson</th> : null}
              {columns.map((field) => (
                <th key={field.id}>{field.label}</th>
              ))}
              <th>Status</th>
              <th>Credit</th>
              <th className={ui.num}>Total</th>
              <th className={ui.num}>Remaining credit</th>
            </tr>
          </thead>
          <tbody>
            {creditNotes.map((creditNote) => (
              <tr key={creditNote.id}>
                <td>
                  <Link href={`/operations/credit-notes/${creditNote.id}`}>
                    {creditNote.creditNoteNumber ?? `Draft #${creditNote.id}`}
                  </Link>
                </td>
                <td>{creditNote.contactName}</td>
                <td>{formatDate(creditNote.creditNoteDate)}</td>
                <td className={ui.muted}>{creditNote.reference}</td>
                {showSalesperson ? <td>{creditNote.salespersonName ?? ""}</td> : null}
                {columns.map((field) => (
                  <CustomValueCell key={field.id} field={field} values={creditNote.customFields} />
                ))}
                <td>
                  <CreditNoteStatusBadge status={creditNote.status} />
                </td>
                <td>{creditNote.creditStatus ? <CreditStatusBadge status={creditNote.creditStatus} /> : null}</td>
                <td className={ui.num}>
                  <Money value={creditNote.total} />
                </td>
                <td className={ui.num}>
                  {creditNote.remainingCredit !== null ? <Money value={creditNote.remainingCredit} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId ? (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load older credit notes
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CreditNotes({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(FILTERS[0]);
  return (
    <Card
      title="Sales credit notes"
      description="Newest first. Drafts post nothing; approving numbers the credit note and posts it. Remaining credit is the total less the credit applied to invoices and refunded."
      actions={
        can("bookkeeper") ? <Button onClick={() => router.push("/operations/credit-notes/new")}>New credit note</Button> : null
      }
    >
      <div className={ui.tabs} role="tablist" aria-label="Credit note status">
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
      <CreditNoteList key={filter.label} organisationId={organisationId} filter={filter} />
    </Card>
  );
}

export default function CreditNotesPage() {
  return (
    <Page>
      <PageHeader
        title="Credit notes"
        description="Credit for your customers, applied to their invoices or refunded, with GST worked out per line."
      />
      <RequireOrganisation>{(organisationId) => <CreditNotes organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
