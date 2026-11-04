"use client";

import { useParams } from "next/navigation";
import { RequireOrganisation } from "@/components/books";
import { EmailTabs } from "@/components/email-settings/tabs";
import { isEmailKind, TemplateEditor } from "@/components/email-settings/templates";
import { Notice, Page, PageHeader } from "@/components/ui";

/** One email template, edited on its own (decision 1395). */
export default function EmailTemplatePage() {
  const { kind } = useParams<{ kind: string }>();
  return (
    <Page>
      <PageHeader title="Email" />
      <EmailTabs current="templates" />
      {isEmailKind(kind) ? (
        <RequireOrganisation>{(organisationId) => <TemplateEditor organisationId={organisationId} kind={kind} />}</RequireOrganisation>
      ) : (
        <Notice tone="error">There&apos;s no email template called {kind}.</Notice>
      )}
    </Page>
  );
}
