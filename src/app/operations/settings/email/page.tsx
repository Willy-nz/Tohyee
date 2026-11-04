"use client";

import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { EmailAccount } from "@/components/email-settings/account";
import { EmailTabs } from "@/components/email-settings/tabs";
import { Page, PageHeader } from "@/components/ui";

/**
 * Settings › Email › Account (admins): the organisation's own email account,
 * which invoices, quotes, credit notes, purchase orders and statements are
 * sent from. The templates are on their own tab (decision 1391).
 */
export default function EmailSettingsPage() {
  return (
    <Page>
      <PageHeader title="Email" />
      <EmailTabs current="account" />
      <Suspense fallback={null}>
        <RequireOrganisation>{(organisationId) => <EmailAccount organisationId={organisationId} />}</RequireOrganisation>
      </Suspense>
    </Page>
  );
}
