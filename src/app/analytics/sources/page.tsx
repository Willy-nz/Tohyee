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
        description="Connect data once, check its fields and reuse it across your reports."
      />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <DataSourcesPage key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
