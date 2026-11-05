import { afterAll, beforeAll, expect, it } from "vitest";
import * as activityRoute from "@/app/api/organisations/[organisationId]/members/[userId]/activity/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import { ACTIVITY_PAGE, memberActivity, type MemberActivity } from "@/lib/organisations/activity";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "activity-paging";
const TIE = "2026-10-01T09:30:00.123456Z";

/**
 * "What they did" paging (#609 item 3; decisions 1510-1511). Events that
 * share a timestamp, in one stream or across the books and server streams,
 * are each returned once, and hidden events stay hidden on every page. Every
 * person and event is made up.
 */
describeWithDatabase("'What they did' paging", () => {
  let server: TestServer;
  let owner: SessionUser;
  let admin: SessionUser;
  let busy: SessionUser;
  let mixed: SessionUser;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("page-owner@example.com", { serverAdmin: true, displayName: "Aroha Owner" });
    admin = await createTestUser("page-admin@example.com", { displayName: "Rangi Admin" });
    busy = await createTestUser("page-busy@example.com", { displayName: "Kiri Bookkeeper" });
    mixed = await createTestUser("page-mixed@example.com", { displayName: "Tama Bookkeeper" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'bookkeeper'), ($1, $4, 'bookkeeper')", [ORG, admin.id, busy.id, mixed.id]);
    // 150 visible events at one instant (a batch), with private mail and
    // payroll events at the same instant mixed between them.
    await inOrganisation(ORG, { userId: busy.id, email: busy.email }, (tx) =>
      tx.query(
        `insert into audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details, created_at)
         select case when n % 5 = 0 then 'private_mail.copy_deleted' when n % 5 = 1 then 'payroll.pay_run_posted' else 'bank_line.matched' end,
                case when n % 5 = 0 then 'private_mail_copy' when n % 5 = 1 then 'pay_run' else 'bank_line' end,
                n::text, $1::uuid, $2, '{}'::jsonb, $3::timestamptz
           from generate_series(0, 249) n`,
        [busy.id, busy.email, TIE],
      ),
    );
    // Across both streams: books and server events at the same instant, and
    // one a microsecond later (kept apart, not rounded to the millisecond).
    await inOrganisation(ORG, { userId: mixed.id, email: mixed.email }, (tx) =>
      tx.query(
        `insert into audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details, created_at)
         select 'invoice.approved', 'invoice', n::text, $1::uuid, $2, '{}'::jsonb, $3::timestamptz from generate_series(1, 120) n
         union all select 'invoice.voided', 'invoice', '0', $1::uuid, $2, '{}'::jsonb, $3::timestamptz + interval '1 microsecond'`,
        [mixed.id, mixed.email, TIE],
      ),
    );
    await coreQuery(
      `insert into admin_audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details, created_at)
       select 'organisation.ai_token_created', 'organisation', $1, $2::uuid, $3, '{}'::jsonb, $4::timestamptz from generate_series(1, 90)
       union all select 'organisation.ai_token_created', 'organisation', 'another-org', $2::uuid, $3, '{}'::jsonb, $4::timestamptz`,
      [ORG, mixed.id, mixed.email, TIE],
    );
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const pages = async (userId: string) => {
    const seen: MemberActivity["entries"][] = [];
    let before: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: MemberActivity = await inOrganisation(ORG, { userId: admin.id, email: admin.email }, (tx) => memberActivity(tx, userId, before));
      seen.push(result.entries);
      before = result.before;
      if (!before) break;
    }
    return seen;
  };

  it("150 events with one timestamp: 100, then the other 50, each once", async () => {
    const seen = await pages(busy.id);
    expect(seen.map((page) => page.length)).toEqual([ACTIVITY_PAGE, 50]);
    const all = seen.flat();
    expect(all.every((entry) => entry.what === "Bank line matched" && entry.where === "books")).toBe(true);
    expect(new Set(all.map((entry) => entry.key)).size).toBe(150);
    // Private mail and payroll stay hidden on every page (the admin has no payroll access).
    expect(all.some((entry) => /private mail|payroll|pay run/i.test(entry.what))).toBe(false);
  });

  it("ties across the books and the server stream, with microseconds kept", async () => {
    const seen = await pages(mixed.id);
    const all = seen.flat();
    expect(seen.map((page) => page.length)).toEqual([ACTIVITY_PAGE, ACTIVITY_PAGE, 11]);
    expect(new Set(all.map((entry) => entry.key)).size).toBe(211);
    expect(all.filter((entry) => entry.where === "books").length).toBe(121);
    expect(all.filter((entry) => entry.where === "server").length).toBe(90);
    // The one a microsecond later is first; another organisation's server event never shows.
    expect(all[0].what).toBe("Invoice voided");
  });

  it("through the API, the cursor goes back as `before`; a made-up one is refused", async () => {
    const cookie = await sessionCookieFor(admin);
    const get = (before?: string) =>
      activityRoute.GET(apiRequest(`/api/organisations/${ORG}/members/${busy.id}/activity${before ? `?before=${encodeURIComponent(before)}` : ""}`, { cookie }), params({ organisationId: ORG, userId: busy.id }));
    const first = (await (await get()).json()) as MemberActivity;
    expect(first.entries.length).toBe(ACTIVITY_PAGE);
    expect(first.before).toBeTruthy();
    const second = (await (await get(first.before!)).json()) as MemberActivity;
    expect([second.entries.length, second.before]).toEqual([50, null]);
    const keys = new Set([...first.entries, ...second.entries].map((entry) => entry.key));
    expect(keys.size).toBe(150);
    expect((await get("not-a-cursor")).status).toBe(400);
  });
});
