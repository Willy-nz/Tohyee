import { withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import type { Actor } from "@/lib/db/org-transaction";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { refreshInvoicePayPal, tryEnsurePayPalInvoice } from "@/lib/payments/paypal";
import { refreshInvoicePaymentLink, tryEnsurePaymentLink } from "@/lib/payments/stripe";

/**
 * Before an invoice is emailed or printed by a bookkeeper or admin (PN2,
 * PPN2): makes sure its Stripe link and PayPal invoice exist, best effort.
 * Viewers only see links that are already there.
 */
export async function linkBeforeSending(request: Request, organisationId: unknown, kind: unknown, invoiceId: unknown): Promise<void> {
  if (kind !== "invoice" || invoiceId == null || invoiceId === "") return;
  const found = await withOrganisation(request, organisationId, "viewer", async (_tx, { auth, membership }) => ({
    organisation: membership.organisation,
    actor: { userId: auth.user.id, email: auth.user.email },
    allowed: roleAtLeast(membership.role, "bookkeeper"),
  }));
  if (!found.allowed) return;
  await tryEnsurePaymentLink(found.organisation, found.actor, invoiceId);
  await tryEnsurePayPalInvoice(found.organisation, found.actor, invoiceId);
}

/** After an invoice is voided or paid on its page (PN5, PN10, PPN5, PPN8): links no longer right are switched off at once. */
export async function refreshInvoiceLinks(organisation: OrganisationRecord, actor: Actor, invoiceId: unknown): Promise<void> {
  await refreshInvoicePaymentLink(organisation, actor, invoiceId);
  await refreshInvoicePayPal(organisation, actor, invoiceId);
}
