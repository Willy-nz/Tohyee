import { route, withOrganisation } from "@/lib/api/http";
import { queryRead } from "@/lib/analytics/read-routes";

/**
 * Answers a tile's question (src/lib/analytics/read-routes.ts): a saved
 * tile's (`dashboardId` + `tileId`), which is all a report viewer may run
 * (decision 360), or any question for viewers and up.
 */
export const POST = route(queryRead(withOrganisation));
