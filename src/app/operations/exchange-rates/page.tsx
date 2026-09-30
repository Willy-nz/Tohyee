"use client";

import { RequireOrganisation } from "@/components/books";
import { ExchangeRatesManager } from "@/components/exchange-rates";
import { Page, PageHeader } from "@/components/ui";

export default function ExchangeRatesPage() {
  return (
    <Page>
      <PageHeader
        title="Exchange rates"
        description="Rates for each foreign currency and the date each takes effect, like NetSuite's Currency Exchange Rates. Kept, never deleted."
      />
      <RequireOrganisation>{(organisationId) => <ExchangeRatesManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
