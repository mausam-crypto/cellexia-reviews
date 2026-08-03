/**
 * Storefront proxy: `GET /apps/cellexia/api/summary?product_id=…&locale=fr`
 * → `/proxy/api/summary`.
 *
 * Returns `{ "summary": SummaryDTO | null }`. The service generates and
 * caches the locale variant on demand by TRANSLATING the default-locale
 * summary — it never generates a summary from scratch on this path
 * (SPEC §6). AI features degrade gracefully: any failure → `summary: null`.
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
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
import { localizeSummary, maybeScheduleFirstGeneration } from "~/services/ai.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request); // SPEC-1.6 §2 — fire-and-forget, throttled

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "summary")) {
    return errorJson(429, { _: "rate_limited" });
  }

  // SPEC-1.2 gating: not-live shops serve zero data unless the request
  // carries the current preview token (`preview_token` query param).
  if (!(await requireLiveOrPreview(shop, request))) {
    return errorJson(403, { _: "not_live" });
  }

  const params = new URL(request.url).searchParams;

  const productId = (params.get("product_id") ?? "").trim();
  if (!productId) {
    return errorJson(422, { product_id: "required" });
  }
  if (!/^\d+$/.test(productId)) {
    return errorJson(422, { product_id: "invalid" });
  }

  const locale = matchShopLocale(params.get("locale"));

  try {
    const summary = await localizeSummary(shop, productId, locale);
    // v1.16 (SPEC-1.16 §1): no summary anywhere for this product yet —
    // schedule the first generation in the background (debounced, silent).
    if (!summary) maybeScheduleFirstGeneration(shop, productId);
    return json({ summary }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[cellexia] localizeSummary failed", error);
    return json({ summary: null }, { headers: NO_STORE_HEADERS });
  }
}

export async function action() {
  return errorJson(405, { _: "method_not_allowed" });
}
