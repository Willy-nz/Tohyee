"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { RequireCrm } from "@/components/crm";
import { MailPage } from "@/components/crm-mail";
import { Page, PageHeader } from "@/components/ui";

export default function CrmMailPage() {
  return (
    <Page>
      <PageHeader title="Email and calendar" description="CRM: emails and meetings with the people and companies you know, on their timelines." />
      <Suspense fallback={null}>
        <RequireOrganisation>
          {(organisationId) => (
            <RequireCrm organisationId={organisationId}>
              <MailPage key={organisationId} organisationId={organisationId} />
            </RequireCrm>
          )}
        </RequireOrganisation>
      </Suspense>
    </Page>
  );
}
