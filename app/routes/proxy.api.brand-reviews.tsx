/**
 * Storefront proxy: `GET /apps/cellexia/api/brand-reviews`
 * → `/proxy/api/brand-reviews` (SPEC-1.9 §1).
 *
 * Serves the brand-wide "Overall reviews" block:
 * `{ stats: ShopStatsDTO, reviews: BrandReviewDTO[] }` (+ pagination fields)
 * over every product's PUBLISHED reviews, ordered by the brand auto score —
 * the optional `stars` (1–5) filter applies before scoring, and hand-picked
 * reviews occupy the first slots when unfiltered. Product info on each card
 * comes from Review rows only: no Admin API call anywhere on this path.
 *
 * Params: `page` (1-based, default 1), `per_page` (default 12, max 24),
 * `stars` (1–5, optional).
 *
 * Proxy-verified, rate limited (`brand`: 120/h per shop:ip) and gated by the
 * SPEC-1.2 live/preview rules exactly like the sibling routes. Caching
 * follows the product reviews list: `public, max-age=60` for ordinary
 * (live-store) traffic, `no-store` whenever the request carried a valid
 * preview token — tokenized merchant traffic is never handed to a shared
 * cache. The ReviewDTO whitelist rules are unchanged (no admin-only fields;
 * the merchant-only `meta` contract does not exist on this route at all).
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  NO_STORE_HEADERS,
  REVIEWS_CACHE_HEADERS,
  errorJson,
  getClientIp,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import {
  DEFAULT_BRAND_PER_PAGE,
  MAX_BRAND_PER_PAGE,
  listBrandReviews,
} from "~/services/brand.server";
import { getSettings } from "~/services/settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request); // SPEC-1.6 §2 — fire-and-forget, throttled

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "brand")) {
    return errorJson(429, { _: "rate_limited" });
  }

  // SPEC-1.2 gating: not-live shops serve zero data unless the request
  // carries the current preview token (`preview_token` query param).
  if (!(await requireLiveOrPreview(shop, request))) {
    return errorJson(403, { _: "not_live" });
  }

  const params = new URL(request.url).searchParams;
  const errors: Record<string, string> = {};

  const page = parsePositiveInt(params.get("page"), 1);

  let perPage = DEFAULT_BRAND_PER_PAGE;
  const perPageRaw = params.get("per_page");
  if (perPageRaw != null && perPageRaw !== "" && /^\d+$/.test(perPageRaw.trim())) {
    perPage = clamp(Number.parseInt(perPageRaw.trim(), 10), 1, MAX_BRAND_PER_PAGE);
  }

  let stars: number | undefined;
  const starsRaw = params.get("stars");
  if (starsRaw != null && starsRaw !== "") {
    if (/^[1-5]$/.test(starsRaw.trim())) {
      stars = Number.parseInt(starsRaw.trim(), 10);
    } else {
      errors.stars = "invalid";
    }
  }

  if (Object.keys(errors).length > 0) return errorJson(422, errors);

  // Same caching rules as the product reviews list (SPEC-1.9 §1): tokenized
  // merchant traffic (theme editor / preview links) is never cached publicly;
  // ordinary live-store traffic is cacheable for 60 s. Independent of the
  // live gate above — a valid token on a LIVE store also means no-store.
  const merchantPreview = await hasValidPreviewToken(shop, params);

  try {
    const list = await listBrandReviews(shop, { page, perPage, stars });
    return json(list, {
      headers: merchantPreview ? NO_STORE_HEADERS : REVIEWS_CACHE_HEADERS,
    });
  } catch (error) {
    console.error("[cellexia] listBrandReviews failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

export async function action() {
  return errorJson(405, { _: "method_not_allowed" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Did this GET carry the shop's CURRENT preview token? Mirrors the product
 * reviews route: only possession of the token qualifies, never the live
 * state, and any failure answers `false` (the response is then simply
 * cacheable, which is the shopper-safe default for a payload that contains
 * no merchant-only data).
 */
async function hasValidPreviewToken(
  shop: string,
  params: URLSearchParams,
): Promise<boolean> {
  const token = params.get("preview_token");
  if (!token) return false;
  try {
    const settings = await getSettings(shop);
    return settings.previewToken != null && token === settings.previewToken;
  } catch (error) {
    console.error("[cellexia] preview-token check failed", error);
    return false;
  }
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw == null || raw === "" || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return parsed >= 1 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
