import { describe, expect, it } from "vitest";
import { joinName } from "@/lib/sales-platforms/shopify";

/** Jess's issue 8 (11 Nov 2026): a name Shopify holds in both fields comes in once. Made-up names. */
describe("Shopify customer names", () => {
  it("uses a whole name held in both first and last once", () => {
    expect(joinName("K A Smith", "K A Smith")).toBe("K A Smith");
    expect(joinName("ari tane", "Ari Tane")).toBe("ari tane");
    expect(joinName("Mere Ngata", "Ngata")).toBe("Mere Ngata");
    expect(joinName("Mere", "Mere Ngata")).toBe("Mere Ngata");
  });
  it("joins first and last as before", () => {
    expect(joinName("Mere", "Ngata")).toBe("Mere Ngata");
    expect(joinName("  Mere ", null)).toBe("Mere");
    expect(joinName(null, "")).toBeNull();
  });
});
