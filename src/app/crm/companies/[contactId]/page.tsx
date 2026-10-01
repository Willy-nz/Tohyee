"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { CompanyRecordPage } from "@/components/crm-record-page";
import { Page } from "@/components/ui";

export default function CrmCompanyPage() {
  const { contactId } = useParams<{ contactId: string }>();
  return (
    <Page>
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CompanyRecordPage key={`${organisationId}:${contactId}`} organisationId={organisationId} contactId={contactId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
