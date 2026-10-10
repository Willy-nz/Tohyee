"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { EmailTemplatesPage } from "@/components/crm-email-templates";
import { Page, PageHeader } from "@/components/ui";

export default function CrmEmailTemplatesPage() {
  return (
    <Page>
      <PageHeader title="Email templates" description="CRM: starting points for sales emails." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <EmailTemplatesPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
