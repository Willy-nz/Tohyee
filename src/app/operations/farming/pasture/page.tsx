"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { PastureHome } from "@/components/pasture";
import { Page, PageHeader } from "@/components/ui";

/** `?farm=` opens a particular farm, e.g. from Home. */
function ForFarm() {
  const farm = useSearchParams().get("farm");
  return <RequireOrganisation>{(organisationId) => <PastureHome key={`${organisationId}:${farm ?? ""}`} organisationId={organisationId} farmId={farm} />}</RequireOrganisation>;
}

export default function PasturePage() {
  return (
    <Page>
      <PageHeader title="Pasture and feed" description="Cover readings, each paddock's growth, grazings and supplements fed. Records only: no feed plan or targets." />
      <Suspense fallback={null}>
        <ForFarm />
      </Suspense>
    </Page>
  );
}
