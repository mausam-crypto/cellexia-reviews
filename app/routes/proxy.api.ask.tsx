/**
 * Storefront proxy: `POST /apps/<subpath>/api/ask` → `/proxy/api/ask`
 * (SPEC-1.16 §3 — the "Looking for specific info?" review Q&A).
 *
 * Body (JSON): { product_id, question, locale?, preview_token? }.
 * Response: { answer, quotes: [{id, excerpt, author, rating}] } — the answer
 * speaks as the brand (first person plural) and every quote excerpt is a
 * server-verified verbatim substring of a published review.
 *
 * Proxy-verified, live/preview-gated, and doubly rate limited: the `ask`
 * bucket (20/h per shop:ip) here plus qna.server's per-shop daily cap of
 * fresh model calls. Cache hits bypass the model entirely and are cheap, but
 * still ride the bucket (an answer endpoint is a scrape target).
 * Errors follow the sibling-route envelope: {"ok":false,"errors":{...}}.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  matchShopLocale,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { askReviews } from "~/services/qna.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return errorJson(405, { _: "method_not_allowed" });
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request);

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "ask")) {
    return errorJson(429, { _: "rate_limited" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorJson(400, { _: "invalid_json" });
  }

  // Review fix: POSTs carry the preview token in the BODY (withPreview, same
  // as /translate) — gating must see it or a merchant preview's first
  // question would 403 and tear the preview session down.
  const previewToken =
    typeof body.preview_token === "string" ? body.preview_token : null;
  if (!(await requireLiveOrPreview(shop, request, previewToken))) {
    return errorJson(403, { _: "not_live" });
  }

  const productId = String(body.product_id ?? "").trim();
  if (!productId || !/^\d+$/.test(productId)) {
    return errorJson(422, { product_id: "invalid" });
  }
  const question = String(body.question ?? "").trim();
  if (question.length < 3 || question.length > 200) {
    return errorJson(422, { question: "invalid" });
  }
  const locale = matchShopLocale(typeof body.locale === "string" ? body.locale : null);

  try {
    const result = await askReviews(shop, productId, question, locale);
    switch (result.status) {
      case "ok":
        return json(result.response, { headers: NO_STORE_HEADERS });
      case "capped":
        return errorJson(429, { _: "rate_limited" });
      case "no_ai":
        return errorJson(403, { _: "qna_disabled" });
      default:
        return errorJson(502, { _: "qna_failed" });
    }
  } catch (error) {
    console.error("[cellexia] askReviews failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

export async function loader() {
  return errorJson(405, { _: "method_not_allowed" });
}
