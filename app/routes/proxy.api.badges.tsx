/**
 * Storefront proxy: `GET /apps/cellexia/api/badges?handles=h1,h2,…[&root=…]`
 * → `/proxy/api/badges` (SPEC-1.5 §2, SPEC-1.31 §2).
 *
 * Returns `{ "badges": { "<handle>": { "average": 4.6, "count": 128 } } }`
 * computed over PUBLISHED reviews only; handles that resolve to nothing
 * (unknown products, no published reviews) are simply omitted. Accepts up to
 * 48 handles, each matching `[a-z0-9-]{1,255}`.
 *
 * `root` (SPEC-1.31 §2) is the storefront locale root the widget runs under
 * (`fr`, `/pt-br/`, …); it unlocks the storefront JSON lookup that resolves
 * TRANSLATED URL handles. An invalid `root` is IGNORED (null), never an
 * error — badges keep answering with canonical-only resolution. The widget
 * omits the param entirely on the default locale, keeping those request
 * URLs byte-identical to v1.30 (public cache keying unchanged there).
 *
 * Proxy-verified, rate limited (`badges`: 2400/h per shop:ip — see the
 * SPEC-1.31 §4b shared-bucket rationale in ratelimit.server.ts) and gated by
 * the SPEC-1.2 live/preview rules exactly like the sibling routes. Responses
 * are publicly cacheable for 5 minutes when the shop is live and `no-store`
 * while previewing (token-gated access must never be cached).
 */

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { unauthenticated } from "~/shopify.server";
import type { BadgesResponse } from "~/types/cellexia";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import {
  badgeStatsByHandles,
  MAX_BADGE_HANDLES,
  normalizeBadgeRoot,
} from "~/services/badges.server";
import { recordObservedMarket } from "~/services/markets.server";
import { getSettings } from "~/services/settings.server";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

const HANDLE_RE = /^[a-z0-9-]{1,255}$/;

/** `Cache-Control` for live shops (SPEC-1.5 §2). */
const BADGES_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=300",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request); // SPEC-1.6 §2 — fire-and-forget, throttled

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "badges")) {
    return errorJson(429, { _: "rate_limited" });
  }

  // SPEC-1.2 gating: not-live shops serve zero data unless the request
  // carries the current preview token (`preview_token` query param).
  if (!(await requireLiveOrPreview(shop, request))) {
    return errorJson(403, { _: "not_live" });
  }

  const params = new URL(request.url).searchParams;

  // v1.14 (SPEC-1.14 §6, review-hardened): remember which market this request
  // came from — but ONLY when the request carries the shop's current preview
  // token. Recording is merchant-driven by design (open the preview link in a
  // market); gating on the token means anonymous visitors can never poison
  // the picker or exhaust its 50-handle cap.
  const previewTokenParam = (params.get("preview_token") ?? "").trim();
  if (previewTokenParam) {
    const settingsForMarket = await getSettings(shop);
    if (settingsForMarket.previewToken && previewTokenParam === settingsForMarket.previewToken) {
      recordObservedMarket(shop, params.get("market"));
    }
  }

  const handlesRaw = (params.get("handles") ?? "").trim();
  if (!handlesRaw) return errorJson(422, { handles: "required" });

  const requested: string[] = [];
  for (const part of handlesRaw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate || requested.includes(candidate)) continue;
    requested.push(candidate);
  }
  if (requested.length === 0) return errorJson(422, { handles: "required" });
  if (requested.length > MAX_BADGE_HANDLES) {
    return errorJson(422, { handles: "too_many" });
  }

  // Handles that do not match the Shopify handle shape can never resolve.
  // The widget derives handles from arbitrary theme card URLs, so such
  // entries are dropped (→ omitted from the response, same as unknown
  // handles) rather than failing the whole batch.
  const handles = requested.filter((handle) => HANDLE_RE.test(handle));

  // SPEC-1.31 §2: the widget's locale root, normalized to `/fr/` shape or
  // null. Invalid values are IGNORED — never an error.
  const rootPrefix = normalizeBadgeRoot(params.get("root"));

  // Live shops get publicly cacheable responses; preview traffic (the only
  // other way past the gate above) must never be cached.
  let headers = NO_STORE_HEADERS;
  try {
    const settings = await getSettings(shop);
    if (settings.isLive) headers = BADGES_CACHE_HEADERS;
  } catch (error) {
    console.error("[cellexia] getSettings failed, badges default to no-store", error);
  }

  if (handles.length === 0) {
    const empty: BadgesResponse = { badges: {} };
    return json(empty, { headers });
  }

  // The Admin API is only needed for handles without Review rows; when the
  // offline client is unavailable the DB-backed resolution still answers.
  let admin: AdminClient | null = null;
  try {
    admin = (await unauthenticated.admin(shop)).admin;
  } catch (error) {
    console.error("[cellexia] unauthenticated admin client unavailable", error);
  }

  try {
    const badges = await badgeStatsByHandles(shop, admin, handles, rootPrefix);
    const body: BadgesResponse = { badges };
    return json(body, { headers });
  } catch (error) {
    console.error("[cellexia] badgeStatsByHandles failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

export async function action() {
  return errorJson(405, { _: "method_not_allowed" });
}
