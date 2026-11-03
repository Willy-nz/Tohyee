"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmWorkspace } from "@/components/farm-workspace";
import { TractorHome } from "@/components/tractor";
import { Page } from "@/components/ui";

/** Tractor and spreader mode (#472 stage 5): start a job, carry one on, send what's waiting, and the farm's jobs. `?farm=` chooses the farm. */
function TractorForLink() {
  const farmId = useSearchParams().get("farm");
  return <FarmWorkspace title="Tractor mode" linkedFarmId={farmId && /^\d+$/.test(farmId) ? farmId : null}>{(context) => <TractorHome {...context} />}</FarmWorkspace>;
}

export default function TractorPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <TractorForLink />
      </Suspense>
    </Page>
  );
}
