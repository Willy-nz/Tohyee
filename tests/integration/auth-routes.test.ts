import { afterAll, beforeAll, expect, it } from "vitest";
import * as accountsRoute from "@/app/api/accounts/route";
import * as adminOrganisationsRoute from "@/app/api/admin/organisations/route";
import * as adminUsersRoute from "@/app/api/admin/users/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as passwordRoute from "@/app/api/auth/password/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as setupRoute from "@/app/api/auth/setup/route";
import * as journalsRoute from "@/app/api/ledger/journals/route";
import * as periodControlsRoute from "@/app/api/ledger/period-controls/route";
import * as membersRoute from "@/app/api/organisations/[organisationId]/members/route";
import * as memberRoute from "@/app/api/organisations/[organisationId]/members/[userId]/route";
import * as trialBalanceRoute from "@/app/api/reports/trial-balance/route";
import { hashSessionToken } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import {
  apiRequest,
  createTestUser,
  describeWithDatabase,
  key,
  params,
  startTestServer,
  TEST_PASSWORD,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0];
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describeWithDatabase("logins, roles and organisation isolation (HTTP routes)", () => {
  let server: TestServer;
  let adminCookie = "";

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("first-time setup needs the setup token and only works once", async () => {
    expect(await body(await setupRoute.GET(apiRequest("/api/auth/setup"), noContext))).toEqual({ needsSetup: true });

    const wrong = await setupRoute.POST(
      apiRequest("/api/auth/setup", {
        method: "POST",
        body: { setupToken: "nope", email: "jess@example.com", displayName: "Jess", password: TEST_PASSWORD },
      }),
      noContext,
    );
    expect(wrong.status).toBe(401);

    const ok = await setupRoute.POST(
      apiRequest("/api/auth/setup", {
        method: "POST",
        body: {
          setupToken: process.env.SETUP_TOKEN,
          email: "Jess@Example.com",
          displayName: "Jess",
          password: TEST_PASSWORD,
        },
      }),
      noContext,
    );
    expect(ok.status).toBe(201);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    adminCookie = cookieFrom(ok);

    const again = await setupRoute.POST(
      apiRequest("/api/auth/setup", {
        method: "POST",
        body: { setupToken: process.env.SETUP_TOKEN, email: "x@example.com", displayName: "X", password: TEST_PASSWORD },
      }),
      noContext,
    );
    expect(again.status).toBe(409);
  });

  it("every data route needs a signed-in user", async () => {
    const anonymous = await journalsRoute.GET(apiRequest("/api/ledger/journals?organisationId=anything"), noContext);
    expect(anonymous.status).toBe(401);
    const session = await sessionRoute.GET(apiRequest("/api/auth/session", { cookie: adminCookie }), noContext);
    expect((await body(session)).user).toMatchObject({ email: "jess@example.com", isServerAdmin: true });
  });

  it("sign-in: wrong passwords are refused and lock the account after 5 tries", async () => {
    const good = await loginRoute.POST(
      apiRequest("/api/auth/login", { method: "POST", body: { email: "jess@example.com", password: TEST_PASSWORD } }),
      noContext,
    );
    expect(good.status).toBe(200);

    const unknown = await loginRoute.POST(
      apiRequest("/api/auth/login", { method: "POST", body: { email: "nobody@example.com", password: "whatever-long" } }),
      noContext,
    );
    expect(unknown.status).toBe(401);
    expect((await body(unknown)).error).toBe("Email or password is incorrect.");

    await adminUsersRoute.POST(
      apiRequest("/api/admin/users", {
        method: "POST",
        cookie: adminCookie,
        body: { email: "lockme@example.com", displayName: "Lock Me", password: TEST_PASSWORD },
      }),
      noContext,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await loginRoute.POST(
        apiRequest("/api/auth/login", { method: "POST", body: { email: "lockme@example.com", password: "wrong-password" } }),
        noContext,
      );
      expect(response.status).toBe(401);
    }
    const locked = await loginRoute.POST(
      apiRequest("/api/auth/login", { method: "POST", body: { email: "lockme@example.com", password: TEST_PASSWORD } }),
      noContext,
    );
    expect(locked.status).toBe(429);
  });

  it("cross-site writes are blocked", async () => {
    const response = await journalsRoute.POST(
      apiRequest("/api/ledger/journals", {
        method: "POST",
        cookie: adminCookie,
        origin: "https://evil.example",
        body: { organisationId: "x" },
      }),
      noContext,
    );
    expect(response.status).toBe(403);
  });

  it("roles: viewers read, bookkeepers post, admins lock periods; non-members see nothing", async () => {
    const created = await adminOrganisationsRoute.POST(
      apiRequest("/api/admin/organisations", {
        method: "POST",
        cookie: adminCookie,
        body: { id: "glimmers", displayName: "Glimmers by Jess" },
      }),
      noContext,
    );
    expect(created.status).toBe(201);
    expect((await body(created)).organisation).toMatchObject({ provisioningStatus: "ready" });

    const people: Record<string, string> = {};
    for (const [name, role] of [
      ["viewer", "viewer"],
      ["bookkeeper", "bookkeeper"],
      ["outsider", null],
    ] as const) {
      await adminUsersRoute.POST(
        apiRequest("/api/admin/users", {
          method: "POST",
          cookie: adminCookie,
          body: { email: `${name}@example.com`, displayName: name, password: TEST_PASSWORD },
        }),
        noContext,
      );
      if (role) {
        const added = await membersRoute.POST(
          apiRequest("/api/organisations/glimmers/members", {
            method: "POST",
            cookie: adminCookie,
            body: { email: `${name}@example.com`, role },
          }),
          params({ organisationId: "glimmers" }),
        );
        expect(added.status).toBe(201);
      }
      const login = await loginRoute.POST(
        apiRequest("/api/auth/login", { method: "POST", body: { email: `${name}@example.com`, password: TEST_PASSWORD } }),
        noContext,
      );
      people[name] = cookieFrom(login);
    }

    const journal = {
      organisationId: "glimmers",
      postingDate: "2026-09-01",
      reference: "SALE-1",
      lines: [
        { accountCode: "1000", debitAmount: "50" },
        { accountCode: "4000", creditAmount: "50" },
      ],
    };

    const viewerPost = await journalsRoute.POST(
      apiRequest("/api/ledger/journals", { method: "POST", cookie: people.viewer, body: { ...journal, idempotencyKey: key() } }),
      noContext,
    );
    expect(viewerPost.status).toBe(403);

    const bookkeeperCommand = { ...journal, idempotencyKey: key() };
    const bookkeeperPost = await journalsRoute.POST(
      apiRequest("/api/ledger/journals", { method: "POST", cookie: people.bookkeeper, body: bookkeeperCommand }),
      noContext,
    );
    expect(bookkeeperPost.status).toBe(201);
    const posted = (await body(bookkeeperPost)).journal as { id: string; createdByEmail: string };
    expect(posted.createdByEmail).toBe("bookkeeper@example.com");

    // D1/D2 over HTTP: a retry returns the original (200); the same key for something else is a 409.
    const retried = await journalsRoute.POST(
      apiRequest("/api/ledger/journals", { method: "POST", cookie: people.bookkeeper, body: bookkeeperCommand }),
      noContext,
    );
    expect(retried.status).toBe(200);
    expect(((await body(retried)).journal as { id: string }).id).toBe(posted.id);
    const reused = await journalsRoute.POST(
      apiRequest("/api/ledger/journals", {
        method: "POST",
        cookie: people.bookkeeper,
        body: { ...bookkeeperCommand, reference: "SOMETHING-ELSE" },
      }),
      noContext,
    );
    expect(reused.status).toBe(409);

    const viewerRead = await trialBalanceRoute.GET(
      apiRequest("/api/reports/trial-balance?organisationId=glimmers&asAt=2026-12-31", { cookie: people.viewer }),
      noContext,
    );
    expect(viewerRead.status).toBe(200);
    expect((await body(viewerRead)).balanced).toBe(true);

    const bookkeeperLock = await periodControlsRoute.PATCH(
      apiRequest("/api/ledger/period-controls", {
        method: "PATCH",
        cookie: people.bookkeeper,
        body: { organisationId: "glimmers", lockDate: "2026-06-30" },
      }),
      noContext,
    );
    expect(bookkeeperLock.status).toBe(403);

    const adminLock = await periodControlsRoute.PATCH(
      apiRequest("/api/ledger/period-controls", {
        method: "PATCH",
        cookie: adminCookie,
        body: { organisationId: "glimmers", lockDate: "2026-06-30" },
      }),
      noContext,
    );
    expect(adminLock.status).toBe(200);

    const outsider = await journalsRoute.GET(
      apiRequest("/api/ledger/journals?organisationId=glimmers", { cookie: people.outsider }),
      noContext,
    );
    expect(outsider.status).toBe(404);

    const bookkeeperAddsAccount = await accountsRoute.POST(
      apiRequest("/api/accounts", {
        method: "POST",
        cookie: people.bookkeeper,
        body: { organisationId: "glimmers", code: "4500", name: "Commissions", accountType: "revenue" },
      }),
      noContext,
    );
    expect(bookkeeperAddsAccount.status).toBe(403);

    // Admin pages are server-admin only.
    const usersAsBookkeeper = await adminUsersRoute.GET(apiRequest("/api/admin/users", { cookie: people.bookkeeper }), noContext);
    expect(usersAsBookkeeper.status).toBe(403);
  });

  it("an organisation always keeps an owner, and only owners manage owners", async () => {
    const members = await body(
      await membersRoute.GET(apiRequest("/api/organisations/glimmers/members", { cookie: adminCookie }), params({ organisationId: "glimmers" })),
    );
    const owner = (members.members as Array<{ userId: string; role: string }>).find((member) => member.role === "owner")!;
    const demote = await memberRoute.PATCH(
      apiRequest(`/api/organisations/glimmers/members/${owner.userId}`, { method: "PATCH", cookie: adminCookie, body: { role: "admin" } }),
      params({ organisationId: "glimmers", userId: owner.userId }),
    );
    expect(demote.status).toBe(400);
    expect((await body(demote)).error).toMatch(/at least one owner/);
  });

  it("changing your password signs out your other sessions; logout ends this one", async () => {
    const second = cookieFrom(
      await loginRoute.POST(
        apiRequest("/api/auth/login", { method: "POST", body: { email: "viewer@example.com", password: TEST_PASSWORD } }),
        noContext,
      ),
    );
    const first = cookieFrom(
      await loginRoute.POST(
        apiRequest("/api/auth/login", { method: "POST", body: { email: "viewer@example.com", password: TEST_PASSWORD } }),
        noContext,
      ),
    );
    const changed = await passwordRoute.POST(
      apiRequest("/api/auth/password", {
        method: "POST",
        cookie: first,
        body: { currentPassword: TEST_PASSWORD, newPassword: "a-brand-new-password" },
      }),
      noContext,
    );
    expect(changed.status).toBe(200);
    expect((await sessionRoute.GET(apiRequest("/api/auth/session", { cookie: second }), noContext)).status).toBe(401);
    expect((await sessionRoute.GET(apiRequest("/api/auth/session", { cookie: first }), noContext)).status).toBe(200);

    await logoutRoute.POST(apiRequest("/api/auth/logout", { method: "POST", cookie: first }), noContext);
    expect((await sessionRoute.GET(apiRequest("/api/auth/session", { cookie: first }), noContext)).status).toBe(401);
  });

  it("sessions slide: using one pushes its expiry out, and the cookie outlives the first 14 days", async () => {
    await createTestUser("slider@example.com");
    const login = await loginRoute.POST(
      apiRequest("/api/auth/login", { method: "POST", body: { email: "slider@example.com", password: TEST_PASSWORD } }),
      noContext,
    );
    expect(login.status).toBe(200);
    const maxAge = Number(/Max-Age=(\d+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(14 * 24 * 60 * 60);

    const cookie = cookieFrom(login);
    const sessionId = hashSessionToken(cookie.slice(cookie.indexOf("=") + 1));
    // Last used two hours ago and about to expire.
    await coreQuery(
      "update sessions set last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 hour' where id = $1",
      [sessionId],
    );
    expect((await sessionRoute.GET(apiRequest("/api/auth/session", { cookie }), noContext)).status).toBe(200);
    const after = await coreQuery<{ days_left: string }>(
      "select (extract(epoch from expires_at - now()) / 86400)::text as days_left from sessions where id = $1",
      [sessionId],
    );
    expect(Number(after.rows[0].days_left)).toBeGreaterThan(13.9);
  });
});
