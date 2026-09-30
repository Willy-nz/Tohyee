import type { Env } from "./config";
import { cleanUp, type Deps, handle } from "./handler";

function deps(): Deps {
  return { fetch: (input, init) => fetch(input, init), now: () => new Date() };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, deps());
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanUp(env, deps()));
  },
} satisfies ExportedHandler<Env>;
