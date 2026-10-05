import type { MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { mimeParts } from "@/lib/analytics/report-email-providers";

describe("IMAP report email attachments (#149)", () => {
  it("keeps .xlsx attachments, as Gmail and Microsoft 365 do", () => {
    const structure = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 10 },
        { part: "2", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", disposition: "attachment", dispositionParameters: { filename: "Sales.xlsx" }, encoding: "base64", size: 400 },
        { part: "3", type: "text/csv", disposition: "attachment", dispositionParameters: { filename: "stock.csv" }, encoding: "7bit", size: 50 },
        { part: "4", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "Report.pdf" }, encoding: "base64", size: 400 },
      ],
    } as unknown as MessageStructureObject;
    expect(mimeParts(structure).map((part) => part.name)).toEqual(["Sales.xlsx", "stock.csv"]);
  });
});
