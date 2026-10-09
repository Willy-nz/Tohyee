"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { LeadRecordPage } from "@/components/crm-leads";
import { Page } from "@/components/ui";

export default function CrmLeadPage() {
  const { leadId } = useParams<{ leadId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <LeadRecordPage key={`${organisationId}:${leadId}`} organisationId={organisationId} leadId={leadId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
