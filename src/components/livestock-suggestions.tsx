"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import { findClass, KIND_NAMES, type LivestockKind } from "@/lib/livestock/classes";
import type { LivestockSuggestion } from "@/lib/livestock/suggestions";

const TYPE_WORDS: Record<string, string> = {
  birth: "Born",
  purchase: "Bought",
  sale: "Sold",
  death: "Died",
  missing: "Missing",
  found: "Found",
  reclass: "Class change",
  transfer: "Moved",
  arrival: "Arrived (someone else's)",
  departure: "Left (someone else's)",
  rations: "Killed for rations",
};

function describe(movement: Record<string, unknown>): string {
  const kind = String(movement.kind ?? "") as LivestockKind;
  const classCode = String(movement.classCode ?? "");
  const className = findClass(kind, classCode)?.name ?? classCode;
  return `${TYPE_WORDS[String(movement.movementType)] ?? String(movement.movementType)}: ${movement.head ?? "?"} ${KIND_NAMES[kind] ?? kind}, ${className}`;
}

/**
 * Livestock movements the AI found in messy data (AIW8): each waits here
 * until someone accepts it (it's then recorded with every check) or declines
 * it. Nothing is recorded until then.
 */
export function LivestockSuggestions({ organisationId, onAccepted }: { organisationId: string; onAccepted: () => void }) {
  const { can } = useWorkspace();
  const suggestions = useApiData<{ suggestions: LivestockSuggestion[] }>("/api/livestock/suggestions", { organisationId, open: "true" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = suggestions.data?.suggestions ?? [];
  if (open.length === 0) return null;

  async function decide(id: string, decision: "accept" | "decline") {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/livestock/suggestions/${id}`, { method: "POST", body: { organisationId, decision, idempotencyKey: newIdempotencyKey("lvs") } });
      suggestions.reload();
      if (decision === "accept") onAccepted();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={`Suggested by your AI (${open.length})`}
      description="Movements your AI found in files or notes. Nothing is recorded until you accept one; accepting records it like any movement, with the same checks."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Movement</th>
              <th className={ui.num}>Amount</th>
              <th>Where it came from</th>
              {can("bookkeeper") ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {open.map((suggestion) => (
              <tr key={suggestion.id}>
                <td data-label="Date">{typeof suggestion.movement.movementDate === "string" ? formatDate(suggestion.movement.movementDate) : ""}</td>
                <td data-label="Movement">
                  {describe(suggestion.movement)}
                  {suggestion.movement.note ? <div className={ui.muted}>{String(suggestion.movement.note)}</div> : null}
                </td>
                <td data-label="Amount" className={ui.num}>
                  {typeof suggestion.movement.amount === "string" ? <Money value={suggestion.movement.amount} /> : null}
                </td>
                <td data-label="Where it came from" className={ui.muted}>
                  {suggestion.evidence}
                </td>
                {can("bookkeeper") ? (
                  <td>
                    <span className={ui.rowButtons}>
                      <Button size="small" disabled={busy !== null} onClick={() => void decide(suggestion.id, "accept")}>
                        Accept
                      </Button>
                      <Button size="small" variant="secondary" disabled={busy !== null} onClick={() => void decide(suggestion.id, "decline")}>
                        Decline
                      </Button>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
