/**
 * Cellexia Reviews — the Badge doctor (SPEC-1.32 §2).
 *
 * Step logic for the admin "Badge doctor" tab: a leave-nothing-out diagnostic
 * of the entire card-star pipeline, runnable from the merchant's admin without
 * anyone touching the storefront. The route (app.badge-doctor.tsx) stays thin;
 * everything here is dev-testable (scripts/dev-tests/badge-doctor.test.mjs).
 *
 *   step 1  badgePreviewStep       — real data for the before/after replicas
 *   step 2  reviewDataStep         — per-product review/handle table
 *   step 3  apiDryRunWithTrace     — the REAL badgeStatsByHandles with the
 *                                    SPEC-1.32 trace hook. REAL means real:
 *                                    step (b) may call the Admin API, and a
 *                                    locale root engages step (c)'s live
 *                                    storefront lookups + the shared caches
 *                                    (incl. 10-min negative entries) exactly
 *                                    as a shopper request would
 *   step 4  liveGatingStep         — isLive + liveMarkets (SPEC-1.2 gating)
 *   step 5  rateLimitStep          — the badges bucket, from RATE_LIMITS
 *   step 6  deployedExtensionCheck — merchant-invoked: the only step that
 *                                    fetches the storefront PAGE, and only
 *                                    when the merchant clicks it
 *
 * Every step returns a StepResult (pass/warn/fail + plain-language detail and
 * remedy); step 6 maps EVERY failure (network, password page, missing config,
 * pre-1.32 build) to an actionable FAIL result object and never throws.
 */
import prisma from "~/db.server";
import type { BadgeStatsDTO } from "~/types/cellexia";
import {
  MAX_BADGE_HANDLES,
  badgeStatsByHandles,
  normalizeBadgeRoot,
} from "./badges.server";
import type { AdminClient, BadgeTraceStep } from "./badges.server";
import { computeProductStats } from "./reviews.server";
import { getSettings, parseLiveMarkets } from "./settings.server";
import { RATE_LIMITS } from "./ratelimit.server";

/** One diagnostic verdict (SPEC-1.32 §2): the Polaris Badge tone + copy. */
export interface StepResult {
  status: "pass" | "warn" | "fail";
  title: string;
  detail: string;
  remedy?: string;
}

/** Shopify handle shape — mirrors badges.server/route validation. */
const HANDLE_RE = /^[a-z0-9-]{1,255}$/;

/* ------------------------------------------------------------------------- *
 * Step 1 — Expected badge preview
 * ------------------------------------------------------------------------- */

export interface BadgePreviewData {
  productId: string | null;
  productTitle: string | null;
  average: number;
  count: number;
  /** True when the shop has no published reviews and the numbers are canned. */
  sample: boolean;
}

/**
 * Real data for the server-rendered card-badge replicas: the shop's
 * top-reviewed product's average/count via computeProductStats — the exact
 * numbers the API serves (SPEC-1.5 §2 rounding, never forked). Falls back to
 * canned sample numbers (WARN) when the shop has no published reviews, so the
 * before/after anatomy is still visible.
 */
export async function badgePreviewStep(
  shop: string,
): Promise<{ result: StepResult; preview: BadgePreviewData }> {
  const groups = await prisma.review.groupBy({
    by: ["productId"],
    where: { shop, status: "PUBLISHED" },
    _count: { _all: true },
  });
  let top: { productId: string; count: number } | null = null;
  for (const group of groups) {
    const count = group._count._all;
    if (!top || count > top.count || (count === top.count && group.productId < top.productId)) {
      top = { productId: group.productId, count };
    }
  }
  if (!top) {
    return {
      result: {
        status: "warn",
        title: "Expected badge preview",
        detail:
          "No published reviews yet, so the replicas below use sample numbers. The anatomy is still exact: v1.32 shows stars, the numeric rating and the review count on every card badge.",
        remedy:
          "Publish at least one review (Reviews tab) and reload this page to preview with your real numbers.",
      },
      preview: { productId: null, productTitle: null, average: 4.8, count: 132, sample: true },
    };
  }
  const [stats, titleRow] = await Promise.all([
    computeProductStats(shop, top.productId),
    prisma.review.findFirst({
      where: { shop, productId: top.productId },
      orderBy: { createdAt: "desc" },
      select: { productTitle: true },
    }),
  ]);
  return {
    result: {
      status: "pass",
      title: "Expected badge preview",
      detail:
        `Rendered from your top-reviewed product using the exact numbers the badge API serves. ` +
        `The v1.32 replica leads with the numeric rating, then the stars, then the count — the product page's arrangement. The pre-1.32 replica is what you reported: stars and count, no number.`,
    },
    preview: {
      productId: top.productId,
      productTitle: titleRow?.productTitle ?? null,
      average: stats.average,
      count: stats.count,
      sample: false,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Step 2 — Review data
 * ------------------------------------------------------------------------- */

export interface ReviewDataRow {
  productId: string;
  productTitle: string | null;
  /** Review rows in ANY status. */
  totalCount: number;
  /** PUBLISHED rows — what shoppers (and badges) can ever see. */
  publishedCount: number;
  /** computeProductStats average — the exact number the API serves. */
  average: number;
  /** Distinct productHandle values on rows: canonical + observed aliases. */
  handles: string[];
  /** FAIL highlight: the product has reviews but not one is PUBLISHED. */
  zeroPublished: boolean;
}

/**
 * Per-product table over every product with Review rows: published count,
 * average (via computeProductStats — the exact numbers the API serves) and
 * the productHandle values present on rows (canonical + observed translated
 * aliases). A product with reviews but zero PUBLISHED ones is the classic
 * "why no stars" cause and flags the whole step FAIL.
 */
export async function reviewDataStep(
  shop: string,
): Promise<{ result: StepResult; rows: ReviewDataRow[] }> {
  const groups = await prisma.review.groupBy({
    by: ["productId", "productHandle", "status"],
    where: { shop },
    _count: { _all: true },
  });
  const byProduct = new Map<string, { total: number; published: number; handles: Set<string> }>();
  for (const group of groups) {
    let entry = byProduct.get(group.productId);
    if (!entry) {
      entry = { total: 0, published: 0, handles: new Set() };
      byProduct.set(group.productId, entry);
    }
    entry.total += group._count._all;
    if (group.status === "PUBLISHED") entry.published += group._count._all;
    if (group.productHandle) entry.handles.add(group.productHandle);
  }
  const productIds = [...byProduct.keys()];
  if (productIds.length === 0) {
    return {
      result: {
        status: "warn",
        title: "Review data",
        detail: "No review rows exist for this shop yet — there is nothing for badges to show.",
        remedy: "Import reviews (Import / Export), collect them, or generate test data (QA data).",
      },
      rows: [],
    };
  }
  // Review hardening (v1.32): bound the burst — the loader runs this on every
  // page view, and one groupBy per product with no ceiling would let a large
  // catalog saturate the connection pool. Cap the table and chunk the stats.
  const REVIEW_DATA_MAX_PRODUCTS = 250;
  const REVIEW_DATA_STATS_CHUNK = 8;
  const truncatedProducts = Math.max(0, productIds.length - REVIEW_DATA_MAX_PRODUCTS);
  const boundedIds = productIds.slice(0, REVIEW_DATA_MAX_PRODUCTS);
  const statsList: Awaited<ReturnType<typeof computeProductStats>>[] = [];
  const titleRows = await prisma.review.findMany({
    where: { shop, productId: { in: boundedIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["productId"],
    select: { productId: true, productTitle: true },
  });
  for (let i = 0; i < boundedIds.length; i += REVIEW_DATA_STATS_CHUNK) {
    statsList.push(
      ...(await Promise.all(
        boundedIds
          .slice(i, i + REVIEW_DATA_STATS_CHUNK)
          .map((productId) => computeProductStats(shop, productId)),
      )),
    );
  }
  const titleById = new Map(titleRows.map((row) => [row.productId, row.productTitle]));
  const statsById = new Map(statsList.map((stats) => [stats.id, stats]));
  const rows: ReviewDataRow[] = boundedIds
    .map((productId) => {
      const entry = byProduct.get(productId)!;
      return {
        productId,
        productTitle: titleById.get(productId) ?? null,
        totalCount: entry.total,
        publishedCount: entry.published,
        average: statsById.get(productId)?.average ?? 0,
        handles: [...entry.handles].sort(),
        zeroPublished: entry.total > 0 && entry.published === 0,
      };
    })
    .sort(
      (a, b) => b.publishedCount - a.publishedCount || a.productId.localeCompare(b.productId),
    );
  const zeroCount = rows.filter((row) => row.zeroPublished).length;
  return {
    result:
      zeroCount > 0
        ? {
            status: "fail",
            title: "Review data",
            detail: `${zeroCount} product(s) have reviews but not one is PUBLISHED — badges only ever count published reviews, so those products show no stars anywhere.`,
            remedy:
              "Open the Reviews tab, filter by the highlighted product and publish (or approve) its reviews.",
          }
        : {
            status: "pass",
            title: "Review data",
            detail:
              `${rows.length} product(s) have review rows, every one with at least one published review. The averages shown are computed by the same code the badge API uses.` +
              (truncatedProducts > 0
                ? ` (${truncatedProducts} more product(s) exist beyond this table's ${rows.length}-row cap.)`
                : ""),
          },
    rows,
  };
}

/* ------------------------------------------------------------------------- *
 * Step 3 — API dry-run with trace
 * ------------------------------------------------------------------------- */

export interface DryRunHandleResult {
  handle: string;
  /** True when the token does not match the Shopify handle shape at all. */
  invalid: boolean;
  /** Resolution decisions, in order (SPEC-1.32 §2 step 3 labels). */
  path: BadgeTraceStep[];
  /** The stats served for this handle, or null when omitted. */
  badge: BadgeStatsDTO | null;
}

export interface DryRunResult {
  result: StepResult;
  /** Normalized locale root actually used (`/fr/`), or null. */
  root: string | null;
  handles: DryRunHandleResult[];
  /** The exact JSON body the storefront would receive. */
  responseJson: string;
}

/**
 * Runs the REAL badgeStatsByHandles in-process — same resolution chain, same
 * module-level caches the live route warms — with a trace collector, and
 * reports per handle the path taken plus the exact JSON the storefront would
 * receive. `handlesRaw` is the form's free text (comma/whitespace separated);
 * `rootRaw` follows the SPEC-1.31 §2 normalizer, invalid values ignored.
 */
export async function apiDryRunWithTrace(
  shop: string,
  admin: AdminClient | null,
  handlesRaw: string,
  rootRaw: string,
): Promise<DryRunResult> {
  // Review hardening (v1.32): bound the raw input and every echoed token —
  // tokens (valid or not) render back into the admin page, so nothing
  // unbounded may pass through.
  const tokens: string[] = [];
  for (const part of handlesRaw.slice(0, 4096).split(/[\s,]+/)) {
    const candidate = part.trim().toLowerCase().slice(0, 255);
    if (!candidate || tokens.includes(candidate)) continue;
    tokens.push(candidate);
    if (tokens.length >= MAX_BADGE_HANDLES) break;
  }
  const valid = tokens.filter((handle) => HANDLE_RE.test(handle));
  const root = normalizeBadgeRoot(rootRaw);
  if (tokens.length === 0) {
    return {
      result: {
        status: "fail",
        title: "API dry-run",
        detail: "No handles to test — enter at least one product handle.",
        remedy: "Copy a handle from the Review data table above, or from a product URL.",
      },
      root,
      handles: [],
      responseJson: JSON.stringify({ badges: {} }),
    };
  }

  const paths = new Map<string, BadgeTraceStep[]>();
  const badges = await badgeStatsByHandles(shop, admin, valid, root, (handle, step) => {
    const path = paths.get(handle);
    if (path) path.push(step);
    else paths.set(handle, [step]);
  });

  const handles: DryRunHandleResult[] = tokens.map((handle) => ({
    handle,
    invalid: !HANDLE_RE.test(handle),
    path: paths.get(handle) ?? [],
    badge: badges[handle] ?? null,
  }));
  const answered = handles.filter((entry) => entry.badge !== null).length;
  const result: StepResult =
    answered === tokens.length
      ? {
          status: "pass",
          title: "API dry-run",
          detail: `All ${tokens.length} handle(s) answered with stats — the server side of the pipeline works for these handles.`,
        }
      : answered > 0
        ? {
            status: "warn",
            title: "API dry-run",
            detail: `${answered} of ${tokens.length} handle(s) answered; the rest were omitted — their trace below says at which step resolution stopped.`,
            remedy:
              'An "unresolved" handle is unknown to the app (no review rows, no Shopify product match, no storefront match under the locale root). Check spelling, or add the locale root for translated handles.',
          }
        : {
            status: "fail",
            title: "API dry-run",
            detail:
              "No handle answered — shoppers requesting these handles would get an empty badges response.",
            remedy:
              "Check the traces below: if every path ends at \"unresolved\", the handles do not match any product the app knows. For translated storefront handles, set the locale root (e.g. fr).",
          };
  return { result, root, handles, responseJson: JSON.stringify({ badges }) };
}

/* ------------------------------------------------------------------------- *
 * Step 4 — Live gating
 * ------------------------------------------------------------------------- */

export interface LiveGatingData {
  isLive: boolean;
  liveScope: "all" | "markets";
  liveMarkets: string[];
}

/**
 * SPEC-1.2 gating: while the shop is not live, every shopper /badges request
 * answers 403 by design (previews excepted) — no card stars anywhere. WARN,
 * not FAIL: staying offline is a legitimate merchant choice.
 */
export async function liveGatingStep(
  shop: string,
): Promise<{ result: StepResult; gating: LiveGatingData }> {
  const settings = await getSettings(shop);
  const liveScope = settings.liveScope === "markets" ? ("markets" as const) : ("all" as const);
  const liveMarkets = liveScope === "markets" ? parseLiveMarkets(settings) : [];
  const gating: LiveGatingData = { isLive: settings.isLive, liveScope, liveMarkets };
  return {
    result: settings.isLive
      ? {
          status: "pass",
          title: "Live gating",
          detail:
            liveScope === "markets"
              ? `You are live in: ${liveMarkets.join(", ") || "(no markets picked)"} — shopper badge requests are answered there.`
              : "You are live in all markets — shopper badge requests are answered.",
        }
      : {
          status: "warn",
          title: "Live gating",
          detail:
            "You are NOT live: shoppers' badge requests answer 403 by design, so no card stars show anywhere (tokenized previews still work).",
          remedy: 'Open the Dashboard tab and press "Go live" when you are ready.',
        },
    gating,
  };
}

/* ------------------------------------------------------------------------- *
 * Step 5 — Rate limits
 * ------------------------------------------------------------------------- */

export interface RateLimitData {
  /** RATE_LIMITS.badges, rendered — never hardcoded in the page. */
  max: number;
  windowMs: number;
  /** Whether CELLEXIA_CLIENT_IP_HEADER is set here (name-only, never the value). */
  ipHeaderSet: boolean;
}

/**
 * The badges token bucket, read from RATE_LIMITS (SPEC-1.32 §2 step 5 —
 * never hardcoded), plus whether this deployment sets
 * CELLEXIA_CLIENT_IP_HEADER (reported name-only; the value is never echoed).
 * FAIL guards the SPEC-1.31 §4b floor the same way dev-test S12 does.
 */
export function rateLimitStep(): { result: StepResult; limits: RateLimitData } {
  const bucket = RATE_LIMITS.badges;
  const ipHeaderSet = Boolean(process.env.CELLEXIA_CLIENT_IP_HEADER?.trim());
  const limits: RateLimitData = { max: bucket.max, windowMs: bucket.windowMs, ipHeaderSet };
  // SPEC-1.31 §4b in one sentence (rendered by the page next to the numbers).
  const shared =
    "Behind the real chain (shopper → CDN → Shopify proxy → host) the limiter sees a small pool of proxy-egress IPs, so this bucket is effectively shared by all shoppers of the store at once — which is why it must stay generous.";
  if (bucket.max < 2400 || bucket.windowMs !== 3_600_000) {
    return {
      result: {
        status: "fail",
        title: "Rate limits",
        detail: `The badges bucket is ${bucket.max} per ${Math.round(bucket.windowMs / 60_000)} min — below the SPEC-1.31 §4b floor of 2400/h. ${shared}`,
        remedy: "Restore RATE_LIMITS.badges to at least 2400 per hour (ratelimit.server.ts).",
      },
      limits,
    };
  }
  if (!ipHeaderSet) {
    return {
      result: {
        status: "warn",
        title: "Rate limits",
        detail: `The badges bucket allows ${bucket.max} requests per hour per bucket. ${shared} CELLEXIA_CLIENT_IP_HEADER is not set in this deployment, so buckets stay shared.`,
        remedy:
          "Optional: set CELLEXIA_CLIENT_IP_HEADER on the host (e.g. true-client-ip on Render) for true per-visitor buckets.",
      },
      limits,
    };
  }
  return {
    result: {
      status: "pass",
      title: "Rate limits",
      detail: `The badges bucket allows ${bucket.max} requests per hour per bucket, and CELLEXIA_CLIENT_IP_HEADER is set, so buckets are per visitor. ${shared}`,
    },
    limits,
  };
}

/* ------------------------------------------------------------------------- *
 * Step 6 — Deployed-extension check (merchant-invoked)
 * ------------------------------------------------------------------------- */

/** Both step-6 fetches abort after this long — INCLUDING the body read
 * (the timer stays armed until the text is fully buffered, mirroring the
 * badges.server step (c) hardening; review finding, v1.32). */
const DOCTOR_FETCH_TIMEOUT_MS = 8000;

/** Body-size ceilings for the two step-6 fetches (review finding): the home
 * page (app embeds ride inside it) and the extension JS (~150 KB deployed).
 * Reads beyond the cap are truncated and the stream cancelled — the markers
 * this check greps for sit well inside both limits. */
const DOCTOR_HOME_MAX_BYTES = 3_000_000;
const DOCTOR_ASSET_MAX_BYTES = 1_000_000;

/** Browser-shaped headers for the storefront fetch: a bare undici UA is
 * exactly what CDN bot protection challenges (SPEC-1.31 §1.4). */
const DOCTOR_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 CellexiaBadgeDoctor/1.32",
  Accept: "text/html,application/xhtml+xml,application/javascript;q=0.9,*/*;q=0.8",
} as const;

/** The v1.32 marker the deployed extension JS must contain (SPEC-1.32 §1). */
const SCORE_MARKER = "cx-badge-inline__score";

/**
 * Fetch boundary for the CDN asset: the URL is extracted from storefront HTML
 * (untrusted page content), so only Shopify's extensions CDN serving THIS
 * app's asset filename is ever fetched — anything else fails the match and
 * the check reports "script tag not found".
 */
const EXTENSION_ASSET_RE =
  /https:\/\/cdn\.shopify\.com\/extensions\/[0-9a-f-]+\/(cellexia-reviews-\d+)\/assets\/cellexia-reviews\.js[^"'\s>]*/;

const EMBED_CONFIG_RE =
  /<script[^>]*id="cx-embed-config"[^>]*>([\s\S]*?)<\/script>/;

export interface DeployedCheckData {
  result: StepResult;
  /** enable_badges / badge_style / card_badge_position from the SERVED config. */
  config: {
    enableBadges: boolean | null;
    badgeStyle: string | null;
    cardBadgePosition: string | null;
  } | null;
  /** Extension build directory from the asset URL, e.g. "cellexia-reviews-29". */
  build: string | null;
  assetUrl: string | null;
}

interface TimedFetchResult {
  status: number;
  /** Final URL after redirects ("" when unavailable). */
  finalUrl: string;
  /** Body text (possibly truncated at the cap); null when status !== 200. */
  text: string | null;
}

/**
 * One timed, size-capped fetch (review hardening, v1.32): the abort timer
 * spans the WHOLE transfer — headers AND body — so a trickled body cannot
 * hang past DOCTOR_FETCH_TIMEOUT_MS; the body is streamed and truncated at
 * `maxBytes` (stream cancelled); non-200 bodies are cancelled immediately so
 * undici releases the socket (the badges.server drain rule). Falls back to
 * plain text() when the runtime/stub provides no body stream — still inside
 * the armed timer. Throws only AbortError/network errors (callers map those
 * to the network FAIL).
 */
async function timedFetch(url: string, maxBytes: number): Promise<TimedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCTOR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: DOCTOR_FETCH_HEADERS,
    });
    let finalUrl = "";
    try {
      finalUrl = response.url || "";
    } catch {
      finalUrl = "";
    }
    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        /* draining is best-effort */
      }
      return { status: response.status, finalUrl, text: null };
    }
    const body: ReadableStream<Uint8Array> | null | undefined = response.body;
    if (!body || typeof body.getReader !== "function") {
      return { status: response.status, finalUrl, text: await response.text() };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size >= maxBytes) {
        chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
        try {
          await reader.cancel();
        } catch {
          /* draining is best-effort */
        }
        break;
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { status: response.status, finalUrl, text: new TextDecoder().decode(joined) };
  } finally {
    clearTimeout(timer);
  }
}

function fail(detail: string, remedy: string): StepResult {
  return { status: "fail", title: "Deployed-extension check", detail, remedy };
}

/**
 * The guarantee step (SPEC-1.32 §2 step 6), run ONLY when the merchant clicks
 * it: server-side fetch of the shop's own home page (`https://{shop}/`, the
 * session's myshopify domain — Shopify's redirect to the primary domain is
 * followed), verify #cx-embed-config exists, report the served badge
 * settings, extract the extension build from the asset URL, then fetch that
 * CDN JS once and grep for the v1.32 score marker. Every failure — network,
 * password page, missing config, pre-1.32 build — maps to an actionable FAIL
 * result object; this function never throws.
 */
export async function deployedExtensionCheck(shop: string): Promise<DeployedCheckData> {
  // `_fd=0` keeps the request on the myshopify origin instead of following
  // Shopify's redirect onto the primary domain — whose CDN bot protection
  // challenges server-side fetches with 403 (SPEC-1.31 §1.4) and would make
  // this step chronically false-FAIL (review finding, v1.32). Same published
  // theme, same embeds, no third-party edge in the path.
  const homeUrl = `https://${shop}/?_fd=0`;
  let html: string;
  let landedPath = "";
  try {
    const home = await timedFetch(homeUrl, DOCTOR_HOME_MAX_BYTES);
    try {
      landedPath = home.finalUrl ? new URL(home.finalUrl).pathname : "";
    } catch {
      landedPath = "";
    }
    if (landedPath === "/password" || landedPath.startsWith("/password")) {
      return {
        result: fail(
          `Your storefront (${homeUrl}) is behind the Shopify password page, so what shoppers would receive cannot be checked.`,
          "Remove the storefront password (Online Store → Preferences) or re-run this check after launch.",
        ),
        config: null,
        build: null,
        assetUrl: null,
      };
    }
    if (home.status === 401 || home.status === 403) {
      return {
        result: fail(
          `Your storefront answered HTTP ${home.status} to the app server — almost always a CDN/bot-protection challenge aimed at server-side requests, NOT something shoppers see.`,
          "Open the storefront in your own browser to confirm it loads; if it does, this check is being challenged — allowlist the app server in your CDN's bot settings, or verify the deployed build number manually in the page source.",
        ),
        config: null,
        build: null,
        assetUrl: null,
      };
    }
    if (home.status !== 200 || home.text === null) {
      return {
        result: fail(
          `Your storefront answered HTTP ${home.status} for ${homeUrl} — the served page could not be checked.`,
          "Make sure the online store is reachable, then run this check again.",
        ),
        config: null,
        build: null,
        assetUrl: null,
      };
    }
    html = home.text;
  } catch {
    return {
      result: fail(
        `Could not reach your storefront (${homeUrl}) from the app server within ${DOCTOR_FETCH_TIMEOUT_MS / 1000} seconds — network error or timeout.`,
        "Check that the online store is reachable in a browser, then run this check again.",
      ),
      config: null,
      build: null,
      assetUrl: null,
    };
  }

  const configMatch = html.match(EMBED_CONFIG_RE);
  if (!configMatch) {
    return {
      result: fail(
        "The served home page has no #cx-embed-config — the Cellexia Reviews app embed is not enabled on the theme shoppers receive, so no badges (numeric or otherwise) can render.",
        'Theme editor → App embeds → turn ON "Cellexia Reviews", save, then run this check again.',
      ),
      config: null,
      build: null,
      assetUrl: null,
    };
  }

  let config: DeployedCheckData["config"] = null;
  try {
    const parsed = JSON.parse(configMatch[1]) as {
      settings?: {
        enable_badges?: unknown;
        badge_style?: unknown;
        card_badge_position?: unknown;
      };
    };
    const settings = parsed?.settings ?? {};
    config = {
      enableBadges: typeof settings.enable_badges === "boolean" ? settings.enable_badges : null,
      badgeStyle: typeof settings.badge_style === "string" ? settings.badge_style : null,
      cardBadgePosition:
        typeof settings.card_badge_position === "string" ? settings.card_badge_position : null,
    };
  } catch {
    return {
      result: fail(
        "#cx-embed-config exists but its JSON could not be parsed — the served config is corrupt, so the injector cannot boot.",
        "Open the theme editor, re-save the Cellexia Reviews app embed, then run this check again.",
      ),
      config: null,
      build: null,
      assetUrl: null,
    };
  }

  const assetMatch = html.match(EXTENSION_ASSET_RE);
  if (!assetMatch) {
    return {
      result: fail(
        "#cx-embed-config exists but the extension script tag (cdn.shopify.com/extensions/…/cellexia-reviews.js) was not found on the served page — the badge JS never loads.",
        "Re-save the app embed in the theme editor; if the tag is still missing, redeploy the extension (npm run deploy).",
      ),
      config,
      build: null,
      assetUrl: null,
    };
  }
  const assetUrl = assetMatch[0];
  const build = assetMatch[1];

  let js: string;
  try {
    const asset = await timedFetch(assetUrl, DOCTOR_ASSET_MAX_BYTES);
    if (asset.status !== 200 || asset.text === null) {
      return {
        result: fail(
          `The extension JS (${build}) answered HTTP ${asset.status} from the Shopify CDN — the deployed build could not be verified.`,
          "Run this check again in a minute; if it keeps failing, redeploy the extension (npm run deploy).",
        ),
        config,
        build,
        assetUrl,
      };
    }
    js = asset.text;
  } catch {
    return {
      result: fail(
        `Could not fetch the extension JS (${build}) from the Shopify CDN within ${DOCTOR_FETCH_TIMEOUT_MS / 1000} seconds — network error or timeout.`,
        "Run this check again in a minute.",
      ),
      config,
      build,
      assetUrl,
    };
  }

  if (!js.includes(SCORE_MARKER)) {
    return {
      result: fail(
        `The deployed build (${build}) predates v1.32 — its card badges have no numeric rating.`,
        "Run `npm run deploy` (extensions half) to ship the v1.32 extension, then run this check again.",
      ),
      config,
      build,
      assetUrl,
    };
  }
  // Setting-level suppressions outrank the marker PASS (review finding,
  // v1.32): a deployed v1.32 build still shows NO number when badges are off
  // or the style is "stars only" — the verdict must say so, not "PASS".
  if (config.enableBadges === false) {
    return {
      result: {
        status: "warn",
        title: "Deployed-extension check",
        detail: `The deployed extension (${build}) renders the numeric rating — but enable_badges is OFF in the served app-embed settings, so card badges are switched off for shoppers.`,
        remedy: 'Theme editor → App embeds → Cellexia Reviews → turn "Star badges on product cards" ON.',
      },
      config,
      build,
      assetUrl,
    };
  }
  if (config.badgeStyle === "stars_only") {
    return {
      result: {
        status: "warn",
        title: "Deployed-extension check",
        detail: `The deployed extension (${build}) CAN render the numeric rating, but the served badge style is "Stars only" — that setting hides the number and the count on every card badge.`,
        remedy: 'Theme editor → App embeds → Cellexia Reviews → set the badge style to "Stars + review count".',
      },
      config,
      build,
      assetUrl,
    };
  }
  return {
    result: {
      status: "pass",
      title: "Deployed-extension check",
      detail: `The deployed extension (${build}) renders the numeric rating — the served JS contains the v1.32 card-badge score. This is what shoppers receive.`,
    },
    config,
    build,
    assetUrl,
  };
}
