import { afterAll, beforeAll, expect, it } from "vitest";
import { getDashboardPreference, saveDashboardPreference } from "@/lib/dashboard/preferences";
import { coreQuery } from "@/lib/db/transactions";
import type { SessionUser } from "@/lib/auth/sessions";
import {
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

describeWithDatabase("dashboard preferences", () => {
  let server: TestServer;
  let owner: SessionUser;
  let userA: SessionUser;
  let userB: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("dashboard-owner@example.com", { serverAdmin: true });
    userA = await createTestUser("dashboard-a@example.com");
    userB = await createTestUser("dashboard-b@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `dashboard-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper'), ($1, $3, 'bookkeeper')", [org, userA.id, userB.id]);
    return { org };
  }

  it("remembers hide and tile order per user and per page", async () => {
    const world = await setup();
    const asUserA = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(world.org, { userId: userA.id, email: userA.email }, work);
    const asUserB = <T>(work: Parameters<typeof inOrganisation<T>>[2]) => inOrganisation(world.org, { userId: userB.id, email: userB.email }, work);
    const defaults = ["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"] as const;

    expect(await asUserA((tx) => getDashboardPreference(tx, { userId: userA.id, page: "home", defaultTiles: defaults }))).toEqual({
      hidden: false,
      tiles: [...defaults],
    });

    await asUserA((tx) =>
      saveDashboardPreference(tx, {
        userId: userA.id,
        page: "home",
        hidden: true,
        tiles: ["next_gst_return", "cash_in_bank", "bills_to_pay", "owed_to_you"],
        defaultTiles: defaults,
      }),
    );

    expect(await asUserA((tx) => getDashboardPreference(tx, { userId: userA.id, page: "home", defaultTiles: defaults }))).toEqual({
      hidden: true,
      tiles: ["next_gst_return", "cash_in_bank", "bills_to_pay", "owed_to_you"],
    });

    // Another page for the same person is independent.
    expect(await asUserA((tx) => getDashboardPreference(tx, { userId: userA.id, page: "sales", defaultTiles: defaults }))).toEqual({
      hidden: false,
      tiles: [...defaults],
    });

    // Another person isn't affected.
    expect(await asUserB((tx) => getDashboardPreference(tx, { userId: userB.id, page: "home", defaultTiles: defaults }))).toEqual({
      hidden: false,
      tiles: [...defaults],
    });
  });
});
