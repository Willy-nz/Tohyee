"use client";

import { RequireOrganisation } from "@/components/books";
import { GstAuditView } from "@/components/reports/gst-audit";
import { Page, PageHeader } from "@/components/ui";

export default function GstAuditPage() {
  return (
    <Page>
      <PageHeader title="GST audit report" description="The documents behind each box of the GST return (GST101A), on the organisation's GST basis." />
      <RequireOrganisation>{(organisationId) => <GstAuditView key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
