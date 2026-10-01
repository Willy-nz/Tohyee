"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { PersonRecordPage } from "@/components/crm-record-page";
import { Page } from "@/components/ui";

export default function CrmPersonPage() {
  const { personId } = useParams<{ personId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <PersonRecordPage key={`${organisationId}:${personId}`} organisationId={organisationId} personId={personId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
