import { RequestLimiter } from "@/lib/ai/limits";
import { type Actor, assertOrganisationUsable, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { getOrganisation, parseOrganisationId } from "@/lib/organisations/registry";
import { loadMemberNames } from "@/lib/people/names";
import { hashToken, type LinkSigner, type RequestRow, signedCopyForToken, signerForToken } from "@/lib/signing/service";
import { TOKEN_PATTERN } from "@/lib/signing/shared";

/*
 * The signer's link (decision 1398): no Tohyee login. The random token in
 * the address finds the signer in that organisation's own database only, so
 * a token from one organisation never opens another's. Every refusal is the
 * same "not found", and requests are limited per link.
 */

const limiter = new RequestLimiter(60, 10 * 60 * 1000);
const LINK_ACTOR: Actor = { userId: null, email: "signing link", via: "signing link" };

async function organisationFor(organisationInput: string) {
  let organisationId: string;
  try {
    organisationId = parseOrganisationId(organisationInput);
  } catch {
    return null;
  }
  const organisation = await getOrganisation(organisationId);
  if (!organisation) return null;
  try {
    assertOrganisationUsable(organisation);
  } catch {
    return null;
  }
  return organisation;
}

/** Runs `work` for an open signer link, or returns null alike for anything wrong with it. */
export async function withSigningLink<T>(organisationInput: string, token: string, work: (tx: OrgTx, found: { request: RequestRow; signer: LinkSigner }) => Promise<T>): Promise<T | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const organisation = await organisationFor(organisationInput);
  if (!organisation) return null;
  if (!limiter.take(`${organisation.id}:${hashToken(token)}`)) return null;
  const people = await loadMemberNames(organisation.id);
  return withOrganisationTransaction(
    organisation,
    LINK_ACTOR,
    async (tx) => {
      const found = await signerForToken(tx, token);
      return found ? work(tx, found) : null;
    },
    { people },
  );
}

/** The signed copy behind a "download the signed copy" link, or null. */
export async function signedCopyForLink(organisationInput: string, token: string): Promise<{ fileName: string; content: Buffer } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const organisation = await organisationFor(organisationInput);
  if (!organisation) return null;
  if (!limiter.take(`${organisation.id}:copy:${hashToken(token)}`)) return null;
  return withOrganisationTransaction(organisation, LINK_ACTOR, (tx) => signedCopyForToken(tx, token));
}
