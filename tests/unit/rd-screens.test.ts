import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelinessBadge } from "@/components/rd";

/** The "entered late" flag on tags and usage entries (RD21, RD22; decision 38). */
describe("R&D screens", () => {
  const render = (daysAfterWork: number, enteredLate: boolean, timelinessText: string) =>
    renderToStaticMarkup(
      createElement(TimelinessBadge, {
        timeliness: { workDate: "2026-07-01", enteredOn: "2026-07-01", daysAfterWork, enteredLate, timelinessText, changedDaysAfterEntry: null },
      }),
    );

  it("RD21: entered 2 days after the work shows how long, without a flag", () => {
    const html = render(2, false, "entered 2 days after the work");
    expect(html).toContain("entered 2 days after the work");
    expect(html).not.toContain("Entered late");
  });

  it("RD22: entered more than 14 days after the work is flagged “Entered late”", () => {
    const html = render(15, true, "entered 15 days after the work");
    expect(html).toContain("Entered late");
    expect(html).toContain("entered 15 days after the work");
  });
});
