"use client";

import { RequireOrganisation } from "@/components/books";
import { AiWorkspace } from "@/components/ai-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function AiWorkspacePage() {
  return (
    <Page>
      <PageHeader title="AI workspace" />
      <RequireOrganisation>{(organisationId) => <AiWorkspace key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
