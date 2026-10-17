import { type AiTool, DATE, schema, type ToolContext, ToolFileAnswer } from "@/lib/ai/tools";
import { IDEMPOTENCY, idempotencyKey } from "@/lib/ai/write-tools";
import { roleAtLeast } from "@/lib/auth/roles";
import { ForbiddenError } from "@/lib/errors";
import { getIrdDocument, getIrdDocumentContent, listIrdDocuments, listProposals, proposeIrdFigures } from "@/lib/tax/income/ird-documents";
import { getIncomeTaxYear, listPayments, requireIncomeYear } from "@/lib/tax/income/service";

/*
 * The AI's income tax tools (examples ITX30-ITX35, decision 549): it can
 * read IRD documents and the typed figures, and propose figures for a person
 * to accept. Income tax is for owners and admins only (decision 545), so
 * every tool here needs the key's owner to be an owner or admin now, whatever
 * the key's level. The AI never changes the figures itself.
 */

function requireTaxRole(context: ToolContext): void {
  if (!roleAtLeast(context.role, "admin")) throw new ForbiddenError("Income tax is only for owners and admins, and this key's owner isn't one.");
}

const MONEY = { type: "string", description: "An amount like 17668.00." } as const;

export const TAX_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_ird_documents",
    title: "IRD documents",
    level: "read",
    minRole: "admin",
    description: "IRD files people uploaded on the Income tax page (assessments, statements of account, provisional tax letters): file name, income year if given, note, and who added it. Owners and admins only.",
    inputSchema: schema({}),
    async run(tx, _args, context) {
      requireTaxRole(context);
      return { documents: await listIrdDocuments(tx), waitingProposals: (await listProposals(tx)).map((proposal) => ({ id: proposal.id, incomeYear: proposal.incomeYear, documentId: proposal.documentId })) };
    },
  },
  {
    name: "read_ird_document",
    title: "Read an IRD document",
    level: "read",
    minRole: "admin",
    description:
      "One IRD document with its file, so you can read IRD's figures from it: the assessed residual income tax (RIT) and the date the return was filed, losses, tax credits, and payments with their dates. Then propose them with propose_ird_figures; a person checks them.",
    inputSchema: schema({ documentId: { type: "string", description: "From list_ird_documents." } }, ["documentId"]),
    async run(tx, args, context) {
      requireTaxRole(context);
      const document = await getIrdDocument(tx, args.documentId);
      const file = await getIrdDocumentContent(tx, document.id);
      return new ToolFileAnswer({ document }, { uri: `tohyee://ird-documents/${document.id}/${encodeURIComponent(file.fileName)}`, ...file });
    },
  },
  {
    name: "get_income_tax_figures",
    title: "Typed income tax figures",
    level: "read",
    minRole: "admin",
    description: "What's typed for an income year (the 2026 income year is 1 April 2025 to 31 March 2026): IRD's assessed RIT and filing date, losses brought forward, tax credits, other income, and payments to IRD towards that year. Owners and admins only.",
    inputSchema: schema({ incomeYear: { type: "integer", minimum: 2025, maximum: 2100 } }, ["incomeYear"]),
    async run(tx, args, context) {
      requireTaxRole(context);
      const incomeYear = requireIncomeYear(args.incomeYear);
      return { figures: await getIncomeTaxYear(tx, incomeYear), payments: await listPayments(tx, incomeYear) };
    },
  },
];

export const TAX_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "propose_ird_figures",
    title: "Propose IRD figures",
    level: "draft",
    minRole: "admin",
    description:
      "Proposes IRD's figures for an income year, usually from an IRD document you've read: assessed RIT with the date the return was filed (both or neither), losses brought forward, tax credits (RWT, PAYE and other refundable credits), imputation credits on dividends received, overseas tax paid, an individual's other income, and payments to IRD towards that year. Give a note saying where in the document each figure is. Nothing changes until a person checks the proposal against the document and accepts it on the Income tax page. Owners and admins only.",
    inputSchema: schema(
      {
        incomeYear: { type: "integer", minimum: 2025, maximum: 2100, description: "The 2026 income year is 1 April 2025 to 31 March 2026." },
        documentId: { type: "string", description: "The IRD document the figures come from, from list_ird_documents." },
        assessedRit: MONEY,
        returnFiledOn: DATE,
        lossesBroughtForward: MONEY,
        taxCredits: MONEY,
        imputationCredits: MONEY,
        overseasTaxPaid: MONEY,
        otherIncome: MONEY,
        payments: {
          type: "array",
          maxItems: 50,
          items: { type: "object", properties: { paidOn: DATE, amount: MONEY, note: { type: "string" } }, required: ["paidOn", "amount"], additionalProperties: false },
        },
        note: { type: "string", description: "Where in the document the figures are, for the person checking." },
        idempotencyKey: IDEMPOTENCY,
      },
      ["incomeYear"],
    ),
    async run(tx, args, context) {
      requireTaxRole(context);
      const result = await proposeIrdFigures(tx, {
        idempotencyKey: idempotencyKey(args.idempotencyKey),
        incomeYear: args.incomeYear,
        documentId: args.documentId,
        assessedRit: args.assessedRit,
        returnFiledOn: args.returnFiledOn,
        lossesBroughtForward: args.lossesBroughtForward,
        taxCredits: args.taxCredits,
        imputationCredits: args.imputationCredits,
        overseasTaxPaid: args.overseasTaxPaid,
        otherIncome: args.otherIncome,
        payments: args.payments,
        note: args.note,
      });
      return { ...result, note: "Saved as a proposal. A person checks it against the document and accepts or declines it on the Income tax page." };
    },
  },
];
