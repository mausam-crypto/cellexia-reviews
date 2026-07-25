/**
 * App-proxy security helpers for the storefront JSON API (SPEC §10).
 *
 * Every `/proxy/api/*` route calls `verifyProxy` first: it validates the
 * Shopify app-proxy HMAC signature and is the ONLY trusted source for the
 * shop domain and the logged-in customer id. The `shop` value is never read
 * from a request body.
 */

import crypto from "node:crypto";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { SHOP_LOCALES, type ShopLocale } from "~/types/cellexia";
import { getSettings } from "~/services/settings.server";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i;

/** `Cache-Control` for every proxy response except the reviews list GET. */
export const NO_STORE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
};

/** `Cache-Control` for the GET reviews list (SPEC §6). */
export const REVIEWS_CACHE_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=60",
};

/**
 * Verify the Shopify app-proxy signature of a request.
 *
 * Algorithm (SPEC §10): drop the `signature` query param, group the remaining
 * params by key (multi-values joined by `,`), sort keys, join each pair as
 * `key=value`, concatenate WITHOUT separators, HMAC-SHA256 the result with
 * `SHOPIFY_API_SECRET` and compare hex digests with a timing-safe compare.
 *
 * Returns `{ shop, customerId? }` on success, `null` on failure (routes
 * respond 401). Setting `CELLEXIA_ALLOW_UNSIGNED=1` skips the HMAC check —
 * strictly for local development / demo use, never in production.
 */
export async function verifyProxy(
  request: Request,
): Promise<{ shop: string; customerId?: string } | null> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const shop = (params.get("shop") ?? "").trim();
  if (!shop || !SHOP_DOMAIN_RE.test(shop)) return null;

  const customerIdRaw = (params.get("logged_in_customer_id") ?? "").trim();
  const customerId = /^\d+$/.test(customerIdRaw) ? customerIdRaw : undefined;

  if (process.env.CELLEXIA_ALLOW_UNSIGNED === "1") {
    return { shop, customerId };
  }

  const signature = params.get("signature");
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!signature || !secret) return null;

  // Group every param except `signature`; multi-values are joined by ",".
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params.entries()) {
    if (key === "signature") continue;
    const values = grouped.get(key);
    if (values) {
      values.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  const message = [...grouped.keys()]
    .sort()
    .map((key) => `${key}=${(grouped.get(key) as string[]).join(",")}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message, "utf8")
    .digest("hex");

  const expected = Buffer.from(digest, "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;

  return { shop, customerId };
}

/**
 * Storefront visibility gate (SPEC-1.2 §Proxy gating).
 *
 * Returns `true` when the shop is live, or when the request carries the
 * shop's current preview token. Every proxy route calls this right after
 * `verifyProxy` + rate limiting and responds
 * `errorJson(403, { _: "not_live" })` on `false`, so a not-live storefront
 * serves zero API data to ordinary visitors.
 *
 * Token sources: GET requests carry `preview_token` as a URL query param
 * (extracted here). POST routes MUST pass the token they already parsed from
 * their body/form via `tokenFromBody` — the request stream is never re-read
 * here. A `null`/absent body token still falls back to the query param.
 */
export async function requireLiveOrPreview(
  shop: string,
  request: Request,
  tokenFromBody?: string | null,
): Promise<boolean> {
  const settings = await getSettings(shop);
  if (settings.isLive) return true;
  const token =
    tokenFromBody ?? new URL(request.url).searchParams.get("preview_token");
  return settings.previewToken != null && token === settings.previewToken;
}

/* ------------------------------------------------------------------------- *
 * Storefront-hit recorder (SPEC-1.6 §2)
 * ------------------------------------------------------------------------- */

/**
 * Query param that marks a request as the app's OWN server-side probe
 * (`probeProxySubpath` / the preview round-trip of the storefront health
 * check). Such requests travel through Shopify's app proxy exactly like real
 * storefront traffic, so they would otherwise light up the
 * "is the theme extension enabled?" signal without any theme being involved —
 * `recordStorefrontHit` therefore ignores them.
 *
 * Suppressing the signal is the only effect a forged value can have, so the
 * marker needs no authentication.
 */
export const HEALTH_PROBE_PARAM = "cx_health_probe";

/** At most one `Setting.lastStorefrontHitAt` write per shop per 60 s. */
const STOREFRONT_HIT_THROTTLE_MS = 60_000;

/** Hard cap on tracked shops before stale throttle entries are pruned. */
const STOREFRONT_HIT_MAX_SHOPS = 5000;

/**
 * Backoff after a failed write. The throttle entry is rewound to this many
 * milliseconds before expiry instead of being deleted, so a database outage
 * retries every ~5 s per shop rather than on EVERY storefront request.
 */
const STOREFRONT_HIT_RETRY_MS = 5_000;

// Stored on globalThis so dev-server module reloads keep one throttle map
// (same pattern as ratelimit.server.ts / db.server.ts).
const globalHitStore = globalThis as typeof globalThis & {
  __cellexiaStorefrontHitAt?: Map<string, number>;
  __cellexiaStorefrontHitFailed?: Set<string>;
};

function storefrontHitStore(): Map<string, number> {
  let store = globalHitStore.__cellexiaStorefrontHitAt;
  if (!store) {
    store = new Map();
    globalHitStore.__cellexiaStorefrontHitAt = store;
  }
  return store;
}

/**
 * Shops whose most recent hit-write failed. Used purely to log once per
 * outage instead of once per storefront request.
 */
function storefrontHitFailures(): Set<string> {
  let failures = globalHitStore.__cellexiaStorefrontHitFailed;
  if (!failures) {
    failures = new Set();
    globalHitStore.__cellexiaStorefrontHitFailed = failures;
  }
  return failures;
}

/**
 * Record that a verified storefront request reached the app (SPEC-1.6 §2).
 *
 * Called by every proxy route right after a successful `verifyProxy` — the
 * shop is therefore HMAC-proven, never taken from a body. The write is
 * throttled to at most once per 60 s per shop (in-memory, per process) and
 * fire-and-forget: the caller never awaits it and a database hiccup can never
 * affect the storefront response. A failed write rewinds the throttle to ~5 s
 * instead of clearing it, so an unreachable database causes a slow retry loop
 * rather than one write attempt (and one log line) per storefront request.
 *
 * This is the only signal behind the health check's "Theme extension active"
 * row, which is why the app's own probes (marked with `HEALTH_PROBE_PARAM`)
 * are excluded.
 *
 * MULTI-INSTANCE CAVEAT: the throttle is per Node.js process, so N instances
 * may perform up to N writes per minute per shop. The value is a coarse
 * "last seen" timestamp, so that is harmless.
 */
export function recordStorefrontHit(shop: string, request: Request): void {
  if (!shop) return;

  try {
    if (new URL(request.url).searchParams.get(HEALTH_PROBE_PARAM) !== null) return;
  } catch {
    // Unparsable URL (never happens for a routed request) — record anyway.
  }

  const store = storefrontHitStore();
  const now = Date.now();
  const last = store.get(shop);
  if (last !== undefined && now - last < STOREFRONT_HIT_THROTTLE_MS) return;
  store.set(shop, now);

  if (store.size > STOREFRONT_HIT_MAX_SHOPS) {
    const failures = storefrontHitFailures();
    for (const [key, at] of store) {
      if (now - at >= STOREFRONT_HIT_THROTTLE_MS) {
        store.delete(key);
        failures.delete(key);
      }
    }
  }

  // Upsert (not update): a shop whose Setting row does not exist yet must not
  // produce a P2025 error storm. The row's defaults are the safe ones
  // (isLive = false), and `shop` came from a verified proxy signature.
  void prisma.setting
    .upsert({
      where: { shop },
      update: { lastStorefrontHitAt: new Date(now) },
      create: { shop, lastStorefrontHitAt: new Date(now) },
    })
    .then(
      () => {
        storefrontHitFailures().delete(shop);
      },
      (error: unknown) => {
        // Back off, do NOT reset: deleting the entry would make every single
        // storefront request re-attempt the write while the database is down —
        // turning a transient hiccup into a sustained write storm. Rewinding
        // the timestamp retries in ~5 s instead.
        if (store.get(shop) === now) {
          store.set(shop, now - STOREFRONT_HIT_THROTTLE_MS + STOREFRONT_HIT_RETRY_MS);
        }
        // Log once per outage (i.e. only when the previous attempt succeeded),
        // never once per storefront request.
        const failures = storefrontHitFailures();
        if (!failures.has(shop)) {
          failures.add(shop);
          console.error("[cellexia] recordStorefrontHit failed", error);
        }
      },
    );
}

/**
 * Best-effort client IP for rate limiting and the privacy-preserving
 * `ipHash`.
 *
 * SECURITY: proxies (Shopify's app proxy and the Render/Fly/Railway load
 * balancers) APPEND the peer address they saw to any client-supplied
 * `x-forwarded-for` header, so the FIRST entry is attacker-controlled and
 * must never be trusted — keying rate limits on it would let a bot mint a
 * fresh token bucket per request. We therefore use the RIGHTMOST entry,
 * which was written by the last trusted proxy hop and cannot be forged by
 * the client.
 *
 * Operators whose platform guarantees a client-IP header (e.g.
 * `fly-client-ip` on Fly.io, `true-client-ip` on Render, `cf-connecting-ip`
 * behind Cloudflare) can opt in via `CELLEXIA_CLIENT_IP_HEADER=<header-name>`
 * for finer-grained buckets. This is opt-in only: trusting such a header by
 * default would re-open the spoofing hole on platforms that do not strip it.
 */
export function getClientIp(request: Request): string {
  const trustedHeader = process.env.CELLEXIA_CLIENT_IP_HEADER?.trim();
  if (trustedHeader) {
    const value = request.headers.get(trustedHeader)?.trim();
    if (value) return value;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const last = forwarded.split(",").pop()?.trim();
    if (last) return last;
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();
  return "unknown";
}

/**
 * One-way hash of the client IP stored on Review.ipHash. Salted with the app
 * secret so the raw IP cannot be recovered from the database.
 */
export function hashClientIp(ip: string): string {
  const salt = process.env.SHOPIFY_API_SECRET ?? "cellexia";
  return crypto.createHash("sha256").update(`${salt}:${ip}`, "utf8").digest("hex");
}

/**
 * Uniform JSON error response: `{ ok: false, errors: { field: "code" } }`
 * with `Cache-Control: no-store` (SPEC §6/§10).
 */
export function errorJson(
  status: number,
  errors: Record<string, string>,
): Response {
  return json({ ok: false, errors }, { status, headers: NO_STORE_HEADERS });
}

/** Parse a JSON request body; returns `null` for anything that is not a JSON object. */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Map an arbitrary locale string to the closest supported shop locale
 * (SPEC §5 SHOP_LOCALES). Falls back to "en".
 */
export function matchShopLocale(raw: string | null | undefined): ShopLocale {
  if (!raw) return "en";
  const lower = raw.trim().toLowerCase();
  if (!lower) return "en";
  for (const locale of SHOP_LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
  }
  const primary = lower.split(/[-_]/)[0];
  for (const locale of SHOP_LOCALES) {
    if (locale.toLowerCase().split("-")[0] === primary) return locale;
  }
  return "en";
}

/** True when a service/prisma error means "record not found" (→ 404). */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "P2025") return true; // Prisma "record not found"
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /not\s*found/i.test(message);
}

/** Read the first bytes of an uploaded file for magic-byte sniffing. */
export async function readMagicBytes(
  file: File,
  length = 16,
): Promise<Uint8Array> {
  const buffer = await file.slice(0, length).arrayBuffer();
  return new Uint8Array(buffer);
}

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

const VIDEO_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp4v",
  "avc1",
  "dash",
  "M4V ",
  "M4VP",
  "qt  ",
]);

/**
 * Server-side magic-byte validation of uploaded review media (SPEC §10).
 * Accepts jpeg/png/webp/heic images and mp4/mov/webm videos; anything else
 * (including files whose extension lies about their content) returns `null`.
 */
export function sniffMediaKind(bytes: Uint8Array): "IMAGE" | "VIDEO" | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "IMAGE";
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "IMAGE";
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "IMAGE";
  }

  // WEBM (Matroska/EBML): 1A 45 DF A3
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "VIDEO";
  }

  // ISO BMFF (mp4 / mov / heic): size + "ftyp" + major brand.
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return "IMAGE";
    if (VIDEO_BRANDS.has(brand)) return "VIDEO";
    return null;
  }

  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}
