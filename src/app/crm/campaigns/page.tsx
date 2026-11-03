"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { CampaignsPage } from "@/components/crm-campaigns";
import { Page, PageHeader } from "@/components/ui";

export default function CrmCampaignsPage() {
  return (
    <Page>
      <PageHeader title="Campaigns" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CampaignsPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
