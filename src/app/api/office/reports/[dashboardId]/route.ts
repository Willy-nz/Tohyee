import { dashboardRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: a report for the PowerPoint add-in, as GET /api/analytics/dashboards/<id> gives it (#429, decision 837). */
export const GET = officeRoute(dashboardRead(withOfficeOrganisation));
