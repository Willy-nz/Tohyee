"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { FollowUpsPage } from "@/components/crm-follow-ups";
import { Page, PageHeader } from "@/components/ui";

export default function CrmFollowUpsPage() {
  return (
    <Page>
      <PageHeader title="Follow-ups" description="CRM: rules that make follow-up tasks." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <FollowUpsPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
