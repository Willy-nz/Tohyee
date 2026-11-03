"use client";

import { RequireOrganisation } from "@/components/books";
import { ImportWizard } from "@/components/import";
import { Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function ImportPage() {
  const { can } = useWorkspace();
  return (
    <Page>
      <PageHeader title="Import and export" />
      <RequireOrganisation>
        {(organisationId) =>
          can("admin") ? <ImportWizard key={organisationId} organisationId={organisationId} /> : <Notice tone="warning">Only admins and owners can import.</Notice>
        }
      </RequireOrganisation>
    </Page>
  );
}
