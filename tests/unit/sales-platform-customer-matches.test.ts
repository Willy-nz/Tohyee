import { describe, expect, it } from "vitest";
import { reasonFor } from "@/lib/sales-platforms/coverage-status";
import { isWeakName, sameNameMessage, separateNameCandidates, testCustomerReason } from "@/lib/sales-platforms/customer-matches";
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

/** Decisions 1335 and 1339, with made-up people. */
describe("weak names and test customers", () => {
  it("treats a single name, or an email or phone as the name, as weak", () => {
    for (const name of ["Kiri", "  kiri  ", "Mary-Jane", "pip@made-up.test", "+64 21 000 0000", ""]) expect(isWeakName(name)).toBe(true);
    for (const name of ["Kiri Tane", "Alex Example", "Sam Rua Rua", "J. Smith"]) expect(isWeakName(name)).toBe(false);
    expect(isWeakName("Kiri Tane", { email: "kiri tane" })).toBe(true);
  });

  it("names a weak-named customer's contact by their email first", () => {
    expect(separateNameCandidates({ name: "Kiri", email: "kiri.b@made-up.test", platform: "shopify", externalId: "1201", weak: true })).toEqual([
      "Kiri (kiri.b@made-up.test)",
      "Kiri (Shopify)",
      "Kiri (Shopify 1201)",
    ]);
    // An email as the name isn't repeated as its own suffix.
    expect(separateNameCandidates({ name: "pip@made-up.test", email: "pip@made-up.test", platform: "shopify", externalId: "1202", weak: true })).toEqual([
      "pip@made-up.test (Shopify)",
      "pip@made-up.test (Shopify 1202)",
    ]);
  });

  it("spots test customers by tag or an example address", () => {
    expect(testCustomerReason({ email: "a@example.com", tags: [] })).toBe("its email is at example.com, a made-up address");
    expect(testCustomerReason({ email: "a@shop.example.org" })).toMatch(/shop\.example\.org/);
    expect(testCustomerReason({ email: "b@made-up.test", tags: ["TEST"] })).toBe('it\'s tagged "test"');
    for (const email of ["c@example.com.au", "d@example.co.nz", "e@notexample.com", null]) expect(testCustomerReason({ email, tags: ["tester"] })).toBeNull();
  });

  it("gives the new reasons AI codes", () => {
    expect(problemReason("skipped", "Shopify customer Pip is a test customer (its email is at example.com, a made-up address), so no contact was added.")).toBe("test_customer");
    expect(reasonFor("Shopify customer Pip is a test customer (it's tagged \"test\"), so no contact was added.")).toBe("test customer");
    expect(problemReason("waiting", "#1004's customer couldn't be linked to a contact (see the customer's line in this log), so the order waits. It's tried again at the next sync.")).toBe(
      "customer_not_linked",
    );
    expect(problemReason("skipped", "Shopify variant Mug wasn't linked: item SHOPIFY-3 is already linked to Shopify variant 4 with the same made-up code.")).toBe("already_linked");
  });
});
