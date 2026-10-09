import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as adminTwoStepRoute from "@/app/api/admin/users/[userId]/two-step/route";
import * as setupLinkRoute from "@/app/api/admin/users/[userId]/setup-link/route";
import * as adminUsersRoute from "@/app/api/admin/users/route";
import * as setupAccountRoute from "@/app/api/auth/setup-account/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as setupRoute from "@/app/api/auth/setup/route";
import * as twoStepRoute from "@/app/api/auth/two-step/route";
import * as backupCodesRoute from "@/app/api/auth/two-step/backup-codes/route";
import * as emailResetRoute from "@/app/api/auth/two-step/email-reset/route";
import * as enrolRoute from "@/app/api/auth/two-step/enrol/route";
import * as resetRoute from "@/app/api/auth/two-step/reset/route";
import * as verifyRoute from "@/app/api/auth/two-step/verify/route";
import { currentStep, totpCode } from "@/lib/auth/totp";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { apiRequest, describeWithDatabase, params, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describeWithDatabase("two-step sign-in (authenticator app and backup codes)", () => {
  let server: TestServer;
  const originalKey = process.env.TOHYEE_SECRET_KEY;
  const sent: OutgoingEmail[] = [];
  // Starts at the real time: lockouts are timed by the database's clock.
  let clock = Date.now();

  /** Moves the clock on so the authenticator shows a new code. */
  function later(minutes = 2) {
    clock += minutes * 60_000;
    vi.setSystemTime(clock);
  }

  const post = (route: { POST: (request: Request, context: unknown) => Promise<Response> }, path: string, cookie: string, payload: unknown = {}) =>
    route.POST(apiRequest(path, { method: "POST", cookie, body: payload }), noContext);
  const login = (email: string, password = TEST_PASSWORD) =>
    loginRoute.POST(apiRequest("/api/auth/login", { method: "POST", body: { email, password } }), noContext);
  const session = (cookie: string) => sessionRoute.GET(apiRequest("/api/auth/session", { cookie }), noContext);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "two-step-test-key-0123456789abcdefghij";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    server = await startTestServer();
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
  });

  afterEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    setEmailSenderForTests(null);
    vi.useRealTimers();
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  let secret = "";
  let adminCookie = "";

  it("the first admin must set up an authenticator app before doing anything", async () => {
    const setup = await setupRoute.POST(
      apiRequest("/api/auth/setup", {
        method: "POST",
        body: { setupToken: process.env.SETUP_TOKEN, email: "jess@example.com", displayName: "Jess", password: TEST_PASSWORD },
      }),
      noContext,
    );
    expect(setup.status).toBe(201);
    expect(await body(setup)).toMatchObject({ stage: "enrol" });
    const pending = cookieFrom(setup);
    // A pending session can't use the app.
    expect((await session(pending)).status).toBe(401);
    expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: pending }), noContext))).toMatchObject({
      stage: "enrol",
      status: { required: true, enabled: false },
    });

    const started = await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: pending }), noContext));
    secret = started.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.otpauthUri).toContain(`secret=${secret}`);
    expect(started.qrSvg).toContain("<svg");
    // The same key is shown again until it's confirmed.
    expect((await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: pending }), noContext))).secret).toBe(secret);
    // Stored encrypted.
    const stored = await coreQuery<{ totp_pending_ciphertext: string }>("select totp_pending_ciphertext from users");
    expect(stored.rows[0].totp_pending_ciphertext).not.toContain(secret);

    const wrong = await post(enrolRoute, "/api/auth/two-step/enrol", pending, { code: "000000" === totpCode(secret, currentStep()) ? "111111" : "000000" });
    expect(wrong.status).toBe(400);

    const confirmed = await post(enrolRoute, "/api/auth/two-step/enrol", pending, { code: totpCode(secret, currentStep()) });
    expect(confirmed.status).toBe(200);
    const codes = (await body(confirmed)).backupCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    adminCookie = cookieFrom(confirmed);
    // The pending token was replaced by a new one.
    expect(adminCookie).not.toBe(pending);
    expect((await session(pending)).status).toBe(401);
    expect((await session(adminCookie)).status).toBe(200);
    expect(sent.map((email) => email.subject)).toEqual([]); // email isn't set up yet
    const hashes = await coreQuery<{ code_hash: string }>("select code_hash from user_backup_codes");
    expect(hashes.rows).toHaveLength(10);
    expect(JSON.stringify(hashes.rows)).not.toContain(codes[0]);
    (globalThis as { __codes?: string[] }).__codes = codes;
  });

  it("signing in needs the password and then a code; a code can't be used twice", async () => {
    later();
    const first = await login("jess@example.com");
    expect(await body(first)).toMatchObject({ stage: "verify" });
    const pending = cookieFrom(first);
    expect((await session(pending)).status).toBe(401);
    const code = totpCode(secret, currentStep());
    const ok = await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(ok.status).toBe(200);
    expect((await session(cookieFrom(ok))).status).toBe(200);

    // The same code again (another sign-in within the same 30 seconds) is refused.
    const again = cookieFrom(await login("jess@example.com"));
    const replay = await post(verifyRoute, "/api/auth/two-step/verify", again, { code });
    expect(replay.status).toBe(400);
    expect((await body(replay)).error).toMatch(/isn't right/);
  });

  it("a backup code works once instead of the app", async () => {
    later();
    const codes = (globalThis as { __codes?: string[] }).__codes!;
    const pending = cookieFrom(await login("jess@example.com"));
    const used = await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: codes[0].toUpperCase().replace("-", "") });
    expect(used.status).toBe(200);
    expect(await body(used)).toMatchObject({ usedBackupCode: true, backupCodesLeft: 9 });
    const pendingAgain = cookieFrom(await login("jess@example.com"));
    expect((await post(verifyRoute, "/api/auth/two-step/verify", pendingAgain, { code: codes[0] })).status).toBe(400);
  });

  it("5 wrong codes end the sign-in; 10 in a row lock the account for 15 minutes", async () => {
    later();
    // A successful sign-in clears earlier wrong codes.
    const fine = cookieFrom(await login("jess@example.com"));
    expect((await post(verifyRoute, "/api/auth/two-step/verify", fine, { code: totpCode(secret, currentStep()) })).status).toBe(200);
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: "999999" })).status).toBe(400);
    }
    const fifth = await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: "999999" });
    expect(fifth.status).toBe(401);
    expect((await body(fifth)).error).toMatch(/Sign in with your password again/);
    const second = cookieFrom(await login("jess@example.com"));
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await post(verifyRoute, "/api/auth/two-step/verify", second, { code: "999999" })).status).toBe(400);
    }
    const tenth = await post(verifyRoute, "/api/auth/two-step/verify", second, { code: "999999" });
    expect(tenth.status).toBe(429);
    expect((await login("jess@example.com")).status).toBe(429);
    later(16);
    const unlocked = cookieFrom(await login("jess@example.com"));
    const ok = await post(verifyRoute, "/api/auth/two-step/verify", unlocked, { code: totpCode(secret, currentStep()) });
    expect(ok.status).toBe(200);
    adminCookie = cookieFrom(ok);
  });

  it("codes and passwords sent all at once can't get past the limits (#130)", async () => {
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    const codes = await Promise.all(Array.from({ length: 20 }, (_, index) => post(verifyRoute, "/api/auth/two-step/verify", pending, { code: String(100000 + index) })));
    // At most the session's 5 tries are checked; the rest are refused before any code is looked at.
    expect(codes.filter((response) => response.status === 400).length).toBeLessThanOrEqual(5);
    expect(codes.every((response) => [400, 401, 429].includes(response.status))).toBe(true);
    const counted = await coreQuery<{ failures: number }>("select coalesce(max(two_step_failures), 0) as failures from sessions s join users u on u.id = s.user_id where u.email = 'jess@example.com' and s.two_step_pending");
    expect(counted.rows[0].failures).toBeLessThanOrEqual(5);

    // Passwords: 20 wrong ones at once are only checked up to the limit of 5; then the account is locked.
    later();
    const passwords = await Promise.all(Array.from({ length: 20 }, (_, index) => login("jess@example.com", `wrong-password-${index}`)));
    expect(passwords.filter((response) => response.status === 401).length).toBeLessThanOrEqual(5);
    expect(passwords.filter((response) => response.status === 429).length).toBeGreaterThanOrEqual(15);
    expect((await login("jess@example.com")).status).toBe(429);

    // An email with no account gets the same answer after 5 tries, so it can't be told apart.
    for (let attempt = 1; attempt <= 5; attempt += 1) expect((await login("nobody@example.com", "wrong")).status).toBe(401);
    expect((await login("nobody@example.com", "wrong")).status).toBe(429);

    later(16);
    const unlocked = cookieFrom(await login("jess@example.com"));
    expect((await post(verifyRoute, "/api/auth/two-step/verify", unlocked, { code: totpCode(secret, currentStep()) })).status).toBe(200);
  });

  it("new backup codes need a current code and replace the old ones", async () => {
    later();
    const codes = (globalThis as { __codes?: string[] }).__codes!;
    expect((await post(backupCodesRoute, "/api/auth/two-step/backup-codes", adminCookie, { code: "123123" })).status).toBe(400);
    const fresh = await post(backupCodesRoute, "/api/auth/two-step/backup-codes", adminCookie, { code: totpCode(secret, currentStep()) });
    expect(fresh.status).toBe(200);
    expect((await body(fresh)).backupCodes).toHaveLength(10);
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    expect((await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: codes[1] })).status).toBe(400);
  });

  it("a lost phone: an emailed link (with the password again) resets two-step and starts setting it up again", async () => {
    await updateEmailSettings(
      { user: { id: "00000000-0000-0000-0000-000000000000", email: "jess@example.com", isServerAdmin: true } },
      { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" },
    );
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    // Without the server's public address there's no safe address for the link, so it isn't offered (#131).
    expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: pending }), noContext))).toMatchObject({
      stage: "verify",
      emailResetAvailable: false,
    });
    expect((await post(emailResetRoute, "/api/auth/two-step/email-reset", pending)).status).toBe(409);
    expect(sent).toHaveLength(0);
    await coreQuery(
      `insert into server_settings (key, value, secret_ciphertext, updated_by_email) values ('remote_access', '{"publicUrl": "https://books.example.nz"}', null, 'test')
       on conflict (key) do update set value = excluded.value`,
    );
    expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: pending }), noContext))).toMatchObject({
      stage: "verify",
      emailResetAvailable: true,
    });
    // Not from a full session, and not without the password first.
    expect((await post(emailResetRoute, "/api/auth/two-step/email-reset", adminCookie)).status).toBe(409);
    const requested = await post(emailResetRoute, "/api/auth/two-step/email-reset", pending);
    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "jess@example.com", subject: "Tohyee: reset two-step sign-in" });
    // The link uses the configured address, whatever Host the request came with.
    const link = /https:\/\/books\.example\.nz\/login\/reset-two-step\?token=(\S+)/.exec(sent[0].text);
    expect(link).not.toBeNull();
    const token = decodeURIComponent(link![1]);
    expect((await post(emailResetRoute, "/api/auth/two-step/email-reset", pending)).status).toBe(429);

    const wrongPassword = await resetRoute.POST(
      apiRequest("/api/auth/two-step/reset", { method: "POST", body: { token, password: "not-the-password" } }),
      noContext,
    );
    expect(wrongPassword.status).toBe(401);
    const reset = await resetRoute.POST(
      apiRequest("/api/auth/two-step/reset", { method: "POST", body: { token, password: TEST_PASSWORD } }),
      noContext,
    );
    expect(reset.status).toBe(200);
    const enrolling = cookieFrom(reset);
    expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: enrolling }), noContext))).toMatchObject({
      stage: "enrol",
      status: { enabled: false, backupCodesLeft: 0 },
    });
    // Every other session was signed out, and the link works once.
    expect((await session(adminCookie)).status).toBe(401);
    expect(
      (await resetRoute.POST(apiRequest("/api/auth/two-step/reset", { method: "POST", body: { token, password: TEST_PASSWORD } }), noContext))
        .status,
    ).toBe(401);
    expect(sent.map((email) => email.subject)).toContain("Tohyee: two-step sign-in was reset");

    secret = (await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: enrolling }), noContext))).secret as string;
    const confirmed = await post(enrolRoute, "/api/auth/two-step/enrol", enrolling, { code: totpCode(secret, currentStep()) });
    expect(confirmed.status).toBe(200);
    adminCookie = cookieFrom(confirmed);
    expect(sent.map((email) => email.subject)).toContain("Tohyee: two-step sign-in turned on");
  });

  it("a server admin can reset someone else's two-step; new users set up their login with a setup link (#208)", async () => {
    // With two-step on, the admin doesn't choose a password.
    const withPassword = await adminUsersRoute.POST(
      apiRequest("/api/admin/users", {
        method: "POST",
        cookie: adminCookie,
        body: { email: "kim@example.com", displayName: "Kim", password: TEST_PASSWORD },
      }),
      noContext,
    );
    expect(withPassword.status).toBe(400);
    const created = await adminUsersRoute.POST(
      apiRequest("/api/admin/users", { method: "POST", cookie: adminCookie, body: { email: "kim@example.com", displayName: "Kim" } }),
      noContext,
    );
    expect(created.status).toBe(201);
    const createdBody = await body(created);
    const kimId = (createdBody.user as { id: string }).id;
    const setupLink = createdBody.setupLink as { url: string; emailed: boolean; localOnly: boolean };
    // The server's public address was saved by the test above, so the link uses it; email is set up, so it was emailed.
    expect(setupLink).toMatchObject({ emailed: true, localOnly: false });
    expect(setupLink.url).toMatch(/^https:\/\/books\.example\.nz\/login\/setup-account\?token=/);
    expect(sent.find((email) => email.to === "kim@example.com")?.text).toContain(setupLink.url);
    expect(((await body(await adminUsersRoute.GET(apiRequest("/api/admin/users", { cookie: adminCookie }), noContext))).users as Array<{ email: string; setupLinkExpiresAt: string | null }>).find((user) => user.email === "kim@example.com")?.setupLinkExpiresAt).not.toBeNull();
    const kimToken = decodeURIComponent(new URL(setupLink.url).searchParams.get("token")!);

    // A password alone can't start setting up two-step: someone who learns one can't register their own app.
    await coreQuery("update users set password_hash = (select password_hash from users where email = 'jess@example.com') where id = $1", [kimId]);
    const first = await login("kim@example.com");
    expect(first.status).toBe(403);
    expect((await body(first)).error).toContain("Open the setup link your server admin sent you");

    expect(await body(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(kimToken)}`), noContext))).toEqual({
      valid: true,
      email: "kim@example.com",
      displayName: "Kim",
    });
    expect((await setupAccountRoute.POST(apiRequest("/api/auth/setup-account", { method: "POST", body: { token: kimToken, password: "short" } }), noContext)).status).toBe(400);
    const usedLink = await setupAccountRoute.POST(
      apiRequest("/api/auth/setup-account", { method: "POST", body: { token: kimToken, password: "kims-own-password-123" } }),
      noContext,
    );
    expect(usedLink.status).toBe(200);
    // Works once.
    expect((await setupAccountRoute.POST(apiRequest("/api/auth/setup-account", { method: "POST", body: { token: kimToken, password: "kims-own-password-123" } }), noContext)).status).toBe(401);
    expect((await body(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(kimToken)}`), noContext))).valid).toBe(false);
    const kimPending = cookieFrom(usedLink);
    expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: kimPending }), noContext))).toMatchObject({ stage: "enrol" });
    const kimSecret = (await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: kimPending }), noContext))).secret as string;
    const kim = cookieFrom(await post(enrolRoute, "/api/auth/two-step/enrol", kimPending, { code: totpCode(kimSecret, currentStep()) }));
    expect((await session(kim)).status).toBe(200);

    const refused = await adminTwoStepRoute.DELETE(
      apiRequest(`/api/admin/users/${kimId}/two-step`, { method: "DELETE", cookie: kim }),
      params({ userId: kimId }),
    );
    expect(refused.status).toBe(403);
    const reset = await adminTwoStepRoute.DELETE(
      apiRequest(`/api/admin/users/${kimId}/two-step`, { method: "DELETE", cookie: adminCookie }),
      params({ userId: kimId }),
    );
    expect(reset.status).toBe(200);
    const resetBody = await body(reset);
    expect((resetBody.user as { twoStepEnabled: boolean }).twoStepEnabled).toBe(false);
    // A fresh setup link to set it up again; asking for another stops the first.
    const resetLink = (resetBody.setupLink as { url: string }).url;
    const again = await setupLinkRoute.POST(apiRequest(`/api/admin/users/${kimId}/setup-link`, { method: "POST", cookie: adminCookie }), params({ userId: kimId }));
    expect(again.status).toBe(200);
    const oldToken = decodeURIComponent(new URL(resetLink).searchParams.get("token")!);
    expect((await body(await setupAccountRoute.GET(apiRequest(`/api/auth/setup-account?token=${encodeURIComponent(oldToken)}`), noContext))).valid).toBe(false);
    expect((await session(kim)).status).toBe(401);
    expect(sent.some((email) => email.to === "kim@example.com" && email.subject === "Tohyee: two-step sign-in was reset")).toBe(true);
    const audit = await coreQuery<{ event_type: string }>(
      "select event_type from admin_audit_events where entity_id = $1 order by id",
      [kimId],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["user.setup_link_created", "user.setup_completed", "user.two_step_enabled", "user.two_step_reset"]),
    );
  });

  it("if the server's secret key is changed, the password leads to setting two-step up again", async () => {
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    process.env.TOHYEE_SECRET_KEY = "a-different-key-0123456789abcdefghijklm";
    try {
      const refused = await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: totpCode(secret, currentStep()) });
      expect(refused.status).toBe(409);
      expect((await body(refused)).error).toMatch(/Set up your authenticator app again/);
      expect(await body(await twoStepRoute.GET(apiRequest("/api/auth/two-step", { cookie: pending }), noContext))).toMatchObject({
        stage: "enrol",
      });
      const fresh = (await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: pending }), noContext))).secret as string;
      const confirmed = await post(enrolRoute, "/api/auth/two-step/enrol", pending, { code: totpCode(fresh, currentStep()) });
      expect(confirmed.status).toBe(200);
      secret = fresh;
    } finally {
      process.env.TOHYEE_SECRET_KEY = "two-step-test-key-0123456789abcdefghij";
    }
    // Back on the original key, the new authenticator key (saved with the other key) can't be read either, so it resets again.
    later();
    const again = cookieFrom(await login("jess@example.com"));
    expect((await post(verifyRoute, "/api/auth/two-step/verify", again, { code: totpCode(secret, currentStep()) })).status).toBe(409);
    const re = (await body(await enrolRoute.GET(apiRequest("/api/auth/two-step/enrol", { cookie: again }), noContext))).secret as string;
    expect((await post(enrolRoute, "/api/auth/two-step/enrol", again, { code: totpCode(re, currentStep()) })).status).toBe(200);
    secret = re;
  });

  it("signing out ends a pending sign-in too", async () => {
    later();
    const pending = cookieFrom(await login("jess@example.com"));
    await post(logoutRoute, "/api/auth/logout", pending);
    expect((await post(verifyRoute, "/api/auth/two-step/verify", pending, { code: totpCode(secret, currentStep()) })).status).toBe(401);
  });
});
