"use client";

import { RequireOrganisation } from "@/components/books";
import { RequireGstRegistered } from "@/components/modules";
import { GstAuditView } from "@/components/reports/gst-audit";
import { Page, PageHeader } from "@/components/ui";

export default function GstAuditPage() {
  return (
    <Page>
      <PageHeader title="GST audit report" />
      <RequireOrganisation>{(organisationId) => (
          <RequireGstRegistered organisationId={organisationId}>
            <GstAuditView key={organisationId} organisationId={organisationId} />
          </RequireGstRegistered>
        )}</RequireOrganisation>
    </Page>
  );
}
