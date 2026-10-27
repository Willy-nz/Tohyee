"use client";

import { FarmToday, FarmWorkspace } from "@/components/farm-workspace";
import { Page, PageHeader } from "@/components/ui";

export default function FarmTodayPage() {
  return (
    <Page>
      <PageHeader title="Today" />
      <FarmWorkspace tab="today">{(context) => <FarmToday {...context} />}</FarmWorkspace>
    </Page>
  );
}
