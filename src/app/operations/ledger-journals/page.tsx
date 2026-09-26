"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Money, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { JournalEditor } from "@/components/journals/journal-editor";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime } from "@/lib/format";
import type { Journal, JournalWithLines } from "@/lib/ledger/journals";

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
  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading journal #{journalId}…</p>;
  const { journal, parentJournal, correctionJournals, canCorrect } = details.data;
  return (
    <Card
      title={`Journal #${journal.id} · ${journal.reference}`}
      description={`${formatDate(journal.postingDate)} · posted by ${journal.createdByEmail ?? "unknown"} on ${formatDateTime(journal.createdAt)}`}
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
          {journal.origin === "invoice" ? "The invoice was voided: reversed by" : "Corrected by"}{" "}
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
