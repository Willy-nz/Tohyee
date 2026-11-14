import { route, withOrganisation } from "@/lib/api/http";
import { placedReportRead } from "@/lib/analytics/read-routes";

/** GET: an accounting report placed on a report's page (#710), for people who can see the Analytics report (src/lib/analytics/read-routes.ts). */
export const GET = route(placedReportRead(withOrganisation));
