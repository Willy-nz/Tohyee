import { describe, expect, it } from "vitest";
import { NO_PAYROLL_ACCESS } from "@/components/payroll-access";
import { PAYROLL_ACCESS_MESSAGE } from "@/lib/payroll/access";

describe("payroll access message (PE10)", () => {
  it("the screen says the same as the API when someone has no payroll access", () => {
    expect(NO_PAYROLL_ACCESS).toBe(PAYROLL_ACCESS_MESSAGE);
    expect(NO_PAYROLL_ACCESS).toBe(
      "You need payroll access to see payroll. Ask an admin to give it to you in Settings › Payroll access.",
    );
  });
});
