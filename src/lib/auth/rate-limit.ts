import { RequestLimiter } from "@/lib/ai/limits";
import { sessionMetaFrom } from "@/lib/auth/sessions";
import { TooManyRequestsError } from "@/lib/errors";

/**
 * A light per-address limit on the sign-in routes (#130), on top of the
 * per-account limits: password and code tries from one address, together.
 * Kept in memory, so a restart starts again. Behind a proxy the address is
 * what the proxy says (X-Forwarded-For), so it's a brake, not the guard: the
 * per-account counts are. With no address (no proxy in front), it doesn't
 * apply: one shared bucket would let anyone lock everyone out.
 */
export const SIGN_IN_TRIES_PER_MINUTE = 30;

const limiter = new RequestLimiter(SIGN_IN_TRIES_PER_MINUTE);

export function assertSignInRate(request: Request): void {
  const address = sessionMetaFrom(request).ipAddress;
  if (address && !limiter.take(address)) throw new TooManyRequestsError("Too many sign-in attempts from this address. Wait a minute, then try again.");
}
