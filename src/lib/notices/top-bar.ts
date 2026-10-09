import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { waitingHandover } from "@/lib/organisations/handover";
import { listFailedCollections } from "@/lib/payments/gocardless";
import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import type { OrgTx } from "@/lib/db/org-transaction";

export type TopBarNotice = {
  id: string;
  message: string;
  href: string;
};

/** Non-blocking top-bar notices for the current organisation. */
export async function listTopBarNotices(tx: OrgTx, role: Role | null = null): Promise<TopBarNotice[]> {
  // #208: a server admin is handing this organisation over; owners and admins can cancel it.
  const handover = role && roleAtLeast(role, "admin") ? await waitingHandover(tx.organisationId) : null;
  const handoverNotice: TopBarNotice[] = handover
    ? [{ id: "organisation-handover", message: `A server admin is making ${handover.toEmail} an owner. Check or cancel it.`, href: "/operations/members" }]
    : [];
  return [...handoverNotice, ...(await accountingNotices(tx))];
}

async function accountingNotices(tx: OrgTx): Promise<TopBarNotice[]> {
  // Accounting's notices (bank feeds) aren't shown while it's off (MOD6).
  if (!(await accountingEnabled(tx))) return [];
  const feeds = await tx.query<{ count: string }>(
    `select count(*)::text as count
       from bank_account_settings s
       join accounts a on a.id = s.account_id
      where a.is_active and s.feed_active and s.last_sync_status = 'failed'`,
  );
  const reconnectCount = Number(feeds.rows[0]?.count ?? "0");
  const notices: TopBarNotice[] = [];
  if (reconnectCount > 0) {
    notices.push({
      id: "bank-feeds-reconnect",
      message: reconnectCount === 1 ? "1 bank feed needs reconnecting." : `${reconnectCount} bank feeds need reconnecting.`,
      href: "/operations/bank-accounts",
    });
  }
  // GC6: direct debit collections that failed and haven't been tried again.
  const failedCount = (await listFailedCollections(tx)).length;
  if (failedCount > 0) {
    notices.push({
      id: "gocardless-failed",
      message: failedCount === 1 ? "1 direct debit collection failed." : `${failedCount} direct debit collections failed.`,
      href: "/operations/settings/online-payments",
    });
  }
  return notices;
}
