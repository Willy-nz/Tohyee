"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { ForecastsPage } from "@/components/crm-forecasts";
import { Page, PageHeader } from "@/components/ui";

export default function CrmForecastsPage() {
  return (
    <Page>
      <PageHeader title="Forecasts" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <ForecastsPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
