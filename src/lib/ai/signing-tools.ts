import { CURSOR, boundedLimit, pageAfter } from "@/lib/ai/limits";
import { type AiTool, schema } from "@/lib/ai/tools";
import { getSigningRequest, listSigningRequests } from "@/lib/signing/service";
import { SOURCE_KINDS, type SigningRequestView } from "@/lib/signing/shared";

/**
 * E-signatures for an AI (decision 1406): read only. It can list signing
 * requests and see where one is up to, but never send, void, remind or
 * sign: a signature is a person's own act, so no tool signs for anyone.
 * The same rules as the screens decide what it sees (employment agreements
 * only with payroll access, for example).
 */

function summary(request: SigningRequestView) {
  return {
    id: request.id,
    title: request.title,
    sourceKind: request.sourceKind,
    sourceId: request.sourceId,
    state: request.state,
    signingOrder: request.signingOrder,
    documentName: request.documentName,
    documentSha256: request.documentSha256,
    signedCopy: request.signedFileId !== null,
    signedSha256: request.signedSha256,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    completedAt: request.completedAt,
    voidReason: request.voidReason,
    signers: request.signers.map((signer) => ({ position: signer.position, name: signer.name, email: signer.email, roleLabel: signer.roleLabel, status: signer.status, signedAt: signer.signedAt, method: signer.method, declineReason: signer.declineReason })),
  };
}

export const SIGNING_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_signing_requests",
    title: "Signing requests",
    level: "read",
    description: "Documents sent to sign electronically (quotes, financial statements, employment agreements, safety inductions, other PDFs), newest first, with each signer's status. Read only: it can't send, remind or sign.",
    inputSchema: schema({
      sourceKind: { type: "string", enum: [...SOURCE_KINDS], description: "What the request is for." },
      sourceId: { type: "string", description: "The quote id, year-end date (YYYY-MM-DD), employee id or other id it's for." },
      state: { type: "string", enum: ["sent", "completed", "declined", "voided", "expired"], description: "sent means waiting for signatures." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
      cursor: CURSOR,
    }),
    async run(tx, args) {
      const requests = await listSigningRequests(tx, { sourceKind: args.sourceKind, sourceId: args.sourceId, state: args.state, limit: 500 });
      const { rows, ...rest } = pageAfter(requests.map(summary), (row) => row.id, args.cursor, boundedLimit(args.limit, 50, 200));
      return { signingRequests: rows, ...rest };
    },
  },
  {
    name: "get_signing_request",
    title: "One signing request",
    level: "read",
    description: "One signing request: its signers and their status, the document fingerprint (SHA-256), whether a signed copy is kept, and its history. Read only.",
    inputSchema: schema({ signingRequestId: { type: "string", description: "The signing request's id, from list_signing_requests." } }, ["signingRequestId"]),
    async run(tx, args) {
      const request = await getSigningRequest(tx, args.signingRequestId);
      return { ...summary(request), history: request.events.map((event) => ({ event: event.event, at: event.at, signerId: event.signerId })) };
    },
  },
];
