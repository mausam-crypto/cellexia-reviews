/**
 * Cellexia Reviews — app-proxy auto-discovery + storefront health check
 * (SPEC-1.6 §2 and §5, SPEC-1.6.1 §A–§C).
 *
 * Why this module exists: v1.5 shipped with the storefront path hard-coded in
 * two places (the app config and the theme extension). They drifted, every
 * storefront API call 404'd, and nothing in the admin could tell the merchant.
 * This module removes both problems:
 *
 *   probeProxySubpath()        Asks the SHOP — over the public internet,
 *                              through Shopify's own app proxy — which
 *                              `/apps/<subpath>/api` actually reaches this
 *                              app, then persists the answer to
 *                              `Setting.proxySubpath` and the
 *                              `cellexia.proxy_path` shop metafield that
 *                              cx-proxy.liquid reads. Run from afterAuth and
 *                              from the health check.
 *
 *   runStorefrontHealthCheck() The seven checks behind the admin's
 *                              "Storefront connection" card: proxy, preview
 *                              token round-trip, theme extension activity,
 *                              review data, metafield sync, database
 *                              persistence and live state.
 *
 *   buildStorefrontDiagnostics() The merchant-only `diag` block the ping route
 *                              attaches once it has verified a preview token
 *                              (SPEC-1.6.1 §C) — the storefront's own view of
 *                              the data.
 *
 * v1.6.1 sharpens two of the checks so nothing fails silently any more: check 4
 * distinguishes "no reviews" from "reviews exist but none are published" (§B),
 * and check 5 fails outright — quoting Shopify verbatim — when a product
 * metafield write is on record as having been rejected (§A), instead of only
 * noticing the mismatch it leaves behind.
 *
 * Rules honoured throughout: no new OAuth scopes (only `shop { id }`,
 * `products` and product metafields, all already granted), no new
 * dependencies, nothing here ever throws — a health check that crashes is
 * worse than no health check — and no shopper-visible surface at all.
 *
 * The check ids are a stable contract for the admin UI: import
 * `HEALTH_CHECK_IDS` / `HealthCheckId` instead of hard-coding strings.
 */
import fs from "node:fs";
import path from "node:path";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";
import { setShopProxyPathMetafield } from "~/services/metafields.server";
import { HEALTH_PROBE_PARAM } from "~/services/proxy.server";
import { getSettings } from "~/services/settings.server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so admin contexts lack REST; this module only ever
 * uses `graphql`, so accept exactly that — contexts with and without REST both
 * satisfy it structurally.
 */
type AdminClient = Pick<AdminApiContext, "graphql">;

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/** The subpath shipped in shopify.app.example.toml and cx-proxy.liquid. */
export const DEFAULT_PROXY_SUBPATH = "cellexia-reviews";

/**
 * Subpaths tried by auto-discovery, in order. The shop's stored/preferred
 * subpath is always probed first; this list covers the shipped default plus
 * the historical/plausible alternatives a developer may have typed into
 * `[app_proxy] subpath`. Mirrored by scripts/selftest.mjs.
 */
export const PROXY_CANDIDATES: readonly string[] = [
  DEFAULT_PROXY_SUBPATH,
  "cellexia",
  "reviews",
  "cellexia-review",
];

/** Identifier the ping route answers with; the discovery success criterion. */
export const PING_APP_ID = "cellexia-reviews";

/** Per-candidate probe timeout (SPEC-1.6 §2). */
const PROBE_TIMEOUT_MS = 6000;

/**
 * Timeout for the preview round-trip (check 2). Higher than the probe: it
 * runs a real reviews query, which can be slow on a cold database.
 */
const ROUNDTRIP_TIMEOUT_MS = 10_000;

/** A storefront request within this window means the extension is live. */
const STOREFRONT_HIT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Products sampled when comparing metafields with the database (check 5). */
const METAFIELD_SAMPLE_SIZE = 5;

/** Response bytes kept while inspecting a probe response. */
const MAX_BODY_CHARS = 2000;

/** Response snippet length shown to the merchant. */
const MAX_DETAIL_SNIPPET = 120;

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i;
const PROXY_SUBPATH_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Attempt detail used for every candidate when the storefront is password-
 * protected. Matched exactly (never parsed) so the checks can report an
 * environment condition instead of a misconfiguration.
 */
const PASSWORD_PAGE_DETAIL =
  "the online store is password-protected, so Shopify served the password page instead of forwarding the request to the app";

/**
 * App version reported by `/api/ping`. Read from package.json (npm sets
 * `npm_package_version` for `npm start`/`npm run dev`; the file read covers a
 * bare `node build/server/index.js`). Informational only — discovery keys off
 * `app === "cellexia-reviews"`, never the version.
 */
export const APP_VERSION: string = readAppVersion();

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

export type HealthStatus = "pass" | "warn" | "fail";

/** Stable ids, in display order. The admin UI keys its extra actions on these. */
export const HEALTH_CHECK_IDS = [
  "app_proxy",
  "preview_token",
  "theme_extension",
  "review_data",
  "metafield_sync",
  "database",
  "live_state",
] as const;

export type HealthCheckId = (typeof HEALTH_CHECK_IDS)[number];

export interface HealthCheck {
  id: HealthCheckId;
  /** Short merchant-facing row title. */
  label: string;
  status: HealthStatus;
  /** What was measured, in plain language. Never contains secrets or PII. */
  detail: string;
  /** The one next step to take, or null when nothing needs doing. */
  fix: string | null;
}

export interface HealthReport {
  shop: string;
  /** ISO timestamp of this run. */
  ranAt: string;
  /** Worst status across all checks. */
  status: HealthStatus;
  /** True when no check failed (warnings are allowed). */
  ok: boolean;
  /** Detected app-proxy subpath, or null when discovery failed. */
  proxySubpath: string | null;
  checks: HealthCheck[];
}

export interface ProxyProbeAttempt {
  subpath: string;
  /** HTTP status, or 0 when no response arrived (timeout / network error). */
  status: number;
  ok: boolean;
  /** Short reason, safe to show a merchant. */
  detail: string;
}

export interface ProxyProbeResult {
  subpath: string | null;
  tried: ProxyProbeAttempt[];
}

/* ------------------------------------------------------------------------- *
 * Auto-discovery (SPEC-1.6 §2)
 * ------------------------------------------------------------------------- */

/**
 * Discover which `/apps/<subpath>/api` reaches this app for `shop`.
 *
 * Sequentially GETs `https://<shop>/apps/<candidate>/api/ping` (preferred
 * candidate first, deduped, 6 s timeout each) and stops at the first success.
 * Success is strict: HTTP 200 **and** a JSON body whose `app` is
 * `"cellexia-reviews"` — Shopify's own 404 page, another app's JSON and
 * timeouts all fail, and each attempt is recorded in `tried` with a short
 * reason for the admin's failure detail.
 *
 * The request travels through Shopify, which signs it, so a success also
 * proves `SHOPIFY_API_SECRET` verifies. It carries the health-probe marker so
 * it never counts as theme traffic (see recordStorefrontHit).
 *
 * On success the winner is persisted to `Setting.proxySubpath` and, when an
 * admin client is supplied, mirrored onto the `cellexia.proxy_path` shop
 * metafield. Never throws.
 *
 * @param admin Optional Admin API client. SPEC-1.6 declares
 *   `probeProxySubpath(shop, preferred?)`; the client is an additive third
 *   parameter so this module never has to import `~/shopify.server`
 *   (afterAuth imports *this* module — the reverse import would be a cycle)
 *   and so the caller's already-authenticated client is reused. Without it the
 *   database is still updated and the metafield is refreshed by the next
 *   settings sync / afterAuth.
 */
export async function probeProxySubpath(
  shop: string,
  preferred?: string | null,
  admin?: AdminClient | null,
): Promise<ProxyProbeResult> {
  const tried: ProxyProbeAttempt[] = [];

  const domain = (shop ?? "").trim().toLowerCase();
  if (!SHOP_DOMAIN_RE.test(domain)) {
    console.error("[cellexia] probeProxySubpath: invalid shop domain");
    return { subpath: null, tried };
  }

  for (const candidate of candidateSubpaths(preferred)) {
    const url = `https://${domain}${proxyApiPath(candidate)}/ping?${HEALTH_PROBE_PARAM}=1`;
    const response = await httpGet(url, PROBE_TIMEOUT_MS);
    const attempt = evaluatePing(candidate, response);
    tried.push(attempt);
    if (attempt.ok) {
      await persistProxySubpath(shop, candidate, admin ?? null);
      return { subpath: candidate, tried };
    }
  }

  return { subpath: null, tried };
}

/** Preferred subpath first, then the standard candidates; deduped + validated. */
function candidateSubpaths(preferred?: string | null): string[] {
  const out: string[] = [];
  for (const raw of [preferred ?? "", ...PROXY_CANDIDATES]) {
    const candidate = raw.trim().toLowerCase();
    if (!PROXY_SUBPATH_RE.test(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** `/apps/<subpath>/api` — the storefront API base for a subpath. */
function proxyApiPath(subpath: string): string {
  return `/apps/${subpath}/api`;
}

/** Apply the strict success criterion to one ping response. */
function evaluatePing(subpath: string, response: HttpResult): ProxyProbeAttempt {
  if (!response.received) {
    return { subpath, status: 0, ok: false, detail: response.error ?? "no response" };
  }

  if (isPasswordPage(response)) {
    return { subpath, status: response.status, ok: false, detail: PASSWORD_PAGE_DETAIL };
  }

  if (response.status !== 200) {
    const hint =
      response.status === 404
        ? " — no app is mounted on this path"
        : response.status === 401
          ? " — the app answered but could not verify the signature"
          : response.status >= 300 && response.status < 400
            ? " — a URL redirect on your store intercepts this path instead of it reaching the app"
            : "";
    return { subpath, status: response.status, ok: false, detail: `HTTP ${response.status}${hint}` };
  }

  const parsed = parseJsonObject(response.body);
  if (!parsed) {
    return {
      subpath,
      status: 200,
      ok: false,
      detail: "HTTP 200 but the response was a page, not JSON (Shopify served the storefront)",
    };
  }

  if (typeof parsed.app !== "string" || parsed.app !== PING_APP_ID) {
    return {
      subpath,
      status: 200,
      ok: false,
      detail: "HTTP 200 but another app answered on this path",
    };
  }

  const version = typeof parsed.version === "string" ? parsed.version : "unknown";
  return { subpath, status: 200, ok: true, detail: `Cellexia Reviews ${version} answered` };
}

/** Persist the detected subpath (DB + shop metafield). Never throws. */
async function persistProxySubpath(
  shop: string,
  subpath: string,
  admin: AdminClient | null,
): Promise<void> {
  try {
    await prisma.setting.upsert({
      where: { shop },
      update: { proxySubpath: subpath },
      create: { shop, proxySubpath: subpath },
    });
  } catch (error) {
    console.error("[cellexia] persisting the detected proxy subpath failed", error);
  }

  if (!admin) return;
  // Logs its own failures; a missing metafield falls back to the shipped
  // default in cx-proxy.liquid, so this can never break the storefront.
  await setShopProxyPathMetafield(admin, subpath);
}

/* ------------------------------------------------------------------------- *
 * Storefront health check (SPEC-1.6 §5)
 * ------------------------------------------------------------------------- */

/**
 * Run the seven storefront-connection checks for `shop`.
 *
 * Every check is individually guarded: a thrown error becomes a "could not
 * run" row rather than a failed request, so the admin card always renders.
 * The whole run is read-only apart from auto-discovery persisting the detected
 * proxy subpath.
 */
export async function runStorefrontHealthCheck(
  shop: string,
  admin: AdminClient,
): Promise<HealthReport> {
  const ranAt = new Date().toISOString();

  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  try {
    settings = await getSettings(shop);
  } catch (error) {
    console.error("[cellexia] health check: getSettings failed", error);
  }

  // Snapshot BEFORE probing: the probes below travel through the app proxy,
  // and although they are marked so recordStorefrontHit ignores them, check 3
  // must never read a timestamp this run could have written.
  const lastStorefrontHitAt = settings?.lastStorefrontHitAt ?? null;

  let probe: ProxyProbeResult = { subpath: null, tried: [] };
  try {
    probe = await probeProxySubpath(shop, settings?.proxySubpath ?? null, admin);
  } catch (error) {
    console.error("[cellexia] health check: proxy probe failed", error);
  }

  const checks: HealthCheck[] = [];
  checks.push(buildProxyCheck(probe));
  checks.push(
    await guard("preview_token", "Preview token round-trip", () =>
      checkPreviewRoundTrip(shop, admin, probe, settings?.previewToken ?? null),
    ),
  );
  checks.push(buildThemeExtensionCheck(lastStorefrontHitAt));
  checks.push(await guard("review_data", "Review data", () => checkReviewData(shop)));
  checks.push(
    await guard("metafield_sync", "Metafield sync", () =>
      checkMetafieldSync(
        shop,
        admin,
        settings?.lastSyncError ?? null,
        settings?.lastSyncAt ?? null,
      ),
    ),
  );
  checks.push(await guard("database", "Database persistence", () => checkDatabase()));
  checks.push(buildLiveStateCheck(settings?.isLive ?? false));

  const status: HealthStatus = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    shop,
    ranAt,
    status,
    ok: status !== "fail",
    proxySubpath: probe.subpath,
    checks,
  };
}

/** Run one check, turning an unexpected throw into a visible row. */
async function guard(
  id: HealthCheckId,
  label: string,
  run: () => Promise<HealthCheck>,
): Promise<HealthCheck> {
  try {
    return await run();
  } catch (error) {
    console.error(`[cellexia] health check "${id}" crashed`, error);
    return {
      id,
      label,
      status: "warn",
      detail: "This check could not be completed. See the app server logs for details.",
      fix: "Run the test again. If it keeps failing, check the app server logs.",
    };
  }
}

// --- 1. App proxy reachable -------------------------------------------------

/** True when every probe attempt hit the storefront password page. */
function isPasswordProtected(probe: ProxyProbeResult): boolean {
  return (
    probe.tried.length > 0 &&
    probe.tried.every((attempt) => attempt.detail === PASSWORD_PAGE_DETAIL)
  );
}

function buildProxyCheck(probe: ProxyProbeResult): HealthCheck {
  if (probe.subpath) {
    return {
      id: "app_proxy",
      label: "App proxy reachable",
      status: "pass",
      detail: `Detected at ${proxyApiPath(probe.subpath)} — Shopify forwards storefront requests to the app and the API secret verified.`,
      fix: null,
    };
  }

  // A password-protected storefront is an environment condition, not a
  // misconfiguration: Shopify serves the password page for every path, so
  // nothing can be verified from outside. Warn instead of failing.
  if (isPasswordProtected(probe)) {
    return {
      id: "app_proxy",
      label: "App proxy reachable",
      status: "warn",
      detail:
        "Your online store is password-protected, so Shopify serves the password page instead of forwarding /apps/… requests to the app. The storefront connection cannot be verified while that is on.",
      fix: "Online Store → Preferences → Restrict store access: remove the password, then run the test again. Shoppers cannot see reviews (or anything else) until the store is open.",
    };
  }

  const tried = probe.tried.length
    ? probe.tried
        .map((attempt) => `${proxyApiPath(attempt.subpath)}/ping → ${attempt.detail}`)
        .join("; ")
    : "no candidate path could be tried";

  return {
    id: "app_proxy",
    label: "App proxy reachable",
    status: "fail",
    detail: `No storefront path reaches the app. Tried: ${tried}.`,
    fix:
      'Check the [app_proxy] block in shopify.app.toml (url = "https://<your-app-url>/proxy", ' +
      'prefix = "apps", subpath = "cellexia-reviews"), then run `npm run deploy` and test again. ' +
      "Any subpath works — the app detects it — but the block must exist and point at the deployed backend.",
  };
}

// --- 2. Preview token round-trip -------------------------------------------

async function checkPreviewRoundTrip(
  shop: string,
  admin: AdminClient,
  probe: ProxyProbeResult,
  previewToken: string | null,
): Promise<HealthCheck> {
  const label = "Preview token round-trip";
  const subpath = probe.subpath;

  if (!subpath) {
    const passwordProtected = isPasswordProtected(probe);
    return {
      id: "preview_token",
      label,
      status: passwordProtected ? "warn" : "fail",
      detail: passwordProtected
        ? "Skipped — the storefront is password-protected (see the check above)."
        : "Skipped — no storefront path reaches the app (see the check above).",
      fix: passwordProtected
        ? "Remove the storefront password and run the test again."
        : "Fix the app proxy first, then run the test again.",
    };
  }

  const token = (previewToken ?? "").trim();
  if (!token) {
    return {
      id: "preview_token",
      label,
      status: "fail",
      detail: "This store has no preview token, so the theme editor and preview links cannot load reviews.",
      fix: 'Open Settings → Data and choose "Regenerate preview link", then run the test again.',
    };
  }

  const domain = (shop ?? "").trim().toLowerCase();
  if (!SHOP_DOMAIN_RE.test(domain)) {
    return {
      id: "preview_token",
      label,
      status: "fail",
      detail: "Skipped — the store domain could not be determined.",
      fix: "Reinstall the app so it can re-authenticate with the store.",
    };
  }

  const productId = await pickProbeProductId(shop, admin);
  const url =
    `https://${domain}${proxyApiPath(subpath)}/reviews` +
    `?product_id=${encodeURIComponent(productId)}` +
    `&preview_token=${encodeURIComponent(token)}` +
    `&per_page=1&${HEALTH_PROBE_PARAM}=1`;
  // The token never appears in `detail` — the URL is only ever shown redacted.
  const redacted = `${proxyApiPath(subpath)}/reviews?product_id=${productId}&preview_token=…`;

  const response = await httpGet(url, ROUNDTRIP_TIMEOUT_MS);

  if (!response.received) {
    return {
      id: "preview_token",
      label,
      status: "fail",
      detail: `${redacted} — ${response.error ?? "no response"}.`,
      fix: "Check that the app backend is running and reachable, then run the test again.",
    };
  }

  if (isPasswordPage(response)) {
    return {
      id: "preview_token",
      label,
      status: "warn",
      detail: `${redacted} — the online store is password-protected, so Shopify served the password page instead of the app's answer.`,
      fix: "Remove the storefront password (Online Store → Preferences → Restrict store access), then run the test again.",
    };
  }

  const parsed = parseJsonObject(response.body);

  if (response.status === 200 && parsed && "product" in parsed) {
    return {
      id: "preview_token",
      label,
      status: "pass",
      detail: `${redacted} returned HTTP 200 with review data — preview links and the theme editor can load reviews.`,
      fix: null,
    };
  }

  if (response.status === 403) {
    return {
      id: "preview_token",
      label,
      status: "fail",
      detail: `${redacted} was refused (HTTP 403 not_live) — the preview token the storefront sent no longer matches the one stored in the app.`,
      fix:
        'Open Settings → Data → "Regenerate preview link" (this also refreshes the theme-editor token), ' +
        "then run the test again. A wiped database is the usual cause.",
    };
  }

  // This detail echoes the response body, so only ever echo a body that came
  // from the store itself: a `/apps/…` URL redirect can point anywhere, and
  // the check must not become a read-out of whatever it pointed at.
  const fromShop = sameHost(url, response.finalUrl);
  return {
    id: "preview_token",
    label,
    status: "fail",
    detail: fromShop
      ? `${redacted} returned HTTP ${response.status}: ${snippet(response.body)}`
      : `${redacted} returned HTTP ${response.status}, answered by a redirect that leaves ${domain} — a URL redirect on your store is intercepting /apps/… requests.`,
    fix: fromShop
      ? "Run the test again; if it persists, check the app server logs for this request."
      : "Online Store → Navigation → URL redirects: remove the redirect that matches /apps/…, then run the test again.",
  };
}

/**
 * A product id to exercise the reviews endpoint with: the most-reviewed
 * published product, else any reviewed product, else the store's first
 * product, else `"0"` (a valid id shape that returns an empty, still-proving
 * 200 — the round-trip, not the data, is what this check measures).
 */
async function pickProbeProductId(shop: string, admin: AdminClient): Promise<string> {
  try {
    const published = await prisma.review.groupBy({
      by: ["productId"],
      where: { shop, status: "PUBLISHED" },
      _count: { _all: true },
    });
    if (published.length > 0) {
      const top = [...published].sort((a, b) => b._count._all - a._count._all)[0];
      if (/^\d+$/.test(top.productId)) return top.productId;
    }

    const latest = await prisma.review.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { productId: true },
    });
    if (latest && /^\d+$/.test(latest.productId)) return latest.productId;
  } catch (error) {
    console.error("[cellexia] health check: product lookup failed", error);
  }

  try {
    const response = await admin.graphql(`#graphql
      query CellexiaHealthProbeProduct { products(first: 1) { nodes { id } } }`);
    const json = (await response.json()) as {
      data?: { products?: { nodes?: Array<{ id?: string | null }> } };
    };
    const numeric = numericIdFromGid(json.data?.products?.nodes?.[0]?.id ?? null);
    if (numeric) return numeric;
  } catch (error) {
    console.error("[cellexia] health check: admin product lookup failed", error);
  }

  return "0";
}

// --- 3. Theme extension active ---------------------------------------------

function buildThemeExtensionCheck(lastHitAt: Date | string | null): HealthCheck {
  const label = "Theme extension active";
  const at = toDate(lastHitAt);

  if (at && Date.now() - at.getTime() <= STOREFRONT_HIT_FRESH_MS) {
    return {
      id: "theme_extension",
      label,
      status: "pass",
      detail: `A storefront request reached the app on ${formatDateTime(at)} — the widget is running on your theme.`,
      fix: null,
    };
  }

  const detail = at
    ? `The last storefront request was on ${formatDateTime(at)}, more than 7 days ago.`
    : "No storefront request has ever reached the app from your theme.";

  return {
    id: "theme_extension",
    label,
    status: "warn",
    detail,
    fix:
      'Open Online Store → Themes → Customize → App embeds and enable "Cellexia Reviews", ' +
      "then visit a product page once and run the test again. (A brand-new install legitimately shows this warning.)",
  };
}

// --- 4. Review data ---------------------------------------------------------

async function checkReviewData(shop: string): Promise<HealthCheck> {
  const label = "Review data";

  const [total, published, pending, publishedProducts] = await Promise.all([
    prisma.review.count({ where: { shop } }),
    prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
    prisma.review.count({ where: { shop, status: "PENDING" } }),
    prisma.review.groupBy({
      by: ["productId"],
      where: { shop, status: "PUBLISHED" },
    }),
  ]);

  const counts =
    `${published} published, ${pending} pending, ${total} total` +
    ` — ${publishedProducts.length} product${publishedProducts.length === 1 ? "" : "s"} with published reviews`;

  // "Reviews exist but none are published" is a different problem from "there
  // are no reviews", and conflating them is what made the merchant read a
  // working moderation queue as a broken storefront (SPEC-1.6.1 §B). Say which
  // one it is, and name the two ways out.
  if (published === 0 && total > 0) {
    return {
      id: "review_data",
      label,
      status: "warn",
      detail:
        `${total} review${total === 1 ? "" : "s"} exist but none are published (${counts}). ` +
        "The storefront shows no stars, badges or review list for a product until its reviews are published.",
      fix: "Approve them under Reviews, or turn on Settings → General → Auto-publish new reviews.",
    };
  }

  if (published === 0) {
    return {
      id: "review_data",
      label,
      status: "warn",
      detail: `This app holds no reviews at all yet (${counts}). The storefront will show no stars or badges until reviews exist.`,
      fix: "Import your existing reviews (Import / Export) or generate test data (QA data). Reviews that live in another review app are not visible to this one.",
    };
  }

  return {
    id: "review_data",
    label,
    status: "pass",
    detail: `${counts}.`,
    fix: pending > 0 ? `${pending} review${pending === 1 ? "" : "s"} waiting for moderation.` : null,
  };
}

// --- 5. Metafield sync ------------------------------------------------------

interface RatingCountNodes {
  data?: {
    nodes?: Array<{
      id?: string | null;
      metafield?: { value?: string | null } | null;
    } | null>;
  };
  errors?: unknown;
}

/**
 * Wording that means "Shopify refused this for permission reasons" — a scope
 * the app was never granted, or an access token that no longer carries it.
 * Only re-authenticating fixes those, so the hint must not say "retry".
 */
const ACCESS_ERROR_RE =
  /access denied|not authoriz|unauthoriz|forbidden|permission|\bscope\b|not approved|requires? (?:the )?(?:write|read)_/i;

/** Wording that means "ask again later" — the write itself was fine. */
const THROTTLE_ERROR_RE =
  /throttl|rate.?limit|too many requests|query cost|maximum cost|try again later|temporarily unavailable|timed? ?out/i;

/**
 * The one next step for a recorded sync error. Shopify's own wording is the
 * only signal available (the error text is all that was persisted), so match
 * on it: permission problems need a re-authentication, throttling needs a
 * retry, anything else gets the honest "retry, and here is where to look".
 */
function syncErrorFix(error: string): string {
  if (ACCESS_ERROR_RE.test(error)) {
    return (
      "Shopify refused the write for permission reasons. Open the app from Shopify admin → Apps so it " +
      "re-authenticates (reinstall it if the error persists), then choose “Re-sync all products” and run this test again."
    );
  }
  if (THROTTLE_ERROR_RE.test(error)) {
    return (
      "Shopify was rate-limiting or timing out the app, which is temporary. Wait a minute, choose " +
      "“Re-sync all products”, then run this test again."
    );
  }
  return (
    "Choose “Re-sync all products” to write the metafields again, then run this test. If the same error " +
    "comes back, send the message above to support — it is Shopify's own wording, word for word."
  );
}

async function checkMetafieldSync(
  shop: string,
  admin: AdminClient,
  lastSyncError: string | null,
  lastSyncAt: Date | string | null,
): Promise<HealthCheck> {
  const label = "Metafield sync";

  // A recorded failure outranks the read-back comparison below. The counts can
  // still agree after a failed write (the previous, correct value is simply
  // left in place), so a mismatch is a symptom while this is the cause — and
  // before v1.6.1 it existed only in the server log. Show it verbatim.
  const recordedError = (lastSyncError ?? "").trim();
  if (recordedError) {
    const failedAt = toDate(lastSyncAt);
    return {
      id: "metafield_sync",
      label,
      status: "fail",
      detail:
        `The last product metafield write failed${failedAt ? ` on ${formatDateTime(failedAt)}` : ""}: ` +
        `“${recordedError}” — so product pages keep whatever was written before it: stale or missing stars, ` +
        "no rich snippets and no rating under the product title.",
      fix: syncErrorFix(recordedError),
    };
  }

  // Past this point no failure is on record, so any timestamp is the last
  // sync that SUCCEEDED — worth stating, because "when did the stars last
  // update?" is the other half of the merchant's question.
  const succeededAt = toDate(lastSyncAt);
  const lastSuccess = succeededAt
    ? ` The last sync succeeded on ${formatDateTime(succeededAt)}.`
    : "";

  const groups = await prisma.review.groupBy({
    by: ["productId"],
    where: { shop, status: "PUBLISHED" },
    _count: { _all: true },
  });

  if (groups.length === 0) {
    return {
      id: "metafield_sync",
      label,
      status: "pass",
      detail: `Nothing to compare yet — no product has published reviews. No sync failure is on record.${lastSuccess}`,
      fix: null,
    };
  }

  const sample = [...groups]
    .sort((a, b) => b._count._all - a._count._all)
    .slice(0, METAFIELD_SAMPLE_SIZE)
    .filter((group) => /^\d+$/.test(group.productId));

  if (sample.length === 0) {
    return {
      id: "metafield_sync",
      label,
      status: "pass",
      detail: `Nothing to compare yet — no product has published reviews. No sync failure is on record.${lastSuccess}`,
      fix: null,
    };
  }

  const response = await admin.graphql(
    `#graphql
      query CellexiaHealthRatingCounts($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            metafield(namespace: "cellexia", key: "rating_count") { value }
          }
        }
      }`,
    { variables: { ids: sample.map((group) => `gid://shopify/Product/${group.productId}`) } },
  );
  const json = (await response.json()) as RatingCountNodes;

  if (json.errors) {
    console.error("[cellexia] health check: rating_count query errors", json.errors);
    return {
      id: "metafield_sync",
      label,
      status: "warn",
      detail: "Shopify could not be asked for the product metafields right now.",
      fix: "Run the test again in a moment.",
    };
  }

  const metafieldByProduct = new Map<string, string | null>();
  for (const node of json.data?.nodes ?? []) {
    const numeric = numericIdFromGid(node?.id ?? null);
    if (numeric) metafieldByProduct.set(numeric, node?.metafield?.value ?? null);
  }

  let mismatches = 0;
  let missing = 0;
  let unknownProducts = 0;
  for (const group of sample) {
    if (!metafieldByProduct.has(group.productId)) {
      // Shopify returned no product for this id — it was deleted while its
      // reviews stayed behind. Not a sync problem, so it is reported apart.
      unknownProducts += 1;
      continue;
    }
    const raw = metafieldByProduct.get(group.productId) ?? "";
    if (raw === "") {
      missing += 1;
      continue;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value !== group._count._all) mismatches += 1;
  }

  const checked = sample.length;
  if (mismatches === 0 && missing === 0 && unknownProducts === 0) {
    return {
      id: "metafield_sync",
      label,
      status: "pass",
      detail: `Checked ${checked} product${checked === 1 ? "" : "s"}: the cellexia.rating_count metafield matches the app's review counts, so stars, rich snippets and the title badge render instantly.${lastSuccess}`,
      fix: null,
    };
  }

  const problems: string[] = [];
  if (missing > 0) problems.push(`${missing} missing`);
  if (mismatches > 0) problems.push(`${mismatches} out of date`);
  if (unknownProducts > 0) {
    problems.push(`${unknownProducts} no longer exist${unknownProducts === 1 ? "s" : ""} in Shopify`);
  }

  return {
    id: "metafield_sync",
    label,
    status: "warn",
    detail: `Checked ${checked} product${checked === 1 ? "" : "s"}: ${problems.join(", ")}. Product pages may show stale or no stars until the metafields are rewritten.`,
    fix:
      missing > 0 || mismatches > 0
        ? 'Choose "Re-sync all products" to rewrite the metafields from the app\'s data.'
        : "Delete the reviews of products that no longer exist (Reviews → filter by product).",
  };
}

// --- 6. Database persistence ------------------------------------------------

async function checkDatabase(): Promise<HealthCheck> {
  const label = "Database persistence";
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  const datasource = readDatasource();

  const fix =
    "docs/INSTALL.md §4: mount a persistent volume and set DATABASE_URL=file:/data/production.sqlite " +
    'with `url = env("DATABASE_URL")` in prisma/schema.prisma, or switch the datasource to Postgres.';

  // Literal `file:` URL in the schema — the classic wiped-on-redeploy setup
  // when the path is relative to the (ephemeral) container filesystem.
  if (datasource.fileUrl) {
    const absolute = datasource.fileUrl.startsWith("/");
    if (absolute) {
      return {
        id: "database",
        label,
        status: "pass",
        detail: `Reviews are stored in SQLite at ${datasource.fileUrl}. Make sure that path is a persistent volume.`,
        fix: null,
      };
    }
    return {
      id: "database",
      label,
      status: "warn",
      detail:
        `Reviews are stored in SQLite at the relative path "${datasource.fileUrl}", inside the app container. ` +
        (databaseUrl
          ? "DATABASE_URL is set but prisma/schema.prisma does not use it. "
          : "DATABASE_URL is not set. ") +
        "Container filesystems are wiped on every deploy, so every review, setting and preview token will be lost the next time the app is redeployed.",
      fix,
    };
  }

  // Schema reads the environment (or could not be read at all).
  if (databaseUrl) {
    return {
      id: "database",
      label,
      status: "pass",
      detail: `Reviews are stored in the database configured by DATABASE_URL (${describeDatabaseUrl(databaseUrl)}).`,
      fix: null,
    };
  }

  return {
    id: "database",
    label,
    status: "warn",
    detail:
      "DATABASE_URL is not set, so the app is using the default SQLite file inside the container. " +
      "Container filesystems are wiped on every deploy, so reviews, settings and preview tokens will not survive a redeploy.",
    fix,
  };
}

// --- 7. Live state ----------------------------------------------------------

function buildLiveStateCheck(isLive: boolean): HealthCheck {
  if (isLive) {
    return {
      id: "live_state",
      label: "Live state",
      status: "pass",
      detail: "Live — shoppers can see the review widget, stars and badges.",
      fix: null,
    };
  }
  return {
    id: "live_state",
    label: "Live state",
    status: "warn",
    detail:
      "Not live — the widget is hidden from shoppers. Only preview links and the theme editor show reviews.",
    fix: 'Use "Go live" on the Dashboard when the checks above pass.',
  };
}

/* ------------------------------------------------------------------------- *
 * Storefront diagnostics (SPEC-1.6.1 §C)
 * ------------------------------------------------------------------------- */

/**
 * The `diag` block of `GET /apps/<subpath>/api/ping`.
 *
 * MERCHANT-ONLY. Every field is business data a shopper must never receive, so
 * the ping route attaches this **only** when the request carried a valid
 * preview token; a tokenless request gets the unchanged, data-free response.
 * That gate lives in the route (it is the only place that can verify a token)
 * — this function just assembles the numbers and knows nothing about auth.
 * Never call it before the token has been verified.
 */
export interface StorefrontDiagnostics {
  /** Published reviews in this shop. */
  published: number;
  /** Reviews awaiting moderation. */
  pending: number;
  /** Distinct products that have at least one review, in any status. */
  products: number;
  /** False when a product metafield write is on record as having failed. */
  metafieldOk: boolean;
  /** That failure, verbatim, or null when the last sync succeeded. */
  lastSyncError: string | null;
}

/**
 * Build the token-gated `diag` block for the ping route: what the STOREFRONT's
 * own round trip can see of the app's data, which is the one thing the admin's
 * health card cannot check from the server side.
 *
 * Read-only by design — the ping route is reachable by anyone who can load the
 * store, so this must never take a write lock (see the route's own notes on
 * why `getSettings` is unusable there): three counts and one `findUnique`.
 * Never throws; returns null when the database cannot answer, so the caller
 * omits `diag` rather than reporting zeros that look like real data.
 */
export async function buildStorefrontDiagnostics(
  shop: string,
): Promise<StorefrontDiagnostics | null> {
  try {
    const [published, pending, reviewedProducts, setting] = await Promise.all([
      prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
      prisma.review.count({ where: { shop, status: "PENDING" } }),
      prisma.review.groupBy({ by: ["productId"], where: { shop } }),
      prisma.setting.findUnique({ where: { shop }, select: { lastSyncError: true } }),
    ]);

    const lastSyncError = (setting?.lastSyncError ?? "").trim() || null;

    return {
      published,
      pending,
      products: reviewedProducts.length,
      metafieldOk: lastSyncError === null,
      lastSyncError,
    };
  } catch (error) {
    console.error("[cellexia] ping: building the diagnostics block failed", error);
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

interface HttpResult {
  /** True when a response arrived (whatever its status). */
  received: boolean;
  status: number;
  body: string;
  /** URL the response came from, after the redirects `httpGet` accepted. */
  finalUrl: string;
  /** Short failure reason when `received` is false. */
  error: string | null;
}

/** Redirect hops `httpGet` will follow before giving up. */
const MAX_REDIRECTS = 3;

/**
 * May `httpGet` follow this redirect target?
 *
 * These probes are the only place where the app fetches a URL that a MERCHANT
 * can influence: Shopify forwards `/apps/<subpath>/…` to the app only where a
 * proxy is actually mounted, and for the other candidates a merchant-created
 * URL Redirect answers instead — whose destination is arbitrary. Following one
 * blindly would turn the health check into an SSRF probe against whatever the
 * app server can reach (cloud metadata at 169.254.169.254, localhost admin
 * ports, intranet hosts).
 *
 * So a hop is accepted only if it looks like a real storefront redirect:
 * HTTPS (Shopify never redirects a storefront to plain HTTP — this alone rules
 * out the metadata service and every `http://127.0.0.1:<port>` target) to a
 * public DNS name, never a bare IP literal or a single-label/loopback/intranet
 * name. What survives — an HTTPS host with a valid certificate for its own
 * public name — cannot be an internal service, and its body is still never
 * echoed back to the merchant (see `checkPreviewRoundTrip`).
 *
 * Same-host hops matter operationally: a password-protected store redirects to
 * `/password`, and a store whose primary domain is a custom domain redirects
 * `<shop>.myshopify.com` to it. Both must keep working.
 */
function mayFollowRedirect(target: URL): boolean {
  if (target.protocol !== "https:") return false;
  const host = target.hostname.toLowerCase();
  if (!host) return false;
  if (host.includes(":")) return false; // IPv6 literal ("[::1]")
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false; // dotted-quad IPv4
  if (/^(?:\d+|0x[0-9a-f]+)$/.test(host)) return false; // decimal/hex IPv4
  if (!host.includes(".")) return false; // single-label intranet name
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host.endsWith(".home.arpa")) return false;
  return true;
}

/** The `Location` of a 3xx resolved against `from`, or null when unusable. */
function redirectTarget(from: string, location: string | null): string | null {
  if (!location) return null;
  try {
    const target = new URL(location, from);
    return mayFollowRedirect(target) ? target.toString() : null;
  } catch {
    return null;
  }
}

/** True when both URLs name the same host (so a body came from where we asked). */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * True when Shopify answered with the storefront password page. Password-
 * protected stores (every unpublished dev store) never forward `/apps/*` to
 * the app, which would otherwise look exactly like a wrong subpath.
 */
function isPasswordPage(response: HttpResult): boolean {
  return /\/password(?:[/?#]|$)/.test(response.finalUrl);
}

/**
 * GET with a hard timeout, capped body read and no exceptions: every failure
 * mode (timeout, DNS, TLS, connection reset) comes back as a short, merchant-
 * readable reason instead of a rejected promise.
 *
 * Redirects are followed by hand (`redirect: "manual"` plus the
 * `mayFollowRedirect` policy) rather than by `fetch`, because the destination
 * of a `/apps/<subpath>/…` redirect is merchant-controlled. A refused or
 * excessive hop is reported as the 3xx itself, with an empty body — the app
 * never reads a response it was steered towards.
 */
async function httpGet(url: string, timeoutMs: number): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "User-Agent": "Cellexia-Reviews-Healthcheck",
        },
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const next = hop < MAX_REDIRECTS
          ? redirectTarget(current, response.headers.get("location"))
          : null;
        // Release the socket without reading a body we are not going to use.
        void response.body?.cancel().catch(() => {});
        if (!next) {
          return { received: true, status: response.status, body: "", finalUrl: current, error: null };
        }
        current = next;
        continue;
      }

      const raw = await response.text();
      return {
        received: true,
        status: response.status,
        body: raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) : raw,
        finalUrl: current,
        error: null,
      };
    }
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      received: false,
      status: 0,
      body: "",
      finalUrl: url,
      error: timedOut
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : `could not be reached (${shortError(error)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated or non-JSON body — treated as "not our app".
  }
  return null;
}

function shortError(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : "network error";
}

/** One-line, length-capped response excerpt for a merchant-facing detail. */
function snippet(body: string): string {
  const cleaned = body.replace(/\s+/g, " ").trim();
  if (!cleaned) return "(empty response)";
  return cleaned.length > MAX_DETAIL_SNIPPET
    ? `${cleaned.slice(0, MAX_DETAIL_SNIPPET)}…`
    : cleaned;
}

function numericIdFromGid(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const tail = String(gid).split("/").pop() ?? "";
  return /^\d+$/.test(tail) ? tail : null;
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Locale-independent, timezone-explicit timestamp for check details. */
function formatDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Describe a DATABASE_URL without ever revealing credentials: the scheme, plus
 * the path for `file:` URLs (which carry no secrets).
 */
function describeDatabaseUrl(value: string): string {
  if (value.startsWith("file:")) return value;
  const scheme = value.split(":")[0];
  return /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? scheme : "custom";
}

interface DatasourceInfo {
  /** Literal `file:` path from the schema, or null (env-driven/unknown). */
  fileUrl: string | null;
}

let datasourceCache: DatasourceInfo | null = null;

/**
 * Best-effort read of the Prisma datasource from prisma/schema.prisma, so the
 * database check can tell "SQLite file baked into the container" apart from
 * "url = env(DATABASE_URL)". Cached; an unreadable schema yields
 * `{ fileUrl: null }`, which falls back to the DATABASE_URL-only heuristic.
 */
function readDatasource(): DatasourceInfo {
  if (datasourceCache) return datasourceCache;
  let info: DatasourceInfo = { fileUrl: null };
  try {
    const source = fs.readFileSync(
      path.join(process.cwd(), "prisma", "schema.prisma"),
      "utf8",
    );
    const block = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(source);
    const url = block ? /url\s*=\s*"([^"]*)"/.exec(block[1]) : null;
    const value = url?.[1]?.trim() ?? "";
    if (value.startsWith("file:")) {
      info = { fileUrl: value.slice("file:".length) || "dev.sqlite" };
    }
  } catch {
    // Schema not shipped with the runtime image — heuristic fallback applies.
  }
  datasourceCache = info;
  return info;
}

function readAppVersion(): string {
  const fromEnv = (process.env.npm_package_version ?? "").trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : null;
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // Version is informational only — discovery keys off `app`, never this.
  }
  return "unknown";
}
