"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { SoilHome } from "@/components/soil";
import { Page, PageHeader } from "@/components/ui";

/** `?farm=` opens a particular farm, e.g. from Home. */
function ForFarm() {
  const farm = useSearchParams().get("farm");
  return <RequireOrganisation>{(organisationId) => <SoilHome key={`${organisationId}:${farm ?? ""}`} organisationId={organisationId} farmId={farm} />}</RequireOrganisation>;
}

export default function SoilTestsPage() {
  return (
    <Page>
      <PageHeader title="Soil tests" description="Each paddock's soil tests as the lab reported them, with the lab's report attached." />
      <Suspense fallback={null}>
        <ForFarm />
      </Suspense>
    </Page>
  );
}
