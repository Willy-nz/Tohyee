import type { OrgTx } from "@/lib/db/org-transaction";
import type { TaxCategory } from "@/lib/tax/categories";
import { contactSalesTaxCode } from "@/lib/tax/exports";

/**
 * The server's copy of the sales editors' starting tax code (EX15), for
 * invoices Tohyee makes itself (a won CRM opportunity's): the contact's own
 * default sales tax code, else the tax code for exports for an overseas
 * contact with Foreign trade on. Null means the usual default applies.
 */
export async function contactSalesTaxCodeFor(tx: OrgTx, contactId: string): Promise<string | null> {
  const contact = await tx.query<{ billing_country: string; delivery_country: string | null; default_sales_tax_code: string | null }>(
    `select billing_country, delivery_country, (select t.code from tax_codes t where t.id = c.default_sales_tax_code_id) as default_sales_tax_code
       from contacts c where c.id = $1`,
    [contactId],
  );
  const row = contact.rows[0];
  if (!row) return null;
  const settings = await tx.query<{ foreign_trade: boolean; export_tax_code: string | null }>(
    `select foreign_trade, (select t.code from tax_codes t where t.id = export_tax_code_id) as export_tax_code
       from organisation_settings where id = true`,
  );
  const codes = await tx.query<{ code: string; category: TaxCategory; is_active: boolean }>("select code, category, is_active from tax_codes");
  return contactSalesTaxCode(
    { billingCountry: row.billing_country, deliveryCountry: row.delivery_country, defaultSalesTaxCode: row.default_sales_tax_code },
    { foreignTrade: settings.rows[0]?.foreign_trade ?? false, exportTaxCode: settings.rows[0]?.export_tax_code ?? null },
    codes.rows.map((code) => ({ code: code.code, category: code.category, isActive: code.is_active })),
  );
}
