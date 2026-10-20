"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { MyMailHome } from "@/components/my-mail";
import { Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function MyMailPage() {
  const { current } = useWorkspace();
  return (
    <Page>
      <PageHeader title="My mail" description="A private copy of your own email, for you and your AI. Only you can see it." />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <MyMailHome key={organisationId} organisationId={organisationId} isOwner={current?.role === "owner"} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
