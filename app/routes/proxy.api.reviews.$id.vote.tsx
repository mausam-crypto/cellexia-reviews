/**
 * Storefront proxy: `POST /apps/cellexia/api/reviews/:id/vote`
 * → `/proxy/api/reviews/:id/vote`.
 *
 * Body: `{ "token": "<visitor uuid>" }`. Increments the helpful counter,
 * idempotent per visitor token (SPEC §6). Rate limited at 60/h per
 * shop:ip (SPEC §10).
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  isNotFoundError,
  readJsonBody,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { voteHelpful } from "~/services/reviews.server";

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

  const reviewId = params.id ?? "";
  if (!REVIEW_ID_RE.test(reviewId)) {
    return errorJson(404, { _: "not_found" });
  }

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "vote")) {
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

  try {
    const helpfulCount = await voteHelpful(shop, reviewId, token);
    return json({ ok: true, helpfulCount }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (isNotFoundError(error)) {
      return errorJson(404, { _: "not_found" });
    }
    console.error("[cellexia] voteHelpful failed", error);
    return errorJson(500, { _: "server_error" });
  }
}
