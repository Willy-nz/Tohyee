import { freshnessRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: how fresh a report's data is (decision 698), for the PowerPoint add-in (#429). */
export const GET = officeRoute(freshnessRead(withOfficeOrganisation));
