"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { CustomReportPage } from "@/components/reports/custom-report";
import { Page } from "@/components/ui";

export default function CustomReportRoute() {
  const { reportId } = useParams<{ reportId: string }>();
  return (
    <Page>
      <RequireOrganisation>{(organisationId) => <CustomReportPage key={reportId} organisationId={organisationId} reportId={reportId} />}</RequireOrganisation>
    </Page>
  );
}
