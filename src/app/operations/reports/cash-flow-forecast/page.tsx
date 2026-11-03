"use client";

import { RequireOrganisation } from "@/components/books";
import { CashFlowForecastView } from "@/components/cash-flow";
import { Page, PageHeader } from "@/components/ui";

/** Reports › Cash flow forecast (CF1-CF9). */
export default function CashFlowForecastPage() {
  return (
    <Page>
      <PageHeader title="Cash flow forecast" />
      <RequireOrganisation>{(organisationId) => <CashFlowForecastView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
