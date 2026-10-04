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
      />
      <RequireOrganisation>{(organisationId) => <Overview organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
