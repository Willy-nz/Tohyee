import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { describeWithDatabase, startTestServer, type TestServer } from "../helpers/test-server";

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

/** Runs `npm run admin -- <args>` against the test core database, with the password in TOHYEE_PASSWORD. */
const admin = (args: string[], password: string) =>
  run(process.execPath, [tsx, "scripts/admin.ts", ...args], {
    env: { ...process.env, TOHYEE_PASSWORD: password },
    timeout: 20_000,
  });

describeWithDatabase("admin CLI", () => {
  let server: TestServer;

  const user = async (email: string) =>
    (
      await coreQuery<{ id: string; password_hash: string; is_server_admin: boolean }>(
        "select id, password_hash, is_server_admin from users where email = $1",
        [email],
      )
    ).rows[0];

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("creates a server admin and resets their password, reading the password from TOHYEE_PASSWORD", async () => {
    const created = await admin(
      ["create-user", "--email", "Rescue@Example.com", "--name", "Rescue Admin", "--server-admin"],
      "first password 123",
    );
    expect(created.stdout.trim()).toBe("Created rescue@example.com (server admin).");
    const before = await user("rescue@example.com");
    expect(before.is_server_admin).toBe(true);
    expect(await verifyPassword("first password 123", before.password_hash)).toBe(true);

    await withCoreTransaction((client) => createSession(client, before.id, { userAgent: "vitest", ipAddress: null }));
    const reset = await admin(["set-password", "--email", "rescue@example.com"], "second password 456");
    expect(reset.stdout.trim()).toBe("Password updated for rescue@example.com; their other sessions were signed out.");
    const after = await user("rescue@example.com");
    expect(await verifyPassword("second password 456", after.password_hash)).toBe(true);
    expect(await verifyPassword("first password 123", after.password_hash)).toBe(false);
    expect((await coreQuery("select 1 from sessions where user_id = $1", [before.id])).rowCount).toBe(0);
    const audit = await coreQuery<{ event_type: string; actor_email: string }>(
      "select event_type, actor_email from admin_audit_events where entity_id = $1 order by id",
      [before.id],
    );
    expect(audit.rows).toEqual([
      { event_type: "user.created_via_cli", actor_email: "cli" },
      { event_type: "user.password_set_via_cli", actor_email: "cli" },
    ]);
  });
});
