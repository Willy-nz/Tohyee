import { describe, expect, it } from "vitest";
import { csvCell, fromCsvCell, toCsv } from "@/lib/csv";

describe("CSV cells can't run as formulas (#148, decision 109)", () => {
  it("puts an apostrophe before text a spreadsheet would run, but not before numbers", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+64 21 555 0101")).toBe("'+64 21 555 0101");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell("Kobe Ltd")).toBe("Kobe Ltd");
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(toCsv([["Code", "Name"], ["1000", "=cmd"]])).toBe("Code,Name\r\n1000,'=cmd\r\n");
  });

  it("an import takes the apostrophe off again, and only that", () => {
    expect(fromCsvCell("'=cmd")).toBe("=cmd");
    expect(fromCsvCell("'+64 21 555 0101")).toBe("+64 21 555 0101");
    expect(fromCsvCell("'Twas")).toBe("'Twas");
    expect(fromCsvCell("'-12.50")).toBe("'-12.50");
  });
});
