"use client";

import { useApiData } from "@/components/hooks";
import { Badge, Notice } from "@/components/ui";
import type { Contact } from "@/lib/contacts/service";
import type { OrganisationSettings } from "@/lib/organisations/settings";
import type { TaxCode } from "@/lib/tax/codes";
import { type ExportContact, type ExportSettings, exportLabel, exportWarning } from "@/lib/tax/exports";

/** The organisation's Foreign trade setting and tax code for exports (EX3, EX4). */
export function useExportSettings(organisationId: string) {
  const settings = useApiData<{ settings: OrganisationSettings }>(`/api/organisations/${organisationId}/settings`);
  const data: ExportSettings | null = settings.data
    ? { foreignTrade: settings.data.settings.foreignTrade, exportTaxCode: settings.data.settings.exportTaxCode }
    : null;
  return { data, error: settings.error };
}

/** "Export (Australia)" beside an overseas customer (EX12). */
export function ExportBadge({ contact }: { contact: ExportContact | null | undefined }) {
  const label = exportLabel(contact);
  return label ? (
    <span style={{ display: "block", marginTop: 4 }}>
      <Badge tone="blue">{label}</Badge>
    </span>
  ) : null;
}

/**
 * The gentle warning when Foreign trade is on and an overseas customer's line
 * is standard-rated (EX12). Never a block: a service consumed in New Zealand
 * can be standard-rated.
 */
export function ExportWarning({
  contact,
  settings,
  lineTaxCodes,
  taxCodes,
  editable = true,
}: {
  contact: ExportContact | null | undefined;
  settings: ExportSettings | null | undefined;
  lineTaxCodes: ReadonlyArray<string | null>;
  taxCodes: ReadonlyArray<TaxCode>;
  /** False on an approved or finalised document: the warning only shows where lines can change (EX25). */
  editable?: boolean;
}) {
  const warning = exportWarning(contact, settings, lineTaxCodes, taxCodes, { editable });
  return warning ? <Notice tone="warning">{warning} Check the tax codes (a service used in New Zealand can still be standard-rated).</Notice> : null;
}

/**
 * The badge on a saved sales document's page (EX12), and the warning while
 * its lines can still be changed (a draft; EX25), loading the contact, the
 * settings and the tax codes.
 */
export function DocumentExportFlags({
  organisationId,
  contactId,
  lineTaxCodes,
  editable,
}: {
  organisationId: string;
  contactId: string;
  lineTaxCodes: ReadonlyArray<string | null>;
  /** Whether the document's lines can still be changed. */
  editable: boolean;
}) {
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId, includeArchived: "true" });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const settings = useExportSettings(organisationId);
  const contact = contacts.data?.contacts.find((entry) => entry.id === contactId);
  if (!contact) return null;
  return (
    <>
      <ExportBadge contact={contact} />
      <ExportWarning
        contact={contact}
        settings={settings.data}
        lineTaxCodes={lineTaxCodes}
        taxCodes={taxCodes.data?.taxCodes ?? []}
        editable={editable}
      />
    </>
  );
}
