"use client";

import { FarmMore, FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmMorePage() {
  return (
    <Page>
      <PageHeader title="More" />
      <FarmWorkspace>{(context) => <FarmMore {...context} />}</FarmWorkspace>
    </Page>
  );
}
