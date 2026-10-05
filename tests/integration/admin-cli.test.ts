import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/sessions";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { createTestUser, describeWithDatabase, startTestServer, type TestServer } from "../helpers/test-server";

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

/** Runs `npm run admin -- <args>` against the test core database, with the password in TOHYEE_PASSWORD. */
const admin = (args: string[], password: string) =>
  run(process.execPath, [tsx, "scripts/admin.ts", ...args], {
    env: { ...process.env, TOHYEE_PASSWORD: password },
    timeout: 20_000,
  });

const SECRET_KEY = "admin-cli-test-key-0123456789abcdefghij";

/** Runs the command-line tool with extra environment variables; resolves with its output and exit code, even when it fails. */
async function cli(args: string[], env: Record<string, string> = {}, program: string[] = [tsx, "scripts/admin.ts"]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [...program, ...args], { env: { ...process.env, TOHYEE_SECRET_KEY: SECRET_KEY, ...env }, timeout: 30_000 });
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: (failed.stdout ?? "").trim(), stderr: (failed.stderr ?? "").trim() };
  }
}


function tunnelToken(secret: string): string {
  const json = JSON.stringify({ a: "0123456789abcdef0123456789abcdef", t: "11111111-2222-3333-4444-555555555555", s: secret });
  return Buffer.from(json).toString("base64");
}

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

  it("shows the commands, and explains a mistake instead of guessing", async () => {
    const help = await cli(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("organisations create --id ID --name NAME");
    const missing = await cli(["users", "login", "--email", "rescue@example.com"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Say --on or --off.");
    const unknown = await cli(["backpacks"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown area "backpacks".');
  });

  it("organisations: creates one with its own database, renames it, takes it out of use and puts it back", async () => {
    await createTestUser("owner@example.com", { displayName: "Olive Owner" });
    const noOwner = await cli(["organisations", "create", "--id", "cli-books", "--name", "CLI Books"]);
    expect(noOwner.code).toBe(1);
    expect(noOwner.stderr).toContain("--owner EMAIL is required");

    const created = await cli(["organisations", "create", "--id", "cli-books", "--name", "CLI Books", "--owner", "Owner@Example.com"]);
    expect(created).toMatchObject({ code: 0, stdout: "Created CLI Books (cli-books), owned by owner@example.com." });
    const listed = JSON.parse((await cli(["organisations", "list", "--json"])).stdout) as { id: string; displayName: string; provisioningStatus: string; memberCount: number; isActive: boolean }[];
    expect(listed.find((o) => o.id === "cli-books")).toMatchObject({ displayName: "CLI Books", provisioningStatus: "ready", memberCount: 1, isActive: true });

    expect((await cli(["organisations", "rename", "--id", "cli-books", "--name", "CLI Books Ltd"])).stdout).toBe("Renamed cli-books to CLI Books Ltd.");
    expect((await cli(["organisations", "take-out-of-use", "--id", "cli-books"])).stdout).toContain("CLI Books Ltd is out of use");
    expect((await coreQuery<{ is_active: boolean }>("select is_active from organisations where id = 'cli-books'")).rows[0].is_active).toBe(false);
    expect((await cli(["organisations", "put-back", "--id", "cli-books"])).stdout).toBe("CLI Books Ltd is back in use.");
    expect((await cli(["organisations", "repair", "--id", "cli-books"])).stdout).toBe("CLI Books Ltd: in use.");

    const table = (await cli(["organisations", "list"])).stdout;
    expect(table).toMatch(/cli-books\s+CLI Books Ltd\s+NZD\s+1\s+in use/);

    const audit = await coreQuery<{ event_type: string; actor_email: string; actor_user_id: string | null }>(
      "select event_type, actor_email, actor_user_id from admin_audit_events where entity_id = 'cli-books' order by id",
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual([
      "organisation.created",
      "organisation.updated",
      "organisation.updated",
      "organisation.updated",
      "organisation.repair_requested",
    ]);
    expect(audit.rows.every((r) => r.actor_email === "cli" && r.actor_user_id === null)).toBe(true);
  });

  it("users: lists them, renames, turns login and server admin off and on, and keeps one server admin", async () => {
    const kim = await createTestUser("kim@example.com", { displayName: "Kim" });
    await withCoreTransaction((client) => createSession(client, kim.id, { userAgent: "vitest", ipAddress: null }));

    expect((await cli(["users", "rename", "--email", "kim@example.com", "--name", "Kim Bookkeeper"])).stdout).toBe("kim@example.com is now called Kim Bookkeeper.");
    expect((await cli(["users", "login", "--email", "kim@example.com", "--off"])).stdout).toBe("kim@example.com can't sign in any more, and was signed out.");
    expect((await coreQuery("select 1 from sessions where user_id = $1", [kim.id])).rowCount).toBe(0);
    expect((await cli(["users", "login", "--email", "kim@example.com", "--on"])).stdout).toBe("kim@example.com can sign in.");
    expect((await cli(["users", "server-admin", "--email", "kim@example.com", "--on"])).stdout).toBe("kim@example.com is a server admin.");

    const listed = JSON.parse((await cli(["users", "list", "--json"])).stdout) as { email: string; displayName: string; isActive: boolean; isServerAdmin: boolean }[];
    expect(listed.find((u) => u.email === "kim@example.com")).toMatchObject({ displayName: "Kim Bookkeeper", isActive: true, isServerAdmin: true });

    // Take server admin away from everyone but Kim, then try Kim too.
    for (const other of listed.filter((u) => u.isServerAdmin && u.email !== "kim@example.com")) {
      expect((await cli(["users", "server-admin", "--email", other.email, "--off"])).code).toBe(0);
    }
    const last = await cli(["users", "server-admin", "--email", "kim@example.com", "--off"]);
    expect(last.code).toBe(1);
    expect(last.stderr).toBe("There must always be at least one active server admin.");

    const nobody = await cli(["users", "login", "--email", "nobody@example.com", "--on"]);
    expect(nobody).toMatchObject({ code: 1, stderr: "No user with the email nobody@example.com." });
  });

  it("remote access: saves the token encrypted and the address, without starting a tunnel itself", async () => {
    const noKey = await cli(["remote-access", "set", "--on", "--token"], { TOHYEE_SECRET_KEY: "", TOHYEE_TUNNEL_TOKEN: tunnelToken("c2VjcmV0") });
    expect(noKey.code).toBe(1);
    expect(noKey.stderr).toContain("Set TOHYEE_SECRET_KEY on the server first");

    const saved = await cli(
      ["remote-access", "set", "--on", "--token", "--url", "books.example.nz"],
      { TOHYEE_SECRET_KEY: SECRET_KEY, TOHYEE_TUNNEL_TOKEN: `cloudflared service install ${tunnelToken("c2VjcmV0")}` },
    );
    expect(saved).toMatchObject({ code: 0, stdout: "Remote access saved: on, https://books.example.nz. Restart Tohyee for the tunnel to start." });

    const shown = await cli(["remote-access", "show", "--json"], { TOHYEE_SECRET_KEY: SECRET_KEY });
    expect(shown.stdout).not.toContain("eyJ");
    expect(JSON.parse(shown.stdout)).toMatchObject({
      enabled: true,
      hasToken: true,
      tunnelId: "11111111-2222-3333-4444-555555555555",
      publicUrl: "https://books.example.nz",
    });
    expect(JSON.parse(shown.stdout).tunnel).toBeUndefined();

    expect((await cli(["remote-access", "clear"], { TOHYEE_SECRET_KEY: SECRET_KEY })).stdout).toContain("Remote access removed");
    expect(JSON.parse((await cli(["remote-access", "show", "--json"])).stdout)).toMatchObject({ enabled: false, hasToken: false });
  });

  it("remote access: a Tohyee address from the command line (for Linux and Docker)", async () => {
    const missing = await cli(["remote-access", "address", "--on"], { TOHYEE_ADDRESS_SERVICE_URL: "http://127.0.0.1:9" });
    expect(missing).toMatchObject({ code: 1, stderr: "The Tohyee address service isn't available yet." });

    const service = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        if (request.method === "DELETE") {
          response.writeHead(204);
          return response.end();
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ hostname: "k7m2q9.tohyee.example", tunnelToken: tunnelToken("YWRkcmVzcw"), releaseKey: "release-secret-123" }));
      });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const env = { TOHYEE_ADDRESS_SERVICE_URL: `http://127.0.0.1:${(service.address() as AddressInfo).port}` };
    try {
      const on = await cli(["remote-access", "address", "--on"], env);
      expect(on.code).toBe(0);
      expect(on.stdout).toContain("Your Tohyee address is https://k7m2q9.tohyee.example.");
      expect(JSON.parse((await cli(["remote-access", "show", "--json"], env)).stdout)).toMatchObject({ method: "tohyee", enabled: true });
      expect((await cli(["remote-access", "address", "--off"], env)).stdout).toContain("off (kept: https://k7m2q9.tohyee.example)");
      expect((await cli(["remote-access", "address", "release"], env)).stdout).toContain("given back");
      expect(JSON.parse((await cli(["remote-access", "show", "--json"], env)).stdout)).toMatchObject({ enabled: false, tohyeeAddress: null });
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
      await cli(["remote-access", "clear"]);
    }
  });

  it("email: saves the SMTP details with the password encrypted, never shows the password, and clears them", async () => {
    const saved = await cli(
      ["email", "set", "--host", "smtp.gmail.com", "--port", "465", "--username", "books@example.com", "--from-name", "Our Books"],
      { TOHYEE_SECRET_KEY: SECRET_KEY, TOHYEE_EMAIL_PASSWORD: "app-password-123" },
    );
    expect(saved).toMatchObject({ code: 0, stdout: 'Email saved: sending from books@example.com through smtp.gmail.com. Try it with "email test --to you@example.com".' });

    const shown = await cli(["email", "show"], { TOHYEE_SECRET_KEY: SECRET_KEY });
    expect(shown.stdout).toBe(
      ["SMTP server: smtp.gmail.com:465 (SSL)", "Username: books@example.com", 'From: "Our Books" <books@example.com>', "Password: saved"].join("\n"),
    );
    const stored = await coreQuery<{ secret_ciphertext: string }>("select secret_ciphertext from server_settings where key = 'email'");
    expect(stored.rows[0].secret_ciphertext).not.toContain("app-password-123");

    // A blank password keeps the saved one.
    const kept = await cli(["email", "set", "--host", "smtp.gmail.com", "--port", "587", "--username", "books@example.com"], {
      TOHYEE_SECRET_KEY: SECRET_KEY,
      TOHYEE_EMAIL_PASSWORD: "",
    });
    expect(kept.code).toBe(0);
    expect(JSON.parse((await cli(["email", "show", "--json"])).stdout)).toMatchObject({ port: 587, secure: false, hasPassword: true });

    expect((await cli(["email", "clear"])).stdout).toBe("Email settings removed.");
    expect((await cli(["email", "show"])).stdout).toBe("Email isn't set up.");
  });

  it("email: turns the local mail relay switch on and off (#145), audited as the command line", async () => {
    expect((await cli(["email", "local-relay"])).stdout).toBe("Allow local mail relay: off");
    expect((await cli(["email", "local-relay", "--on"])).stdout).toMatch(/^Local mail relay allowed/);
    expect((await cli(["email", "local-relay"])).stdout).toBe("Allow local mail relay: on");
    expect((await cli(["email", "local-relay", "--off"])).stdout).toMatch(/^Local mail relay not allowed/);
    const audit = await coreQuery<{ actor_email: string; details: { allowed: boolean } }>(
      "select actor_email, details from admin_audit_events where event_type = 'server.local_mail_relay_updated' order by id",
    );
    expect(audit.rows).toEqual([
      { actor_email: "cli", details: { allowed: true } },
      { actor_email: "cli", details: { allowed: false } },
    ]);
  });

  it("the bundled tool (tohyee-admin.cjs, shipped in the Docker image) runs with plain Node", async () => {
    await run(process.execPath, ["scripts/build-admin.mjs"], { timeout: 60_000 });
    const bundled = [path.join(process.cwd(), "dist", "tohyee-admin.cjs")];
    const listed = await cli(["users", "list", "--json"], {}, bundled);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.stdout) as { email: string }[]).map((u) => u.email)).toContain("kim@example.com");
  });
});
