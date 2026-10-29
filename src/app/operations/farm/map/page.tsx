"use client";

import { FarmMapTab, FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmMapPage() {
  return (
    <Page>
      <PageHeader title="Map" />
      <FarmWorkspace>{(context) => <FarmMapTab {...context} />}</FarmWorkspace>
    </Page>
  );
}
