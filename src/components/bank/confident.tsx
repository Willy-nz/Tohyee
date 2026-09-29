"use client";

import { useState } from "react";
import { originLabel } from "@/components/bank/common";
import { Badge, Button, Notice, ui } from "@/components/ui";
import type { StatementLine } from "@/lib/bank/accounts";
import type { BulkResult } from "@/lib/bank/bulk";
import type { ConfidentSuggestion, LineConfidence } from "@/lib/bank/confident";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney } from "@/lib/format";

/**
 * One-click matching (examples BK17-BK19): a line's confident suggestion,
 * highlighted with an "OK" button, and "OK all confident matches".
 */
export function suggestionText(suggestion: ConfidentSuggestion): string {
  if (suggestion.kind === "match") {
    return `Match ${originLabel(suggestion.origin).toLowerCase()} #${suggestion.journalId} · ${formatDate(suggestion.postingDate)}${
      suggestion.description ? ` · ${suggestion.description}` : ""
    }`;
  }
  if (suggestion.kind === "payment") {
    return `Pay ${suggestion.documentKind === "invoice" ? "invoice" : "bill"} ${suggestion.number} · ${suggestion.contactName} · ${formatMoney(
      suggestion.amountDue,
    )} due`;
  }
  return `Rule “${suggestion.ruleName}”: ${suggestion.contactName}, ${suggestion.accountCode} ${suggestion.accountName}${
    suggestion.taxCode ? `, ${suggestion.taxCode}` : ", no GST"
  }`;
}

/** The highlighted suggestion under a line, or why there's none. */
export function SuggestionBox({
  organisationId,
  confidence,
  canReconcile,
  onDone,
}: {
  organisationId: string;
  confidence: LineConfidence | undefined;
  canReconcile: boolean;
  onDone: () => void;
}) {
  const [key, setKey] = useState(() => newIdempotencyKey("ok"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!confidence) return null;
  if (!confidence.suggestion) {
    if (confidence.competing) return <div className={ui.muted}><Badge tone="amber">Another line has the same match</Badge> Open to choose.</div>;
    if (confidence.candidateCount > 1) {
      return (
        <div className={ui.muted}>
          <Badge tone="amber">{confidence.candidateCount} possible matches</Badge> Open to choose.
        </div>
      );
    }
    return null;
  }
  const suggestion = confidence.suggestion;
  async function ok() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/statement-lines/${confidence!.lineId}/ok`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, expect: suggestion.key },
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      setKey(newIdempotencyKey("ok"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={ui.suggestion}>
        <span>{suggestionText(suggestion)}</span>
        {canReconcile ? (
          <Button size="small" onClick={() => void ok()} disabled={busy} aria-label={`OK: ${suggestionText(suggestion)}`}>
            {busy ? "…" : "OK"}
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

/** "OK all confident matches": each line on its own, with what happened to each. */
export function OkAllBar({
  organisationId,
  accountId,
  confidences,
  lines,
  onDone,
}: {
  organisationId: string;
  accountId: string;
  confidences: LineConfidence[];
  lines: StatementLine[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const items = confidences.filter((entry) => entry.suggestion).map((entry) => ({ lineId: entry.lineId, expect: entry.suggestion!.key }));
  const describe = (lineId: string) => {
    const line = lines.find((entry) => entry.id === lineId);
    return line ? `${formatDate(line.date)} ${line.description} ${formatMoney(line.amount)}` : `Line ${lineId}`;
  };
  async function okAll() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api<BulkResult>(`/api/bank-accounts/${accountId}/confident-matches`, {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey: newIdempotencyKey("okall"), items },
        }),
      );
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.length > 0 ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          <Button onClick={() => void okAll()} disabled={busy}>
            {busy ? "Reconciling…" : `OK all ${items.length} confident ${items.length === 1 ? "match" : "matches"}`}
          </Button>
          <span className={ui.muted}>Each line is reconciled on its own, so one that can&apos;t be doesn&apos;t stop the rest.</span>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result ? (
        <Notice tone={result.failed ? "warning" : "success"}>
          {result.succeeded} reconciled{result.failed ? `, ${result.failed} not:` : "."}
          {result.failed ? (
            <ul>
              {result.results.flatMap((entry) => (entry.ok ? [] : [<li key={entry.lineId}>{describe(entry.lineId)}: {entry.error}</li>]))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </div>
  );
}
