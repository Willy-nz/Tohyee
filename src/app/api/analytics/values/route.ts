import { route, withOrganisation } from "@/lib/api/http";
import { valuesRead } from "@/lib/analytics/read-routes";

/** The values a slicer offers (src/lib/analytics/read-routes.ts; decisions 360, 697, 757). */
export const GET = route(valuesRead(withOrganisation));
