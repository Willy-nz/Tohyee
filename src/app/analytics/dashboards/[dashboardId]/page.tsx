"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DashboardView } from "@/components/analytics-dashboards";
import { RequireOrganisation } from "@/components/books";
import { Page } from "@/components/ui";

function DashboardPageInner() {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const search = useSearchParams();
  return (
    <RequireOrganisation>
      {(organisationId) => (
        <DashboardView key={`${organisationId}-${dashboardId}`} organisationId={organisationId} dashboardId={dashboardId} startEditing={search.get("edit") === "1"} />
      )}
    </RequireOrganisation>
  );
}

export default function AnalyticsDashboardPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <DashboardPageInner />
      </Suspense>
    </Page>
  );
}
