"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { VisitView } from "@/components/jobs";
import { Page, PageHeader } from "@/components/ui";

export default function VisitPage() {
  const { visitId } = useParams<{ visitId: string }>();
  return (
    <Page>
      <PageHeader title="Visit" />
      <RequireOrganisation>{(organisationId) => <VisitView key={`${organisationId}:${visitId}`} organisationId={organisationId} visitId={visitId} />}</RequireOrganisation>
    </Page>
  );
}
