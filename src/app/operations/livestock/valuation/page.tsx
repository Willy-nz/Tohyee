"use client";

import { RequireOrganisation } from "@/components/books";
import { LivestockValuation } from "@/components/livestock";
import { Page, PageHeader } from "@/components/ui";

export default function LivestockValuationPage() {
  return (
    <Page>
      <PageHeader title="Livestock valuation" />
      <RequireOrganisation>{(organisationId) => <LivestockValuation key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
