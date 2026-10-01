"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { OpportunityRecordPage } from "@/components/crm-record-page";
import { Page } from "@/components/ui";

export default function CrmOpportunityPage() {
  const { opportunityId } = useParams<{ opportunityId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <OpportunityRecordPage key={`${organisationId}:${opportunityId}`} organisationId={organisationId} opportunityId={opportunityId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
