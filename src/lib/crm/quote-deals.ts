import { writeAuditEvent } from "@/lib/audit";
import { getOpportunity, updateOpportunity } from "@/lib/crm/service";
import { listStages, salesProcessOf } from "@/lib/crm/stages";
import { crmEnabled } from "@/lib/crm/switch";
import type { OrgTx } from "@/lib/db/org-transaction";

/**
 * When a quote made from a deal is accepted (DS9, decision 502): the deal
 * moves to the first active Closed won stage of its sales process and the
 * invoice or sales order is linked to it, so the deal can't make another.
 * Accepting the quote never fails because of the deal: with the CRM off, a
 * deal that already has an invoice or order, or no won stage to move to,
 * the quote is accepted and the deal is left as it is (its history says why).
 */
export async function winDealFromQuote(tx: OrgTx, quoteId: string, made: { invoiceId?: string; salesOrderId?: string }): Promise<void> {
  const link = (await tx.query<{ opportunity_id: string | null }>("select opportunity_id::text from quotes where id = $1", [quoteId])).rows[0];
  if (!link?.opportunity_id) return;
  if (!(await crmEnabled(tx))) return;
  await tx.query("select id from crm_opportunities where id = $1 for update", [link.opportunity_id]);
  const deal = await getOpportunity(tx, link.opportunity_id);
  const leave = async (reason: string) =>
    writeAuditEvent(tx, { eventType: "crm.quote_accepted_deal_left", entityType: "crm_opportunity", entityId: deal.id, details: { quoteId, reason, ...made } });
  if (deal.invoiceId || deal.salesOrderId) return leave("The deal already has an invoice or sales order.");
  if (deal.stageType !== "won") {
    const process = await salesProcessOf(tx, deal.recordTypeId);
    const won = (await listStages(tx)).find((stage) => stage.isActive && stage.type === "won" && (process.stageKeys === null || process.stageKeys.includes(stage.key)));
    if (!won) return leave(`There's no active Closed won stage in the ${process.name} sales process.`);
    // A deal its page layout won't let move (a required field missing, say) is left; the quote is still accepted.
    await tx.query("savepoint win_deal");
    try {
      await updateOpportunity(tx, deal.id, { stage: won.key }, { fromLines: true });
      await tx.query("release savepoint win_deal");
    } catch (error) {
      await tx.query("rollback to savepoint win_deal");
      return leave(`The deal couldn't move to ${won.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (made.invoiceId) await tx.query("update crm_opportunities set invoice_id = $2, updated_at = now() where id = $1", [deal.id, made.invoiceId]);
  if (made.salesOrderId) await tx.query("update crm_opportunities set sales_order_id = $2, updated_at = now() where id = $1", [deal.id, made.salesOrderId]);
  await writeAuditEvent(tx, { eventType: "crm.opportunity_won_from_quote", entityType: "crm_opportunity", entityId: deal.id, details: { quoteId, ...made } });
}
