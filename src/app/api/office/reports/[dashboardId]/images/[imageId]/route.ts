import { imageRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: one of a report's images, for the PowerPoint add-in (#429): only for people who can see the report. */
export const GET = officeRoute(imageRead(withOfficeOrganisation));
