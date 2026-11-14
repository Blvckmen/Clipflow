import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { runPublisher } from "../lib/publisher";

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    // Test-only: wrangler's local cron trigger doesn't reach this Worker, so tests/publishing.e2e.mjs runs the
    // publisher through this path. Only active when ENABLE_TEST_CRON=1, which deployments never set.
    if (env.ENABLE_TEST_CRON === "1") {
      const url = new URL(request.url);
      if (url.pathname === "/__test/cron") {
        const time = Number(url.searchParams.get("time")) || Date.now();
        return runPublisher(env, time).then(() => new Response("ok"), error => new Response(String(error?.stack ?? error), { status: 500 }));
      }
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
  // Cron trigger (every minute when deployed with scripts/deploy-cloudflare.mjs): publish approved clips.
  scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    // The run's scheduled time is "now" for the publisher (also lets local tests simulate later runs).
    ctx.waitUntil(runPublisher(env, controller.scheduledTime).catch(error => console.error("Publisher run failed:", error)));
  },
};
