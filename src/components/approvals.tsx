"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import styles from "./approvals.module.css";
import type { OrganisationMember } from "@/lib/approvals/rules";
import {
  APPROVAL_DOCUMENT_LABELS,
  APPROVAL_DOCUMENT_TYPES,
  type ApprovalBudgetLine,
  type ApprovalDocumentType,
  approvalHref,
  type ApprovalMode,
  type ApprovalRequest,
  type ApprovalRule,
  type DocumentApproval,
  documentNoun,
} from "@/lib/approvals/types";
import type { DuplicateWarning } from "@/lib/bills/duplicates";
import { api, errorMessage } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatDateTime, formatMoney, personName, todayInBrowser } from "@/lib/format";

/**
 * Approval workflows on screen (AW1-AW17): Settings › Approval rules, the
 * Approvals page (Purchases), one request's approval page with the budget,
 * and the panel on a bill, purchase order or expense claim.
 */

const MODE_WORDS: Record<ApprovalMode, string> = { any: "Any one of", all: "All of" };

export function documentHref(type: ApprovalDocumentType, id: string): string {
  return type === "bill" ? `/operations/bills/${id}` : type === "purchase_order" ? `/operations/purchase-orders/${id}` : `/operations/expense-claims/${id}`;
}

function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? "an" : "a";
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- rules

type RulesData = { rules: ApprovalRule[]; approvers: OrganisationMember[]; claimants: OrganisationMember[] };

function memberName(members: OrganisationMember[], person: { userId: string; email: string }): string {
  return members.find((member) => member.userId === person.userId)?.displayName ?? person.email;
}

function conditionsText(rule: ApprovalRule): string {
  const parts: string[] = [];
  if (rule.minTotal !== null) parts.push(`total at least ${formatMoney(rule.minTotal)}`);
  if (rule.contactName) parts.push(`supplier ${rule.contactName}`);
  if (rule.claimantEmail) parts.push(`claimant ${rule.claimantEmail}`);
  if (rule.accountCode) parts.push(`a line on ${rule.accountCode} ${rule.accountName}`);
  if (rule.trackingValueName) parts.push(`a line tagged ${rule.trackingCategoryName}: ${rule.trackingValueName}`);
  return parts.length === 0 ? "Every one" : capital(parts.join(", "));
}

function stepsText(rule: ApprovalRule, members: OrganisationMember[]): string {
  return rule.steps
    .map((step) => `${step.stepNumber}. ${MODE_WORDS[step.mode]} ${step.approvers.map((approver) => memberName(members, approver)).join(step.mode === "any" ? " or " : " and ")}`)
    .join(" · ");
}

type StepDraft = { mode: ApprovalMode; approverUserIds: string[] };

function RuleForm({
  organisationId,
  data,
  rule,
  documentType,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  data: RulesData;
  rule: ApprovalRule | null;
  documentType: ApprovalDocumentType;
  onSaved: (message: string, warnings: string[]) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const tracking = useTracking(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>(documentType === "expense_claim" ? null : "/api/contacts", { organisationId });
  const [name, setName] = useState(rule?.name ?? "");
  const [minTotal, setMinTotal] = useState(rule?.minTotal ?? "");
  const [contactId, setContactId] = useState(rule?.contactId ?? "");
  const [claimantUserId, setClaimantUserId] = useState(rule?.claimantUserId ?? "");
  const [accountCode, setAccountCode] = useState(rule?.accountCode ?? "");
  const [trackingValueId, setTrackingValueId] = useState(rule?.trackingValueId ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(
    rule ? rule.steps.map((step) => ({ mode: step.mode, approverUserIds: step.approvers.map((approver) => approver.userId) })) : [{ mode: "any", approverUserIds: [] }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = documentNoun(documentType);
  const accountList = accounts.data?.accounts ?? [];
  const values = (tracking.data?.categories ?? []).flatMap((category) => category.values.filter((value) => value.isActive || value.id === trackingValueId).map((value) => ({ id: value.id, label: `${category.name}: ${value.name}` })));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const accountId = accountCode ? (accountList.find((account) => account.code === accountCode)?.id ?? null) : null;
    const body = {
      organisationId,
      documentType,
      name,
      minTotal,
      contactId: contactId || null,
      claimantUserId: claimantUserId || null,
      accountId,
      trackingValueId: trackingValueId || null,
      steps,
      ...(rule ? { version: rule.version } : {}),
    };
    try {
      const result = await api<{ rule: ApprovalRule; warnings: string[] }>(rule ? `/api/approval-rules/${rule.id}` : "/api/approval-rules", { method: rule ? "PUT" : "POST", body });
      onSaved(rule ? `Saved the rule "${result.rule.name}".` : `Added the rule "${result.rule.name}".`, result.warnings);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Rule name" hint="Shown on documents it applies to, e.g. Over $1,000.">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="Total at least" hint="Including GST, in the base currency. Blank for any total.">
          <input value={minTotal} onChange={(event) => setMinTotal(event.target.value)} inputMode="decimal" />
        </Field>
        {documentType === "expense_claim" ? (
          <Field label="Claimant" hint="Blank for anyone's claims.">
            <select value={claimantUserId} onChange={(event) => setClaimantUserId(event.target.value)}>
              <option value="">Anyone</option>
              {data.claimants.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Supplier" hint="Blank for any supplier.">
            <select value={contactId} onChange={(event) => setContactId(event.target.value)}>
              <option value="">Any supplier</option>
              {(contacts.data?.contacts ?? [])
                .filter((contact) => (contact.isSupplier && !contact.isArchived) || contact.id === contactId)
                .map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Account on any line" hint="Blank for any account.">
          <AccountSelect accounts={accountList} value={accountCode} onChange={setAccountCode} placeholder="Any account" />
        </Field>
        {values.length > 0 ? (
          <Field label="Tracking on any line" hint="Lines tagged with the value or one under it. Blank for any.">
            <select value={trackingValueId} onChange={(event) => setTrackingValueId(event.target.value)}>
              <option value="">Any</option>
              {values.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </div>
      <h3 className={styles.stepsHeading}>Steps, in order</h3>
      <p className={ui.muted}>
        Each step&apos;s approvers are asked when the step before is done. Approvers are bookkeepers, admins or owners. Nobody approves a {noun} they submitted or made.
      </p>
      {steps.map((step, index) => (
        <fieldset key={index} className={`${ui.fieldSection} ${styles.step}`}>
          <legend>Step {index + 1}</legend>
          <div className={ui.inlineForm}>
            <Field label="Needs">
              <select
                value={step.mode}
                onChange={(event) => setSteps(steps.map((item, at) => (at === index ? { ...item, mode: event.target.value as ApprovalMode } : item)))}
              >
                <option value="any">Any one of them</option>
                <option value="all">All of them</option>
              </select>
            </Field>
            {steps.length > 1 ? (
              <Button variant="secondary" size="small" onClick={() => setSteps(steps.filter((_, at) => at !== index))}>
                Remove step {index + 1}
              </Button>
            ) : null}
          </div>
          <div className={ui.choiceList}>
            {data.approvers.map((member) => (
              <label key={member.userId} className={ui.checkbox}>
                <input
                  type="checkbox"
                  checked={step.approverUserIds.includes(member.userId)}
                  onChange={(event) =>
                    setSteps(
                      steps.map((item, at) =>
                        at === index
                          ? {
                              ...item,
                              approverUserIds: event.target.checked ? [...item.approverUserIds, member.userId] : item.approverUserIds.filter((id) => id !== member.userId),
                            }
                          : item,
                      ),
                    )
                  }
                />{" "}
                {member.displayName} <span className={ui.muted}>({member.role})</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        {steps.length < 10 ? (
          <Button variant="secondary" onClick={() => setSteps([...steps, { mode: "any", approverUserIds: [] }])}>
            Add a step
          </Button>
        ) : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Settings › Approval rules (AW1, AW11). Everyone sees them; admins change them. */
export function ApprovalRules({ organisationId, canEdit }: { organisationId: string; canEdit: boolean }) {
  const confirm = useConfirm();
  const [archived, setArchived] = useState(false);
  const loaded = useApiData<RulesData>("/api/approval-rules", { organisationId, archived: archived ? "true" : null });
  const [editing, setEditing] = useState<{ type: ApprovalDocumentType; rule: ApprovalRule | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function act(path: string, body: Record<string, unknown>, text: string) {
    setError(null);
    try {
      await api(path, { method: "POST", body: { organisationId, ...body } });
      setMessage(text);
      setWarnings([]);
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const data = loaded.data;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      <div className={ui.tabs} role="tablist" aria-label="Approval rules">
        {[false, true].map((value) => (
          <button
            key={String(value)}
            type="button"
            role="tab"
            aria-selected={archived === value}
            className={`${ui.tab} ${archived === value ? ui.tabActive : ""}`}
            onClick={() => {
              setArchived(value);
              setEditing(null);
            }}
          >
            {value ? "Archived" : "Current"}
          </button>
        ))}
      </div>
      {!data ? <p className={ui.muted}>Loading…</p> : null}
      {data
        ? APPROVAL_DOCUMENT_TYPES.map((type) => {
            const rules = data.rules.filter((rule) => rule.documentType === type);
            const noun = documentNoun(type);
            return (
              <Card
                key={type}
                title={APPROVAL_DOCUMENT_LABELS[type].many}
                description={
                  archived
                    ? `Archived rules no longer apply to new ${noun}s.`
                    : `Rules are tried in this order; the first that matches ${article(noun)} ${noun} is used. ${capital(article(noun))} ${noun} no rule matches is approved as usual.`
                }
                actions={
                  canEdit && !archived && editing?.type !== type ? (
                    <Button size="small" onClick={() => setEditing({ type, rule: null })}>
                      Add rule
                    </Button>
                  ) : null
                }
              >
                {editing?.type === type ? (
                  <RuleForm
                    organisationId={organisationId}
                    data={data}
                    rule={editing.rule}
                    documentType={type}
                    onCancel={() => setEditing(null)}
                    onSaved={(text, saved) => {
                      setMessage(text);
                      setWarnings(saved);
                      setEditing(null);
                      loaded.reload();
                    }}
                  />
                ) : null}
                {rules.length === 0 ? (
                  <Empty>{archived ? `No archived rules for ${noun}s.` : `No rules: ${noun}s are approved as usual.`}</Empty>
                ) : (
                  <div className={ui.tableWrap}>
                    <table className={`${ui.table} ${ui.stackOnPhone}`}>
                      <thead>
                        <tr>
                          <th>Rule</th>
                          <th>Applies to</th>
                          <th>Steps</th>
                          {canEdit ? <th aria-label="Actions" /> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((rule, index) => (
                          <tr key={rule.id}>
                            <td data-label="Rule">
                              <strong>{rule.name}</strong>
                              <div className={ui.muted}>
                                Changed by {personName(rule, "updatedBy") ?? "unknown"}, {formatDateTime(rule.updatedAt)}
                              </div>
                            </td>
                            <td data-label="Applies to">{conditionsText(rule)}</td>
                            <td data-label="Steps">{stepsText(rule, data.approvers)}</td>
                            {canEdit ? (
                              <td data-label="Actions">
                                <div className={ui.actions}>
                                  {archived ? (
                                    <Button size="small" variant="secondary" onClick={() => act(`/api/approval-rules/${rule.id}/archive`, { archived: false }, `Restored "${rule.name}".`)}>
                                      Restore
                                    </Button>
                                  ) : (
                                    <>
                                      <Button size="small" variant="secondary" onClick={() => setEditing({ type, rule })}>
                                        Edit
                                      </Button>
                                      <Button size="small" variant="secondary" disabled={index === 0} aria-label={`Move ${rule.name} up`} onClick={() => act(`/api/approval-rules/${rule.id}/move`, { direction: "up" }, `Moved "${rule.name}" up.`)}>
                                        ↑
                                      </Button>
                                      <Button size="small" variant="secondary" disabled={index === rules.length - 1} aria-label={`Move ${rule.name} down`} onClick={() => act(`/api/approval-rules/${rule.id}/move`, { direction: "down" }, `Moved "${rule.name}" down.`)}>
                                        ↓
                                      </Button>
                                      <Button
                                        size="small"
                                        variant="danger"
                                        onClick={async () => {
                                          if (await confirm(`Archive "${rule.name}"? New ${noun}s won't match it; one already waiting carries on with it.`)) {
                                            await act(`/api/approval-rules/${rule.id}/archive`, { archived: true }, `Archived "${rule.name}".`);
                                          }
                                        }}
                                      >
                                        Archive
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })
        : null}
    </>
  );
}

// ---------------------------------------------------------------- the approvals page

const STATUS_TONES = { waiting: "amber", approved: "green", declined: "red", withdrawn: "neutral" } as const;
const STATUS_WORDS = { waiting: "Waiting", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" } as const;

type ListTab = "mine" | "waiting" | "finished";

/** Purchases › Approvals (AW3): what's waiting for the signed-in person, everything waiting, and what's finished. */
export function ApprovalsList({ organisationId }: { organisationId: string }) {
  const [tab, setTab] = useState<ListTab>("mine");
  const loaded = useApiData<{ requests: ApprovalRequest[] }>("/api/approvals", {
    organisationId,
    mine: tab === "mine" ? "true" : null,
    finished: tab === "finished" ? "true" : null,
  });
  const requests = loaded.data?.requests;
  return (
    <Card>
      <div className={ui.tabs} role="tablist" aria-label="Approvals">
        {(
          [
            ["mine", "Waiting for you"],
            ["waiting", "All waiting"],
            ["finished", "Finished"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className={`${ui.tab} ${tab === value ? ui.tabActive : ""}`} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {!requests ? <p className={ui.muted}>Loading…</p> : null}
      {requests && requests.length === 0 ? (
        <Empty>{tab === "mine" ? "Nothing is waiting for you to approve." : tab === "waiting" ? "Nothing is waiting for approval." : "Nothing has finished approval yet."}</Empty>
      ) : null}
      {requests && requests.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Document</th>
                <th className={ui.num}>Total</th>
                <th>Rule</th>
                <th>{tab === "finished" ? "Result" : "Step"}</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td data-label="Document">
                    <Link href={approvalHref(request.id)}>{request.documentLabel}</Link>
                  </td>
                  <td data-label="Total" className={ui.num}>
                    <Money value={request.total} /> {request.currencyCode}
                  </td>
                  <td data-label="Rule">{request.ruleName}</td>
                  <td data-label={tab === "finished" ? "Result" : "Step"}>
                    {tab === "finished" ? (
                      <Badge tone={STATUS_TONES[request.status]}>{STATUS_WORDS[request.status]}</Badge>
                    ) : (
                      <>
                        {request.currentStep ? `${request.currentStep} of ${request.stepCount}` : "All steps done"}
                        <div className={ui.muted}>{request.waitingFor}</div>
                      </>
                    )}
                  </td>
                  <td data-label="Submitted">
                    {personName(request, "submittedBy")}, {formatDateTime(request.submittedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- one request

function BudgetTable({ lines }: { lines: ApprovalBudgetLine[] }) {
  if (lines.length === 0) {
    return <p className={ui.muted}>No budget covers this document&apos;s accounts.</p>;
  }
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Account</th>
            <th>Budget</th>
            <th className={ui.num}>Month&apos;s budget</th>
            <th className={ui.num}>Spent</th>
            <th className={ui.num}>This document</th>
            <th className={ui.num}>Left</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.accountId}-${line.budgetId}`}>
              <td data-label="Account">
                {line.accountCode} {line.accountName}
              </td>
              <td data-label="Budget">
                {line.budgetName} <span className={ui.muted}>({formatDate(line.month).replace(/^\d+\s/, "")})</span>
              </td>
              <td data-label="Month's budget" className={ui.num}>
                {line.budget === null ? <span className={ui.muted}>None set</span> : <Money value={line.budget} />}
              </td>
              <td data-label="Spent" className={ui.num}>
                <Money value={line.spent} />
              </td>
              <td data-label="This document" className={ui.num}>
                <Money value={line.thisDocument} />
              </td>
              <td data-label="Left" className={ui.num}>
                {line.left === null ? "" : <Money value={line.left} />}
                {line.overBy ? <div className={styles.overBudget}>{line.overBy}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RequestData = { request: ApprovalRequest; budget: ApprovalBudgetLine[]; warnings: DuplicateWarning[] };

/** One request's approval page (AW4, AW5, AW9, AW12): the document, its steps, the budget, and approve or decline. */
export function ApprovalRequestView({ organisationId, requestId }: { organisationId: string; requestId: string }) {
  const confirm = useConfirm();
  const loaded = useApiData<RequestData>(`/api/approvals/${requestId}`, { organisationId });
  const [claimDate, setClaimDate] = useState(todayInBrowser());
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!loaded.data) return <p className={ui.muted}>Loading…</p>;
  const { request, budget, warnings } = loaded.data;
  const noun = documentNoun(request.documentType);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      loaded.reload();
    }
  }

  async function approve() {
    const despite = request.isFinalStep && warnings.length > 0;
    const question = request.isFinalStep
      ? `${despite ? `${warnings.map((warning) => warning.message).join(". ")}. ` : ""}Approve this ${noun}? This is the last step, so the ${noun} is approved${request.documentType === "purchase_order" ? "" : ` and posted to the ledger${request.documentType === "expense_claim" ? ` on ${formatDate(claimDate)}` : ""}`}.`
      : `Approve step ${request.currentStep}? The next step's approvers are asked.`;
    if (!(await confirm(question))) return;
    void run(async () => {
      const result = await api<{ request: ApprovalRequest }>(`/api/approvals/${request.id}/approve`, {
        method: "POST",
        body: { organisationId, claimDate: request.documentType === "expense_claim" ? claimDate : undefined, approveDespiteWarnings: despite },
      });
      return result.request.status === "approved" ? `Approved. ${capital(result.request.documentLabel)} is approved.` : `Approved step ${request.currentStep}.`;
    });
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={capital(request.documentLabel)}
        description={
          <>
            Rule: {request.ruleName}. Submitted by {personName(request, "submittedBy")}, {formatDateTime(request.submittedAt)}.
          </>
        }
        actions={
          <Link className={`${ui.button} ${ui.secondary} ${ui.small}`} href={documentHref(request.documentType, request.documentId)}>
            Open the {noun}
          </Link>
        }
      >
        <div className={ui.statRow}>
          <div className={ui.stat}>
            <div className={ui.statLabel}>{request.documentType === "expense_claim" ? "Claimant" : "Supplier"}</div>
            <div className={ui.statValue}>{request.partyName}</div>
          </div>
          {request.documentNumber ? (
            <div className={ui.stat}>
              <div className={ui.statLabel}>Number</div>
              <div className={ui.statValue}>{request.documentNumber}</div>
            </div>
          ) : null}
          <div className={ui.stat}>
            <div className={ui.statLabel}>Total</div>
            <div className={ui.statValue}>
              {formatMoney(request.total)} {request.currencyCode}
            </div>
          </div>
          <div className={ui.stat}>
            <div className={ui.statLabel}>Status</div>
            <div className={ui.statValue}>
              <Badge tone={STATUS_TONES[request.status]}>{STATUS_WORDS[request.status]}</Badge>
            </div>
          </div>
        </div>
        {request.status === "waiting" && request.waitingFor ? <Notice tone="info">{request.waitingFor}</Notice> : null}
        {request.status === "waiting" && request.lastError ? (
          <Notice tone="warning">
            Approving it was refused {request.lastErrorAt ? `(${formatDateTime(request.lastErrorAt)})` : ""}: {request.lastError} It&apos;s still waiting at this step; approve again once that&apos;s fixed.
          </Notice>
        ) : null}
        {request.status === "declined" ? (
          <Notice tone="warning">
            Declined by {personName(request, "finishedBy")}: {request.declineReason}
          </Notice>
        ) : null}
        {request.status === "withdrawn" ? <Notice tone="info">Withdrawn by {personName(request, "finishedBy")}. Approvals already given were dropped.</Notice> : null}
        {request.status === "approved" ? <Notice tone="success">Approved by {personName(request, "finishedBy")}, {formatDateTime(request.finishedAt)}.</Notice> : null}
        {request.status === "waiting" && warnings.length > 0 ? (
          <Notice tone="warning">
            {warnings.map((warning) => warning.message).join(". ")}. Check it isn&apos;t the same bill before approving the last step.
          </Notice>
        ) : null}
        {request.canAct ? (
          <div className={ui.inlineForm}>
            {request.isFinalStep && request.documentType === "expense_claim" ? (
              <Field label="Claim date" hint="The claim posts on this date (EC3).">
                <input type="date" value={claimDate} onChange={(event) => setClaimDate(event.target.value)} required />
              </Field>
            ) : null}
            <Button onClick={approve} disabled={busy}>
              {busy ? "Working…" : request.isFinalStep ? `Approve the ${noun}` : `Approve step ${request.currentStep}`}
            </Button>
            <Button variant="danger" onClick={() => setDeclining(!declining)} disabled={busy}>
              Decline…
            </Button>
          </div>
        ) : null}
        {request.canAct && declining ? (
          <form
            className={ui.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api(`/api/approvals/${request.id}/decline`, { method: "POST", body: { organisationId, reason } });
                setDeclining(false);
                return `Declined. It's back with ${personName(request, "submittedBy")} as a draft, with your reason.`;
              });
            }}
          >
            <Field label="Reason" hint={`Shown to ${personName(request, "submittedBy")} on the ${noun}.`}>
              <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required />
            </Field>
            <Button type="submit" variant="danger" disabled={busy}>
              Decline the {noun}
            </Button>
          </form>
        ) : null}
        {request.canWithdraw ? (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm(`Withdraw this ${noun} from approval? It's an ordinary draft again, and approvals already given are dropped.`))) return;
                void run(async () => {
                  await api(`/api/approvals/${request.id}/withdraw`, { method: "POST", body: { organisationId } });
                  return `Withdrawn. The ${noun} is a draft again.`;
                });
              }}
            >
              Withdraw from approval
            </Button>
          </div>
        ) : null}
      </Card>

      <Card title="Steps" description="Each step's approvers are asked when the step before is done.">
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Step</th>
                <th>Needs</th>
                <th>Approvers</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {request.steps.map((step) => (
                <tr key={step.stepNumber}>
                  <td data-label="Step">{step.stepNumber}</td>
                  <td data-label="Needs">{step.mode === "any" ? "Any one" : "All"}</td>
                  <td data-label="Approvers">
                    {step.approvers.map((approver) => (
                      <div key={approver.userId}>
                        {approver.name}{" "}
                        {approver.approvedAt ? (
                          <span className={ui.muted}>approved {formatDateTime(approver.approvedAt)}</span>
                        ) : approver.excluded ? (
                          <span className={ui.muted}>can&apos;t approve (submitted or made it)</span>
                        ) : step.state === "done" ? null : (
                          <span className={ui.muted}>hasn&apos;t approved</span>
                        )}
                      </div>
                    ))}
                    {step.approvedBy
                      .filter((by) => !step.approvers.some((approver) => approver.email.toLowerCase() === by.email.toLowerCase()))
                      .map((by) => (
                        <div key={by.email}>
                          {by.name} <span className={ui.muted}>approved {formatDateTime(by.at)} (no longer an approver)</span>
                        </div>
                      ))}
                  </td>
                  <td data-label="State">
                    {step.state === "done" ? <Badge tone="green">Done</Badge> : step.state === "current" && request.status === "waiting" ? <Badge tone="amber">Waiting</Badge> : <Badge>Not yet</Badge>}
                    {step.blocked && request.status === "waiting" ? <div className={ui.muted}>{step.blocked}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {request.status === "waiting" ? (
        <Card title="Budget" description="The month's budget for each profit and loss account on the document, what's been posted to it in the month, and this document (excluding GST). Shown to help decide; it never blocks approving.">
          <BudgetTable lines={budget} />
        </Card>
      ) : null}

      <Card title="History">
        <ul className={styles.history}>
          <li>
            Submitted by {personName(request, "submittedBy")}, {formatDateTime(request.submittedAt)}
          </li>
          {request.actions.map((action) => (
            <li key={action.id}>
              Step {action.stepNumber} {action.action} by {action.name}, {formatDateTime(action.at)}
              {action.reason ? `: ${action.reason}` : ""}
            </li>
          ))}
          {request.status === "approved" ? (
            <li>
              {capital(noun)} approved by {personName(request, "finishedBy")}, {formatDateTime(request.finishedAt)}
            </li>
          ) : null}
          {request.status === "withdrawn" ? (
            <li>
              Withdrawn by {personName(request, "finishedBy")}, {formatDateTime(request.finishedAt)}
            </li>
          ) : null}
          {request.emails.map((email) => (
            <li key={`${email.stepNumber}-${email.toEmail}`} className={ui.muted}>
              Step {email.stepNumber} email to {email.toEmail}: {email.status === "sent" ? "sent" : email.status === "failed" ? `not sent (${email.lastError ?? "unknown"})` : "waiting to send"}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- on a document

export function useDocumentApproval(organisationId: string, documentType: ApprovalDocumentType, documentId: string) {
  return useApiData<{ approval: DocumentApproval }>("/api/approvals/document", { organisationId, documentType, documentId });
}

/** Whether approving the document directly is refused: a rule matches it or it's waiting (AW3). */
export function approvalBlocksApproving(approval: DocumentApproval | null | undefined): boolean {
  return !!approval && (approval.needsApproval || approval.request?.status === "waiting");
}

/** Whether the document is waiting for approval, so it can't be edited (AW3). */
export function waitingForApproval(approval: DocumentApproval | null | undefined): boolean {
  return approval?.request?.status === "waiting";
}

/**
 * The approval panel on a bill, purchase order or expense claim: the rule
 * that applies and Submit for approval, or where it's waiting and Withdraw,
 * or why it was declined.
 */
export function DocumentApprovalPanel({
  organisationId,
  documentType,
  documentId,
  documentStatus,
  approval,
  canSubmit,
  onChanged,
}: {
  organisationId: string;
  documentType: ApprovalDocumentType;
  documentId: string;
  documentStatus: string;
  approval: DocumentApproval | null | undefined;
  /** Bills and purchase orders: bookkeepers. Claims are submitted with their own Submit button. */
  canSubmit: boolean;
  onChanged: (message: string) => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!approval) return null;
  const noun = documentNoun(documentType);
  const request = approval.request;

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (request?.status === "waiting") {
    return (
      <>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Notice tone="info">
          Waiting for approval (rule: {request.ruleName}
          {request.currentStep ? `, step ${request.currentStep} of ${request.stepCount}` : ""}). {request.waitingFor?.replace(/\.?$/, ".")}{" "}
          <Link href={approvalHref(request.id)}>Open its approval page</Link>. It can&apos;t be edited until it&apos;s withdrawn.
        </Notice>
        {request.canWithdraw ? (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm(`Withdraw this ${noun} from approval? It's an ordinary draft again, and approvals already given are dropped.`))) return;
                void run(async () => {
                  await api(`/api/approvals/${request.id}/withdraw`, { method: "POST", body: { organisationId } });
                  return `Withdrawn from approval. The ${noun} is a draft again.`;
                });
              }}
            >
              Withdraw from approval
            </Button>
          </div>
        ) : null}
      </>
    );
  }
  const declined = request?.status === "declined" && documentStatus === "draft" ? request : null;
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {declined ? (
        <Notice tone="warning">
          Declined by {personName(declined, "finishedBy")} ({formatDateTime(declined.finishedAt)}): {declined.declineReason}
        </Notice>
      ) : null}
      {approval.needsApproval && approval.rule ? (
        <>
          <Notice tone="info">
            This {noun} needs approval (rule: {approval.rule.name}). Submitting it asks the rule&apos;s approvers; it stays a draft, and can&apos;t be edited until it&apos;s approved, declined or withdrawn.
          </Notice>
          {canSubmit ? (
            <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ request: ApprovalRequest }>("/api/approvals", { method: "POST", body: { organisationId, documentType, documentId } });
                    return `Submitted for approval (rule: ${result.request.ruleName}). ${result.request.waitingFor ?? ""}`;
                  })
                }
              >
                {busy ? "Submitting…" : "Submit for approval"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {request?.status === "approved" ? (
        <p className={ui.muted}>
          Approved through the rule {request.ruleName}: <Link href={approvalHref(request.id)}>see who approved each step</Link>.
        </p>
      ) : null}
    </>
  );
}
