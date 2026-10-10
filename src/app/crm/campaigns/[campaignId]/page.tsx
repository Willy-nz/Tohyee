"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { CampaignPage } from "@/components/crm-campaigns";
import { Page } from "@/components/ui";

export default function CrmCampaignPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CampaignPage key={`${organisationId}:${campaignId}`} organisationId={organisationId} campaignId={campaignId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
