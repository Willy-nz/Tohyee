"use client";

import { RequireOrganisation } from "@/components/books";
import { AiWorkspace } from "@/components/ai-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function AiWorkspacePage() {
  return (
    <Page>
      <PageHeader title="AI workspace" description="What your own AI keeps and makes in Tohyee: dashboards, its tables, and the files you leave for it." />
      <RequireOrganisation>{(organisationId) => <AiWorkspace key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
