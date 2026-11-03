import { describe, expect, it } from "vitest";
import { nextMenuIndex } from "@/lib/ui/menu-keys";

describe("nextMenuIndex (the ⋯ menu's keyboard)", () => {
  it("moves with the arrows and wraps at both ends", () => {
    expect(nextMenuIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextMenuIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextMenuIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextMenuIndex(1, "ArrowUp", 3)).toBe(0);
  });
  it("starts from the first or last item when nothing has focus", () => {
    expect(nextMenuIndex(-1, "ArrowDown", 4)).toBe(0);
    expect(nextMenuIndex(-1, "ArrowUp", 4)).toBe(3);
  });
  it("jumps with Home and End, and ignores other keys and empty menus", () => {
    expect(nextMenuIndex(2, "Home", 4)).toBe(0);
    expect(nextMenuIndex(0, "End", 4)).toBe(3);
    expect(nextMenuIndex(0, "a", 4)).toBeNull();
    expect(nextMenuIndex(0, "ArrowDown", 0)).toBeNull();
  });
});
