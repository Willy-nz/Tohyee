import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganisationPicker } from "@/components/app-shell";
import { WorkspaceProvider, type WorkspaceOrganisation } from "@/components/workspace";

/*
 * The demo farm is added on the server, where organisations are added (#445):
 * the books' organisation menu no longer offers it, but one already made
 * still opens from the menu, marked DEMO.
 */
const user = { id: "00000000-0000-4000-8000-000000000001", email: "kim@example.com", displayName: "Kim", isServerAdmin: true };
const real: WorkspaceOrganisation = { id: "harbour-bowls", displayName: "Harbour Bowling Club", baseCurrency: "NZD", role: "owner", status: "ready" };
const demo: WorkspaceOrganisation = { id: "demo-farm-00000000", displayName: "Kōwhai Dairies Ltd", baseCurrency: "NZD", role: "owner", status: "ready", isDemo: true };

function render(organisations: WorkspaceOrganisation[]) {
  return renderToStaticMarkup(createElement(WorkspaceProvider, { user, organisations } as Parameters<typeof WorkspaceProvider>[0], createElement(OrganisationPicker)));
}

describe("the books' organisation menu (#445)", () => {
  it("doesn't offer the demo farm, even to a server admin", () => {
    const html = render([real]);
    expect(html).toContain("Harbour Bowling Club");
    expect(html).not.toMatch(/demo farm/i);
    expect(html).not.toContain("demo-farm");
  });

  it("says there are no organisations rather than offering the demo farm", () => {
    const html = render([]);
    expect(html).toContain("No organisations yet");
    expect(html).not.toMatch(/demo/i);
  });

  it("still lists a demo farm already made, with its DEMO badge, and no reset or delete entry", () => {
    const html = render([demo, real]);
    expect(html).toContain("Kōwhai Dairies Ltd (demo)");
    expect(html).toContain(">DEMO<");
    expect(html).not.toMatch(/Reset or delete/);
    expect(html).not.toContain("/operations/demo-farm");
    expect(html.match(/<option/g)).toHaveLength(2);
  });
});
