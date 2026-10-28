"use client";

import { RequireOrganisation } from "@/components/books";
import { FarmOfflinePage } from "@/components/farm-offline";
import { Page, PageHeader } from "@/components/ui";

/** Offline on this device (#472 stage 3): what's kept, when, how big, extras and removal. */
export default function FarmOfflineRoute() {
  return (
    <Page>
      <PageHeader title="Offline on this device" />
      <RequireOrganisation>{(organisationId) => <FarmOfflinePage organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
