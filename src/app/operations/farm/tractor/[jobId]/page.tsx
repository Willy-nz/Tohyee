"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { TractorJobReview } from "@/components/tractor";
import { Page, PageHeader } from "@/components/ui";

/** A tractor job on the website (#472 stage 5): its track and estimated worked area, details and exports. */
export default function TractorJobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  return (
    <Page>
      <PageHeader title="Tractor job" />
      <RequireOrganisation>{(organisationId) => <TractorJobReview key={`${organisationId}:${jobId}`} organisationId={organisationId} jobId={jobId} />}</RequireOrganisation>
    </Page>
  );
}
