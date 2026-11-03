"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MoreMenuItem } from "@/components/more-menu";
import { Button, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { CUSTOM_REPORT_BASES, type TransactionReportBase, type TransactionReportFilters, TRANSACTION_REPORT_DEFAULT_COLUMNS } from "@/lib/reports/custom-layout";
import type { CustomReport } from "@/lib/reports/custom";

/**
 * "Save as custom report" for a transaction report: a draft custom report
 * with these filters, opened for editing. As a "⋯" menu item (decision 1352)
 * or a button; null for people who can't make reports.
 */
export function useSaveAsCustomReport(organisationId: string, base: TransactionReportBase, filters: TransactionReportFilters) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [key] = useState(() => newIdempotencyKey("custom-report"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const periodEnd = filters.asAt ?? filters.to ?? todayInBrowser();
      const result = await api<{ report: CustomReport }>("/api/custom-reports", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          base,
          periodEnd,
          layout: { title: CUSTOM_REPORT_BASES[base], filters, columns: TRANSACTION_REPORT_DEFAULT_COLUMNS[base] },
        },
      });
      router.push(`/operations/reports/custom/${result.report.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  const item: MoreMenuItem | null = can("bookkeeper") ? { label: busy ? "Saving…" : "Save as custom report", disabled: busy, onSelect: () => void save() } : null;
  return { item, busy, error, save, allowed: can("bookkeeper") };
}

export function SaveAsCustomReportButton({
  organisationId,
  base,
  filters,
}: {
  organisationId: string;
  base: TransactionReportBase;
  filters: TransactionReportFilters;
}) {
  const { allowed, busy, error, save } = useSaveAsCustomReport(organisationId, base, filters);
  if (!allowed) return null;
  return (
    <>
      <Button size="small" variant="secondary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save as custom report"}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}
