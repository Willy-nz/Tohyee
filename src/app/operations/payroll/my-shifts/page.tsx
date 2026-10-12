"use client";

import { RequireOrganisation } from "@/components/books";
import { MyShifts } from "@/components/rosters";
import { Page, PageHeader } from "@/components/ui";

export default function MyShiftsPage() {
  return (
    <Page>
      <PageHeader title="My shifts" description="Your published shifts, and when you can't work." />
      <RequireOrganisation>{(organisationId) => <MyShifts key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
