import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as readingsRoute from "@/app/api/farming/farms/[farmId]/pasture/readings/route";
import * as reportsRoute from "@/app/api/farming/safety/reports/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { ACCOUNT_CHANGED_CODE, expectedAccountHeaders, sessionCheck } from "@/lib/offline/account";
import { fetchSender, openQueue } from "@/lib/offline/queue";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "offline-account";

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Work saved on a phone is recorded only as the account that made it
 * (#478, decision 1050), against Tohyee's real routes: the browser's
 * cookie changing to someone else (who may record on the same farm, or
 * may not) never records it as them; it stays waiting until its own
 * account is signed in. Made-up data only.
 */
describeWithDatabase("offline work and a different signed-in account", () => {
  let server: TestServer;
  let owner: SessionUser;
  let hemi: SessionUser;
  let aroha: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  const cookies = new Map<string, string>();
  let signedIn: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("account-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    hemi = await createTestUser("account-hemi@example.com", { displayName: "Hemi" });
    aroha = await createTestUser("account-aroha@example.com", { displayName: "Aroha" });
    await createTestOrganisation(owner, ORG);
    for (const user of [hemi, aroha]) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, user.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "7", effectiveHa: "4" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: hemi.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    // Aroha can't see the home farm at all.
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: aroha.id, role: "farm_worker", access: "farms", farmIds: [w.runoff] }));
    for (const user of [owner, hemi, aroha]) cookies.set(user.id, await sessionCookieFor(user));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  /** The browser: one cookie for every tab, whoever signed in last. */
  const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    let match: RegExpExecArray | null;
    const handler: { run: Handler; params: Record<string, string> } =
      path === "/api/farming/safety/reports"
        ? { run: reportsRoute.POST as Handler, params: {} }
        : (match = /^\/api\/farming\/farms\/([^/]+)\/pasture\/readings$/.exec(path))
          ? { run: readingsRoute.POST as Handler, params: { farmId: match[1] } }
          : (() => {
              throw new Error(`No route for ${path} in this test.`);
            })();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    return handler.run(apiRequest(path, { method: init?.method, cookie: cookies.get(signedIn.id), body: JSON.parse(String(init?.body)), headers }), params(handler.params) as never);
  }) as typeof fetch;

  const count = async (sql: string, values: unknown[] = []) => Number((await as(owner)((tx) => tx.query<{ n: string }>(sql, values))).rows[0].n);

  it("holds Hemi's report and reading while the owner (same farm) or Aroha (another farm) is signed in, then sends them as Hemi", async () => {
    const queue = await openQueue({ server: "http://tohyee.test", userId: hemi.id, organisationId: ORG }, { factory: new IDBFactory(), locks: null, channel: false });
    await queue.add({ kind: "safety.report", label: "Near miss: quad on the race", farmId: w.home, farmName: "Home farm", request: { method: "POST", path: "/api/farming/safety/reports", body: { farmId: w.home, type: "near_miss", title: "Quad nearly rolled on the race" } } });
    await queue.add({ kind: "farm.reading", label: "Cover 2400", farmId: w.home, farmName: "Home farm", request: { method: "POST", path: `/api/farming/farms/${w.home}/pasture/readings`, body: { paddockId: w.paddock, measuredOn: "2026-10-28", cover: "2400", method: "plate_meter" } } });
    const before = { reports: await count("select count(*) as n from safety_entries where kind = 'report'"), readings: await count("select count(*) as n from pasture_readings") };

    for (const other of [owner, aroha]) {
      signedIn = other;
      expect((await queue.sync(fetchSender(browserFetch))).stoppedBecause).toBe("account_changed");
      expect(queue.items().map((item) => item.status)).toEqual(["waiting", "waiting"]);
    }
    expect(await count("select count(*) as n from safety_entries where kind = 'report'")).toBe(before.reports);
    expect(await count("select count(*) as n from pasture_readings")).toBe(before.readings);

    signedIn = hemi;
    expect(await queue.sync(fetchSender(browserFetch))).toEqual({ sent: 2, refused: 0, stoppedBecause: "done" });
    const ids = queue.items().map((item) => item.operationId);
    const made = await as(owner)((tx) => tx.query<{ created_by_email: string }>("select created_by_email from pasture_readings where operation_id = any($1::uuid[])", [ids]));
    expect(made.rows.map((row) => row.created_by_email)).toEqual([hemi.email]);
  });

  it("refuses a request naming another account on any route, and says why", async () => {
    const response = await (reportsRoute.POST as Handler)(
      apiRequest("/api/farming/safety/reports", { method: "POST", cookie: cookies.get(owner.id), body: { organisationId: ORG, farmId: w.home, type: "near_miss", title: "Sent as the wrong person" }, headers: expectedAccountHeaders(hemi.id) }),
      params({}) as never,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(ACCOUNT_CHANGED_CODE);
  });

  it("tells a tab who's signed in now, so only the same account renews its offline session", async () => {
    const response = await (sessionRoute.GET as Handler)(apiRequest("/api/auth/session", { cookie: cookies.get(owner.id) }), params({}) as never);
    const body = await response.json();
    expect(sessionCheck(response.status, body, owner.id)).toBe("verified");
    expect(sessionCheck(response.status, body, hemi.id)).toBe("other_account");
    const none = await (sessionRoute.GET as Handler)(apiRequest("/api/auth/session"), params({}) as never);
    expect(sessionCheck(none.status, await none.json(), hemi.id)).toBe("signed_out");
  });
});
