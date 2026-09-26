import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { SessionUser } from "@/lib/auth/sessions";
import { migrateEverything } from "@/lib/db/migrations";
import type { Actor } from "@/lib/db/org-transaction";
import { postJournal } from "@/lib/ledger/journals";
import {
  createTestLogin,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  dropTestLogin,
  inOrganisation,
  key,
  startTestServer,
  testDatabaseUrl,
  type TestServer,
  withDb,
  withLogin,
} from "../helpers/test-server";

const ORG = "hardened-co";

async function asLogin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/**
 * docs/ARCHITECTURE.md, "Database logins": with DATABASE_ADMIN_URL set, the
 * runtime login gets data access only.
 */
describeWithDatabase("separate admin and runtime logins (DATABASE_ADMIN_URL)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let actor: Actor;
  let databaseName = "";

  beforeAll(async () => {
    server = await startTestServer({ separateRuntimeLogin: true });
    owner = await createTestUser("hardened@example.com", { serverAdmin: true });
    actor = { userId: owner.id, email: owner.email };
    databaseName = (await createTestOrganisation(owner, ORG)).databaseName;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("the app works day to day as the runtime login", async () => {
    const result = await inOrganisation(ORG, actor, (tx) =>
      postJournal(tx, {
        idempotencyKey: key("j"),
        postingDate: "2026-06-15",
        reference: "HARD-1",
        lines: [
          { accountCode: "1000", debitAmount: "50.00" },
          { accountCode: "4000", creditAmount: "50.00" },
        ],
      }),
    );
    expect(result.created).toBe(true);

    // Migrations run again on every server start; that must keep access intact.
    const rerun = await migrateEverything();
    expect(rerun.organisations.find((organisation) => organisation.organisationId === ORG)?.ok).toBe(true);
    const listed = await inOrganisation(ORG, actor, (tx) =>
      tx.query<{ count: string }>("select count(*)::text as count from ledger_journals"),
    );
    expect(listed.rows[0].count).toBe("1");
  });

  it("the runtime login can't change the schema or rewrite posted history", async () => {
    const runtimeUrl = withDb(process.env.DATABASE_URL!, databaseName);
    await asLogin(runtimeUrl, async (client) => {
      const whoAmI = await client.query<{ current_user: string }>("select current_user");
      expect(whoAmI.rows[0].current_user).toBe(server.runtimeLogin!.role);

      for (const sql of [
        "create table sneaky (id int)",
        "alter table accounts add column sneaky int",
        "update ledger_journals set reference = 'changed'",
        "delete from ledger_journal_lines",
        "truncate audit_events",
        "insert into schema_migrations (version, name, checksum) values ('999', 'x', 'x')",
      ]) {
        const error = await client.query(sql).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(pgCode(error), sql).toBe("42501"); // insufficient_privilege
      }
    });
  });

  it("other logins on the same PostgreSQL server can't connect to an organisation's database", async () => {
    const outsider = await createTestLogin("toeyee_outsider");
    try {
      const error = await asLogin(
        withLogin(withDb(testDatabaseUrl!, databaseName), outsider.role, outsider.password),
        async () => null,
      ).catch((caught: unknown) => caught);
      expect(pgCode(error)).toBe("42501");
    } finally {
      await dropTestLogin(outsider.role);
    }
  });
});
