import { valuesRead } from "@/lib/analytics/read-routes";
import { officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/** GET: the values one of a report's slicers offers, for the PowerPoint add-in (#429): only a slicer on that report. */
export const GET = officeRoute(valuesRead(withOfficeOrganisation, { reportOnly: true }));
