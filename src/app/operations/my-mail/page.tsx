"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { MyMailHome } from "@/components/my-mail";
import { Page, PageHeader, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function MyMailPage() {
  const { current } = useWorkspace();
  return (
    <Page>
      <PageHeader title="My mail" />
      <Notice>Private: only you can see your mail.</Notice>
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <MyMailHome key={organisationId} organisationId={organisationId} isOwner={current?.role === "owner"} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
