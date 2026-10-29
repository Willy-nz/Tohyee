"use client";

import { FarmToday, FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmTodayPage() {
  return (
    <Page>
      <PageHeader title="Today" />
      <FarmWorkspace>{(context) => <FarmToday {...context} />}</FarmWorkspace>
    </Page>
  );
}
