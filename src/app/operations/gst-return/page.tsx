"use client";

import { RequireOrganisation } from "@/components/books";
import { GstReturnReport } from "@/components/reports/gst-return";
import { Page, PageHeader } from "@/components/ui";

/**
 * The GST return. It opens for any organisation: for a period with no GST
 * registration the report says so instead of showing boxes (#577, GSR11),
 * the same answer the AI's gst_return tool gives.
 */
export default function GstReturnPage() {
  return (
    <Page>
      <PageHeader title="GST return" />
      <RequireOrganisation>{(organisationId) => <GstReturnReport key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
