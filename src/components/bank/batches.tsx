"use client";

import { useState } from "react";
import { Badge, Button, Empty, Notice, ui } from "@/components/ui";
import { useApiData } from "@/components/hooks";
import { useWorkspace } from "@/components/workspace";
import type { Plan, PlanLine } from "@/lib/bank/batches";
import {
  ACTION_LABELS,
  ACTION_STATUS_LABELS,
  BATCH_KIND_LABELS,
  BATCH_STATE_LABELS,
  canResume,
  countsText,
  planButtonText,
} from "@/lib/bank/batch-words";
import type { Batch, BatchSummary, RunOutcome } from "@/lib/batches/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";

type Tone = "green" | "red" | "amber" | "neutral" | "blue";

const STATE_TONE: Record<string, Tone> = { done: "green", finished_with_failures: "amber", working: "blue", waiting: "amber", rate_limited: "amber" };
const STATUS_TONE: Record<string, Tone> = { committed: "green", failed: "red", pending: "neutral", in_progress: "blue", unknown: "amber" };

/** What a run did, in a sentence, with what to do next. */
export function outcomeText(outcome: Pick<RunOutcome, "batch" | "stopped" | "retryAfterSeconds">): string {
  const { batch } = outcome;
  const counts = countsText(batch.counts);
  if (outcome.stopped === "busy") return `Someone else is working on this batch. Try again in ${outcome.retryAfterSeconds ?? 5} seconds.`;
  if (outcome.stopped === "rate_limit") return `${counts}. Paused: try Resume in ${outcome.retryAfterSeconds ?? 5} seconds. What's done stays done.`;
  if (outcome.stopped === "lost_connection") return `${counts}. The server lost its database connection part way; use Resume to carry on (nothing is done twice).`;
  if (outcome.stopped === "time") return `${counts}. It took a while, so it paused; use Resume to carry on.`;
  return `${counts}.`;
}

/** The plan to check before anything changes: what's unreconciled, what's voided, what's left alone and why. */
export function PlanReview({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: Plan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const doable = plan.items.filter((item) => !item.blocked);
  const blocked = plan.items.filter((item) => item.blocked);
  return (
    <section className={ui.card} aria-label="Check before going ahead" style={{ display: "grid", gap: 10, minWidth: 0, overflowWrap: "anywhere" }}>
      <h3 className={ui.cardTitle}>{plan.mode === "unreconcile" ? "Unreconcile these lines?" : "Undo this batch?"}</h3>
      <p className={ui.muted} style={{ margin: 0 }}>
        {plan.mode === "unreconcile"
          ? "Each line goes back to be reconciled. Nothing is posted or voided: what it was reconciled with stays in the books."
          : "Each line goes back to be reconciled, with the other side of a transfer. What the batch posted (spend or receive money, transfers) is voided on the line's date. Payments stay."}
      </p>
      {doable.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}>
          {doable.map((item) => (
            <li key={item.lineId} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 12px", display: "grid", gap: 4, minWidth: 0 }}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
                <strong>
                  {formatDate(item.date)} · {item.description}
                </strong>
                <span className={ui.num}>{formatMoney(item.amount)}</span>
              </div>
              <div className={ui.muted}>
                {item.accountCode} {item.accountName}
              </div>
              {item.reconciliationId ? <div>Unreconciled{item.reconciledWith.length ? ` from ${item.reconciledWith.join(", ")}` : ""}.</div> : null}
              {item.alsoLines.map((other) => (
                <div key={other.lineId}>
                  Also unreconciled ({other.why === "split" ? "same split" : "other side of the transfer"}): {other.accountCode}, {formatDate(other.date)},{" "}
                  {formatMoney(other.amount)}
                </div>
              ))}
              {item.voids ? (
                <div>
                  <Badge tone="amber">Voided</Badge> {item.voids.label} on {formatDate(item.voids.date)}
                </div>
              ) : null}
              {item.notes.map((note) => (
                <div key={note} className={ui.muted}>
                  {note}
                </div>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone="warning">None of these can be {plan.mode === "unreconcile" ? "unreconciled" : "undone"}.</Notice>
      )}
      {blocked.length > 0 ? (
        <div>
          <strong>Left as they are ({blocked.length})</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {blocked.map((item) => (
              <li key={item.lineId}>
                {formatDate(item.date)} {item.description} ({formatMoney(item.amount)}): {item.blocked}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button disabled={busy || doable.length === 0} onClick={onConfirm}>
          {busy ? "Working…" : planButtonText(plan.mode, plan.counts)}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function BatchDetail({ organisationId, batchId, onChanged }: { organisationId: string; batchId: string; onChanged: () => void }) {
  const { can } = useWorkspace();
  const detail = useApiData<{ batch: Batch; lines: Record<string, PlanLine> }>(`/api/bank-batches/${batchId}`, { organisationId });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [undoKey, setUndoKey] = useState(() => newIdempotencyKey("undo"));

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  const resume = (retryFailed: boolean) =>
    act(async () => {
      const outcome = await api<RunOutcome>(`/api/bank-batches/${batchId}/resume`, { method: "POST", body: { organisationId, retryFailed } });
      setMessage({ tone: outcome.stopped ? "warning" : "success", text: outcomeText(outcome) });
      detail.reload();
      onChanged();
    });

  const previewUndo = () =>
    act(async () => {
      const answer = await api<{ plan: Plan }>(`/api/bank-batches/${batchId}/undo`, { method: "POST", body: { organisationId } });
      setPlan(answer.plan);
    });

  const confirmUndo = () =>
    act(async () => {
      if (!plan) return;
      const outcome = await api<RunOutcome>(`/api/bank-batches/${batchId}/undo`, {
        method: "POST",
        body: { organisationId, previewHash: plan.hash, idempotencyKey: undoKey },
      });
      setPlan(null);
      setUndoKey(newIdempotencyKey("undo"));
      setMessage({ tone: outcome.stopped || outcome.batch.counts.failed ? "warning" : "success", text: `Undo: ${outcomeText(outcome)}` });
      detail.reload();
      onChanged();
    });

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <p className={ui.muted}>Loading…</p>;
  const batch = detail.data.batch;
  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {can("bookkeeper") ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {canResume(batch.counts, batch.state) ? (
            <Button size="small" disabled={busy} onClick={() => void resume(false)}>
              Resume
            </Button>
          ) : null}
          {batch.counts.failed > 0 && batch.state !== "working" ? (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => void resume(true)}>
              Try refused ones again
            </Button>
          ) : null}
          {batch.kind === "bank_reconcile" && batch.counts.committed > 0 ? (
            <Button size="small" variant="secondary" disabled={busy} onClick={() => void previewUndo()}>
              Undo batch…
            </Button>
          ) : null}
        </div>
      ) : null}
      {plan ? <PlanReview plan={plan} busy={busy} onConfirm={() => void confirmUndo()} onCancel={() => setPlan(null)} /> : null}
      <ol style={{ margin: 0, paddingLeft: 24, display: "grid", gap: 6 }}>
        {batch.actions.map((action) => {
          const target = action.targetId ? detail.data!.lines[action.targetId] : undefined;
          return (
            <li key={action.id}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                <Badge tone={STATUS_TONE[action.status] ?? "neutral"}>{ACTION_STATUS_LABELS[action.status] ?? action.status}</Badge>
                <span>
                  {ACTION_LABELS[action.action] ?? action.action}:{" "}
                  {target ? `${formatDate(target.date)} · ${target.description} · ${formatMoney(target.amount)}` : action.targetId ? `line ${action.targetId}` : "no line"}
                </span>
              </div>
              {action.error ? <div className={ui.muted}>{action.error}</div> : null}
              {action.status === "unknown" ? <div className={ui.muted}>The server stopped while doing it. Resume checks it with its original key.</div> : null}
              {action.attempts > 1 ? <div className={ui.muted}>Tried {action.attempts} times</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Batches on this account (#547): AI reconciliations, Unreconcile selected and undos, with their counts. */
export function BatchesPanel({ organisationId, accountId, onChanged }: { organisationId: string; accountId: string; onChanged: () => void }) {
  const list = useApiData<{ batches: BatchSummary[] }>("/api/bank-batches", { organisationId, accountId });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className={ui.muted} style={{ margin: 0 }}>
        Lines done or undone together: an AI&apos;s reconciliations, Unreconcile selected, and undos. Each line&apos;s outcome is kept, so a batch that
        stopped part way can be resumed without doing anything twice.
      </p>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.batches.length === 0 ? <Empty>No batches on this account yet.</Empty> : null}
      {list.data?.batches.map((batch) => (
        <section key={batch.id} className={ui.card} style={{ display: "grid", gap: 8, minWidth: 0, overflowWrap: "anywhere" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <strong>
                {BATCH_KIND_LABELS[batch.kind] ?? batch.kind} · batch {batch.id}
              </strong>{" "}
              <Badge tone={STATE_TONE[batch.state] ?? "neutral"}>{BATCH_STATE_LABELS[batch.state] ?? batch.state}</Badge>
              <div className={ui.muted}>
                {formatDateTime(batch.createdAt)} · {batch.createdByEmail ?? "Someone"}
                {batch.createdVia ? ` via ${batch.createdVia}` : ""}
                {batch.undoesBatchId ? ` · undoes batch ${batch.undoesBatchId}` : ""}
                {batch.undoneByBatchIds.length ? ` · undone by batch ${batch.undoneByBatchIds.join(", ")}` : ""}
              </div>
              <div>{countsText(batch.counts)}</div>
            </div>
            <Button
              size="small"
              variant="secondary"
              aria-expanded={open === batch.id}
              onClick={() => setOpen(open === batch.id ? null : batch.id)}
            >
              {open === batch.id ? "Hide" : "Show lines"}
            </Button>
          </div>
          {open === batch.id ? (
            <BatchDetail
              organisationId={organisationId}
              batchId={batch.id}
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
