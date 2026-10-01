"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { RdActivityView } from "@/components/rd";
import { Page, PageHeader } from "@/components/ui";

export default function RdActivityPage() {
  const { activityId } = useParams<{ activityId: string }>();
  return (
    <Page>
      <PageHeader title="R&D activity" />
      <RequireOrganisation>{(organisationId) => <RdActivityView key={organisationId} organisationId={organisationId} activityId={activityId} />}</RequireOrganisation>
    </Page>
  );
}
