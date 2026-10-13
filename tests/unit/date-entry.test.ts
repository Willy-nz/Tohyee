import { describe, expect, it } from "vitest";
import { isIsoDate, parseDateEntry, showDateEntry } from "@/lib/date-entry";

const TODAY = "2026-10-14";
const read = (text: string, base?: string) => parseDateEntry(text, TODAY, base);

describe("typed dates, day first (#258)", () => {
  it("reads full and short NZ dates", () => {
    expect(read("14/10/2026")).toBe("2026-10-14");
    expect(read("4/3/26")).toBe("2026-03-04");
    expect(read("14-10-2026")).toBe("2026-10-14");
    expect(read("14.10.26")).toBe("2026-10-14");
    expect(read("14 10 2026")).toBe("2026-10-14");
    expect(read(" 14/10 ")).toBe("2026-10-14");
    expect(read("2026-10-14")).toBe("2026-10-14");
    expect(read("31/12/99")).toBe("1999-12-31");
  });

  it("reads digits only, day first", () => {
    expect(read("1410")).toBe("2026-10-14");
    expect(read("0103")).toBe("2026-03-01");
    expect(read("141026")).toBe("2026-10-14");
    expect(read("14102026")).toBe("2026-10-14");
    expect(read("9")).toBe("2026-10-09");
  });

  it("counts days and weeks from the base date, or today", () => {
    expect(read("t")).toBe(TODAY);
    expect(read("today")).toBe(TODAY);
    expect(read("+14")).toBe("2026-10-28");
    expect(read("-3")).toBe("2026-10-11");
    expect(read("+14", "2026-12-20")).toBe("2027-01-03");
    expect(read("+2w", "2026-10-01")).toBe("2026-10-15");
  });

  it("reads +20m as the 20th of the following month (NZ trade terms)", () => {
    expect(read("+20m")).toBe("2026-11-20");
    expect(read("+20m", "2026-12-05")).toBe("2027-01-20");
    // February is shorter: the last day of the month.
    expect(read("+31m", "2027-01-15")).toBe("2027-02-28");
    expect(read("-20m")).toBeNull();
    expect(read("+40m")).toBeNull();
  });

  it("refuses what isn't a date", () => {
    for (const text of ["", "31/02/2026", "13/13/2026", "32", "abc", "12345", "2026-02-30", "1/1/1800"]) expect(read(text)).toBeNull();
  });

  it("shows ISO dates day first", () => {
    expect(showDateEntry("2026-10-14")).toBe("14/10/2026");
    expect(showDateEntry("")).toBe("");
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });
});
