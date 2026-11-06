"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import type { MoreMenuItem } from "@/components/more-menu";
import { Button } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { type LayoutBase, lastDayOfMonth } from "@/lib/reports/custom-layout";

/**
 * The standard profit and loss or balance sheet's default layout (decision
 * 1359): whether it has one, "Edit layout" (opens it, or starts one from the
 * standard rows), and switching between it and the standard layout.
 */
export function useReportLayout(organisationId: string, base: LayoutBase) {
  const router = useRouter();
  const { can } = useWorkspace();
  const defaults = useApiData<{
    defaults: Array<{ base: string; reportId: string; title: string }>;
  }>("/api/report-layouts", { organisationId });
  const chosen = defaults.data?.defaults.find((entry) => entry.base === base) ?? null;
  const [standard, setStandard] = useState(false);
  const [key] = useState(() => newIdempotencyKey("edit-layout"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function edit(periodEnd: string) {
    if (chosen) return router.push(`/operations/reports/custom/${chosen.reportId}`);
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ report: { id: string } }>("/api/custom-reports", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          base,
          start: "standard",
          periodEnd: lastDayOfMonth(periodEnd),
        },
      });
      router.push(`/operations/reports/custom/${result.report.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  const active = Boolean(chosen && !standard);
  const more: MoreMenuItem[] = chosen
    ? [
        standard
          ? {
              label: `Show in ${chosen.title}`,
              onSelect: () => setStandard(false),
            }
          : {
              label: "Show the standard layout",
              onSelect: () => setStandard(true),
            },
      ]
    : [];
  const button = (periodEnd: string) =>
    can("bookkeeper") ? (
      <Button variant="secondary" disabled={busy || !defaults.data} onClick={() => void edit(periodEnd)}>
        Edit layout
      </Button>
    ) : null;
  return {
    chosen,
    active,
    more,
    button,
    error,
    loaded: Boolean(defaults.data),
  };
}
