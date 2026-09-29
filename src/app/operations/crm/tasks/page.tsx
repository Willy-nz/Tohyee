"use client";

import { RequireOrganisation } from "@/components/books";
import { TasksPage, RequireCrm } from "@/components/crm";
import { Page, PageHeader } from "@/components/ui";

export default function CrmTasksPage() {
  return (
    <Page>
      <PageHeader title="Tasks" description="CRM: what needs doing, and by whom." />
      <RequireOrganisation>
        {(organisationId) => (
          <RequireCrm organisationId={organisationId}>
            <TasksPage key={organisationId} organisationId={organisationId} />
          </RequireCrm>
        )}
      </RequireOrganisation>
    </Page>
  );
}
