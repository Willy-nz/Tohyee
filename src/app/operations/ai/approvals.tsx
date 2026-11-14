"use client";

import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { AiActionRequest } from "@/lib/ai/action-approvals";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";

type Requests = { waiting: AiActionRequest[]; decided: AiActionRequest[] };

/** A preview's simple values as "name: value" lines; anything nested is left to the record itself. */
function previewLines(preview: unknown): Array<[string, string]> {
  if (!preview || typeof preview !== "object") return [];
  const flat = (value: unknown): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value);
  const lines: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(preview as Record<string, unknown>)) {
    if (flat(value)) lines.push([name, String(value)]);
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) if (flat(innerValue)) lines.push([inner, String(innerValue)]);
    } else if (Array.isArray(value)) lines.push([name, `${value.length} ${value.length === 1 ? "item" : "items"}`]);
  }
  return lines.slice(0, 14);
}

const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase()).toLowerCase().replace(/^./, (letter) => letter.toUpperCase());

/**
 * #697 (decision 1633): the owner's switch for "a person approves the AI's
 * voids, deletes and roll-backs", and what's waiting for a bookkeeper or
 * higher to approve or decline.
 */
export function AiApprovals({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const settings = useApiData<{ required: boolean }>("/api/ai/action-approval-settings", { organisationId });
  const requests = useApiData<Requests>(can("bookkeeper") ? "/api/ai/action-requests" : null, { organisationId });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!settings.data) return null;
  const waiting = requests.data?.waiting ?? [];
  const decided = requests.data?.decided ?? [];

  async function setRequired(required: boolean) {
    setBusy("setting");
    setError(null);
    setMessage(null);
    try {
      await api("/api/ai/action-approval-settings", { method: "PUT", body: { organisationId, required } });
      setMessage(required ? "From now on a person approves the AI's voids, deletes and roll-backs." : "The AI confirms its own voids, deletes and roll-backs again.");
      settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function decide(request: AiActionRequest, decision: "approve" | "decline") {
    setBusy(request.id);
    setError(null);
    setMessage(null);
    try {
      const answer = await api<{ request: AiActionRequest }>(`/api/ai/action-requests/${request.id}/decide`, { method: "POST", body: { organisationId, decision } });
      if (answer.request.status === "failed") setError(`${request.title}: it couldn't be done as it stood, so nothing was changed. ${answer.request.error ?? ""}`);
      else setMessage(decision === "approve" ? `Done: ${request.title.toLowerCase()}.` : `Declined: ${request.title.toLowerCase()}. Nothing was changed.`);
      requests.reload();
    } catch (caught) {
      setError(errorMessage(caught));
      requests.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Voids, deletes and roll-backs by the AI"
      description="At Full access an AI can void, delete, remove and roll back. It always shows what it will act on first. You can also have a person approve each one here before it happens."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="success">{message}</Notice> : null}
      <label>
        <input type="checkbox" checked={settings.data.required} disabled={!can("owner") || busy === "setting"} onChange={(event) => void setRequired(event.target.checked)} /> A person approves
        the AI&apos;s voids, deletes and roll-backs
      </label>
      {!can("owner") ? <p className={ui.muted}>An owner turns this on or off.</p> : null}
      {can("bookkeeper") && waiting.length ? (
        <>
          <h3 className={ui.cardTitle}>Waiting for a person</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
            {waiting.map((request) => (
              <li key={request.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <strong>{request.title}</strong>{" "}
                <span className={ui.muted}>
                  · asked {formatDateTime(request.createdAt)} by {request.requestedByEmail} through {request.via}
                </span>
                <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 12px", margin: "8px 0" }}>
                  {previewLines(request.preview).map(([name, value], index) => (
                    <div key={index} style={{ display: "contents" }}>
                      <dt className={ui.muted}>{words(name)}</dt>
                      <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
                    </div>
                  ))}
                </dl>
                <Button size="small" onClick={() => void decide(request, "approve")} disabled={busy !== null}>
                  {busy === request.id ? "Working…" : "Approve and do it"}
                </Button>{" "}
                <Button size="small" variant="secondary" onClick={() => void decide(request, "decline")} disabled={busy !== null}>
                  Decline
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {can("bookkeeper") && decided.length ? (
        <details>
          <summary>Decided lately</summary>
          <ul>
            {decided.map((request) => (
              <li key={request.id}>
                {request.title}{" "}
                <Badge tone={request.status === "approved" ? "green" : request.status === "declined" ? "neutral" : "red"}>
                  {request.status === "approved" ? "Approved" : request.status === "declined" ? "Declined" : "Couldn't be done"}
                </Badge>{" "}
                <span className={ui.muted}>
                  {request.decidedAt ? formatDateTime(request.decidedAt) : ""} · {request.decidedByEmail}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
