import { afterAll, beforeAll, expect, it } from "vitest";
import * as dashboardRoute from "@/app/api/analytics/dashboards/[dashboardId]/route";
import * as dashboardsRoute from "@/app/api/analytics/dashboards/route";
import * as themeRoute from "@/app/api/analytics/themes/[themeId]/route";
import * as themesRoute from "@/app/api/analytics/themes/route";
import * as settingsRoute from "@/app/api/organisations/[organisationId]/settings/route";
import { closeAnalytics } from "@/lib/analytics/engine";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "theme-co";
const noContext = undefined as unknown;

/** Report themes (#376, decision 668): saved for the organisation, chosen per report. */
describeWithDatabase("analytics report themes", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let ownerCookie: string;
  let viewerCookie: string;

  const body = async (response: Response) => ({
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- checked field by field
    data: (await response.json()) as Record<string, any>,
  });

  const theme = {
    name: "Shop colours",
    light: { series: ["#1f5fae", "#d66919", "#009e98"], page: "#f5f7fa", card: "#ffffff", text: "#1b2533", mutedText: "#546072" },
    font: "verdana",
    card: { radius: 12, shadow: "soft" },
    unknown: "dropped",
  };

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("theme-owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    viewer = await createTestUser("theme-viewer@example.com");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    ownerCookie = await sessionCookieFor(owner);
    viewerCookie = await sessionCookieFor(viewer);
    await settingsRoute.PATCH(
      apiRequest(`/api/organisations/${ORG}/settings`, { method: "PATCH", cookie: ownerCookie, body: { analyticsEnabled: true } }),
      params({ organisationId: ORG }),
    );
  });

  afterAll(async () => {
    await closeAnalytics(ORG);
    await server?.teardown();
  });

  let themeId = "";
  let dashboardId = "";

  it("saves a theme for the organisation (bookkeepers and up), checked, with dark worked out", async () => {
    const refused = await themesRoute.POST(apiRequest("/api/analytics/themes", { method: "POST", cookie: viewerCookie, body: { organisationId: ORG, theme } }), noContext);
    expect(refused.status).toBe(403);
    const bad = await body(
      await themesRoute.POST(
        apiRequest("/api/analytics/themes", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, theme: { ...theme, light: { ...theme.light, card: "white" } } } }),
        noContext,
      ),
    );
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/colour like/);

    const made = await body(await themesRoute.POST(apiRequest("/api/analytics/themes", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, theme } }), noContext));
    expect(made.status).toBe(201);
    themeId = made.data.theme.id;
    expect(made.data.theme.theme.name).toBe("Shop colours");
    expect(made.data.theme.theme.dark.series).toHaveLength(3);
    expect("unknown" in made.data.theme.theme).toBe(false);
    expect(made.data.theme.reports).toBe(0);
    expect(Array.isArray(made.data.theme.warnings)).toBe(true);

    const twin = await themesRoute.POST(apiRequest("/api/analytics/themes", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, theme: { ...theme, name: "shop COLOURS" } } }), noContext);
    expect(twin.status).toBe(400);

    const listed = await body(await themesRoute.GET(apiRequest(`/api/analytics/themes?organisationId=${ORG}`, { cookie: viewerCookie }), noContext));
    expect(listed.data.themes.map((entry: { id: string }) => entry.id)).toEqual([themeId]);
  });

  it("keeps existing reports unchanged, and lets a report choose a theme and chart type defaults", async () => {
    const made = await body(
      await dashboardsRoute.POST(apiRequest("/api/analytics/dashboards", { method: "POST", cookie: ownerCookie, body: { organisationId: ORG, name: "Plain" } }), noContext),
    );
    dashboardId = made.data.dashboard.id;
    expect(made.data.dashboard.settings).toEqual({ from: null, to: null, preset: null, slicers: [] });

    const missing = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings: { slicers: [], theme: "custom:999999" } } }),
        params({ dashboardId }),
      ),
    );
    expect(missing.status).toBe(400);

    const settings = {
      slicers: [],
      theme: `custom:${themeId}`,
      visualDefaults: { column: { labels: { show: true }, kpi: { target: "5" } }, kpi: { kpi: { target: "100", downIsGood: true } }, rocket: {} },
    };
    const saved = await body(
      await dashboardRoute.PATCH(apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings } }), params({ dashboardId })),
    );
    expect(saved.status).toBe(200);
    expect(saved.data.dashboard.settings.theme).toBe(`custom:${themeId}`);
    expect(saved.data.dashboard.settings.visualDefaults).toEqual({ column: { labels: { show: true } }, kpi: { kpi: { downIsGood: true } } });
    // Read with the report, so anyone who can see it gets its colours.
    const read = await body(await dashboardRoute.GET(apiRequest(`/api/analytics/dashboards/${dashboardId}?organisationId=${ORG}`, { cookie: viewerCookie }), params({ dashboardId })));
    expect(read.data.dashboard.customTheme.name).toBe("Shop colours");

    const builtIn = await body(
      await dashboardRoute.PATCH(
        apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings: { slicers: [], theme: "harbour" } } }),
        params({ dashboardId }),
      ),
    );
    expect(builtIn.data.dashboard.settings.theme).toBe("harbour");
    expect(builtIn.data.dashboard.customTheme).toBeUndefined();
    const neon = await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings: { slicers: [], theme: "neon" } } }),
      params({ dashboardId }),
    );
    expect(neon.status).toBe(400);
  });

  it("changes a theme for every report using it, and won't remove one in use", async () => {
    await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings: { slicers: [], theme: `custom:${themeId}` } } }),
      params({ dashboardId }),
    );
    const changed = await body(
      await themeRoute.PATCH(
        apiRequest(`/api/analytics/themes/${themeId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, theme: { ...theme, name: "Shop colours 2026" } } }),
        params({ themeId }),
      ),
    );
    expect(changed.data.theme.theme.name).toBe("Shop colours 2026");
    expect(changed.data.theme.reports).toBe(1);

    const inUse = await body(await themeRoute.DELETE(apiRequest(`/api/analytics/themes/${themeId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ themeId })));
    expect(inUse.status).toBe(400);
    expect(inUse.data.error).toMatch(/used by 1 report/);

    await dashboardRoute.PATCH(
      apiRequest(`/api/analytics/dashboards/${dashboardId}`, { method: "PATCH", cookie: ownerCookie, body: { organisationId: ORG, settings: { slicers: [] } } }),
      params({ dashboardId }),
    );
    const viewerDelete = await themeRoute.DELETE(apiRequest(`/api/analytics/themes/${themeId}?organisationId=${ORG}`, { method: "DELETE", cookie: viewerCookie }), params({ themeId }));
    expect(viewerDelete.status).toBe(403);
    const removed = await themeRoute.DELETE(apiRequest(`/api/analytics/themes/${themeId}?organisationId=${ORG}`, { method: "DELETE", cookie: ownerCookie }), params({ themeId }));
    expect(removed.status).toBe(200);
    const listed = await body(await themesRoute.GET(apiRequest(`/api/analytics/themes?organisationId=${ORG}`, { cookie: ownerCookie }), noContext));
    expect(listed.data.themes).toEqual([]);
  });
});
