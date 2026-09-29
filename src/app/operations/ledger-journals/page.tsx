"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Money, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { JournalEditor } from "@/components/journals/journal-editor";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, personName } from "@/lib/format";
import type { Journal, JournalWithLines } from "@/lib/ledger/journals";
import { RecordExtrasPanel } from "@/components/records/record-extras";

type JournalDetails = {
  journal: JournalWithLines;
  parentJournal: Journal | null;
  correctionJournals: Journal[];
  canCorrect: boolean;
};

const ORIGIN_LABELS: Record<Journal["origin"], string> = {
  manual: "Manual",
  correction: "Correction",
  inventory: "Stock",
  fx_revaluation: "FX revaluation",
  invoice: "Invoice",
  customer_payment: "Customer payment",
  customer_payment_batch: "Payment for several invoices",
  supplier_payment_batch: "Payment for several bills",
  bill: "Bill",
  supplier_payment: "Supplier payment",
  sales_credit_note: "Credit note",
  sales_credit_note_refund: "Credit note refund",
  supplier_credit_note: "Supplier credit note",
  supplier_credit_note_refund: "Supplier refund",
  customer_overpayment_refund: "Overpayment refund",
  bank_transaction: "Bank transaction",
  bank_transfer: "Transfer",
  expense_claim: "Expense claim",
  expense_claim_payment: "Expense claim payment",
  fixed_asset_depreciation: "Depreciation",
  fixed_asset_disposal: "Asset disposal",
};

const REVERSED_BY: Partial<Record<Journal["origin"], string>> = {
  invoice: "The invoice was voided: reversed by",
  customer_payment: "The payment was voided: reversed by",
  customer_payment_batch: "The payment was voided: reversed by",
  supplier_payment_batch: "The payment was voided: reversed by",
  bill: "The bill was voided: reversed by",
  supplier_payment: "The payment was voided: reversed by",
  sales_credit_note: "The credit note was voided: reversed by",
  sales_credit_note_refund: "The refund was voided: reversed by",
  supplier_credit_note: "The supplier credit note was voided: reversed by",
  supplier_credit_note_refund: "The refund was voided: reversed by",
  customer_overpayment_refund: "The refund was voided: reversed by",
  bank_transaction: "The bank transaction was voided: reversed by",
  bank_transfer: "The transfer was voided: reversed by",
  expense_claim: "The expense claim was voided: reversed by",
  expense_claim_payment: "The payment was voided: reversed by",
  fixed_asset_depreciation: "The depreciation run was rolled back: reversed by",
  fixed_asset_disposal: "The disposal was undone: reversed by",
};

function KindBadge({ journal }: { journal: Journal }) {
  if (journal.correctionKind === "reversal") return <Badge tone="amber">Reversal</Badge>;
  if (journal.correctionKind === "replacement") return <Badge tone="blue">Replacement</Badge>;
  return <Badge tone={journal.origin === "manual" ? "neutral" : "green"}>{ORIGIN_LABELS[journal.origin]}</Badge>;
}

function JournalDetail({
  organisationId,
  journalId,
  onSelect,
  onCorrect,
}: {
  organisationId: string;
  journalId: string;
  onSelect: (id: string) => void;
  onCorrect: (journal: JournalWithLines) => void;
}) {
  const { can } = useWorkspace();
  const details = useApiData<JournalDetails>(`/api/ledger/journals/${journalId}`, { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading journal #{journalId}…</p>;
  const { journal, parentJournal, correctionJournals, canCorrect } = details.data;
  return (
    <Card
      title={`Journal #${journal.id} · ${journal.reference}`}
      description={`${formatDate(journal.postingDate)} · posted by ${personName(journal, "createdBy") ?? "unknown"} on ${formatDateTime(journal.createdAt)}`}
      actions={
        canCorrect && can("bookkeeper") ? (
          <Button variant="secondary" onClick={() => onCorrect(journal)}>
            Correct this journal
          </Button>
        ) : null
      }
    >
      <div className={ui.actions}>
        <KindBadge journal={journal} />
        {journal.description ? <span className={ui.muted}>{journal.description}</span> : null}
      </div>
      {parentJournal ? (
        <p className={ui.muted}>
          {journal.correctionKind === "reversal" ? "Reverses" : "Replaces"} journal{" "}
          <button type="button" className={ui.muted} style={{ border: 0, background: "none", textDecoration: "underline" }} onClick={() => onSelect(parentJournal.id)}>
            #{parentJournal.id} ({parentJournal.reference})
          </button>
        </p>
      ) : null}
      {correctionJournals.length > 0 ? (
        <Notice tone="warning">
          {REVERSED_BY[journal.origin] ?? "Corrected by"}{" "}
          {correctionJournals.map((entry, index) => (
            <span key={entry.id}>
              {index > 0 ? " and " : ""}
              <button type="button" style={{ border: 0, background: "none", textDecoration: "underline", color: "inherit" }} onClick={() => onSelect(entry.id)}>
                #{entry.id} ({entry.correctionKind})
              </button>
            </span>
          ))}
          .
        </Notice>
      ) : null}
      {!canCorrect && (journal.origin === "inventory" || journal.origin === "fx_revaluation") ? (
        <p className={ui.muted}>
          This journal was created by {journal.origin === "inventory" ? "a stock movement" : "an FX revaluation"}. Correct it
          there so the records stay in step with the ledger.
        </p>
      ) : null}
      {journal.origin === "invoice" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "approving"} a sales invoice, so it
          can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To cancel it, void the invoice from <Link href="/operations/invoices">Invoices</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "customer_payment" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a customer payment, so
          it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the payment from its invoice in <Link href="/operations/invoices">Invoices</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "customer_payment_batch" || journal.origin === "supplier_payment_batch" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a payment for several{" "}
          {journal.origin === "customer_payment_batch" ? "invoices" : "bills"}, so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the whole payment from{" "}
              {journal.origin === "customer_payment_batch" ? (
                <Link href="/operations/customer-payments">payments for several invoices</Link>
              ) : (
                <Link href="/operations/supplier-payments">payments for several bills</Link>
              )}
              .
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "bill" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "approving"} a bill, so it
          can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To cancel it, void the bill from <Link href="/operations/bills">Bills</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "supplier_payment" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a supplier payment, so
          it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the payment from its bill in <Link href="/operations/bills">Bills</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "sales_credit_note" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "approving"} a sales credit note,
          so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To cancel it, void the credit note from <Link href="/operations/credit-notes">Credit notes</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "sales_credit_note_refund" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a credit note refund,
          so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the refund from its credit note in{" "}
              <Link href="/operations/credit-notes">Credit notes</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "customer_overpayment_refund" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a refund of a
          customer overpayment, so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the refund from the overpayment, which is linked from the overpaid invoice in{" "}
              <Link href="/operations/invoices">Invoices</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "bank_transaction" || journal.origin === "bank_transfer" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "posting"} a{" "}
          {journal.origin === "bank_transaction" ? "bank transaction" : "transfer between bank accounts"}, so it can&apos;t
          be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, unreconcile it and void it from its bank account in{" "}
              <Link href="/operations/bank-accounts">Bank accounts</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "supplier_credit_note" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "approving"} a supplier credit
          note, so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To cancel it, void the credit note from{" "}
              <Link href="/operations/supplier-credit-notes">Supplier credit notes</Link>.
            </>
          )}
        </p>
      ) : null}
      {journal.origin === "supplier_credit_note_refund" ? (
        <p className={ui.muted}>
          This journal was posted by {journal.correctionKind === "reversal" ? "voiding" : "recording"} a refund received
          from a supplier, so it can&apos;t be corrected here.
          {journal.correctionKind === "reversal" ? null : (
            <>
              {" "}
              To undo it, void the refund from its credit note in{" "}
              <Link href="/operations/supplier-credit-notes">Supplier credit notes</Link>.
            </>
          )}
        </p>
      ) : null}
      <CustomValuesText setup={customSetup.data} values={journal.customFields} />
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Account</th>
              <th>Description</th>
              <th className={ui.num}>Debit</th>
              <th className={ui.num}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.lineOrder}>
                <td>
                  {line.accountCode} · {line.accountName}
                  <TrackingTagsText setup={tracking.data} tags={line.tracking} />
                  <CustomValuesText setup={customSetup.data} values={line.customFields} />
                </td>
                <td className={ui.muted}>{line.description}</td>
                <td className={ui.num}>
                  <Money value={line.debitAmount} blankZero />
                </td>
                <td className={ui.num}>
                  <Money value={line.creditAmount} blankZero />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total ({journal.currencyCode})</td>
              <td className={ui.num}>
                <Money value={journal.totalDebit} />
              </td>
              <td className={ui.num}>
                <Money value={journal.totalCredit} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

type Filters = { from: string; to: string; reference: string; kind: string };

function Journals({ organisationId, initialJournalId }: { organisationId: string; initialJournalId: string | null }) {
  const { can } = useWorkspace();
  const accounts = useAccounts(organisationId);
  const [filters, setFilters] = useState<Filters>({ from: "", to: "", reference: "", kind: "" });
  const [applied, setApplied] = useState<Filters>(filters);
  const list = useApiData<{ journals: Journal[]; nextBeforeId: string | null }>("/api/ledger/journals", {
    organisationId,
    postingDateFrom: applied.from,
    postingDateTo: applied.to,
    referenceQuery: applied.reference,
    kind: applied.kind,
  });
  const [more, setMore] = useState<{ journals: Journal[]; nextBeforeId: string | null } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialJournalId);
  const [composing, setComposing] = useState(false);
  const [correcting, setCorrecting] = useState<JournalWithLines | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  const journals = [...(list.data?.journals ?? []), ...(more?.journals ?? [])];
  const nextBeforeId = more ? more.nextBeforeId : (list.data?.nextBeforeId ?? null);

  async function loadMore() {
    if (!nextBeforeId) return;
    try {
      const page = await api<{ journals: Journal[]; nextBeforeId: string | null }>("/api/ledger/journals", {
        query: {
          organisationId,
          postingDateFrom: applied.from,
          postingDateTo: applied.to,
          referenceQuery: applied.reference,
          kind: applied.kind,
          beforeId: nextBeforeId,
        },
      });
      setMore((current) => ({ journals: [...(current?.journals ?? []), ...page.journals], nextBeforeId: page.nextBeforeId }));
    } catch (caught) {
      setMoreError(errorMessage(caught));
    }
  }

  function refresh(select: string) {
    setMore(null);
    list.reload();
    setSelected(select);
  }

  return (
    <>
      {posted ? <Notice tone="success">{posted}</Notice> : null}
      {can("bookkeeper") && !correcting ? (
        composing ? (
          <Card title="New journal" description="Pick an account for each line. Debits must equal credits.">
            {accounts.data ? (
              <JournalEditor
                organisationId={organisationId}
                accounts={accounts.data.accounts}
                mode="new"
                onCancel={() => setComposing(false)}
                onDone={(id) => {
                  setPosted(`Posted journal #${id}.`);
                  refresh(id);
                }}
              />
            ) : (
              <p className={ui.muted}>{accounts.error ?? "Loading accounts…"}</p>
            )}
          </Card>
        ) : (
          <div>
            <Button onClick={() => setComposing(true)}>New journal</Button>
          </div>
        )
      ) : null}

      {correcting ? (
        <Card title={`Correct journal #${correcting.id}`}>
          {accounts.data ? (
            <JournalEditor
              organisationId={organisationId}
              accounts={accounts.data.accounts}
              mode="correct"
              original={correcting}
              onCancel={() => setCorrecting(null)}
              onDone={(id) => {
                setCorrecting(null);
                setPosted(`Posted the correction. The replacement is journal #${id}.`);
                refresh(id);
              }}
            />
          ) : (
            <p className={ui.muted}>Loading accounts…</p>
          )}
        </Card>
      ) : null}

      {selected ? (
        <JournalDetail
          key={selected}
          organisationId={organisationId}
          journalId={selected}
          onSelect={setSelected}
          onCorrect={(journal) => {
            setComposing(false);
            setCorrecting(journal);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      ) : null}
      {selected ? (
        <RecordExtrasPanel key={`journal-${selected}`} organisationId={organisationId} recordType="ledger_journal" recordId={selected} />
      ) : null}

      <Card title="Journals">
        <form
          className={ui.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            setMore(null);
            setApplied(filters);
          }}
        >
          <Field label="From">
            <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </Field>
          <Field label="Reference contains">
            <input value={filters.reference} onChange={(event) => setFilters({ ...filters, reference: event.target.value })} />
          </Field>
          <Field label="Kind">
            <select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}>
              <option value="">All</option>
              <option value="manual">Manual</option>
              <option value="inventory">Stock</option>
              <option value="fx_revaluation">FX revaluation</option>
              <option value="invoice">Invoices</option>
              <option value="customer_payment">Customer payments</option>
              <option value="customer_payment_batch">Payments for several invoices</option>
              <option value="bill">Bills</option>
              <option value="supplier_payment">Supplier payments</option>
              <option value="supplier_payment_batch">Payments for several bills</option>
              <option value="sales_credit_note">Credit notes</option>
              <option value="sales_credit_note_refund">Credit note refunds</option>
              <option value="supplier_credit_note">Supplier credit notes</option>
              <option value="supplier_credit_note_refund">Supplier refunds</option>
              <option value="customer_overpayment_refund">Overpayment refunds</option>
              <option value="bank_transaction">Bank transactions</option>
              <option value="bank_transfer">Transfers</option>
              <option value="reversal">Reversals</option>
              <option value="replacement">Replacements</option>
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            Filter
          </Button>
        </form>
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {moreError ? <Notice tone="error">{moreError}</Notice> : null}
        {list.data && journals.length === 0 ? (
          <Empty>No journals match.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Description</th>
                  <th>Kind</th>
                  <th className={ui.num}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {journals.map((journal) => (
                  <tr
                    key={journal.id}
                    className={`${ui.clickableRow} ${selected === journal.id ? ui.selectedRow : ""}`}
                    onClick={() => setSelected(journal.id)}
                  >
                    <td>{journal.id}</td>
                    <td>{formatDate(journal.postingDate)}</td>
                    <td>{journal.reference}</td>
                    <td className={ui.muted}>{journal.description}</td>
                    <td>
                      <KindBadge journal={journal} />
                    </td>
                    <td className={ui.num}>
                      <Money value={journal.totalDebit} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextBeforeId ? (
          <div>
            <Button variant="secondary" onClick={() => void loadMore()}>
              Load older journals
            </Button>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function JournalsPage() {
  const params = useSearchParams();
  return (
    <Page>
      <PageHeader
        title="Journals"
        description="Every posting in the ledger. Posted journals are never edited: corrections reverse the original and post a replacement."
      />
      <RequireOrganisation>
        {(organisationId) => (
          <Journals key={organisationId} organisationId={organisationId} initialJournalId={params.get("journal")} />
        )}
      </RequireOrganisation>
    </Page>
  );
}

export default function LedgerJournalsPage() {
  return (
    <Suspense fallback={null}>
      <JournalsPage />
    </Suspense>
  );
}
