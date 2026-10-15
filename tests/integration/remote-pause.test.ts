import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import * as pauseRoute from "@/app/api/admin/remote-access/pause/route";
import * as loginRoute from "@/app/api/auth/login/route";
import { assertRemoteAllowed } from "@/lib/auth/remote";
import { forgetRemotePauseCache, noteRemoteFailure, PAUSE_AFTER_FAILURES, remotePausedUntil, remotePauseStatus, resumeRemoteAccess } from "@/lib/auth/remote-pause";
import type { SessionUser } from "@/lib/auth/sessions";
import { logSignIn } from "@/lib/auth/sign-in-log";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { apiRequest, createTestUser, describeWithDatabase, sessionCookieFor, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const KEY = "remote-pause-key-0123456789abcdefghijklmn";

/** A request that came through Cloudflare (remote access), and one on the local network. */
const remote = (address = "203.0.113.77") => new Request("http://tohyee.test/api/auth/login", { headers: { "x-forwarded-for": address, "cf-ray": "8c1f-AKL", "user-agent": "curl/8" } });
const local = () => new Request("http://tohyee.test/api/auth/login", { headers: { "x-forwarded-for": "192.168.1.20" } });

/** Remote access pauses after many failed sign-ins through it (decision 542). */
describeWithDatabase("pausing remote access when someone is guessing", () => {
  let server: TestServer;
  let admin: SessionUser;
  const sent: OutgoingEmail[] = [];
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = KEY;
    server = await startTestServer();
    admin = await createTestUser("pause-admin@example.com", { serverAdmin: true });
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    await updateEmailSettings({ user: { id: admin.id, email: admin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
  });

  beforeEach(async () => {
    await coreQuery("delete from sign_in_events");
    await coreQuery("delete from server_settings where key = 'remote_pause'");
    forgetRemotePauseCache();
    sent.length = 0;
  });

  afterEach(() => forgetRemotePauseCache());

  afterAll(async () => {
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  const fail = async (count: number, request = remote) => {
    for (let index = 0; index < count; index += 1) {
      await logSignIn(request(`203.0.113.${(index % 50) + 1}`), { email: `guess${index}@example.com`, step: "password", outcome: "failed" });
    }
  };

  it(`${PAUSE_AFTER_FAILURES} failed sign-ins through remote access, from any logins and addresses, pause it for an hour and email the server admins`, async () => {
    await fail(PAUSE_AFTER_FAILURES - 1);
    expect((await remotePauseStatus()).paused).toBe(false);
    await expect(assertRemoteAllowed(remote().headers)).resolves.toBeUndefined();

    const before = Date.now();
    await fail(1);
    const status = await remotePauseStatus();
    expect(status).toMatchObject({ paused: true, failures: PAUSE_AFTER_FAILURES, tripsToday: 1 });
    const minutes = (Date.parse(status.until!) - before) / 60_000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThan(61);
    const pausedEmails = sent.filter((email) => email.text.includes("Remote access to Tohyee is paused until"));
    expect(pausedEmails.map((email) => email.to)).toEqual([admin.email]);
    const audit = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where event_type like 'remote_access.%'");
    expect(audit.rows.map((row) => row.event_type)).toContain("remote_access.paused");

    // Remote requests are refused; the local network carries on.
    await expect(assertRemoteAllowed(remote().headers)).rejects.toThrow(/Remote access to Tohyee is paused until/);
    await expect(assertRemoteAllowed(local().headers)).resolves.toBeUndefined();
    // It ends by itself.
    expect(await remotePausedUntil(new Date(Date.now() + 61 * 60_000))).toBeNull();
  });

  it("failures on the local network don't count, and refusals while paused don't extend it", async () => {
    await fail(PAUSE_AFTER_FAILURES + 5, local);
    expect((await remotePauseStatus()).paused).toBe(false);

    await fail(PAUSE_AFTER_FAILURES);
    const until = (await remotePauseStatus()).until;
    for (let index = 0; index < 30; index += 1) await logSignIn(remote(), { email: "guess@example.com", step: "password", outcome: "refused" });
    await noteRemoteFailure();
    expect((await remotePauseStatus()).until).toBe(until);
    expect(sent.filter((email) => email.text.includes("is paused until"))).toHaveLength(1);
  });

  it("the sign-in page refuses through remote access while paused, and the attempt is recorded as refused", async () => {
    await fail(PAUSE_AFTER_FAILURES);
    const response = await loginRoute.POST(
      apiRequest("/api/auth/login", { method: "POST", body: { email: admin.email, password: TEST_PASSWORD }, headers: { "x-forwarded-for": "203.0.113.90", "cf-ray": "8c1f-AKL" } }),
      noContext,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain("paused until");
    const last = await coreQuery<{ outcome: string }>("select outcome from sign_in_events order by id desc limit 1");
    expect(last.rows[0].outcome).toBe("refused");
  });

  it("a server admin can resume it on the server computer; pausing again the same day lasts twice as long", async () => {
    await fail(PAUSE_AFTER_FAILURES);
    const cookie = await sessionCookieFor(admin);
    const resumed = await pauseRoute.POST(apiRequest("/api/admin/remote-access/pause", { method: "POST", cookie, local: true }), noContext);
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { pause: { paused: boolean } }).pause.paused).toBe(false);
    await expect(assertRemoteAllowed(remote().headers)).resolves.toBeUndefined();
    const audit = await coreQuery<{ event_type: string; actor_email: string }>("select event_type, actor_email from admin_audit_events where event_type = 'remote_access.resumed'");
    expect(audit.rows).toEqual([{ event_type: "remote_access.resumed", actor_email: admin.email }]);

    // The earlier burst doesn't pause it again by itself: it takes another one.
    await fail(1);
    expect((await remotePauseStatus()).paused).toBe(false);
    const before = Date.now();
    await fail(PAUSE_AFTER_FAILURES);
    const again = await remotePauseStatus();
    expect(again).toMatchObject({ paused: true, tripsToday: 2 });
    const minutes = (Date.parse(again.until!) - before) / 60_000;
    expect(minutes).toBeGreaterThan(119);
    expect(minutes).toBeLessThan(121);

    // Not from another computer, and resuming when it isn't paused says so.
    const elsewhere = await pauseRoute.POST(apiRequest("/api/admin/remote-access/pause", { method: "POST", cookie, local: false }), noContext);
    expect(elsewhere.status).toBe(403);
    await resumeRemoteAccess({ userId: admin.id, email: admin.email });
    await expect(resumeRemoteAccess({ userId: admin.id, email: admin.email })).rejects.toThrow("isn't paused");
  });
});
