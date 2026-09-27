/**
 * Break-glass admin tasks run on the server itself, straight against the
 * database (no web login needed):
 *
 *   npm run admin -- create-user --email you@example.com --name "Your Name" --server-admin
 *   npm run admin -- set-password --email you@example.com
 *
 * Passwords are read from the TOHYEE_PASSWORD environment variable or asked
 * for interactively, so they don't end up in shell history.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword, validateNewPassword } from "@/lib/auth/password";
import { normaliseEmail, parseDisplayName } from "@/lib/auth/service";
import { closeAllPools } from "@/lib/db/pools";
import { coreQuery } from "@/lib/db/transactions";

function option(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : (args[index + 1] ?? null);
}

async function readPassword(): Promise<string> {
  if (process.env.TOHYEE_PASSWORD) {
    return process.env.TOHYEE_PASSWORD;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question("New password (10+ characters): ");
  } finally {
    rl.close();
  }
}

async function audit(eventType: string, userId: string, details: Record<string, unknown>) {
  await coreQuery(
    `insert into admin_audit_events (event_type, entity_type, entity_id, actor_email, details)
     values ($1, 'user', $2, 'cli', $3::jsonb)`,
    [eventType, userId, JSON.stringify(details)],
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "create-user") {
    const email = normaliseEmail(option(args, "email"));
    const displayName = parseDisplayName(option(args, "name"));
    const isServerAdmin = args.includes("--server-admin");
    const passwordHash = await hashPassword(validateNewPassword(await readPassword()));
    const inserted = await coreQuery<{ id: string }>(
      `insert into users (email, display_name, password_hash, is_server_admin)
       values ($1, $2, $3, $4) returning id`,
      [email, displayName, passwordHash, isServerAdmin],
    );
    await audit("user.created_via_cli", inserted.rows[0].id, { email, isServerAdmin });
    console.log(`Created ${email}${isServerAdmin ? " (server admin)" : ""}.`);
    return;
  }
  if (command === "set-password") {
    const email = normaliseEmail(option(args, "email"));
    const passwordHash = await hashPassword(validateNewPassword(await readPassword()));
    const updated = await coreQuery<{ id: string }>(
      `update users
          set password_hash = $2, password_changed_at = now(), failed_login_count = 0,
              locked_until = null, is_active = true, updated_at = now()
        where email = $1
        returning id`,
      [email, passwordHash],
    );
    const userId = updated.rows[0]?.id;
    if (!userId) {
      throw new Error(`No user with the email ${email}.`);
    }
    await coreQuery("delete from sessions where user_id = $1", [userId]);
    await audit("user.password_set_via_cli", userId, { email });
    console.log(`Password updated for ${email}; their other sessions were signed out.`);
    return;
  }
  console.log(
    "Usage:\n  npm run admin -- create-user --email EMAIL --name NAME [--server-admin]\n  npm run admin -- set-password --email EMAIL",
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
