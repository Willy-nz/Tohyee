import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { NotFoundError } from "@/lib/errors";

/*
 * The one door to a private mail copy (#250; PM7, PM8, decision 611).
 * Every listing, search, email, attachment, folder choice, deletion and AI
 * tool goes through a MailOwner, and a MailOwner exists only for the
 * signed-in person while they're an Owner of the organisation now, with an
 * active login, acting on Tohyee's own screens (or, PR 2 of #250, through
 * an AI key its owner gave the private-mail scope). Every query is then
 * limited to copies whose owner_user_id is that person's: there's no way
 * to name someone else's. Everyone else (admins, other Owners, accountants,
 * server admins, report viewers, custom apps, AI keys without the scope,
 * the scheduler) gets "not found", the same as for a copy that doesn't
 * exist, so not even whether one exists leaks.
 */

/** The same answer for every refusal. */
export function notFound(): NotFoundError {
  return new NotFoundError("Not found.");
}

export type MailChannel = { aiTokenId: string };

/** How a MailOwner was let in: Tohyee's screens, or one AI key the owner gave the private-mail scope. */
export type MailOwnerVia = "screen" | { aiTokenId: string };

export class MailOwner {
  private constructor(
    readonly userId: string,
    readonly organisationId: string,
    readonly via: MailOwnerVia,
  ) {}

  /**
   * The signed-in person as the owner of their own private mail, or "not
   * found". The role is read from the server's own records now, never from
   * the request, so a role taken away a moment ago counts. `channel` is
   * only for the AI key check (which also checks the key's scope).
   */
  static async of(tx: OrgTx, channel?: MailChannel & { granted: (tx: OrgTx, userId: string, tokenId: string) => Promise<boolean> }): Promise<MailOwner> {
    const userId = tx.actor.userId;
    if (!userId) throw notFound();
    // Anything acting through a key (AI keys, farm app keys) isn't let in,
    // unless it's an AI key its owner gave the private-mail scope.
    if (tx.actor.via && !channel) throw notFound();
    const found = await coreQuery<{ role: string; is_active: boolean }>(
      `select m.role, u.is_active from organisation_members m join users u on u.id = m.user_id
        where m.organisation_id = $1 and m.user_id = $2`,
      [tx.organisationId, userId],
    );
    const row = found.rows[0];
    if (!row || row.role !== "owner" || !row.is_active) throw notFound();
    if (channel && !(await channel.granted(tx, userId, channel.aiTokenId))) throw notFound();
    return new MailOwner(userId, tx.organisationId, channel ? { aiTokenId: channel.aiTokenId } : "screen");
  }

  /** For the tx it was made in only: refuses another organisation's transaction. */
  check(tx: OrgTx): void {
    if (tx.organisationId !== this.organisationId || tx.actor.userId !== this.userId) throw notFound();
  }
}

/** Whether a member is an Owner with an active login now (for the scheduler, PM8). */
export async function isActiveOwner(organisationId: string, userId: string): Promise<boolean> {
  const found = await coreQuery<{ ok: boolean }>(
    `select (m.role = 'owner' and u.is_active) as ok from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and m.user_id = $2`,
    [organisationId, userId],
  );
  return found.rows[0]?.ok === true;
}
