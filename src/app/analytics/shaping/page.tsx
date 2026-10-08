"use client";

import { AnalyticsNavigation } from "@/components/analytics/studio";
import { Suspense } from "react";
import { AnalyticsShapingPage } from "@/components/analytics-shaping";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function ShapingPage() {
  return (
    <Page>
      <PageHeader title="Prepare data" description="Apply safe, repeatable steps to loaded tables and preview the result before it is rebuilt." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <><AnalyticsNavigation active="shaping" /><AnalyticsShapingPage key={organisationId} organisationId={organisationId} /></>}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
