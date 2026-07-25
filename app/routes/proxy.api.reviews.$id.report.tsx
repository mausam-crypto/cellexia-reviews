/**
 * Storefront proxy: `POST /apps/cellexia/api/reviews/:id/report`
 * → `/proxy/api/reviews/:id/report`.
 *
 * Body: `{ "token": "<visitor uuid>", "reason": "<REPORT_REASONS key>" }`.
 * At ≥ 3 distinct reports the service flips the review back to PENDING for
 * re-moderation (SPEC §6). Rate limited at 20/h per shop:ip (SPEC §10).
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { REPORT_REASONS } from "~/types/cellexia";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  isNotFoundError,
  readJsonBody,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { reportReview } from "~/services/reviews.server";

const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_MAX = 128;

export async function loader() {
  return errorJson(405, { _: "method_not_allowed" });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return errorJson(405, { _: "method_not_allowed" });
  }

  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request); // SPEC-1.6 §2 — fire-and-forget, throttled

  const reviewId = params.id ?? "";
  if (!REVIEW_ID_RE.test(reviewId)) {
    return errorJson(404, { _: "not_found" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "report")) {
    return errorJson(429, { _: "rate_limited" });
  }

  const body = await readJsonBody(request);

  // SPEC-1.2 gating: the preview token comes from the JSON body parsed above
  // (the request stream is consumed — never re-read it here).
  const previewToken =
    typeof body?.preview_token === "string" ? body.preview_token : null;
  if (!(await requireLiveOrPreview(shop, request, previewToken))) {
    return errorJson(403, { _: "not_live" });
  }

  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > TOKEN_MAX) {
    return errorJson(422, { token: "invalid" });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) {
    return errorJson(422, { reason: "invalid" });
  }

  try {
    await reportReview(shop, reviewId, token, reason);
    return json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (isNotFoundError(error)) {
      return errorJson(404, { _: "not_found" });
    }
    console.error("[cellexia] reportReview failed", error);
    return errorJson(500, { _: "server_error" });
  }
}
