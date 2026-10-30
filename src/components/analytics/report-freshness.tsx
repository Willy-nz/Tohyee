"use client";

import { useApiData } from "@/components/hooks";
import { Notice } from "@/components/ui";
import type { ReportFreshness, SourceFreshness } from "@/lib/analytics/freshness";
import { formatDate, formatDateTime } from "@/lib/format";
import styles from "./report-freshness.module.css";

/** One source's line: when its data was last loaded and how far it goes (decision 698). */
export function freshnessText(source: SourceFreshness): string {
  const changing = source.mayChangeFrom ? ` Google may still change the days from ${formatDate(source.mayChangeFrom)}.` : "";
  return `${sourceText(source)}${changing}`;
}

function sourceText(source: SourceFreshness): string {
  const through = source.dataThrough ? `, data up to ${formatDate(source.dataThrough)}` : "";
  if (source.running) {
    return source.refreshedAt
      ? `${source.name} is refreshing now; showing the data loaded ${formatDateTime(source.refreshedAt)}${through}.`
      : `${source.name} is loading for the first time.`;
  }
  if (source.failedAt) {
    return source.refreshedAt
      ? `${source.name}: the last refresh failed (${formatDateTime(source.failedAt)}), so this is still the data loaded ${formatDateTime(source.refreshedAt)}${through}. It may be out of date.`
      : `${source.name}: loading failed (${formatDateTime(source.failedAt)}) and no data has loaded yet.`;
  }
  return source.refreshedAt ? `${source.name} refreshed ${formatDateTime(source.refreshedAt)}${through}.` : `${source.name}: when it was last loaded isn't recorded${through}.`;
}

/** Under a report's dates: each source's freshness, failed refreshes as stale, and a note when sources are from different times. */
export function ReportFreshnessLine({ organisationId, dashboardId, version }: { organisationId: string; dashboardId: string; version?: string }) {
  const loaded = useApiData<ReportFreshness>(`/api/analytics/dashboards/${dashboardId}/freshness`, { organisationId, ...(version ? { version } : {}) });
  const freshness = loaded.data;
  // Anything unexpected (an older server, a failed request) shows nothing rather than breaking the report.
  if (!freshness || !Array.isArray(freshness.sources) || freshness.sources.length === 0) return null;
  const stale = freshness.sources.filter((source) => source.failedAt);
  const fine = freshness.sources.filter((source) => !source.failedAt);
  return (
    <div className={styles.freshness}>
      {stale.map((source) => (
        <Notice key={source.name} tone="warning">
          {freshnessText(source)}
        </Notice>
      ))}
      {fine.length ? (
        <p className={styles.line}>
          {fine.map((source) => freshnessText(source)).join(" ")}
          {freshness.mixed ? " These sources were refreshed at different times, so the tiles may not agree with each other." : ""}
        </p>
      ) : null}
    </div>
  );
}
