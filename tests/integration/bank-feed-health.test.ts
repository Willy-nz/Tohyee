import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { createBankAccount, listBankAccounts } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { listTopBarNotices } from "@/lib/notices/top-bar";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Feed health (#258): a feed that hasn't tried to sync for 2 days has
 * stopped (the server was off, or its job isn't running), which is shown on
 * the account and in the top bar; failed feeds of every provider count as
 * needing reconnecting, not just Akahu's.
 */
describeWithDatabase("bank feed health", () => {
  let server: TestServer;
  let owner: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("feed-health@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("flags feeds that haven't synced for 2 days, and failed feeds of any provider", async () => {
    await createTestOrganisation(owner, "feed-health-co");
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation("feed-health-co", { userId: owner.id, email: owner.email }, work);
    const cheque = await as((tx) => createBankAccount(tx, { code: "1010", name: "Cheque", accountType: "bank" }));
    const savings = await as((tx) => createBankAccount(tx, { code: "1020", name: "Savings", accountType: "bank" }));
    const card = await as((tx) => createBankAccount(tx, { code: "1030", name: "Card", accountType: "credit_card" }));
    // Akahu on Cheque: last synced 3 days ago, fine then. Savings: synced an hour ago.
    await as(async (tx) => {
      const feed = `update bank_account_settings set akahu_account_id = $2, feed_start_date = '2026-01-01', feed_active = true, last_sync_status = 'ok', last_synced_at = now() - $3::interval
                    where account_id = $1`;
      await tx.query(feed, [cheque.id, "acc_cheque", "3 days"]);
      await tx.query(feed, [savings.id, "acc_savings", "1 hour"]);
    });
    // SimpleFIN on the card: it failed an hour ago.
    await as(async (tx) => {
      const connection = await tx.query<{ id: string }>(
        "insert into simplefin_connections (name, access_url_ciphertext, host, sync_minute) values ('SimpleFIN', 'x', 'bridge.simplefin.org', 5) returning id::text",
      );
      await tx.query(
        `insert into simplefin_links (account_id, connection_id, simplefin_account_id, currency_code, start_date, time_zone, active, last_synced_at, last_sync_status)
         values ($1, $2, 'ACT-1', 'NZD', '2026-01-01', 'Pacific/Auckland', true, now() - interval '1 hour', 'failed')`,
        [card.id, connection.rows[0].id],
      );
    });

    const accounts = await as((tx) => listBankAccounts(tx));
    const byCode = new Map(accounts.map((account) => [account.code, account]));
    expect(byCode.get("1010")!.feed).toMatchObject({ active: true, lastSyncStatus: "ok", stale: true });
    expect(byCode.get("1020")!.feed).toMatchObject({ active: true, stale: false });
    expect(byCode.get("1030")!.simplefin).toMatchObject({ lastSyncStatus: "failed", stale: false });

    const notices = await as((tx) => listTopBarNotices(tx));
    expect(notices).toEqual(
      expect.arrayContaining([
        { id: "bank-feeds-reconnect", message: "1 bank feed needs reconnecting.", href: "/operations/bank-accounts" },
        { id: "bank-feeds-stale", message: "1 bank feed hasn't synced for 2 days.", href: "/operations/bank-accounts" },
      ]),
    );

    // A feed turned off, or an archived account, isn't counted.
    await as((tx) => tx.query("update bank_account_settings set feed_active = false where account_id = $1", [cheque.id]));
    expect((await as((tx) => listTopBarNotices(tx))).map((notice) => notice.id)).not.toContain("bank-feeds-stale");
  });
});
