"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { CompanyPage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmCompanyPage() {
  const { contactId } = useParams<{ contactId: string }>();
  return (
    <Page>
      <PageHeader title="Company" />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <CompanyPage key={`${organisationId}:${contactId}`} organisationId={organisationId} contactId={contactId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
