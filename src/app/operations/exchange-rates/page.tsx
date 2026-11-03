"use client";

import { RequireOrganisation } from "@/components/books";
import { ExchangeRatesManager } from "@/components/exchange-rates";
import { Page, PageHeader } from "@/components/ui";

export default function ExchangeRatesPage() {
  return (
    <Page>
      <PageHeader title="Exchange rates" />
      <RequireOrganisation>{(organisationId) => <ExchangeRatesManager key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
