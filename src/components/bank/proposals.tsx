"use client";

import { Fragment, useState } from "react";
import { outcomeText } from "@/components/bank/batches";
import { takesBankTransactionLines } from "@/components/bank/common";
import { AccountSelect } from "@/components/books";
import { useDocumentTaxCodes } from "@/components/document-tax-codes";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { toggleAll, toggleSelection } from "@/lib/bank/batch-words";
import {
  confidenceText,
  GST_EVIDENCE_LABELS,
  isOpen,
  PROPOSAL_FILTER_LABELS,
  PROPOSAL_FILTERS,
  PROPOSAL_STATE_LABELS,
  PROPOSAL_STATE_TONES,
  type ProposalFilter,
  proposalCountsText,
  proposalCsv,
  type TotalLine,
} from "@/lib/bank/coding-proposal-words";
import type { ApprovalOutcome, Proposal, ProposalRow, ProposalSummary } from "@/lib/bank/coding-proposals";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import { isAvailableOn, type TaxSide } from "@/lib/tax/available-on";

type Message = { tone: "success" | "error" | "warning"; text: string };

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function TotalsTable({ title, lines }: { title: string; lines: TotalLine[] }) {
  return (
    <div className={ui.tableWrap} style={{ minWidth: 0 }}>
      <table className={ui.table} aria-label={title}>
        <thead>
          <tr>
            <th style={{ whiteSpace: "normal" }}>{title}</th>
            <th className={ui.num}>Rows</th>
            <th className={ui.num}>Money in</th>
            <th className={ui.num}>Money out</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key || "none"}>
              <td style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{line.label}</td>
              <td className={ui.num}>{line.rows}</td>
              <td className={ui.num}>{formatMoney(line.moneyIn)}</td>
              <td className={ui.num}>{formatMoney(line.moneyOut)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowEditor({
  organisationId,
  proposalId,
  row,
  accounts,
  contacts,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  proposalId: string;
  row: ProposalRow;
  accounts: Account[];
  contacts: Contact[];
  onSaved: (message: Message) => void;
  onCancel: () => void;
}) {
  const taxCodes = useDocumentTaxCodes(organisationId);
  const [contactId, setContactId] = useState(row.contactId);
  const [accountCode, setAccountCode] = useState(row.accountCode);
  const [taxCode, setTaxCode] = useState(row.taxCode ?? "");
  const [description, setDescription] = useState(row.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const side: TaxSide = row.line.amount.startsWith("-") ? "purchases" : "sales";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-coding-proposals/${proposalId}/rows/${row.id}`, {
        method: "PATCH",
        body: { organisationId, version: row.version, contactId, accountCode, taxCode: taxCode || null, description },
      });
      onSaved({ tone: "success", text: "Row saved. Approve it to post it." });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10, padding: "8px 0", minWidth: 0 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        <Field label="Contact">
          <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
            {contacts
              .filter((contact) => !contact.isArchived || contact.id === row.contactId)
              .map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Account">
          <AccountSelect accounts={accounts} filter={takesBankTransactionLines} value={accountCode} onChange={setAccountCode} />
        </Field>
        <Field label="GST">
          <select value={taxCode} onChange={(event) => setTaxCode(event.target.value)}>
            <option value="">No GST</option>
            {(taxCodes.data?.taxCodes ?? [])
              .filter((code) => code.isActive && (isAvailableOn(code.availableOn, side) || code.code === row.taxCode))
              .map((code) => (
                <option key={code.code} value={code.code}>
                  {code.code} {code.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Description">
          <input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button size="small" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="small" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ProposalReview({ organisationId, proposalId, onChanged }: { organisationId: string; proposalId: string; onChanged: () => void }) {
  const { can } = useWorkspace();
  const [filter, setFilter] = useState<ProposalFilter>("all");
  const detail = useApiData<{ proposal: Proposal }>(`/api/bank-coding-proposals/${proposalId}`, { organisationId, filter });
  const accounts = useApiData<{ accounts: Account[] }>(can("bookkeeper") ? "/api/accounts" : null, { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>(can("bookkeeper") ? "/api/contacts" : null, { organisationId });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // One key until the server answers, so a retry after a lost answer posts nothing twice.
  const [approveKey, setApproveKey] = useState(() => newIdempotencyKey("approve"));

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <p className={ui.muted}>Loading…</p>;
  const proposal = detail.data.proposal;
  const reviewer = can("bookkeeper");
  const open = proposal.rows.filter((row) => isOpen(row.state));
  const chosen = open.filter((row) => selected.has(row.id));
  const picked = chosen.map((row) => ({ id: row.id, version: row.version }));

  function refresh(next: Message | null) {
    setMessage(next);
    setSelected(new Set());
    setEditing(null);
    detail.reload();
    onChanged();
  }

  async function approve() {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await api<ApprovalOutcome>(`/api/bank-coding-proposals/${proposalId}/approve`, {
        method: "POST",
        body: { organisationId, rows: picked, idempotencyKey: approveKey },
      });
      setApproveKey(newIdempotencyKey("approve"));
      const skipped = outcome.skipped.length ? ` ${outcome.skipped.length} left as they are (see Needs a look).` : "";
      const tone = outcome.stopped || outcome.batch.counts.failed || outcome.skipped.length ? "warning" : "success";
      refresh({ tone, text: `Batch ${outcome.batch.id}: ${outcomeText(outcome)}${skipped}` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/bank-coding-proposals/${proposalId}/reject`, { method: "POST", body: { organisationId, rows: picked } });
      refresh({ tone: "success", text: `${picked.length} rejected. Nothing was posted.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const lookupsReady = accounts.data && contacts.data;
  const exportName = `proposal-${proposal.id}${filter === "all" ? "" : `-${filter}`}.csv`;

  return (
    <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {proposal.note ? <p style={{ margin: 0 }}>Note: {proposal.note}</p> : null}
      {proposal.refused.length ? (
        <p className={ui.muted} style={{ margin: 0 }}>
          {proposal.refused.length} not kept.{" "}
          <InfoTip label="Rows not kept">
            {proposal.refused.map((entry) => `Row ${entry.index + 1}${entry.lineId ? ` (line ${entry.lineId})` : ""}: ${entry.reason}`).join(" ")}
          </InfoTip>
        </p>
      ) : null}
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        <TotalsTable title="By account" lines={proposal.totals.byAccount} />
        <TotalsTable title="By GST" lines={proposal.totals.byTax} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
        <Field label="Show">
          <select value={filter} onChange={(event) => setFilter(event.target.value as ProposalFilter)}>
            {PROPOSAL_FILTERS.map((entry) => (
              <option key={entry} value={entry}>
                {PROPOSAL_FILTER_LABELS[entry]}
                {entry !== "all" && entry !== "attention" ? ` (${proposal.counts[entry]})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Button size="small" variant="secondary" onClick={() => download(exportName, proposalCsv(proposal.rows))}>
          Export CSV
        </Button>
        {reviewer ? (
          <>
            <Button size="small" disabled={busy || picked.length === 0} onClick={() => void approve()}>
              {busy ? "Working…" : `Approve ${picked.length || ""}`.trim()}
            </Button>
            <Button size="small" variant="danger" disabled={busy || picked.length === 0} onClick={() => void reject()}>
              {`Reject ${picked.length || ""}`.trim()}
            </Button>
          </>
        ) : null}
      </div>
      {proposal.rows.length === 0 ? <Empty>No rows here.</Empty> : null}
      {proposal.rows.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                {reviewer ? (
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Choose every open row shown"
                      disabled={open.length === 0}
                      checked={open.length > 0 && open.every((row) => selected.has(row.id))}
                      onChange={() => setSelected(toggleAll(selected, open.map((row) => row.id)))}
                    />
                  </th>
                ) : null}
                <th>Date</th>
                <th>Bank line</th>
                <th className={ui.num}>Amount</th>
                <th>Proposed coding</th>
                <th className={ui.num}>Sure</th>
                <th>State</th>
                {reviewer ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {proposal.rows.map((row) => (
                <Fragment key={row.id}>
                  <tr className={selected.has(row.id) ? ui.selectedRow : undefined}>
                    {reviewer ? (
                      <td data-label="">
                        {isOpen(row.state) ? (
                          <input
                            type="checkbox"
                            aria-label={`Choose ${formatDate(row.line.date)} ${row.line.description} ${formatMoney(row.line.amount)}`}
                            checked={selected.has(row.id)}
                            onChange={() => setSelected(toggleSelection(selected, row.id))}
                          />
                        ) : null}
                      </td>
                    ) : null}
                    <td data-label="Date" style={{ whiteSpace: "nowrap" }}>
                      {formatDate(row.line.date)}
                    </td>
                    <td data-label="Bank line" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                      {row.line.description}
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      {formatMoney(row.line.amount)}
                    </td>
                    <td data-label="Proposed coding" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                      <div>
                        {row.accountCode} {row.accountName ?? ""} · {row.taxCode ?? "No GST"}
                      </div>
                      <div className={ui.muted}>
                        {row.contactName ?? `Contact ${row.contactId}`}
                        {row.rationale || row.evidence || row.gstEvidence ? (
                          <>
                            {" "}
                            <InfoTip label="Why">
                              {[
                                row.rationale,
                                row.gstEvidence ? `GST: ${GST_EVIDENCE_LABELS[row.gstEvidence] ?? row.gstEvidence}.` : null,
                                row.evidence ? `Evidence: ${row.evidence}` : null,
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            </InfoTip>
                          </>
                        ) : null}
                      </div>
                      {row.problems.map((problem) => (
                        <div key={problem.text} style={{ color: "var(--warning-text, var(--text))" }}>
                          {problem.kind === "stale" ? <Badge tone="amber">Stale</Badge> : null} {problem.text}
                        </div>
                      ))}
                      {row.error ? <div>{row.error}</div> : null}
                    </td>
                    <td data-label="Sure" className={ui.num}>
                      {confidenceText(row.confidence)}
                    </td>
                    <td data-label="State">
                      <Badge tone={PROPOSAL_STATE_TONES[row.state]}>{PROPOSAL_STATE_LABELS[row.state]}</Badge>{" "}
                      {!row.reviewed && proposal.aiDrafted ? <Badge tone="neutral">AI draft</Badge> : null}
                      {row.reviewedByEmail && row.state !== "proposed" ? (
                        <div className={ui.muted}>
                          {row.state === "rejected" ? "Rejected" : "Approved"} by {row.reviewedByName ?? row.reviewedByEmail}
                        </div>
                      ) : row.editedByEmail ? (
                        <div className={ui.muted}>Edited by {row.editedByName ?? row.editedByEmail}</div>
                      ) : null}
                    </td>
                    {reviewer ? (
                      <td data-label="">
                        {isOpen(row.state) ? (
                          <Button
                            size="small"
                            variant="secondary"
                            aria-expanded={editing === row.id}
                            disabled={!lookupsReady}
                            onClick={() => setEditing(editing === row.id ? null : row.id)}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {editing === row.id && lookupsReady ? (
                    <tr>
                      <td colSpan={reviewer ? 8 : 6}>
                        <RowEditor
                          organisationId={organisationId}
                          proposalId={proposal.id}
                          row={row}
                          accounts={accounts.data!.accounts}
                          contacts={contacts.data!.contacts}
                          onSaved={refresh}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Bank coding proposals on this account (#544): drafted coding, reviewed and approved by a person before anything posts. */
export function ProposalsPanel({ organisationId, accountId, onChanged }: { organisationId: string; accountId: string; onChanged: () => void }) {
  const list = useApiData<{ proposals: ProposalSummary[] }>("/api/bank-coding-proposals", { organisationId, accountId });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className={ui.muted} style={{ margin: 0 }}>
        Nothing posts until a person approves.{" "}
        <InfoTip label="About proposals">
          An AI proposes coding for unreconciled lines. Edit, reject or approve each row. Approving posts spend or receive money and
          reconciles the line, as a batch you can resume on the Batches tab. A row whose line changed since is marked stale and left as it is.
        </InfoTip>
      </p>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.proposals.length === 0 ? <Empty>No proposals on this account yet.</Empty> : null}
      {list.data?.proposals.map((proposal) => (
        <section key={proposal.id} className={ui.card} style={{ display: "grid", gap: 8, minWidth: 0, overflowWrap: "anywhere" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <strong>Proposal {proposal.id}</strong> {proposal.aiDrafted ? <Badge tone="neutral">AI draft</Badge> : null}
              <div className={ui.muted}>
                {formatDateTime(proposal.createdAt)} · {proposal.createdVia ?? proposal.createdByEmail ?? "Someone"}
              </div>
              <div>{proposalCountsText(proposal.counts)}</div>
            </div>
            <Button size="small" variant="secondary" aria-expanded={open === proposal.id} onClick={() => setOpen(open === proposal.id ? null : proposal.id)}>
              {open === proposal.id ? "Hide" : "Review"}
            </Button>
          </div>
          {open === proposal.id ? (
            <ProposalReview
              organisationId={organisationId}
              proposalId={proposal.id}
              onChanged={() => {
                list.reload();
                onChanged();
              }}
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}
