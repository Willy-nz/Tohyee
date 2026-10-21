"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { FarmingHome } from "@/components/farming";
import { Page, PageHeader } from "@/components/ui";

/** `?farm=` opens a particular farm, e.g. from Home. */
function ForFarm() {
  const farm = useSearchParams().get("farm");
  return <RequireOrganisation>{(organisationId) => <FarmingHome key={`${organisationId}:${farm ?? ""}`} organisationId={organisationId} farmId={farm} />}</RequireOrganisation>;
}

export default function FarmingPage() {
  return (
    <Page>
      <PageHeader title="Farms and paddocks" description="Your paddocks, their areas and boundaries, and where each came from." />
      <Suspense fallback={null}>
        <ForFarm />
      </Suspense>
    </Page>
  );
}
