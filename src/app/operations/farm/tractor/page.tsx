"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmWorkspace } from "@/components/farm-workspace";
import { TractorHome } from "@/components/tractor";
import { Page, PageHeader } from "@/components/ui";

/** Tractor and spreader mode (#472 stage 5): start a job, carry one on, send what's waiting, and the farm's jobs. `?farm=` chooses the farm. */
function TractorForLink() {
  const farmId = useSearchParams().get("farm");
  return <FarmWorkspace linkedFarmId={farmId && /^\d+$/.test(farmId) ? farmId : null}>{(context) => <TractorHome {...context} />}</FarmWorkspace>;
}

export default function TractorPage() {
  return (
    <Page>
      <PageHeader title="Tractor mode" />
      <Suspense fallback={null}>
        <TractorForLink />
      </Suspense>
    </Page>
  );
}
