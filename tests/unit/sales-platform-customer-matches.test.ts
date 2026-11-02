import { describe, expect, it } from "vitest";
import { reasonFor } from "@/lib/sales-platforms/coverage-status";
import { sameNameMessage, separateNameCandidates } from "@/lib/sales-platforms/customer-matches";
import { problemReason } from "@/lib/sales-platforms/diagnostics";

/** #539 (SPC35-SPC37): same-name customers, with made-up people. */
describe("same-name customers to check", () => {
  it("says what to check without suggesting a changed email", () => {
    const withEmail = sameNameMessage("Shopify", { name: "Alex Example", email: "alex-b@example.test" }, "Alex Example");
    expect(withEmail).toBe(
      'Shopify customer Alex Example (alex-b@example.test) wasn\'t added: contact Alex Example has the same name but a different email, so they may be different people. Check who they are, then choose "Same person" or "Different person" under "Customers to check".',
    );
    const noEmail = sameNameMessage("WooCommerce", { name: "Alex Example", email: null }, "Alex Example");
    expect(noEmail).toContain("WooCommerce has no email to tell whether they're the same person");
    for (const message of [withEmail, noEmail]) expect(message).not.toMatch(/same email|give the contact|change/i);
  });

  it("gives the reason a plain label and an AI reason code", () => {
    const message = sameNameMessage("Shopify", { name: "Alex Example", email: null }, "Alex Example");
    expect(reasonFor(message)).toBe("same name as a contact: check who they are");
    expect(problemReason("skipped", message)).toBe("same_name_needs_check");
  });

  it("suggests names that tell a different person apart, within 150 characters", () => {
    expect(separateNameCandidates({ name: "Alex  Example", email: "alex-b@example.test", platform: "shopify", externalId: "1101" })).toEqual([
      "Alex Example (Shopify)",
      "Alex Example (alex-b@example.test)",
      "Alex Example (Shopify 1101)",
    ]);
    expect(separateNameCandidates({ name: "Alex Example", email: null, platform: "woocommerce", externalId: "7" })).toEqual([
      "Alex Example (WooCommerce)",
      "Alex Example (WooCommerce 7)",
    ]);
    const long = separateNameCandidates({ name: "A".repeat(160), email: null, platform: "shopify", externalId: "1" });
    for (const name of long) expect(name.length).toBeLessThanOrEqual(150);
    expect(long[0].endsWith(" (Shopify)")).toBe(true);
  });
});
