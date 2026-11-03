"use client";

import { RequireOrganisation } from "@/components/books";
import { BankFileSettingsView } from "@/components/payroll-p5";
import { Page, PageHeader, Notice } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

/** Settings › Bank files (PBF7): which bank's file format each bank account uses, and its account number. */
export default function BankFilesPage() {
  const workspace = useWorkspace();
  return (
    <Page>
      <PageHeader title="Bank files" />
      <Notice>Bookkeepers can see these; admins change them.</Notice>
      <RequireOrganisation>
        {(organisationId) => <BankFileSettingsView key={organisationId} organisationId={organisationId} canEdit={workspace.can("admin")} />}
      </RequireOrganisation>
    </Page>
  );
}
