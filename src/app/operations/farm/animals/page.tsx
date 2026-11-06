"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { FarmAnimals } from "@/components/farm-animals";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page } from "@/components/ui";

/** The animal register (decisions 1481-1486). `?farm=` opens a farm, `?animal=` an animal. */
function Animals() {
  const params = useSearchParams();
  return <FarmWorkspace title="Animals" linkedFarmId={params.get("farm")}>{(context) => <FarmAnimals {...context} initialAnimal={params.get("animal")} />}</FarmWorkspace>;
}

export default function FarmAnimalsPage() {
  return (
    <Page>
      <Suspense fallback={null}>
        <Animals />
      </Suspense>
    </Page>
  );
}
