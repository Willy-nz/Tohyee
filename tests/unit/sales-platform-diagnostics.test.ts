import { describe, expect, it } from "vitest";
import { connectionAccess } from "@/lib/ai/tools";
import { problemReason, redactSecrets } from "@/lib/sales-platforms/diagnostics";

describe("sales platform diagnostics (#532, decisions 1248-1249)", () => {
  it("keeps only the host of web addresses and removes token-like text", () => {
    expect(redactSecrets("Set up at https://books.example.nz/api/sales-platforms/webhooks/org/abc?x=1 now")).toBe("Set up at https://books.example.nz/[removed] now");
    expect(redactSecrets("token shpat_abcdef123456 and ck_1234567890abcdef")).toBe("token [removed] and [removed]");
    expect(redactSecrets(`key ${"a".repeat(43)}.`)).toBe("key [removed].");
    expect(redactSecrets("Linked Shopify variant Gift box (SKU BOX-1) to item BOX-1.")).toBe("Linked Shopify variant Gift box (SKU BOX-1) to item BOX-1.");
  });

  it("gives problem lines a reason code, and none to the rest", () => {
    expect(problemReason("skipped", "Shopify variant X has no SKU, so it wasn't matched to an item or added.")).toBe("missing_sku");
    expect(problemReason("skipped", 'Shopify variant X wasn\'t matched or added: its SKU "A B" can\'t be an item code.')).toBe("invalid_sku");
    expect(problemReason("skipped", "Payouts aren't brought in: the app hasn't been given read_shopify_payments_payouts. Add them to the app's access scopes.")).toBe("missing_scope");
    expect(problemReason("waiting", "#1001 isn't paid yet (Shopify says PENDING), so it isn't invoiced.")).toBe("not_paid_yet");
    // Payouts and payment gateways (SPC38-SPC46).
    expect(problemReason("failed", "Payout 7 can't be posted: no fees account is chosen. Choose it in the Shopify settings; the payout is tried again at the next sync.")).toBe("payout_account_missing");
    expect(problemReason("failed", "Payout 7's transfer rows come to -40.00, but Tohyee expects one transfer of -49.38 for this payout, so record this payout by hand.")).toBe("payout_transfer_mismatch");
    expect(problemReason("failed", "Payout 7 has transactions of a type Tohyee doesn't post (SHOP_CASH_CREDIT); only charges... so record this payout by hand.")).toBe("unknown_payout_transaction");
    expect(problemReason("failed", "Payout 7's transactions come to 49.38 but the payout is 50.00, so nothing was posted.")).toBe("payout_doesnt_add_up");
    expect(problemReason("waiting", "Choose where afterpay payments go in the Shopify settings. It's tried again at the next sync.")).toBe("payment_method_not_mapped");
    expect(problemReason("failed", "#1001 was paid through more than one payment method (paypal, afterpay); split payments aren't supported yet, so it isn't invoiced.")).toBe("split_payment");
    expect(problemReason("failed", "Something new.")).toBe("other");
    expect(problemReason("linked", "Linked it.")).toBeNull();
  });
});

describe("get_organisation's access (#531, decision 1246)", () => {
  it("names the level the connection works at now, and says when the role caps it", () => {
    expect(connectionAccess({ accessLevel: "full", grantedAccessLevel: "full", role: "owner" })).toMatchObject({ access: "full", accessLabel: "Full access" });
    const capped = connectionAccess({ accessLevel: "post", grantedAccessLevel: "full", role: "bookkeeper" });
    expect(capped).toMatchObject({ access: "post", accessGranted: "full" });
    expect(capped.accessNote).toBe('This connection was given "Full access", but your role is now bookkeeper, so it works as "Make and post".');
  });
});
