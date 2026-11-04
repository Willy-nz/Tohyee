"use client";

import { RequireOrganisation } from "@/components/books";
import { EmailTabs } from "@/components/email-settings/tabs";
import { TemplateList } from "@/components/email-settings/templates";
import { Page, PageHeader } from "@/components/ui";

/** Settings › Email › Templates (admins): the subject and message each document type's email starts with. */
export default function EmailTemplatesPage() {
  return (
    <Page>
      <PageHeader title="Email" />
      <EmailTabs current="templates" />
      <RequireOrganisation>{(organisationId) => <TemplateList organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
