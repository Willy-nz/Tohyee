import { route, withOrganisation } from "@/lib/api/http";
import { freshnessRead } from "@/lib/analytics/read-routes";

/** How fresh a report's data is (decision 698; src/lib/analytics/read-routes.ts). */
export const GET = route(freshnessRead(withOrganisation));
