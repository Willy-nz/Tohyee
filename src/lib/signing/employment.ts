import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { requirePayrollAccess } from "@/lib/payroll/access";
import { getEmployee } from "@/lib/payroll/employees";
import { createSigningRequest, listSigningRequests, type SendContext, type SendResult } from "@/lib/signing/service";
import type { SigningRequestView } from "@/lib/signing/shared";
import { requireString } from "@/lib/validation";

/*
 * Employment agreements (decision 1408): the agreement, as a PDF someone
 * uploads (Tohyee doesn't write agreements), sent from the employee's
 * payroll record to the employee and anyone signing for the employer. Kept
 * with the employee; only people with payroll access see or send them.
 */

const MAX_BASE64 = Math.ceil((25 * 1024 * 1024 * 4) / 3) + 8;

export function decodePdf(input: unknown): Uint8Array {
  if (typeof input !== "string" || !input) throw new ValidationError("Choose the PDF to send.");
  if (input.length > MAX_BASE64) throw new ValidationError("A PDF to sign can be at most 25 MB.");
  return new Uint8Array(Buffer.from(input, "base64"));
}

export async function sendEmploymentAgreement(
  tx: OrgTx,
  employeeId: string,
  input: { source?: unknown; idempotencyKey: unknown; title?: unknown; fileName?: unknown; contentBase64?: unknown; signers: unknown; signingOrder?: unknown; message?: unknown; expiresInDays?: unknown; remindEveryDays?: unknown },
  context: SendContext,
): Promise<SendResult> {
  await requirePayrollAccess(tx);
  const employee = await getEmployee(tx, employeeId);
  if (!employee.email) throw new ValidationError(`Add ${employee.firstName}'s email address to their payroll details first: they sign with a link sent to it.`);
  const signers = Array.isArray(input.signers) ? input.signers : [];
  if (!signers.some((signer) => String((signer as { email?: unknown })?.email ?? "").trim().toLowerCase() === employee.email!.toLowerCase())) {
    throw new ValidationError(`${employee.firstName} ${employee.lastName} (${employee.email}) must be one of the people signing.`);
  }
  const title = input.title ? requireString(input.title, "Title", { maxLength: 200 }) : `Employment agreement, ${employee.firstName} ${employee.lastName}`;
  return createSigningRequest(
    tx,
    {
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      title,
      sourceKind: "employment",
      sourceId: employee.id,
      fileName: typeof input.fileName === "string" ? input.fileName : "employment agreement.pdf",
      bytes: decodePdf(input.contentBase64),
      signers,
      signingOrder: input.signingOrder,
      message: input.message,
      expiresInDays: input.expiresInDays,
      remindEveryDays: input.remindEveryDays,
    },
    context,
  );
}

export async function listEmploymentAgreements(tx: OrgTx, employeeId: string): Promise<SigningRequestView[]> {
  await requirePayrollAccess(tx);
  await getEmployee(tx, employeeId);
  return listSigningRequests(tx, { sourceKind: "employment", sourceId: employeeId });
}
