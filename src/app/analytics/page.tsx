"use client";

import { Suspense } from "react";
import { DataSourcesPage } from "@/components/analytics-sources";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function AnalyticsPage() {
  return (
    <Page>
      <PageHeader
        title="Data sources"
        description="Files from this organisation's folder on the server, loaded every night after 4am, ready for reports and dashboards."
      />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <DataSourcesPage key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
