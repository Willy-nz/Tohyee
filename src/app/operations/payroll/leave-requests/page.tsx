"use client";

import { RequireOrganisation } from "@/components/books";
import { LeaveRequestsPage } from "@/components/payroll-leave-requests";
import { Page, PageHeader } from "@/components/ui";

/**
 * Payroll › Leave requests (HL49-HL51; decision 169). Open to viewers and
 * above: each person sees their own requests, the ones they approve, or
 * everyone's with payroll access. Days and hours only, never pay.
 */
export default function LeaveRequestsRoutePage() {
  return (
    <Page>
      <PageHeader
        title="Leave requests"
        description="Ask for leave, and approve or reject the requests you look after. Approving books the leave, so the next pay run pays it."
      />
      <RequireOrganisation>{(organisationId) => <LeaveRequestsPage key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
