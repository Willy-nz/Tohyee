import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as signOutRoute from "@/app/api/admin/users/[userId]/sign-out/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as sessionsRoute from "@/app/api/auth/sessions/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listSignIns, logSignIn, markSignInsSeen, unseenFlags } from "@/lib/auth/sign-in-log";
import { coreQuery } from "@/lib/db/transactions";
import { type OutgoingEmail, setEmailSenderForTests, updateEmailSettings } from "@/lib/email/mailer";
import { apiRequest, createTestUser, describeWithDatabase, params, sessionCookieFor, startTestServer, TEST_PASSWORD, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;
const KEY = "sign-in-monitor-key-0123456789abcdefghijk";

const from = (address: string, userAgent = "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0", extra: Record<string, string> = {}) =>
  new Request("http://tohyee.test/api/auth/login", { headers: { "x-forwarded-for": address, "user-agent": userAgent, ...extra } });

/** The sign-in monitor (#208 item 1, decision 487): recorded, flagged, reported (never blocked). */
describeWithDatabase("sign-in monitor (#208)", () => {
  let server: TestServer;
  let admin: SessionUser;
  let kim: SessionUser;
  const sent: OutgoingEmail[] = [];
  const originalKey = process.env.TOHYEE_SECRET_KEY;

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = KEY;
    server = await startTestServer();
    admin = await createTestUser("mon-admin@example.com", { serverAdmin: true });
    kim = await createTestUser("mon-kim@example.com");
    setEmailSenderForTests(async (message) => {
      sent.push(message);
    });
    await updateEmailSettings({ user: { id: admin.id, email: admin.email, isServerAdmin: true } }, { host: "smtp.gmail.com", port: 465, username: "books@example.com", password: "app-password" });
  });

  afterEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    setEmailSenderForTests(null);
    process.env.TOHYEE_SECRET_KEY = originalKey;
    await server?.teardown();
  });

  it("records failures through the sign-in route with the proxy's address, and flags several for one login once", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await loginRoute.POST(
        apiRequest("/api/auth/login", { method: "POST", body: { email: kim.email, password: "not-the-password" }, headers: { "x-forwarded-for": "10.1.1.1, 203.0.113.50", "cf-ray": "8c1f-AKL" } }),
        noContext,
      );
      expect(response.status).toBe(401);
    }
    const events = (await listSignIns({ email: kim.email })).reverse();
    expect(events.map((event) => [event.outcome, event.step, event.address, event.remote])).toEqual(Array(4).fill(["failed", "password", "203.0.113.50", true]));
    expect(events.map((event) => event.flag)).toEqual([null, null, "Several failed tries for this login (3 in 15 minutes)", null]);
    // Reported to the server admins, not to the person (it may not be them).
    expect(sent.map((email) => email.to)).toEqual([admin.email]);
    expect(sent[0].text).toContain("It wasn't blocked.");
  });

  it("flags failures for many logins from one address (someone guessing)", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await logSignIn(from("198.51.100.77"), { email: `guess-${index}@example.com`, step: "password", outcome: "failed" });
    }
    const flagged = (await listSignIns({ flaggedOnly: true })).filter((event) => event.address === "198.51.100.77");
    expect(flagged.map((event) => event.flag)).toEqual(["Failed sign-ins for 5 different logins from one address (someone guessing)"]);
  });

  it("flags a new device, a new remote address, a backup code, a lock and a server admin through remote access; tells the person too", async () => {
    await logSignIn(from("192.168.1.20"), { email: kim.email, step: "code", outcome: "signed_in" });
    await logSignIn(from("192.168.1.20"), { email: kim.email, step: "code", outcome: "signed_in" });
    expect((await listSignIns({ email: kim.email, limit: 2 })).map((event) => event.flag)).toEqual([null, null]);
    expect(sent).toHaveLength(0);

    await logSignIn(from("192.168.1.20", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), { email: kim.email, step: "code", outcome: "signed_in" });
    await logSignIn(from("203.0.113.88", "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0", { "cf-ray": "8c1f-AKL" }), { email: kim.email, step: "code", outcome: "signed_in" });
    await logSignIn(from("192.168.1.20"), { email: kim.email, step: "backup_code", outcome: "signed_in" });
    await logSignIn(from("192.168.1.20"), { email: kim.email, step: "password", outcome: "locked", detail: "Too many failed sign-in attempts." });
    expect((await listSignIns({ email: kim.email, limit: 4 })).map((event) => event.flag).reverse()).toEqual([
      "A new device or browser for this login",
      "A new address for this login",
      "A backup code was used instead of the authenticator app",
      "The login was locked after too many wrong tries",
    ]);
    expect(sent.filter((email) => email.to === kim.email)).toHaveLength(4);

    await logSignIn(from("192.168.1.30"), { email: admin.email, step: "code", outcome: "signed_in" });
    await logSignIn(from("203.0.113.90", "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0", { "cf-ray": "8c1f-AKL" }), { email: admin.email, step: "code", outcome: "signed_in" });
    expect((await listSignIns({ email: admin.email, limit: 1 }))[0].flag).toBe("A new address for this login; A server admin signed in through remote access");
    expect((await listSignIns({ remoteOnly: true })).every((event) => event.remote)).toBe(true);
  });

  it("counts flags since a server admin last looked", async () => {
    expect((await unseenFlags()).count).toBeGreaterThan(0);
    await markSignInsSeen({ id: admin.id, email: admin.email });
    expect((await unseenFlags()).count).toBe(0);
    await logSignIn(from("192.168.1.20"), { email: kim.email, step: "password", outcome: "locked" });
    expect((await unseenFlags()).count).toBe(1);
  });

  it("people see where they're signed in and sign one or all others out; a server admin can sign anyone out everywhere", async () => {
    const first = await sessionCookieFor(kim);
    const second = await sessionCookieFor(kim);
    const third = await sessionCookieFor(kim);
    const listed = (await (await sessionsRoute.GET(apiRequest("/api/auth/sessions", { cookie: first }), noContext)).json()) as { sessions: Array<{ id: string; current: boolean }> };
    expect(listed.sessions.length).toBeGreaterThanOrEqual(3);
    expect(listed.sessions.filter((session) => session.current)).toHaveLength(1);
    const other = listed.sessions.find((session) => !session.current)!;
    const one = await sessionsRoute.DELETE(apiRequest("/api/auth/sessions", { method: "DELETE", cookie: first, body: { id: other.id } }), noContext);
    expect(one.status).toBe(200);
    const others = await sessionsRoute.DELETE(apiRequest("/api/auth/sessions", { method: "DELETE", cookie: first, body: { id: "others" } }), noContext);
    expect(((await others.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
    for (const cookie of [second, third]) expect((await sessionsRoute.GET(apiRequest("/api/auth/sessions", { cookie }), noContext)).status).toBe(401);

    const adminCookie = await sessionCookieFor(admin);
    const signedOut = await signOutRoute.POST(apiRequest(`/api/admin/users/${kim.id}/sign-out`, { method: "POST", cookie: adminCookie }), params({ userId: kim.id }));
    expect(signedOut.status).toBe(200);
    expect((await sessionsRoute.GET(apiRequest("/api/auth/sessions", { cookie: first }), noContext)).status).toBe(401);
    const audit = await coreQuery<{ event_type: string }>("select event_type from admin_audit_events where entity_id = $1 order by id desc limit 1", [kim.id]);
    expect(audit.rows[0].event_type).toBe("user.signed_out_everywhere");
  });

  it("a correct password for a login is recorded as the first step (two-step on)", async () => {
    await coreQuery("update users set locked_until = null, failed_login_count = 0 where id = $1", [kim.id]);
    const response = await loginRoute.POST(apiRequest("/api/auth/login", { method: "POST", body: { email: kim.email, password: TEST_PASSWORD }, headers: { "x-forwarded-for": "192.168.1.20" } }), noContext);
    expect(response.status).toBe(200);
    expect((await listSignIns({ email: kim.email, limit: 1 }))[0]).toMatchObject({ outcome: "password_ok", step: "password", remote: false });
  });
});
