"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { ImportPaddocks } from "@/components/farming";
import { Page, PageHeader } from "@/components/ui";

function ImportForFarm() {
  const farm = useSearchParams().get("farm");
  return <RequireOrganisation>{(organisationId) => <ImportPaddocks key={organisationId} organisationId={organisationId} farmId={farm} />}</RequireOrganisation>;
}

export default function ImportPaddocksPage() {
  return (
    <Page>
      <PageHeader title="Import paddock shapes" />
      <Suspense fallback={null}>
        <ImportForFarm />
      </Suspense>
    </Page>
  );
}
