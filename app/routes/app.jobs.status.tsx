/**
 * Cellexia Reviews — generation-job status resource route (SPEC-1.7 §5).
 *
 * GET /app/jobs/status → `authenticate.admin` → `activeJobSummary(shop)` as
 * JSON with `Cache-Control: no-store` (the payload changes every few seconds
 * and must never be cached by the embedded iframe or any proxy).
 *
 * The route also calls `kickRunner()` on every poll, so any polling client —
 * the global GenerationActivityBar or the QA-data jobs card — keeps a stalled
 * runner alive (kickRunner is idempotent and non-blocking per SPEC-1.7 §3).
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";

import { authenticate } from "~/shopify.server";
import { activeJobSummary, kickRunner } from "~/services/jobs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    kickRunner();
  } catch (error) {
    // The runner failing to (re)start must never break the status poll.
    console.error("[cellexia] jobs.status kickRunner failed", error);
  }

  try {
    const summary = await activeJobSummary(session.shop);
    return json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[cellexia] jobs.status summary failed", error);
    // A JSON error body keeps the polling clients simple (they check res.ok
    // and silently retry on the next tick).
    return json(
      { active: 0, jobs: [], error: "status_unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
