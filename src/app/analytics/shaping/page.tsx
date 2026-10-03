"use client";

import { Suspense } from "react";
import { AnalyticsShapingPage } from "@/components/analytics-shaping";
import { RequireOrganisation } from "@/components/books";
import { Page, PageHeader } from "@/components/ui";

export default function ShapingPage() {
  return (
    <Page>
      <PageHeader title="Shaping" description="Apply safe, repeatable steps to loaded tables and preview the result before it is rebuilt." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <AnalyticsShapingPage key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
