"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { ForecastsPage } from "@/components/crm-forecasts";
import { Page, PageHeader } from "@/components/ui";

export default function CrmForecastsPage() {
  return (
    <Page>
      <PageHeader title="Forecasts" description="CRM: what's expected to close each month or quarter, by owner, with Salesforce's forecast categories and quotas." />
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
