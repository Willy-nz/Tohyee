import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { waitingHandover } from "@/lib/organisations/handover";
import { listFailedCollections } from "@/lib/payments/gocardless";
import { accountingEnabled } from "@/lib/organisations/accounting-switch";
import type { OrgTx } from "@/lib/db/org-transaction";
import { STALE_FEED_HOURS } from "@/lib/bank/accounts";

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
  // Every feed provider: failed ones need new logins or tokens; ones that haven't tried for 2 days have stopped (#258).
  const feeds = await tx.query<{ failed: string; stale: string }>(
    `with feeds as (
       select s.last_sync_status as status, s.last_synced_at as at from bank_account_settings s join accounts a on a.id = s.account_id where a.is_active and s.feed_active
       union all select l.last_sync_status, l.last_synced_at from simplefin_links l join accounts a on a.id = l.account_id where a.is_active and l.active
       union all select l.last_sync_status, l.last_synced_at from stripe_links l join accounts a on a.id = l.account_id where a.is_active and l.active
       union all select l.last_sync_status, l.last_synced_at from paypal_links l join accounts a on a.id = l.account_id where a.is_active and l.active
       union all select l.last_sync_status, l.last_synced_at from wise_links l join accounts a on a.id = l.account_id where a.is_active and l.active
     )
     select count(*) filter (where status = 'failed')::text as failed,
            count(*) filter (where status <> 'failed' and at < now() - make_interval(hours => $1))::text as stale
       from feeds`,
    [STALE_FEED_HOURS],
  );
  const reconnectCount = Number(feeds.rows[0]?.failed ?? "0");
  const staleCount = Number(feeds.rows[0]?.stale ?? "0");
  const notices: TopBarNotice[] = [];
  if (reconnectCount > 0) {
    notices.push({
      id: "bank-feeds-reconnect",
      message: reconnectCount === 1 ? "1 bank feed needs reconnecting." : `${reconnectCount} bank feeds need reconnecting.`,
      href: "/operations/bank-accounts",
    });
  }
  if (staleCount > 0) {
    notices.push({
      id: "bank-feeds-stale",
      message: staleCount === 1 ? "1 bank feed hasn't synced for 2 days." : `${staleCount} bank feeds haven't synced for 2 days.`,
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
