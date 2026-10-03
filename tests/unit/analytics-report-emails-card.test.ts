import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { imapFolderRequest, ReportEmailsCard } from "@/components/analytics-report-emails";

vi.mock("@/components/hooks", () => ({
  useApiData: () => ({
    data: {
      accounts: [{ id: "1", email: "reports@example.test", provider: "google" }],
      mailboxes: [{
        id: "2", kind: "imap", accountId: null, email: null, host: "imap.gmail.com", port: 993,
        username: "reports@example.test", folderId: "Reports", folderName: "Reports", replace: true, hasPassword: true,
      }],
      checks: [{ id: "3", mailboxId: "2", startedAt: "2026-10-03T04:00:00Z", finishedAt: "2026-10-03T04:01:00Z", filesSaved: 2, status: "ok", error: null }],
    },
    error: null,
    reload: vi.fn(),
  }),
}));

describe("Report emails card", () => {
  const render = () => renderToStaticMarkup(createElement(ReportEmailsCard, { organisationId: "example", folderChosen: true, onChanged: () => undefined }));

  it("omits the saved mailbox ID for new IMAP folder requests, but includes it when editing", () => {
    expect(imapFolderRequest("imap.example.test", "reports", "app-password", null)).toEqual({
      host: "imap.example.test", port: 993, username: "reports", password: "app-password",
    });
    expect(imapFolderRequest("imap.example.test", "reports", "", "2")).toMatchObject({ mailboxId: "2", password: "" });
  });

  it("explains read-only access, whole-mailbox permissions, limitations and mailbox rules", () => {
    const html = render();
    expect(html).toContain("permissions cover the whole mailbox");
    expect(html).toContain("never moves, marks as read, labels or deletes");
    expect(html).toContain("Microsoft 365 has turned off IMAP passwords");
    expect(html).toContain("Looker Studio sends only PDFs");
    expect(html).toContain("rule in your mailbox");
    expect(html).toContain("25 MB per attachment");
    expect(html).toContain("100 MB per check");
  });

  it("shows mailbox choices, saved configurations and job-written checks without a password value", () => {
    const html = render();
    expect(html).toContain("reports@example.test");
    expect(html).toContain("IMAP with an app password");
    expect(html).toContain("Check now");
    expect(html).toContain("Reports");
    expect(html).toContain("Newest file");
    expect(html).toContain("Last checks");
    expect(html).toContain('type="password"');
    expect(html).not.toContain("ciphertext");
    expect(html).not.toContain("secret");
  });
});
