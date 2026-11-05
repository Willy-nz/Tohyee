"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmMobs } from "@/components/farm-mobs";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** The farm's mobs (decisions 1421-1430). `?farm=` opens a particular farm. */
function Mobs() {
  const farm = useSearchParams().get("farm");
  return <FarmWorkspace title="Mobs" linkedFarmId={farm}>{(context) => <FarmMobs {...context} />}</FarmWorkspace>;
}

export default function FarmMobsPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <Mobs />
      </Suspense>
    </Page>
  );
}
