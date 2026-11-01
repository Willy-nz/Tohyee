"use client";

import { InfoTip } from "@/components/info-tip";
import { RequireOrganisation } from "@/components/books";
import { ImportWizard } from "@/components/import";
import { Notice, Page, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";

export default function ImportPage() {
  const { can } = useWorkspace();
  return (
    <Page>
      <PageHeader
        title="Import and export"
        description={
          <>
            Bring in an organisation&apos;s existing books.{" "}
            <InfoTip label="Importing">
              Chart of accounts, contacts, products and services, then the opening balances with open invoices, bills and stock. Each file is checked row by row and imported whole, or not at all.
            </InfoTip>
          </>
        }
      />
      <RequireOrganisation>
        {(organisationId) =>
          can("admin") ? <ImportWizard key={organisationId} organisationId={organisationId} /> : <Notice tone="warning">Only admins and owners can import.</Notice>
        }
      </RequireOrganisation>
    </Page>
  );
}
