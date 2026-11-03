"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { takesBankTransactionLines } from "@/components/bank/common";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { ChoiceTiles } from "@/components/choice-tiles";
import { useConfirm } from "@/components/confirm-dialog";
import { useDocumentTaxCodes } from "@/components/document-tax-codes";
import { useApiData } from "@/components/hooks";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { SetupProgress } from "@/components/store-setup";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import type { ReviewLine, UsageAccount } from "@/lib/bank/mixed-use";
import { type AccountUsage, DECISION_LABELS, decisionsFor, type ReviewDecision, USAGE_LABELS, USAGE_SHORT } from "@/lib/bank/mixed-use-rules";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate } from "@/lib/format";
import { isDecimalString } from "@/lib/money/decimal";
import styles from "@/components/store-setup.module.css";
import own from "./mixed-use.module.css";

/**
 * Personal and mixed-use accounts (#545, examples MU1-MU14): the guided
 * "How is this account used?" setup, and the review list that replaces
 * reconciling on such an account.
 */

export function UsageBadge({ usage }: { usage: AccountUsage }) {
  if (usage === "business") return null;
  return <Badge tone={usage === "mixed" ? "amber" : "neutral"}>{USAGE_LABELS[usage]}</Badge>;
}

type Step = "use" | "owner" | "check";
const STEP_NAMES: Record<Step, string> = { use: "How it's used", owner: "Owner account", check: "Check" };

/** The guided choice (MU1, MU12, MU13). */
export function UsageSetup({
  organisationId,
  account,
  onClose,
}: {
  organisationId: string;
  account: UsageAccount;
  onClose: (changed: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("use");
  const [usage, setUsage] = useState<AccountUsage>(account.usage === "business" ? "mixed" : account.usage);
  const chart = useAccounts(organisationId);
  const [ownerCode, setOwnerCode] = useState(account.ownerAccount?.code ?? "3000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);

  const steps: Step[] = usage === "business" ? ["use", "check"] : ["use", "owner", "check"];
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const ownerName = chart.data?.accounts.find((entry) => entry.code === ownerCode)?.name ?? "";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${account.accountId}/usage`, {
        method: "PUT",
        body: { organisationId, usage, ownerAccountCode: usage === "business" ? undefined : ownerCode },
      });
      onClose(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  let next: ReactNode;
  if (step === "use") {
    body = (
      <>
        <ChoiceTiles<AccountUsage>
          label="How this account is used"
          value={usage}
          onChange={setUsage}
          options={(["business", "mixed", "personal"] as const).map((value) => ({ value, title: USAGE_LABELS[value], text: USAGE_SHORT[value] }))}
        />
        {usage !== "business" ? (
          <p className={ui.muted} style={{ margin: 0 }}>
            The card or account stays out of the business books.{" "}
            <InfoTip label="How it's kept">
              <InfoPara>Each business purchase is posted as spend money, with the same amount credited to the owner (owner funds introduced). The account&apos;s balance in Tohyee stays 0.00.</InfoPara>
              <InfoPara>Household spending isn&apos;t posted at all. No opening balance is entered: what&apos;s owed on a personal card isn&apos;t a business debt.</InfoPara>
              <InfoPara>Paying the card from the business account is coded to Owner drawings, so nothing is expensed twice.</InfoPara>
              <InfoPara>If the business does owe the card, keep it business only and enter its balance as for any card.</InfoPara>
            </InfoTip>
          </p>
        ) : null}
      </>
    );
    next = <Button onClick={() => go(usage === "business" ? "check" : "owner")}>Next</Button>;
  } else if (step === "owner") {
    body = (
      <Field label="Owner account">
        <AccountSelect
          accounts={chart.data?.accounts ?? []}
          value={ownerCode}
          onChange={setOwnerCode}
          filter={(entry) => entry.accountClass === "equity" && entry.systemKey !== "retained_earnings" && entry.systemKey !== "conversion_clearing"}
          ariaLabel="Owner account"
        />
      </Field>
    );
    next = (
      <Button disabled={!ownerCode} onClick={() => go("check")}>
        Next
      </Button>
    );
  } else {
    body = (
      <dl className={styles.summary}>
        <dt>Account</dt>
        <dd>
          {account.code} {account.name}
        </dd>
        <dt>Used for</dt>
        <dd>{USAGE_LABELS[usage]}</dd>
        {usage !== "business" ? (
          <>
            <dt>Owner account</dt>
            <dd>
              {ownerCode} {ownerName}
            </dd>
            <dt>Lines</dt>
            <dd>{usage === "personal" ? "Private unless you pick one out" : "Reviewed one by one"}</dd>
          </>
        ) : (
          <>
            <dt>Lines</dt>
            <dd>Reconciled as usual. Private lines stay excluded.</dd>
          </>
        )}
      </dl>
    );
    next = (
      <Button disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </Button>
    );
  }
  const at = steps.indexOf(step);
  return (
    <div className={styles.wizard}>
      <SetupProgress steps={steps} names={STEP_NAMES} current={step} done={(candidate) => steps.indexOf(candidate) < at} />
      <h3 className={styles.stepTitle} ref={heading} tabIndex={-1}>
        {step === "use" ? "How is this account used?" : step === "owner" ? "Whose money is it?" : "Check and save"}
      </h3>
      {body}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={styles.footer}>
        <div className={ui.actions}>
          {at > 0 ? (
            <Button variant="secondary" onClick={() => go(steps[at - 1])} disabled={busy}>
              Back
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onClose(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
        <div className={styles.footerRight}>{next}</div>
      </div>
    </div>
  );
}

const FILTERS = [
  { value: "to_review", label: "To review" },
  { value: "reviewed", label: "Reviewed" },
  { value: "excluded", label: "Excluded" },
  { value: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

/** The review list for a mixed-use or personal account (MU2-MU12). */
export function MixedUsePanel({ organisationId, accountId, canReview, onChanged }: { organisationId: string; accountId: string; canReview: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState<Filter>("to_review");
  const list = useApiData<{ account: UsageAccount; lines: ReviewLine[] }>(`/api/bank-accounts/${accountId}/mixed-use-lines`, { organisationId, state: filter, limit: "200" });
  const reviewed = useApiData<{ lines: ReviewLine[] }>(`/api/bank-accounts/${accountId}/mixed-use-lines`, { organisationId, state: "reviewed", limit: "200" });
  const [open, setOpen] = useState<{ lineId: string; decision: ReviewDecision } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const refresh = () => {
    list.reload();
    reviewed.reload();
    onChanged();
  };
  const lines = list.data?.lines ?? [];
  const purchases = (reviewed.data?.lines ?? []).filter((line) => line.review && (line.review.decision === "business" || line.review.decision === "split"));

  async function markPrivate() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ batch: { counts: { committed: number; failed: number } } }>(`/api/bank-accounts/${accountId}/mixed-use-lines/batch`, {
        method: "POST",
        body: { organisationId, idempotencyKey: newIdempotencyKey("private"), actions: [...selected].map((lineId) => ({ lineId, decision: "private" })) },
      });
      const { committed, failed } = result.batch.counts;
      setMessage(`${committed} marked private.${failed ? ` ${failed} couldn't be: see the Batches tab.` : ""}`);
      setSelected(new Set());
      refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function undo(line: ReviewLine) {
    const posted = line.review?.bankTransactionId ? " What it posted is voided on the line's date." : "";
    if (!(await confirm(`Undo this review?${posted}`))) return;
    setError(null);
    try {
      await api(`/api/statement-lines/${line.id}/review/undo`, { method: "POST", body: { organisationId, idempotencyKey: newIdempotencyKey("undo") } });
      setMessage("Review undone.");
      refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function quickPrivate(line: ReviewLine) {
    setError(null);
    try {
      await api(`/api/statement-lines/${line.id}/review`, { method: "POST", body: { organisationId, idempotencyKey: newIdempotencyKey("private"), decision: "private" } });
      setMessage(null);
      refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const selectable = lines.filter((line) => line.state === "to_review");
  return (
    <div className={own.panel}>
      <div className={own.toolbar}>
        <div className={ui.tabs} role="tablist" aria-label="Which lines">
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              aria-selected={filter === entry.value}
              className={`${ui.tab} ${filter === entry.value ? ui.tabActive : ""}`}
              onClick={() => {
                setFilter(entry.value);
                setSelected(new Set());
                setOpen(null);
              }}
            >
              {entry.label}
              {entry.value === "to_review" && list.data?.account.toReview ? ` (${list.data.account.toReview})` : ""}
            </button>
          ))}
        </div>
        {canReview && selected.size > 0 ? (
          <Button size="small" variant="secondary" disabled={busy} onClick={() => void markPrivate()}>
            {busy ? "Marking…" : `Mark ${selected.size} private`}
          </Button>
        ) : null}
      </div>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && lines.length === 0 ? <Empty>{filter === "to_review" ? "Nothing to review." : "No lines here."}</Empty> : null}
      {canReview && filter === "to_review" && selectable.length > 1 ? (
        <label className={own.selectAll}>
          <input
            type="checkbox"
            checked={selected.size === selectable.length}
            onChange={(event) => setSelected(event.target.checked ? new Set(selectable.map((line) => line.id)) : new Set())}
          />
          Select all
        </label>
      ) : null}
      <ul className={own.lines}>
        {lines.map((line) => (
          <li key={line.id} className={own.line} data-state={line.state}>
            <div className={own.lineHead}>
              {canReview && line.state === "to_review" ? (
                <input
                  type="checkbox"
                  aria-label={`Select ${line.description}`}
                  checked={selected.has(line.id)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(line.id);
                    else next.delete(line.id);
                    setSelected(next);
                  }}
                />
              ) : null}
              <div className={own.lineText}>
                <strong>{line.payee ?? line.description}</strong>
                <span className={ui.muted}>
                  {formatDate(line.date)}
                  {line.payee && line.payee !== line.description ? ` · ${line.description}` : ""}
                </span>
              </div>
              <span className={own.amount} data-out={line.amount.startsWith("-") ? "yes" : "no"}>
                <Money value={line.amount} />
              </span>
            </div>
            {line.looksLikePaymentFrom ? <p className={own.hint}>Looks like a payment from {line.looksLikePaymentFrom}. Mark it private.</p> : null}
            {line.possibleDuplicateOf && line.state === "to_review" ? <p className={own.hint}>Possible duplicate of another line.</p> : null}
            {line.review ? <ReviewSummary line={line} /> : null}
            {line.state === "excluded" ? <p className={ui.muted} style={{ margin: 0 }}>Excluded (e.g. a duplicate).</p> : null}
            {canReview ? (
              <div className={own.actions}>
                {line.state === "to_review"
                  ? decisionsFor(line.amount).map((decision) =>
                      decision === "private" ? (
                        <Button key={decision} size="small" variant="secondary" onClick={() => void quickPrivate(line)}>
                          Private
                        </Button>
                      ) : (
                        <Button
                          key={decision}
                          size="small"
                          variant={open?.lineId === line.id && open.decision === decision ? "primary" : "secondary"}
                          aria-expanded={open?.lineId === line.id && open.decision === decision}
                          onClick={() => setOpen(open?.lineId === line.id && open.decision === decision ? null : { lineId: line.id, decision })}
                        >
                          {DECISION_LABELS[decision]}
                        </Button>
                      ),
                    )
                  : null}
                {line.review && !line.review.automatic ? (
                  <Button size="small" variant="secondary" onClick={() => void undo(line)}>
                    Undo
                  </Button>
                ) : null}
                {line.review?.automatic ? (
                  <Button
                    size="small"
                    variant="secondary"
                    aria-expanded={open?.lineId === line.id}
                    onClick={() => setOpen(open?.lineId === line.id ? null : { lineId: line.id, decision: line.amount.startsWith("-") ? "business" : "refund" })}
                  >
                    {line.amount.startsWith("-") ? "It's business" : "It's a refund"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {open?.lineId === line.id ? (
              <ReviewForm
                organisationId={organisationId}
                line={line}
                decision={open.decision}
                purchases={purchases}
                onDone={() => {
                  setOpen(null);
                  setMessage(null);
                  refresh();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewSummary({ line }: { line: ReviewLine }) {
  const review = line.review!;
  const part = review.parts[0];
  return (
    <p className={own.summary}>
      <Badge tone={review.decision === "private" ? "neutral" : "blue"}>{DECISION_LABELS[review.decision]}</Badge>{" "}
      {review.decision === "private" ? (
        review.automatic ? "Personal account" : "Not posted"
      ) : (
        <>
          {review.decision === "split" ? (
            <>
              <Money value={review.businessAmount} /> business ·{" "}
            </>
          ) : null}
          {part ? `${part.accountCode} ${part.accountName}${part.taxCode ? ` · ${part.taxCode}` : ""}` : ""}
          {review.parts.length > 1 ? ` and ${review.parts.length - 1} more` : ""}
          {review.contactName ? ` · ${review.contactName}` : ""}
        </>
      )}
    </p>
  );
}

function ReviewForm({
  organisationId,
  line,
  decision,
  purchases,
  onDone,
}: {
  organisationId: string;
  line: ReviewLine;
  decision: ReviewDecision;
  purchases: ReviewLine[];
  onDone: () => void;
}) {
  const total = line.amount.replace(/^-/, "");
  const chart = useAccounts(organisationId);
  const taxCodes = useDocumentTaxCodes(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>(decision === "refund" ? null : "/api/contacts", { organisationId });
  const [contactId, setContactId] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [taxCode, setTaxCode] = useState("");
  const [business, setBusiness] = useState(decision === "split" ? "" : total);
  const [refundOf, setRefundOf] = useState("");
  const [receipt, setReceipt] = useState(false);
  const [notDuplicate, setNotDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `review-${line.id}`;

  const original = purchases.find((entry) => entry.id === refundOf);
  const refundParts = useMemo(() => original?.review?.parts ?? [], [original]);
  const code = (taxCodes.data?.taxCodes ?? []).find((entry) => entry.code === taxCode);
  const withGst = decision !== "refund" && code !== undefined && code.category !== "out_of_scope";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const part =
        decision === "refund"
          ? { accountCode: refundParts[0]?.accountCode, taxCode: refundParts[0]?.taxCode ?? null, amount: business }
          : { accountCode, taxCode: taxCode || null, amount: business };
      await api(`/api/statement-lines/${line.id}/review`, {
        method: "POST",
        body: {
          organisationId,
          idempotencyKey: newIdempotencyKey("review"),
          decision,
          ...(decision === "refund" ? { refundOfLineId: refundOf } : { contactId }),
          ...(decision === "split" ? { businessAmount: business } : {}),
          lines: [part],
          ...(withGst && receipt ? { gstEvidence: "tax_document" } : {}),
          ...(notDuplicate ? { notDuplicate: true } : {}),
        },
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    isDecimalString(business) &&
    (decision === "refund" ? Boolean(refundOf) && refundParts.length === 1 : Boolean(contactId) && Boolean(accountCode)) &&
    (!withGst || receipt);
  return (
    <form
      className={own.form}
      aria-label={`${DECISION_LABELS[decision]}: ${line.description}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {decision === "refund" ? (
        <>
          <Field label="Refund of">
            <select value={refundOf} onChange={(event) => setRefundOf(event.target.value)} required>
              <option value="">Choose the purchase</option>
              {purchases.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {formatDate(entry.date)} · {entry.payee ?? entry.description} · {entry.review?.businessAmount}
                </option>
              ))}
            </select>
          </Field>
          {original && refundParts.length > 1 ? <Notice tone="info">This purchase was coded to several accounts. Ask your AI, or undo and redo it, to refund it.</Notice> : null}
          {original && refundParts.length === 1 ? (
            <p className={ui.muted} style={{ margin: 0 }}>
              Back to {refundParts[0].accountCode} {refundParts[0].accountName}
              {refundParts[0].taxCode ? ` with ${refundParts[0].taxCode}` : ""}.
            </p>
          ) : null}
        </>
      ) : (
        <Field label="From">
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
            <option value="">Choose a contact</option>
            {(contacts.data?.contacts ?? []).map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className={own.formRow}>
        {decision !== "refund" ? (
          <>
            <Field label="Account">
              <AccountSelect accounts={chart.data?.accounts ?? []} value={accountCode} onChange={setAccountCode} filter={takesBankTransactionLines} ariaLabel="Account" />
            </Field>
            <Field label="GST">
              <select value={taxCode} onChange={(event) => setTaxCode(event.target.value)}>
                <option value="">No GST</option>
                {(taxCodes.data?.taxCodes ?? [])
                  .filter((entry) => entry.isActive)
                  .map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.label}
                    </option>
                  ))}
              </select>
            </Field>
          </>
        ) : null}
        <Field label={decision === "business" ? "Amount" : "Business part"}>
          <input
            inputMode="decimal"
            value={business}
            readOnly={decision === "business"}
            onChange={(event) => setBusiness(event.target.value.trim())}
            aria-describedby={`${id}-of`}
            required
          />
        </Field>
      </div>
      {decision === "split" || decision === "refund" ? (
        <p id={`${id}-of`} className={ui.muted} style={{ margin: 0 }}>
          Of {total}. The rest is private.
        </p>
      ) : null}
      {withGst ? (
        <label className={own.check}>
          <input type="checkbox" checked={receipt} onChange={(event) => setReceipt(event.target.checked)} />
          I have the receipt or tax invoice{" "}
          <InfoTip label="Why a receipt">
            <InfoPara>GST is claimed only on the business part, and only with the receipt. A shop&apos;s name isn&apos;t enough: fuel, parking and supermarkets can be private.</InfoPara>
          </InfoTip>
        </label>
      ) : null}
      {line.possibleDuplicateOf ? (
        <label className={own.check}>
          <input type="checkbox" checked={notDuplicate} onChange={(event) => setNotDuplicate(event.target.checked)} />
          It&apos;s a separate purchase, not a duplicate
        </label>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
