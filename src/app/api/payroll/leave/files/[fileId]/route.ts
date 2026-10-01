import { route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getLeaveFile } from "@/lib/payroll/leave-records";

type Context = { params: Promise<{ fileId: string }> };

/** A file kept with a leave record (a cash-up request, an agreement). Payroll access. */
export const GET = route<Context>(async (request, context) => {
  const { fileId } = await context.params;
  const params = searchParams(request);
  const file = await withPayrollAccess(request, params.get("organisationId"), (tx) => getLeaveFile(tx, fileId));
  return fileResponse(file, params.get("download") === "1");
});
