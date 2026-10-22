import { queryRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/**
 * POST: a saved tile's answer for the PowerPoint add-in (#429, decision
 * 837), with the reader's dates, slicers, clicks and drill-down, as
 * /api/analytics/query answers it. A POST only because the reader's view
 * doesn't fit an address; it reads, in a read-only transaction, and never a
 * question someone types (only `dashboardId` + `tileId`).
 */
export const POST = officeRoute(queryRead(withOfficeOrganisation, { savedOnly: true }));
