import { describe, expect, it } from "vitest";
import { filedName, fileNamePattern, normaliseSender, ruleMatches, ruleText } from "@/lib/private-mail/filing-types";
import { importSource } from "@/lib/farming/soil";

/** Filing from My mail (#250; PM22, PM26): the rules' matching and the filed name, Claude's rules, not yet reviewed. */
describe("filing from My mail", () => {
  it("PM26 a rule's sender is an address or @domain, lower case", () => {
    expect(normaliseSender("Results@SoilLab.example")).toBe("results@soillab.example");
    expect(normaliseSender("@SoilLab.example")).toBe("@soillab.example");
    expect(normaliseSender("soillab.example")).toBe("@soillab.example");
    expect(normaliseSender("  ")).toBeNull();
    expect(() => normaliseSender("Soil Lab")).toThrow("The sender must be an email address");
  });

  it("PM26 a rule matches every part it has", () => {
    const csv = { sender: "results@soillab.example", fileName: "Soil results P12.CSV" };
    expect(ruleMatches({ sender: "@soillab.example", fileName: null }, csv)).toBe(true);
    expect(ruleMatches({ sender: "@lab.example", fileName: null }, csv)).toBe(false);
    // A domain matches the end of the address, not a look-alike.
    expect(ruleMatches({ sender: "@soillab.example", fileName: null }, { ...csv, sender: "x@notsoillab.example.nz" })).toBe(false);
    expect(ruleMatches({ sender: "results@soillab.example", fileName: "*.csv" }, csv)).toBe(true);
    expect(ruleMatches({ sender: "results@soillab.example", fileName: "*.pdf" }, csv)).toBe(false);
    expect(ruleMatches({ sender: null, fileName: "soil*" }, csv)).toBe(true);
    expect(ruleMatches({ sender: null, fileName: "soil results p1?.csv" }, csv)).toBe(true);
    expect(ruleMatches({ sender: null, fileName: "results*" }, csv)).toBe(false);
    expect(ruleMatches({ sender: "@soillab.example", fileName: null }, { ...csv, sender: null })).toBe(false);
    // A rule with nothing matches nothing.
    expect(ruleMatches({ sender: null, fileName: null }, csv)).toBe(false);
    // Regular expression characters in a pattern are just characters.
    expect(fileNamePattern("a.(1)+.csv").test("a.(1)+.csv")).toBe(true);
    expect(fileNamePattern("a.(1)+.csv").test("aX(1)+.csv")).toBe(false);
    expect(ruleText({ sender: "@soillab.example", fileName: "*.csv" })).toBe("Attachments from anyone at soillab.example named *.csv");
    expect(ruleText({ sender: "results@soillab.example", fileName: null })).toBe("Attachments from results@soillab.example");
  });

  it("PM22 the filed name keeps the attachment's ending", () => {
    expect(filedName("Invoice 4471 Rangi.pdf", null)).toBe("Invoice 4471 Rangi.pdf");
    expect(filedName("Invoice 4471 Rangi.pdf", "  Invoice 4471.PDF ")).toBe("Invoice 4471.PDF");
    expect(() => filedName("Invoice.pdf", "Invoice.txt")).toThrow("Keep the file's ending (.pdf)");
    expect(() => filedName("Invoice.pdf", "../Invoice.pdf")).toThrow("slashes");
    expect(() => filedName("Invoice.pdf", `${"a".repeat(200)}.pdf`)).toThrow("1 to 200 characters");
  });

  it("PM21 an import's source says it was filed from a private email, within 200 characters", () => {
    expect(importSource("hills.csv")).toBe("Imported from hills.csv");
    expect(importSource("hills.csv", { filedFromPrivateMail: true })).toBe("Imported from hills.csv, filed from a private email");
    expect(importSource(`${"a".repeat(300)}.csv`, { filedFromPrivateMail: true })).toHaveLength(200);
  });
});
