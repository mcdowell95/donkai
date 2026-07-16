import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logEvent } from "../registry/db.js";
import { wakeOrchestrator } from "../control/actions.js";

// Linear webhook = doorbell only. The payload is never trusted for enqueueing;
// the next tick's pollReady() does the authoritative Linear query, keeping all
// reconciliation logic single-sourced. Missed deliveries cost nothing — the
// interval poll still catches everything.
export function buildLinearWebhook(): Hono {
  const app = new Hono();

  app.post("/linear", async (c) => {
    const secret = config.webhooks.linearSecret;
    if (!secret) return c.text("webhook disabled", 404);

    const raw = await c.req.text();
    const signature = c.req.header("linear-signature") ?? "";
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.text("bad signature", 401);
    }

    try {
      const payload = JSON.parse(raw) as {
        type?: string;
        action?: string;
        data?: { state?: { name?: string }; identifier?: string };
      };
      const stateName = payload.data?.state?.name?.toLowerCase();
      const relevant =
        payload.type === "Issue" &&
        (stateName === config.states.ready.toLowerCase() || payload.action === "update");
      if (relevant) {
        logEvent(payload.data?.identifier ?? null, "webhook_doorbell", {
          action: payload.action,
          state: payload.data?.state?.name,
        });
        wakeOrchestrator("linear-webhook");
      }
    } catch {
      // Malformed body after a valid signature: still ring the bell.
      wakeOrchestrator("linear-webhook");
    }

    return c.json({ ok: true });
  });

  return app;
}
