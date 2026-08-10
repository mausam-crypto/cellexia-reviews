/**
 * Storefront proxy: `GET /apps/<subpath>/reviews` — the crawlable
 * "All Cellexia Reviews" archive (SPEC-1.19 §8).
 *
 * Responds with `Content-Type: application/liquid`: Shopify renders the body
 * server-side INSIDE the theme layout on the shop's own domain, so every
 * review on every page exists in server-rendered HTML with plain-`<a>`
 * pagination and filter links — no JS required to read anything.
 *
 * Params (all optional, invalid values silently ignored):
 *   page     1-based (24 reviews per page)
 *   product  product handle
 *   concern  SKIN_CONCERNS key
 *   stars    1–5
 *   review   review id — resolves to the page containing it (deep links)
 *
 * Security:
 *  - user content is HTML-escaped AND Liquid-neutralized (liquidSafe) — the
 *    body is interpreted as Liquid, so raw {{ or {% in a review would
 *    otherwise execute in the theme context;
 *  - live/preview gating identical to sibling routes (not live + no token ⇒
 *    404 JSON, never a rendered page);
 *  - `path_prefix` (a visitor-supplied, HMAC-covered query param) is
 *    whitelist-validated before it reaches any href;
 *  - DEBUG MODE: synthetic QA reviews are currently INCLUDED (SPEC-1.19 §6
 *    deviation — see PUBLIC_WHERE in brand-page.server.ts);
 *  - `archive` rate bucket (crawler-friendly); public cache 300 s when live, no-store for
 *    tokenized preview traffic.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { getSettings } from "~/services/settings.server";
import prisma from "~/db.server";
import { SKIN_CONCERNS } from "~/types/cellexia";
import {
  AGE_LABELS,
  CONCERN_LABELS,
  RESULT_LABELS,
  SOURCE_LABELS,
  TIME_LABELS,
  computeBrandPageFacts,
  jsonLdSafe,
  liquidSafe,
  sliceSafe,
} from "~/services/brand-page.server";

const PER_PAGE = 24;
const ARCHIVE_CACHE_HEADERS = { "Cache-Control": "public, max-age=300" };

/**
 * computeBrandPageFacts scans every published review, and this route is a
 * public SEO surface a crawler walks page after page. The facts only feed
 * the filter rows and the intro line, so a short per-shop memo keeps a
 * crawl from re-scanning the table on every request (300 s matches the
 * response cache; a moderation change shows up on the next window).
 */
const FACTS_TTL_MS = 300_000;
const factsCache = new Map<string, { at: number; facts: Awaited<ReturnType<typeof computeBrandPageFacts>> }>();

async function cachedFacts(shop: string) {
  const hit = factsCache.get(shop);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS) return hit.facts;
  const facts = await computeBrandPageFacts(shop);
  if (factsCache.size > 200) {
    for (const [k, v] of factsCache) if (Date.now() - v.at >= FACTS_TTL_MS) factsCache.delete(k);
  }
  factsCache.set(shop, { at: Date.now(), facts });
  return facts;
}

function stars(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

function archiveUrl(
  base: string,
  opts: { page?: number; product?: string; concern?: string; stars?: number },
): string {
  const params = new URLSearchParams();
  if (opts.product) params.set("product", opts.product);
  if (opts.concern) params.set("concern", opts.concern);
  if (opts.stars) params.set("stars", String(opts.stars));
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request);

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "archive")) return errorJson(429, { _: "rate_limited" });
  if (!(await requireLiveOrPreview(shop, request))) return errorJson(404, { _: "not_live" });

  const url = new URL(request.url);
  const params = url.searchParams;
  const pageRaw = params.get("page");
  let page = pageRaw && /^\d{1,5}$/.test(pageRaw) ? Number.parseInt(pageRaw, 10) : 1;
  if (page < 1) page = 1;
  const productRaw = (params.get("product") ?? "").trim();
  const product = productRaw && /^[a-z0-9-]{1,120}$/.test(productRaw) ? productRaw : undefined;
  const concernRaw = (params.get("concern") ?? "").trim();
  const concern = (SKIN_CONCERNS as readonly string[]).includes(concernRaw)
    ? concernRaw
    : undefined;
  const starsRaw = (params.get("stars") ?? "").trim();
  const starFilter = /^[1-5]$/.test(starsRaw) ? Number.parseInt(starsRaw, 10) : undefined;
  // v1.19 fix: `review=<id>` lands on the page that actually CONTAINS that
  // review (the page's analysis quotes link here) instead of always page 1.
  const reviewRaw = (params.get("review") ?? "").trim();
  const reviewAnchor = /^[A-Za-z0-9_-]{1,40}$/.test(reviewRaw) ? reviewRaw : undefined;

  // The path Shopify forwarded is the shopper-facing path — reuse it for
  // self-links so the subpath never needs hard-coding (SPEC-1.6 discipline).
  //
  // SECURITY: `path_prefix` is a QUERY PARAMETER, so a visitor can supply
  // their own value and it still passes HMAC verification (Shopify signs the
  // whole query string, including params the visitor added). This response is
  // rendered as Liquid, so an unvalidated value would be both a Liquid
  // injection and an attribute-breakout XSS — and the page is publicly
  // cached. Accept ONLY the exact shape Shopify sends; anything else falls
  // back to the default subpath.
  const forwardedRaw = url.searchParams.get("path_prefix") ?? "";
  const forwardedPath = /^\/apps\/[A-Za-z0-9_-]{1,60}$/.test(forwardedRaw)
    ? forwardedRaw
    : "/apps/cellexia-reviews";
  const base = `${forwardedPath}/reviews`;

  const where = {
    shop,
    status: "PUBLISHED",
    // DEBUG MODE (v1.29.1): synthetic reviews included — see PUBLIC_WHERE in
    // brand-page.server.ts. Restore `isSynthetic: false` here with it.
    ...(product ? { productHandle: product } : {}),
    ...(concern ? { skinConcerns: { contains: `"${concern}"` } } : {}),
    ...(starFilter ? { rating: starFilter } : {}),
  };

  const [total, facts] = await Promise.all([
    prisma.review.count({ where }),
    cachedFacts(shop),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (reviewAnchor) {
    // Same ordering as the list query below (createdAt desc, id asc), so the
    // count of rows that sort BEFORE the target gives its page.
    const target = await prisma.review.findFirst({
      where: { ...where, id: reviewAnchor },
      select: { createdAt: true, id: true },
    });
    if (target) {
      const ahead = await prisma.review.count({
        where: {
          ...where,
          OR: [
            { createdAt: { gt: target.createdAt } },
            { createdAt: target.createdAt, id: { lt: target.id } },
          ],
        },
      });
      page = Math.floor(ahead / PER_PAGE) + 1;
    }
  }
  if (page > totalPages) page = totalPages;

  const rows = await prisma.review.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * PER_PAGE,
    take: PER_PAGE,
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      authorName: true,
      createdAt: true,
      verified: true,
      language: true,
      productTitle: true,
      productHandle: true,
      skinConcerns: true,
      ageRange: true,
      timeUsing: true,
      resultsSeen: true,
      source: true,
      reply: true,
    },
  });

  // RAW (unescaped) display values — escaped exactly once at each use site.
  const productName = product
    ? (rows[0]?.productTitle ?? facts.products.find((p) => p.handle === product)?.title ?? product)
    : null;
  const concernName = concern ? CONCERN_LABELS[concern] ?? concern : null;

  let h1 = "All Cellexia Reviews";
  if (productName) h1 = `Cellexia Reviews: ${productName}`;
  else if (concernName) h1 = `Cellexia Reviews for ${concernName}`;
  else if (starFilter) h1 = `${starFilter}-Star Cellexia Reviews`;
  const pageSuffix = page > 1 ? `, Page ${page}` : "";

  const parts: string[] = [];
  parts.push(`<div class="cx-archive" style="max-width:920px;margin:0 auto;padding:24px 16px;">`);
  parts.push(
    `<nav aria-label="Breadcrumb" style="font-size:14px;margin-bottom:12px;"><a href="/pages/cellexia-reviews">Cellexia Reviews</a> › ${liquidSafe(h1 + pageSuffix)}</nav>`,
  );
  parts.push(`<h1 style="font-size:26px;margin:0 0 8px;">${liquidSafe(h1 + pageSuffix)}</h1>`);
  parts.push(
    `<p style="margin:0 0 16px;">${total} customer review${total === 1 ? "" : "s"}${
      productName ? ` of ${liquidSafe(productName)}` : concernName ? ` mentioning ${liquidSafe(concernName)}` : ""
    }, shown newest first. Cellexia's overall rating is ${facts.average} out of 5 from ${facts.count} reviews. See the full <a href="/pages/cellexia-reviews">Cellexia reviews summary and analysis</a>.</p>`,
  );

  // Crawlable filter rows (plain links, current filter highlighted).
  const filterLinks: string[] = [];
  filterLinks.push(
    `<a href="${archiveUrl(base, {})}"${!product && !concern && !starFilter ? ' aria-current="true"' : ""}>All reviews</a>`,
  );
  for (const p of facts.products) {
    if (!p.handle) continue;
    filterLinks.push(
      `<a href="${archiveUrl(base, { product: p.handle })}"${product === p.handle ? ' aria-current="true"' : ""}>${liquidSafe(p.title ?? p.handle)} (${p.count})</a>`,
    );
  }
  parts.push(
    `<p style="font-size:14px;line-height:2;margin:0 0 4px;"><strong>By product:</strong> ${filterLinks.join(" · ")}</p>`,
  );
  const concernLinks = facts.concernWinners.map(
    (w) =>
      `<a href="${archiveUrl(base, { concern: w.concern })}"${concern === w.concern ? ' aria-current="true"' : ""}>${liquidSafe(w.label)} (${w.mentions})</a>`,
  );
  if (concernLinks.length > 0) {
    parts.push(
      `<p style="font-size:14px;line-height:2;margin:0 0 4px;"><strong>By skin concern:</strong> ${concernLinks.join(" · ")}</p>`,
    );
  }
  const starLinks = [5, 4, 3, 2, 1].map(
    (s) =>
      `<a href="${archiveUrl(base, { stars: s })}"${starFilter === s ? ' aria-current="true"' : ""}>${s}★ (${facts.distribution[String(s)]?.count ?? 0})</a>`,
  );
  parts.push(
    `<p style="font-size:14px;line-height:2;margin:0 0 20px;"><strong>By rating:</strong> ${starLinks.join(" · ")}</p>`,
  );

  if (rows.length === 0) {
    parts.push(`<p>No reviews match this filter yet.</p>`);
  }

  for (const r of rows) {
    const concerns = safeKeys(r.skinConcerns).map((k) => CONCERN_LABELS[k] ?? k);
    const results = safeKeys(r.resultsSeen).map((k) => RESULT_LABELS[k] ?? k);
    const tags: string[] = [];
    if (r.ageRange && AGE_LABELS[r.ageRange]) tags.push(`Age ${AGE_LABELS[r.ageRange]}`);
    if (concerns.length) tags.push(`Concerns: ${concerns.join(", ")}`);
    if (r.timeUsing && TIME_LABELS[r.timeUsing]) tags.push(`Used for ${TIME_LABELS[r.timeUsing]}`);
    if (results.length) tags.push(`Results: ${results.join(", ")}`);
    // dir="auto" — the chrome is English/LTR, but the review text renders in
    // its own language; without a direction hint an Arabic body displays
    // left-aligned with its punctuation on the wrong side.
    parts.push(`<article id="r${liquidSafe(r.id)}" lang="${liquidSafe(r.language)}" dir="auto" style="border-top:1px solid #e3e3e3;padding:16px 0;">`);
    parts.push(
      `<p style="margin:0;font-size:14px;"><span aria-label="${r.rating} out of 5 stars">${stars(r.rating)}</span> <strong>${liquidSafe(r.title ?? "")}</strong></p>`,
    );
    parts.push(
      `<p style="margin:2px 0;font-size:13px;color:#555;">${liquidSafe(r.authorName)} · ${r.createdAt.toISOString().slice(0, 10)}${r.verified ? " · Verified Purchase" : ""}${
        r.productHandle
          ? ` · on <a href="/products/${liquidSafe(r.productHandle)}">${liquidSafe(r.productTitle ?? r.productHandle)}</a>`
          : r.productTitle
            ? ` · on ${liquidSafe(r.productTitle)}`
            : ""
      }</p>`,
    );
    if (tags.length) {
      parts.push(`<p style="margin:2px 0;font-size:12px;color:#777;">${liquidSafe(tags.join(" · "))}</p>`);
    }
    parts.push(`<p style="margin:6px 0 0;white-space:pre-line;">${liquidSafe(r.body)}</p>`);
    if (r.reply) {
      parts.push(
        `<p style="margin:8px 0 0;padding:8px 12px;background:#f6f6f6;font-size:14px;"><strong>Response from Cellexia:</strong> ${liquidSafe(r.reply)}</p>`,
      );
    }
    parts.push(
      `<p style="margin:4px 0 0;font-size:12px;color:#999;">${liquidSafe(SOURCE_LABELS[r.source ?? "storefront"] ?? "Customer review")}</p>`,
    );
    parts.push(`</article>`);
  }

  // Plain pagination links.
  const pager: string[] = [];
  const current = { product, concern, stars: starFilter };
  if (page > 1) pager.push(`<a href="${archiveUrl(base, { ...current, page: page - 1 })}" rel="prev">← Previous</a>`);
  for (let p = Math.max(1, page - 3); p <= Math.min(totalPages, page + 3); p += 1) {
    pager.push(
      p === page
        ? `<strong aria-current="page">${p}</strong>`
        : `<a href="${archiveUrl(base, { ...current, page: p })}">${p}</a>`,
    );
  }
  if (page < totalPages) pager.push(`<a href="${archiveUrl(base, { ...current, page: page + 1 })}" rel="next">Next →</a>`);
  parts.push(`<nav aria-label="Pages" style="margin:20px 0;font-size:15px;display:flex;gap:12px;flex-wrap:wrap;">${pager.join(" ")}</nav>`);
  parts.push(
    `<p style="font-size:14px;">Back to the <a href="/pages/cellexia-reviews">Cellexia Reviews summary</a>.</p>`,
  );

  // JSON-LD (SPEC-1.19 §3): BreadcrumbList + WebPage always; the
  // product-filtered view adds that product's aggregate + the reviews
  // VISIBLE on this page.
  const jsonLd: unknown[] = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Cellexia Reviews", item: "/pages/cellexia-reviews" },
        { "@type": "ListItem", position: 2, name: `${h1}${pageSuffix}` },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: `${h1}${pageSuffix}`,
      description: `${total} customer reviews of Cellexia${productName ? ` ${productName}` : ""}, with ratings, verified purchase status and skin details.`,
    },
  ];
  if (product && productName) {
    const info = facts.products.find((p) => p.handle === product);
    if (info) {
      jsonLd.push({
        "@context": "https://schema.org",
        "@type": "Product",
        "@id": `/products/${product}#product`,
        name: info.title ?? product,
        url: `/products/${product}`,
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: info.average,
          reviewCount: info.count,
          bestRating: 5,
          worstRating: 1,
        },
        // DEBUG MODE (v1.29.1): synthetic rows may be in `rows`, but they must
        // never become schema.org Review objects — structured data has no
        // "Synthetic test review" caption, so a synthetic row here would be
        // presented to Google as a genuine customer review.
        ...(() => {
          const ldRows = rows.filter((r) => r.source !== "synthetic").slice(0, 5);
          return ldRows.length
            ? {
                review: ldRows.map((r) => ({
                  "@type": "Review",
                  reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
                  author: { "@type": "Person", name: r.authorName },
                  datePublished: r.createdAt.toISOString().slice(0, 10),
                  reviewBody: sliceSafe(r.body, 500),
                  ...(r.title ? { name: r.title } : {}),
                })),
              }
            : {};
        })(),
      });
    }
  }
  // jsonLdSafe neutralizes braces inside string values (Liquid) AND escapes
  // < / > (so a review body containing "</script>" cannot end the element).
  parts.push(`<script type="application/ld+json">${jsonLdSafe(jsonLd)}</script>`);
  parts.push(`</div>`);

  const merchantPreview = await hasValidPreviewToken(shop, params);
  return new Response(parts.join("\n"), {
    headers: {
      "Content-Type": "application/liquid",
      ...(merchantPreview ? NO_STORE_HEADERS : ARCHIVE_CACHE_HEADERS),
    },
  });
}

/** Same semantics as the sibling routes' local helper: any failure ⇒ false
 * (cacheable is the shopper-safe default; the page has no merchant data). */
async function hasValidPreviewToken(shop: string, params: URLSearchParams): Promise<boolean> {
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

function safeKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
