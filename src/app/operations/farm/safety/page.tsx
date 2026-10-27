"use client";

import { FarmSafetyTab } from "@/components/farm-safety-tab";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmSafetyPage() {
  return (
    <Page>
      <PageHeader title="Safety" />
      <FarmWorkspace tab="safety">{(context) => <FarmSafetyTab {...context} />}</FarmWorkspace>
    </Page>
  );
}
