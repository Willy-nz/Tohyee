"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { todayInBrowser } from "@/lib/format";
import { CUSTOM_REPORT_BASES, type TransactionReportBase, type TransactionReportFilters, TRANSACTION_REPORT_DEFAULT_COLUMNS } from "@/lib/reports/custom-layout";
import type { CustomReport } from "@/lib/reports/custom";

export function SaveAsCustomReportButton({
  organisationId,
  base,
  filters,
}: {
  organisationId: string;
  base: TransactionReportBase;
  filters: TransactionReportFilters;
}) {
  const router = useRouter();
  const { can } = useWorkspace();
  const [key] = useState(() => newIdempotencyKey("custom-report"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can("bookkeeper")) return null;

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

  return (
    <>
      <Button size="small" variant="secondary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save as custom report"}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}
