import type { BackupHeader } from "@/lib/backups/format";

/**
 * Words for the restore wizard (#389 part 3). Pure, so the page and the
 * tests share them; nothing here touches a key.
 */

type Found = { name: string; header: BackupHeader | null; problem: string | null; compatible: boolean };

/** What a backup is, which key opens it, and what to give for it. */
export function describeBackup(backup: Found): { what: string; key: string; needs: string; note: string | null } {
  const header = backup.header;
  if (!header) return { what: backup.name, key: "", needs: "", note: backup.problem };
  const what = header.kind === "server" ? "People and settings (the server's own database)" : (header.displayName ?? header.organisationId ?? "An organisation");
  const note = !backup.compatible ? `Made by a newer Tohyee (${header.tohyeeVersion}): update this server first.` : null;
  return {
    what,
    key: `Recovery kit v${header.recoveryKey.version}`,
    needs: `This backup needs recovery key version ${header.recoveryKey.version} (fingerprint ${header.recoveryKey.id}). If this server didn't make it, give that server's recovery code, or its recovery file and passphrase.`,
    note,
  };
}

/** The cutover checklist after a restore: what to do before switching to the copy. */
export function cutoverChecklist(report: { reconnect: string[]; queuedEmails: number; privateMail: { ownersNotHere: number } }): string[] {
  const items = [
    "Open the restored organisation and check its books: the trial balance, the latest invoices and bills, and bank balances.",
    "Make sure the original installation is switched off (or will never run again) before turning on automatic jobs here, so nothing is sent or imported twice.",
  ];
  if (report.reconnect.length > 0) items.push(`Connect again what couldn't be carried over: ${report.reconnect.join(", ")}.`);
  items.push("Set up this server's own email sending, remote access and folders (they aren't in an organisation's backup).");
  if (report.privateMail.ownersNotHere > 0) items.push("Recover the people from the server backup, so private mail copies get their owners back.");
  items.push(
    report.queuedEmails > 0
      ? `Turn on automatic jobs. ${report.queuedEmails} queued ${report.queuedEmails === 1 ? "email is" : "emails are"} then sent.`
      : "Turn on automatic jobs.",
  );
  items.push("Choose this server's backup folder, back up, and save and check this server's own recovery kit: it has its own recovery key.");
  items.push("Keep the old backups and the old recovery kit until the new backups have been running for a while; they're what you fall back on.");
  items.push("Tell people the new address, if it changed.");
  return items;
}
