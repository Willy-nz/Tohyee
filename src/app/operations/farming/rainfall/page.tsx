"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmRainfall } from "@/components/farm-rainfall";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** Rainfall (decisions 1451-1456): the farm's gauges and their history. `?farm=` opens a farm. */
function RainfallForLink() {
  const farm = useSearchParams().get("farm");
  return <FarmWorkspace title="Rainfall" linkedFarmId={farm}>{(context) => <FarmRainfall {...context} />}</FarmWorkspace>;
}

export default function RainfallPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <RainfallForLink />
      </Suspense>
    </Page>
  );
}
