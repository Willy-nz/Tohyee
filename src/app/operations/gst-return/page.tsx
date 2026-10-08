"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireGstRegistered } from "@/components/modules";
import { GstReturnReport } from "@/components/reports/gst-return";
import { Page, PageHeader } from "@/components/ui";

export default function GstReturnPage() {
  return (
    <Page>
      <PageHeader
        title="GST return"
        description="NZ GST101A (boxes 5-15), worked out from your documents on the organisation's GST basis."
      />
      <RequireOrganisation>{(organisationId) => (
          <RequireGstRegistered organisationId={organisationId}>
            <GstReturnReport key={organisationId} organisationId={organisationId} />
          </RequireGstRegistered>
        )}</RequireOrganisation>
    </Page>
  );
}
