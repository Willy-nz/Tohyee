import type { OrgTx } from "@/lib/db/org-transaction";

export type TopBarNotice = {
  id: string;
  message: string;
  href: string;
};

/** Non-blocking top-bar notices for the current organisation. */
export async function listTopBarNotices(tx: OrgTx): Promise<TopBarNotice[]> {
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
  return notices;
}
