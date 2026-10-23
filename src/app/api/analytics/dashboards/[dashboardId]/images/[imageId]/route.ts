import { route, withOrganisation } from "@/lib/api/http";
import { imageRead } from "@/lib/analytics/read-routes";

/** GET: one of a report's images, for people who can see the report (decision 360; src/lib/analytics/read-routes.ts). */
export const GET = route(imageRead(withOrganisation));
