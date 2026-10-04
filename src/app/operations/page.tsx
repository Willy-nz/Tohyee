"use client";

import { RequireOrganisation } from "@/components/books";
import { HomeTiles } from "@/components/home/home";
import { Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

function Overview({ organisationId }: { organisationId: string }) {
  return (
    <>
      <HomeTiles organisationId={organisationId} />
    </>
  );
}

export default function OperationsPage() {
  const { current } = useWorkspace();
  return (
    <Page>
      <PageHeader
        title={current ? current.displayName : "Welcome to Tohyee"}
        description="Home: your dashboard, this year's monthly net profit, today's to-do list and recent activity."
      />
      <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
