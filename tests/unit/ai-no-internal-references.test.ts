import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { messageForAi, problemReason } from "@/lib/sales-platforms/diagnostics";

/**
 * #578: what the AI reads (tool descriptions, input schemas and the fixed
 * words in answers) carries no internal issue numbers ("#548") or decision
 * numbers ("decision 537"). They mean nothing to an AI or the person it's
 * helping. Store data such as order names ("#1001") isn't fixed text and
 * isn't checked here.
 */
const INTERNAL = /#\d{2,}|\bdecisions? \d+/i;

function strings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((entry, index) => strings(entry, `${path}[${index}]`, out));
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) strings(entry, `${path}.${key}`, out);
}

describe("AI-facing text has no internal references (#578)", () => {
  it("no tool title, description or input schema cites an issue or decision number", () => {
    const found: Array<[string, string]> = [];
    for (const tool of AI_TOOLS) strings({ title: tool.title, description: tool.description, inputSchema: tool.inputSchema }, tool.name, found);
    expect(found.filter(([, text]) => INTERNAL.test(text)).map(([path, text]) => `${path}: ${text.match(INTERNAL)![0]}`)).toEqual([]);
  });

  it("customers' email addresses are taken out of log messages the AI reads", () => {
    expect(
      messageForAi(
        `Shopify customer Aroha (aroha.example@example.com) wasn't added: contact Aroha has the same name but a different email, so they may be different people.`,
      ),
    ).toBe("Shopify customer Aroha wasn't added: contact Aroha has the same name but a different email, so they may be different people.");
    expect(messageForAi("Sent to kiri@example.co.nz today.")).toBe("Sent to today.");
  });

  it("known causes have a specific reason code, never other", () => {
    const cases: Array<[string, string]> = [
      ["Payout 70001 has transfer transactions; only charges, refunds, adjustments, chargebacks and reserves are posted, so record this payout by hand.", "payout_refused_before_update"],
      ["Payout 70002 is a withdrawal (money taken from the bank); those aren't supported yet.", "payout_refused_before_update"],
      ["Payout 70003 has transactions of a type Tohyee doesn't post (SHOP_CASH_CREDIT); only charges, refunds, adjustments, chargebacks, reserves and the payout's own transfer are posted, so record this payout by hand.", "unknown_payout_transaction"],
      ["Payout 70004 is 0.00; only payouts of more than nothing are posted.", "zero_payout"],
      ["Payout 70005 has more balance transactions than Tohyee reads.", "too_many_transactions"],
      ["Payout 70006 has a dispute_withdrawal transaction of 5.00; Tohyee expects it to be negative, so record this payout by hand.", "unexpected_sign"],
      ["Payout 70007 has a chargeback. Choose a chargebacks account in the Shopify settings.", "account_not_set"],
      ["Payout 70008 (10.00) couldn't be posted: the period is closed. It's tried again at the next sync.", "posting_error"],
      ["Payout 70009's transfer rows come to -5.00, but Tohyee expects one transfer of -10.00 for this payout, so record this payout by hand.", "payout_transfer_mismatch"],
      ["Shopify customer Aroha (aroha.example@example.com) wasn't added: there's already a contact called Aroha with a different email. Give the contact the same email to link them.", "same_name_needs_check"],
    ];
    for (const [message, reason] of cases) expect([message, problemReason("skipped", message)]).toEqual([message, reason]);
  });
});
