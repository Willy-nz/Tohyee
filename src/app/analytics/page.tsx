"use client";

import { Suspense } from "react";
import { DashboardsList } from "@/components/analytics-dashboards";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function AnalyticsDashboardsPage() {
  return (
    <Page>
      <PageHeader title="Reports" description="Charts, tables and key figures from your connected data, with date ranges and filters." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <DashboardsList key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
