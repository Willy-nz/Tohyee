"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import type { DashboardVersion } from "@/lib/analytics/dashboard-history";
import type { Dashboard } from "@/lib/analytics/dashboards";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/format";
import styles from "@/components/analytics-dashboards.module.css";

/**
 * A report's edit history (#591, decisions 1414-1415): each saved version,
 * who saved it and how, and what changed. Changes made through an AI are
 * marked. "Put this version back" saves that version again as a new one,
 * so it can be undone the same way.
 */
export function DashboardHistoryCard({
  organisationId,
  dashboardId,
  version,
  unsaved,
  onRestored,
}: {
  organisationId: string;
  dashboardId: string;
  /** The version the report is at now, so the list reloads after each save. */
  version: number;
  unsaved: boolean;
  onRestored: (dashboard: Dashboard) => void;
}) {
  const history = useApiData<{ version: number; versions: DashboardVersion[] }>(`/api/analytics/dashboards/${dashboardId}/history`, { organisationId, at: String(version) });
  const confirm = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function putBack(entry: DashboardVersion) {
    const ok = await confirm(`The report goes back to version ${entry.version} (${entry.change.toLowerCase()}). This is saved as a new version, so you can put today's back the same way.`, {
      title: `Put version ${entry.version} back?`,
      confirmLabel: "Put it back",
    });
    if (!ok) return;
    setBusy(entry.version);
    setMessage(null);
    try {
      const { dashboard } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}/history`, {
        method: "POST",
        body: { organisationId, version: entry.version, expectedVersion: history.data?.version ?? version },
      });
      onRestored(dashboard);
      setMessage({ tone: "success", text: `Version ${entry.version} is back, saved as version ${dashboard.version}.` });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="History" description="Every saved version of this report, newest first, with who saved it. Changes made through an AI are marked.">
      {history.error ? <Notice tone="error">{history.error}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {unsaved ? <Notice tone="info">Save or undo your changes before putting an earlier version back.</Notice> : null}
      {!history.data ? (
        <p className={ui.muted}>Loading…</p>
      ) : history.data.versions.length === 0 ? (
        <Empty>No saved versions yet.</Empty>
      ) : (
        <ol className={styles.historyList}>
          {history.data.versions.map((entry) => (
            <li key={entry.version} className={styles.historyItem}>
              <div>
                <strong>Version {entry.version}</strong>{" "}
                {entry.current ? <Badge tone="blue">Now</Badge> : null} {entry.byAi ? <Badge tone="amber">Made through AI</Badge> : null}
                <div>{entry.change}</div>
                <div className={ui.muted}>
                  {formatDateTime(entry.savedAt)} · {entry.savedByEmail}
                  {entry.savedVia ? ` via ${entry.savedVia}` : ""}
                </div>
              </div>
              {entry.current ? null : (
                <Button size="small" variant="secondary" onClick={() => void putBack(entry)} disabled={unsaved || busy !== null} aria-label={`Put version ${entry.version} back`}>
                  {busy === entry.version ? "Putting back…" : "Put this version back"}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
