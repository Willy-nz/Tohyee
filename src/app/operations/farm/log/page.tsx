"use client";

import { FarmLog } from "@/components/farm-log";
import { FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmLogPage() {
  return (
    <Page>
      <PageHeader title="Log" />
      <FarmWorkspace tab="log">{(context) => <FarmLog {...context} />}</FarmWorkspace>
    </Page>
  );
}
