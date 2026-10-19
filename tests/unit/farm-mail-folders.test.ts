import { describe, expect, it } from "vitest";
import { folderSummary } from "@/lib/farming/calendar-shared";
import { gmailFolders, orderFolders, subfolderIds } from "@/lib/farming/mail-providers";

/** FC25, FC26 (#340): the folders and labels offered, as a tree, and a folder's subfolders. Made-up names. */
describe("farm mail folders", () => {
  it("offers Gmail's Inbox and the member's own labels, nested by name, not system labels", () => {
    const folders = gmailFolders([
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_9", name: "Farm/LIC/Herd tests", type: "user" },
      { id: "Label_2", name: "Farm/LIC", type: "user" },
      { id: "TRASH", name: "TRASH", type: "system" },
      { id: "Label_1", name: "Farm", type: "user" },
      { id: "Label_3", name: "accounts", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
      // A nested label whose parent label was deleted sits at the top.
      { id: "Label_4", name: "Old/Things", type: "user" },
    ]);
    expect(folders.map((folder) => [folder.id, folder.name, folder.path, folder.parentId, folder.depth])).toEqual([
      ["INBOX", "Inbox", "Inbox", null, 0],
      ["Label_3", "accounts", "accounts", null, 0],
      ["Label_1", "Farm", "Farm", null, 0],
      ["Label_2", "LIC", "Farm/LIC", "Label_1", 1],
      ["Label_9", "Herd tests", "Farm/LIC/Herd tests", "Label_2", 2],
      ["Label_4", "Things", "Old/Things", null, 0],
    ]);
    expect(subfolderIds(folders, "Label_1")).toEqual(["Label_2", "Label_9"]);
    expect(subfolderIds(folders, "Label_3")).toEqual([]);
  });

  it("orders Outlook folders as a tree, the Inbox first, and leaves orphans at the top", () => {
    const folders = orderFolders([
      { id: "b", name: "Board papers", path: "Inbox › Board papers", parentId: "i", depth: 9 },
      { id: "s", name: "Sent Items", path: "Sent Items", parentId: null, depth: 0 },
      { id: "f", name: "Farm", path: "Inbox › Farm", parentId: "i", depth: 9 },
      { id: "i", name: "Inbox", path: "Inbox", parentId: null, depth: 0 },
      { id: "a", name: "Archive", path: "Archive", parentId: null, depth: 0 },
      { id: "x", name: "Lost", path: "Lost", parentId: "gone", depth: 3 },
    ]);
    expect(folders.map((folder) => [folder.id, folder.depth, folder.parentId])).toEqual([
      ["i", 0, null],
      ["b", 1, "i"],
      ["f", 1, "i"],
      ["a", 0, null],
      ["x", 0, null],
      ["s", 0, null],
    ]);
  });

  it("says on the mailbox card what it reads", () => {
    expect(folderSummary([])).toBe("Not reading: no folders chosen");
    expect(
      folderSummary([
        { id: "1", externalId: "f", name: "Inbox › Farm", includeSubfolders: true, missing: false },
        { id: "2", externalId: "v", name: "Vet", includeSubfolders: false, missing: true },
      ]),
    ).toBe("Reads Inbox › Farm and its subfolders; Vet (not found in the mailbox)");
  });
});
