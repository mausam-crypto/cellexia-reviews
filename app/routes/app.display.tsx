/**
 * Display order admin page (SPEC-1.8 §3, SPEC-1.9 §4).
 *
 * One page, two views:
 *  - Overview (no `?product=`): the shop-wide default ranking system (six
 *    ChoiceList options with plain-language descriptions and tiny star-row
 *    examples, plus the two boost checkboxes), the per-product overrides
 *    IndexTable (every product with ≥ 1 published review), and — v1.9 — the
 *    "Overall reviews (homepage widget)" card: Auto / Hand-picked mode, the
 *    cross-product picker (cap 12) and the Refresh-homepage-data button.
 *  - Editor (`?product=<id>`): per-product system select (incl. "Use the store
 *    default"), the ordered Featured-reviews list with ↑ / ↓ / Remove buttons,
 *    and a searchable, paginated "Add reviews" list of that product's
 *    published reviews. Cap: 10 featured reviews per product, validated on
 *    both ends.
 *
 * Saving a per-product config persists ProductDisplayConfig (the row is
 * deleted when reverted to default-with-no-pins) and re-syncs that product's
 * metafields via syncProductData so SSR (top_reviews metafield + JSON-LD)
 * updates promptly; the shopper-facing GET reviews response is cached for
 * 60 s, hence the "within a minute" helptext everywhere. The homepage card's
 * save/refresh paths call syncShopRating synchronously (SPEC-1.9 §4) so the
 * two shop metafields the Overall-reviews block SSRs from update right away.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { RANKING_STRATEGIES } from "~/types/cellexia";
import type { RankingStrategy } from "~/types/cellexia";
import { getSettings } from "~/services/settings.server";
import type { CurationEstimate as FullCurationEstimate } from "~/services/curation-estimate.server";
import { computeShopStats, syncShopRating } from "~/services/brand.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { StarRating } from "~/components/admin/StarRating";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, formatDateTime, pluralize } from "~/components/admin/labels";
import { formatUsd } from "~/components/admin/GenerationActivityBar";

/** What the estimate action actually sends: aggregates only (no `pairs`). */
type CurationEstimate = Omit<FullCurationEstimate, "pairs">;

/** Featured ("pinned") reviews per product — SPEC-1.8 §3 cap, both ends. */
const MAX_PINNED = 10;
/** Page size of the editor's "Add reviews" candidate list. */
const ADD_PER_PAGE = 10;
/**
 * Hand-picked reviews for the brand-wide "Overall reviews" homepage block —
 * SPEC-1.9 §4 cap, validated on both ends (matches the 12-entry ceiling of the
 * `cellexia.shop_top_reviews` metafield and the block's max_reviews range).
 */
const MAX_OVERALL_PICKED = 12;
/** Page size of the homepage card's cross-product "Add reviews" list. */
const OVERALL_ADD_PER_PAGE = 10;
/**
 * A shop-default save re-syncs product metafields (SSR top reviews + JSON-LD
 * follow the effective display). At most this many products — the
 * most-reviewed first — are synced before the action responds, so the request
 * never holds for minutes on large catalogs; the remainder is synced
 * best-effort in the background after the response so every product's SSR
 * converges rather than waiting on its next moderation-driven sync. The live
 * widget always updates within the 60 s proxy cache window regardless.
 */
const DEFAULT_SAVE_RESYNC_CAP = 25;

/** Short system names for table cells ("Default (Amazon-style)" etc.). */
const STRATEGY_SHORT: Record<RankingStrategy, string> = {
  amazon_top: "Amazon-style",
  top_positive: "Best rated first",
  most_recent: "Newest first",
  verified_first: "Verified first",
  media_first: "Photos first",
  balanced: "Balanced",
  ai_curated: "AI curated",
};

interface ExampleRow {
  stars: number;
  note: string;
}

/**
 * The six ranking systems with merchant-friendly labels, one-line
 * plain-language descriptions and a tiny star-row example each (SPEC-1.8 §3).
 */
const STRATEGY_OPTIONS: Array<{
  value: RankingStrategy;
  label: string;
  description: string;
  example: ExampleRow[];
}> = [
  {
    value: "amazon_top",
    label: "Amazon-style — most helpful first (default)",
    description:
      "The classic order shoppers know: reviews other customers found helpful lead, verified purchases break ties, newest first after that.",
    example: [
      { stars: 5, note: "312 found helpful" },
      { stars: 4, note: "198 found helpful · Verified" },
      { stars: 5, note: "54 found helpful" },
    ],
  },
  {
    value: "ai_curated",
    label: "AI curated — conversion optimized (per language)",
    description:
      "A skeptical AI agent reads your product description and Overview, works out what prospects doubt, and puts the most credible convincing reviews first. Runs separately for every language, with instructions written in that language. Helpful-vote counts are ignored. Uses your Claude API key; you trigger curation from the card below (or turn on automatic refresh there), and languages without a curation fall back to the Amazon-style order.",
    example: [
      { stars: 5, note: "Answers the biggest doubt, credibly" },
      { stars: 4, note: "Believable, covers a second concern" },
      { stars: 5, note: "Specific results story" },
    ],
  },
  {
    value: "top_positive",
    label: "Best rated first",
    description: "Your strongest reviews lead: 5-star reviews first, the most helpful of them on top.",
    example: [
      { stars: 5, note: "Most helpful 5-star" },
      { stars: 5, note: "Next 5-star" },
      { stars: 4, note: "Then 4-star reviews" },
    ],
  },
  {
    value: "most_recent",
    label: "Newest first",
    description: "The latest reviews always lead — ideal when you collect fresh reviews regularly.",
    example: [
      { stars: 4, note: "Today" },
      { stars: 5, note: "Yesterday" },
      { stars: 3, note: "Last week" },
    ],
  },
  {
    value: "verified_first",
    label: "Verified purchases first",
    description: "Reviews from confirmed buyers lead; within each group the most helpful come first.",
    example: [
      { stars: 5, note: "Verified Purchase" },
      { stars: 4, note: "Verified Purchase" },
      { stars: 5, note: "Not verified" },
    ],
  },
  {
    value: "media_first",
    label: "Photos and videos first",
    description: "Reviews with customer photos or videos lead; the most helpful come first after that.",
    example: [
      { stars: 4, note: "3 photos" },
      { stars: 5, note: "1 photo" },
      { stars: 5, note: "No photos" },
    ],
  },
  {
    value: "balanced",
    label: "Balanced — positive and critical mixed",
    description:
      "Three positive reviews, then one critical, repeating — the honest mix that builds shopper trust.",
    example: [
      { stars: 5, note: "Positive" },
      { stars: 5, note: "Positive" },
      { stars: 5, note: "Positive" },
      { stars: 2, note: "Then one critical" },
    ],
  },
];

function isStrategy(value: string): value is RankingStrategy {
  return (RANKING_STRATEGIES as readonly string[]).includes(value);
}

function normalizeStrategy(value: string | null | undefined): RankingStrategy {
  return value && isStrategy(value) ? value : "amazon_top";
}

/** Parses Setting.rankingBoosts (JSON `{ boostVerified?, boostMedia? }`). */
function parseBoosts(raw: string | null | undefined): {
  boostVerified: boolean;
  boostMedia: boolean;
} {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const record =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    return {
      boostVerified: record.boostVerified === true,
      boostMedia: record.boostMedia === true,
    };
  } catch {
    return { boostVerified: false, boostMedia: false };
  }
}

/** Parses ProductDisplayConfig.pinnedIds (JSON string[]). */
function parseIdArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Parses Setting.overallWidget (SPEC-1.9 §1): JSON
 * `{ mode?: "auto" | "picked", pickedIds?: string[] }`, validated on read —
 * anything unknown or unparsable falls back to auto with no picks.
 */
function parseOverallWidget(raw: string | null | undefined): {
  mode: "auto" | "picked";
  pickedIds: string[];
} {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const mode = record.mode === "picked" ? "picked" : "auto";
    const pickedIds = Array.isArray(record.pickedIds)
      ? record.pickedIds.filter((v): v is string => typeof v === "string")
      : [];
    return { mode, pickedIds: [...new Set(pickedIds)] };
  } catch {
    return { mode: "auto", pickedIds: [] };
  }
}

/** Collapses whitespace and clips to `max` characters (SPEC-1.8 §3: 60). */
function excerptOf(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const PIN_SELECT = {
  id: true,
  rating: true,
  title: true,
  body: true,
  authorName: true,
  createdAt: true,
} as const;

interface PinRowSource {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  createdAt: Date;
}

/** One row of the per-product overrides table (overview view). */
interface OverviewProduct {
  productId: string;
  productTitle: string | null;
  publishedCount: number;
  /** Override system, or null when the product inherits the store default. */
  override: RankingStrategy | null;
  pinnedCount: number;
}

function toPinRow(row: PinRowSource) {
  return {
    id: row.id,
    rating: row.rating,
    title: row.title,
    excerpt: excerptOf(row.body),
    authorName: row.authorName,
    createdAt: row.createdAt,
  };
}

/**
 * The homepage picker is cross-product (SPEC-1.9 §4), so its rows also carry
 * the product they belong to — rendered as the picker's product column.
 */
const OVERALL_SELECT = {
  ...PIN_SELECT,
  productId: true,
  productTitle: true,
} as const;

interface OverallRowSource extends PinRowSource {
  productId: string;
  productTitle: string | null;
}

function toOverallRow(row: OverallRowSource) {
  return {
    ...toPinRow(row),
    productId: row.productId,
    productTitle: row.productTitle,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const productParam = (url.searchParams.get("product") ?? "").trim();

  const settings = await getSettings(shop);
  const defaults = {
    strategy: normalizeStrategy(settings.rankingStrategy),
    ...parseBoosts(settings.rankingBoosts),
  };

  if (productParam) {
    // Review.productId is always the numeric Shopify id as a string.
    if (!/^\d{1,20}$/.test(productParam)) {
      return redirect("/app/display");
    }
    const productId = productParam;

    const q = (url.searchParams.get("q") ?? "").trim();
    const starsRaw = Number.parseInt(url.searchParams.get("stars") ?? "", 10);
    const stars = starsRaw >= 1 && starsRaw <= 5 ? starsRaw : null;
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

    const config = await prisma.productDisplayConfig.findUnique({
      where: { shop_productId: { shop, productId } },
    });
    const storedPinnedIds = parseIdArray(config?.pinnedIds);

    const candidateWhere = {
      shop,
      productId,
      status: "PUBLISHED",
      ...(stars ? { rating: stars } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q } },
              { body: { contains: q } },
              { authorName: { contains: q } },
            ],
          }
        : {}),
    };

    const [sample, publishedCount, pinnedRows, candidates, candidatesTotal] = await Promise.all([
      prisma.review.findFirst({
        where: { shop, productId },
        orderBy: { createdAt: "desc" },
        select: { productTitle: true },
      }),
      prisma.review.count({ where: { shop, productId, status: "PUBLISHED" } }),
      storedPinnedIds.length
        ? prisma.review.findMany({
            where: { shop, productId, status: "PUBLISHED", id: { in: storedPinnedIds } },
            select: PIN_SELECT,
          })
        : Promise.resolve([] as PinRowSource[]),
      prisma.review.findMany({
        where: candidateWhere,
        orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: ADD_PER_PAGE,
        skip: (page - 1) * ADD_PER_PAGE,
        select: PIN_SELECT,
      }),
      prisma.review.count({ where: candidateWhere }),
    ]);

    // Preserve the stored order; ids that are no longer published (or were
    // deleted) are silently dropped, matching the ranking service semantics.
    const pinnedById = new Map(pinnedRows.map((row) => [row.id, row]));
    const pinned = storedPinnedIds
      .map((id) => pinnedById.get(id))
      .filter((row): row is PinRowSource => Boolean(row))
      .map(toPinRow);

    return json({
      defaults,
      editor: {
        productId,
        productTitle: sample?.productTitle ?? null,
        publishedCount,
        strategy: config?.strategy && isStrategy(config.strategy) ? config.strategy : "",
        pinned,
        candidates: candidates.map(toPinRow),
        candidatesTotal,
        page,
        perPage: ADD_PER_PAGE,
      },
      products: [] as OverviewProduct[],
      overall: null,
      curation: null,
    });
  }

  // Overview: the shop default, the per-product overrides table and the
  // v1.9 "Overall reviews" homepage card (mode + cross-product picker + the
  // live stats preview the block will show).
  const q = (url.searchParams.get("q") ?? "").trim();
  const starsRaw = Number.parseInt(url.searchParams.get("stars") ?? "", 10);
  const stars = starsRaw >= 1 && starsRaw <= 5 ? starsRaw : null;
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const overallConfig = parseOverallWidget(settings.overallWidget);
  // Cross-product candidate list: every PUBLISHED review of the shop.
  const overallCandidateWhere = {
    shop,
    status: "PUBLISHED",
    ...(stars ? { rating: stars } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q } },
            { body: { contains: q } },
            { authorName: { contains: q } },
          ],
        }
      : {}),
  };

  const [groups, pickedRows, overallCandidates, overallCandidatesTotal, shopStats] =
    await Promise.all([
      prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
        _count: { _all: true },
      }),
      overallConfig.pickedIds.length
        ? prisma.review.findMany({
            where: { shop, status: "PUBLISHED", id: { in: overallConfig.pickedIds } },
            select: OVERALL_SELECT,
          })
        : Promise.resolve([] as OverallRowSource[]),
      prisma.review.findMany({
        where: overallCandidateWhere,
        orderBy: [{ helpfulCount: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: OVERALL_ADD_PER_PAGE,
        skip: (page - 1) * OVERALL_ADD_PER_PAGE,
        select: OVERALL_SELECT,
      }),
      prisma.review.count({ where: overallCandidateWhere }),
      computeShopStats(shop),
    ]);
  const productIds = groups.map((g) => g.productId);
  const [titleRows, configs] = await Promise.all([
    productIds.length
      ? prisma.review.findMany({
          where: { shop, productId: { in: productIds } },
          orderBy: { createdAt: "desc" },
          distinct: ["productId"],
          select: { productId: true, productTitle: true },
        })
      : Promise.resolve([] as Array<{ productId: string; productTitle: string | null }>),
    prisma.productDisplayConfig.findMany({ where: { shop } }),
  ]);
  const titleById = new Map(titleRows.map((row) => [row.productId, row.productTitle]));
  const configById = new Map(configs.map((c) => [c.productId, c]));

  const products: OverviewProduct[] = groups
    .map((group) => {
      const config = configById.get(group.productId);
      const override =
        config?.strategy && isStrategy(config.strategy) ? config.strategy : null;
      return {
        productId: group.productId,
        productTitle: titleById.get(group.productId) ?? null,
        publishedCount: group._count._all,
        override,
        pinnedCount: parseIdArray(config?.pinnedIds).length,
      };
    })
    .sort(
      (a, b) =>
        b.publishedCount - a.publishedCount || a.productId.localeCompare(b.productId),
    );

  // Preserve the stored pick order; ids that are no longer published (or were
  // deleted) are silently dropped, matching pickTopBrandReviews' semantics.
  const overallPickedById = new Map(pickedRows.map((row) => [row.id, row]));
  const overallPicked = overallConfig.pickedIds
    .map((id) => overallPickedById.get(id))
    .filter((row): row is OverallRowSource => Boolean(row))
    .map(toOverallRow);

  const { curationStatus, recentCurationFailures } = await import("~/services/curation.server");
  const { ensureCurationScheduler } = await import("~/services/curation-scheduler.server");
  ensureCurationScheduler();
  const curationRows = await curationStatus(shop);

  // v1.20 (SPEC-1.20 §4/§5): refresh the STATUS of any open batch so the card
  // is current the moment the page opens. Deliberately status-only: applying a
  // batch means one Shopify Admin call and one database write per curation in
  // it, which on a large catalogue is minutes of work — far too much to hang a
  // page load on. The scheduler applies results (it tightens its tick while a
  // batch is open), so nothing is lost by not doing it here. Best-effort: a
  // failed refresh must never take the page down with it.
  const { refreshBatchStatuses, recentCurationBatches } = await import(
    "~/services/curation-batch.server"
  );
  try {
    await refreshBatchStatuses(shop);
  } catch (error) {
    console.error("[cellexia] curation batch status refresh on display load failed", error);
  }
  const batchRows = await recentCurationBatches(shop);
  // Rolling monthly counter: a stamp from an earlier month reads as 0 spent,
  // exactly as checkBudget treats it (SPEC-1.20 §3).
  const spendMonth = settings.curationSpendMonth ?? "";
  const currentMonth = new Date().toISOString().slice(0, 7);

  return json({
    defaults,
    editor: null,
    products,
    curation: {
      instructions: settings.curationInstructions ?? "",
      overviewField: settings.curationOverviewField,
      source: settings.curationSource === "all_translated" ? "all_translated" : "as_seen",
      refresh: ["daily", "weekly"].includes(settings.curationRefresh)
        ? settings.curationRefresh
        : "manual",
      rows: curationRows.map((r) => ({
        productId: r.productId,
        locale: r.locale,
        ordered: r.ordered,
        reviewCount: r.reviewCount,
        readOf: r.readOf,
        publishedNow: r.publishedNow,
        stale: r.stale,
        model: r.model,
        rationale: r.rationale,
        updatedAt: r.updatedAt,
      })),
      failures: recentCurationFailures(shop).map((f) => ({
        productId: f.productId,
        locale: f.locale,
        status: f.status,
      })),
      // v1.20 (SPEC-1.20 §3/§5): spend ceiling, month-to-date spend, batches.
      budgetUsd: settings.curationBudgetUsd ?? null,
      model: settings.aiModel,
      modelPriced: (await import("~/services/pricing.server")).ratesFor(settings.aiModel) !== null,
      spendUsd: spendMonth === currentMonth ? settings.curationSpendUsd : 0,
      spendMonth,
      // Dates are stringified here rather than left to json()'s serializer so
      // the client-side type is unambiguously `string`.
      batches: batchRows.map((b) => ({
        id: b.id,
        anthropicBatchId: b.anthropicBatchId,
        status: b.status,
        model: b.model,
        requestCount: b.requestCount,
        succeeded: b.succeeded,
        errored: b.errored,
        expired: b.expired,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        costUsd: b.costUsd,
        error: b.error,
        submittedAt: b.submittedAt.toISOString(),
        endedAt: b.endedAt ? b.endedAt.toISOString() : null,
        appliedAt: b.appliedAt ? b.appliedAt.toISOString() : null,
      })),
    },
    overall: {
      mode: overallConfig.mode,
      picked: overallPicked,
      candidates: overallCandidates.map(toOverallRow),
      candidatesTotal: overallCandidatesTotal,
      page,
      perPage: OVERALL_ADD_PER_PAGE,
      stats: {
        average: shopStats.average,
        count: shopStats.count,
        verifiedPercent: shopStats.verifiedPercent,
      },
    },
  });
};

/**
 * Which products a run covers, as the PREVIEW measured them. `productId` is a
 * single product; `productIds` is the explicit list the preview priced when it
 * ran out of time before reaching the whole catalogue. Neither present means
 * "everything", which is only correct when the preview covered everything.
 * Returning the priced list is what keeps the quote and the bill the same.
 */
function scopedProductIds(form: FormData): string[] | undefined {
  const single = String(form.get("productId") ?? "").trim();
  if (single) return [single];
  const many = String(form.get("productIds") ?? "").trim();
  if (!many) return undefined;
  const ids = many
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 2000);
  return ids.length > 0 ? ids : undefined;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "save-default") {
      const strategyRaw = String(form.get("strategy") ?? "");
      const strategy = isStrategy(strategyRaw) ? strategyRaw : "amazon_top";
      // Only true flags are stored, so an untouched shop keeps the schema
      // default "{}" semantics (out-of-the-box behavior byte-identical).
      const boosts: Record<string, boolean> = {};
      if (form.get("boostVerified") === "true") boosts.boostVerified = true;
      if (form.get("boostMedia") === "true") boosts.boostMedia = true;
      const rankingBoosts = JSON.stringify(boosts);

      await prisma.setting.upsert({
        where: { shop },
        update: { rankingStrategy: strategy, rankingBoosts },
        create: { shop, rankingStrategy: strategy, rankingBoosts },
      });

      // The shop default feeds getEffectiveDisplay for every product without
      // an override, and aggregates.server picks the top_reviews metafield
      // (SSR + JSON-LD source) from the effective display — re-sync so SSR
      // matches the live widget promptly (capped; see DEFAULT_SAVE_RESYNC_CAP).
      const affected = await prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
        _count: { _all: true },
      });
      // Most-reviewed products first, so the highest-traffic SSR converges
      // before the response and the long tail follows in the background.
      affected.sort(
        (a, b) =>
          b._count._all - a._count._all || a.productId.localeCompare(b.productId),
      );
      const syncProduct = async (productId: string) => {
        try {
          await syncProductData(shop, productId, admin);
        } catch (error) {
          console.error(
            `[cellexia] display default re-sync failed for product ${productId}`,
            error,
          );
        }
      };
      for (const group of affected.slice(0, DEFAULT_SAVE_RESYNC_CAP)) {
        await syncProduct(group.productId);
      }
      const remainder = affected.slice(DEFAULT_SAVE_RESYNC_CAP);
      if (remainder.length > 0) {
        // Best-effort, fire-and-forget: sequential to respect Admin API rate
        // limits, each product isolated by syncProduct's own try/catch, and
        // never blocking the merchant's save response.
        void (async () => {
          for (const group of remainder) {
            await syncProduct(group.productId);
          }
        })();
      }

      return json({
        ok: true,
        message: "Default review order saved — live on the storefront within a minute",
      });
    }

    // v1.17 (SPEC-1.17): AI Curator admin actions.
    if (intent === "save-curation-settings") {
      const overviewRaw = String(form.get("curationOverviewField") ?? "").trim();
      // Validate BEFORE saving so a typo never gets a success toast while the
      // sanitizer silently keeps the old value (SPEC-1.17 §5).
      if (overviewRaw && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(overviewRaw)) {
        return json(
          {
            ok: false,
            message:
              'Not saved — the Overview field must look like "namespace.key" (letters, digits, - and _ only), e.g. accentuate.overview.',
          },
          { status: 400 },
        );
      }
      // v1.18: whitelist-validate the two selects before saving (the same
      // "no silent drops behind a success toast" rule as the overview field).
      // ABSENT fields are left untouched — a pre-1.18 admin tab still open
      // must never silently reset them to defaults.
      const sourceRaw = form.get("curationSource");
      const refreshRaw = form.get("curationRefresh");
      if (sourceRaw !== null && !["as_seen", "all_translated"].includes(String(sourceRaw))) {
        return json({ ok: false, message: "Not saved — invalid candidate source." }, { status: 400 });
      }
      if (refreshRaw !== null && !["manual", "daily", "weekly"].includes(String(refreshRaw))) {
        return json({ ok: false, message: "Not saved — invalid refresh frequency." }, { status: 400 });
      }
      // v1.20 (SPEC-1.20 §3): the spend ceiling. Empty string means "no
      // ceiling" (null); anything non-numeric or negative is refused rather
      // than quietly dropped. ABSENT ⇒ untouched, same stale-tab rule as above.
      const budgetRaw = form.get("curationBudgetUsd");
      let budgetPatch: { curationBudgetUsd: number | null } | null = null;
      if (budgetRaw !== null) {
        const budgetText = String(budgetRaw).trim();
        if (budgetText === "") {
          budgetPatch = { curationBudgetUsd: null };
        } else {
          const budgetValue = Number(budgetText);
          if (!Number.isFinite(budgetValue) || budgetValue < 0) {
            return json(
              {
                ok: false,
                message:
                  "Not saved — the spending limit must be a number of dollars (for example 25), or empty for no limit.",
              },
              { status: 400 },
            );
          }
          budgetPatch = { curationBudgetUsd: Math.round(budgetValue * 100) / 100 };
        }
      }
      const { updateSettings } = await import("~/services/settings.server");
      await updateSettings(shop, {
        curationInstructions: String(form.get("curationInstructions") ?? "").trim() || null,
        curationOverviewField: overviewRaw,
        ...(sourceRaw !== null ? { curationSource: String(sourceRaw) } : {}),
        ...(refreshRaw !== null ? { curationRefresh: String(refreshRaw) } : {}),
        // v1.20: the ceiling rides the same sanitizer as every other setting.
        ...(budgetPatch ?? {}),
      });
      return json({
        ok: true,
        message: overviewRaw
          ? "Curation settings saved."
          : "Curation settings saved — Overview field reset to accentuate.overview.",
      });
    }
    if (intent === "curate") {
      const { queueCuration } = await import("~/services/curation.server");
      const summary = await queueCuration(shop, admin, scopedProductIds(form));
      if (!summary.aiReady) {
        return json(
          {
            ok: false,
            message:
              "Nothing queued — no Claude API key is configured. Add one in Settings, then curate.",
          },
          { status: 400 },
        );
      }
      const parts = [`${summary.queued} curation run(s) queued across ${summary.products} product(s)`];
      if (summary.skippedDebounce) parts.push(`${summary.skippedDebounce} skipped (ran in the last 10 minutes)`);
      if (summary.skippedCap) {
        // v1.20: the only thing that skips a pair now is the spend ceiling, and
        // the summary carries both numbers — name them rather than say "cap".
        const { formatUsd: formatSpend } = await import("~/services/pricing.server");
        parts.push(
          summary.budget
            ? `${summary.skippedCap} not started — you have spent ${formatSpend(summary.budget.spent)} this month and your limit is ${formatSpend(summary.budget.ceiling)}`
            : `${summary.skippedCap} not started — your monthly spending limit is already reached`,
        );
      }
      return json({
        ok: summary.queued > 0 || summary.skippedDebounce > 0,
        message: parts.join(" · ") + ". Results appear in the table below as they finish — refresh in a minute.",
      });
    }

    // v1.20 (SPEC-1.20 §2/§5): measure what a run would cost before it runs.
    // Spends nothing — dry-run payloads plus the free count_tokens endpoint.
    if (intent === "estimate-curation") {
      const productIdRaw = String(form.get("productId") ?? "").trim();
      try {
        const { estimateCuration } = await import("~/services/curation-estimate.server");
        const estimate = await estimateCuration(
          shop,
          admin,
          productIdRaw ? [productIdRaw] : undefined,
        );
        // The modal renders aggregates; the per-pair array is large and
        // unused on the client, so it never crosses the wire.
        const { pairs: _pairs, ...estimateSummary } = estimate;
        return json({ ok: true, estimate: estimateSummary });
      } catch (error) {
        console.error("Curation estimate failed", error);
        return json(
          {
            ok: false,
            message:
              "Could not measure this run — the estimate did not complete. Try again in a minute.",
          },
          { status: 500 },
        );
      }
    }

    // v1.20 (SPEC-1.20 §4): the same run, submitted to the Message Batches API
    // at half price. The pair list is rebuilt exactly as queueCuration builds
    // it, so what is submitted is what the estimate measured.
    if (intent === "curate-batch") {
      const scoped = scopedProductIds(form);
      const estimatedCostRaw = String(form.get("estimatedCost") ?? "").trim();
      const estimatedCostValue = Number(estimatedCostRaw);
      const estimatedCost =
        estimatedCostRaw && Number.isFinite(estimatedCostValue) && estimatedCostValue > 0
          ? estimatedCostValue
          : 0;

      const { asCurationSource, qualifyingLocales } = await import("~/services/curation.server");
      const settings = await getSettings(shop);
      const source = asCurationSource(settings.curationSource);

      let ids: string[];
      if (scoped) {
        ids = scoped;
      } else {
        const groups = await prisma.review.groupBy({
          by: ["productId"],
          where: { shop, status: "PUBLISHED", isSynthetic: false },
        });
        ids = groups.map((g) => g.productId);
      }
      const pairs: Array<{ productId: string; locale: string }> = [];
      for (const productId of ids) {
        for (const locale of await qualifyingLocales(shop, productId, source)) {
          pairs.push({ productId, locale });
        }
      }

      const { submitCurationBatch } = await import("~/services/curation-batch.server");
      const result = await submitCurationBatch(shop, admin, pairs, estimatedCost);
      if (result.status === "ok") {
        const batchParts = [
          `Background run submitted — ${result.requestCount} AI call(s) sent to Anthropic at half price`,
        ];
        if (result.skipped > 0) {
          // Do not promise "run again to get the rest": a second run rebuilds
          // and re-bills every pair, not only the leftovers. Say what happened.
          batchParts.push(
            `${result.skipped} did not fit in this batch or could not be prepared, and were not submitted. Running the preview again once this finishes will cover them, but it covers everything else again too and is billed accordingly`,
          );
        }
        return json({
          ok: true,
          message:
            batchParts.join(" · ") +
            '. It shows under "Background runs" below; results are applied automatically when the batch finishes.',
        });
      }
      if (result.status === "no_ai") {
        return json(
          {
            ok: false,
            message:
              "Nothing submitted — no Claude API key is configured. Add one in Settings, then curate.",
          },
          { status: 400 },
        );
      }
      if (result.status === "already_running") {
        return json(
          {
            ok: false,
            message:
              'Nothing submitted — a background run is already going. Wait for it to finish (see "Background runs" below), or cancel it first. This guard is what stops a double-click billing the same run twice.',
          },
          { status: 409 },
        );
      }
      if (result.status === "no_pairs") {
        return json(
          {
            ok: false,
            message:
              "Nothing submitted — no product and language could be prepared for this run. Products need at least 3 published reviews.",
          },
          { status: 400 },
        );
      }
      if (result.status === "over_budget") {
        const { formatUsd: formatSpend } = await import("~/services/pricing.server");
        return json(
          {
            ok: false,
            message: `Nothing submitted — this run would pass your spending limit. You have spent ${formatSpend(result.spent)} on AI curation this month and your limit is ${formatSpend(result.ceiling)}. Raise the limit, or clear it for no limit.`,
          },
          { status: 400 },
        );
      }
      return json(
        {
          ok: false,
          message:
            "Nothing submitted — Anthropic rejected the batch. Check your Claude API key in Settings, then try again.",
        },
        { status: 502 },
      );
    }

    // v1.20: applying a batch is minutes of work on a large catalogue, so the
    // page load never does it — the scheduler does. This gives the merchant a
    // way to make it happen right now instead of waiting for the next tick.
    if (intent === "apply-batches") {
      const { pollCurationBatches } = await import("~/services/curation-batch.server");
      const result = await pollCurationBatches(shop);
      return json({
        ok: true,
        message:
          result.applied > 0
            ? `${result.applied} background run(s) applied — the table below is up to date.`
            : "Nothing to apply yet. The results are still with Anthropic; the app keeps checking every few minutes on its own.",
      });
    }

    if (intent === "cancel-batch") {
      const batchId = String(form.get("batchId") ?? "").trim();
      if (!batchId) {
        return json({ ok: false, message: "Nothing to cancel — no run was named." }, { status: 400 });
      }
      const { cancelCurationBatch } = await import("~/services/curation-batch.server");
      const cancelled = await cancelCurationBatch(shop, batchId);
      return cancelled
        ? json({
            ok: true,
            message:
              "Cancellation requested — calls that had not started are dropped. Calls already running still finish, return results, and are still billed.",
          })
        : json(
            {
              ok: false,
              message:
                "Could not cancel that run — it may have already finished, or no Claude API key is configured.",
            },
            { status: 400 },
          );
    }

    if (intent === "save-product") {
      const productId = String(form.get("productId") ?? "").trim();
      if (!/^\d{1,20}$/.test(productId)) {
        return json({ ok: false, message: "Invalid product" }, { status: 400 });
      }

      const strategyRaw = String(form.get("strategy") ?? "");
      // "" (or anything unknown) means "use the store default" → null.
      const strategy = isStrategy(strategyRaw) ? strategyRaw : null;

      let requested: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(form.get("pinnedIds") ?? "[]"));
        if (Array.isArray(parsed)) {
          requested = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        requested = [];
      }
      // De-dupe while preserving the merchant's order.
      requested = [...new Set(requested)];
      if (requested.length > MAX_PINNED) {
        return json(
          {
            ok: false,
            message: `You can feature up to ${MAX_PINNED} reviews per product.`,
          },
          { status: 400 },
        );
      }

      // Server-side validation: only PUBLISHED reviews of THIS product can be
      // featured; anything else is silently dropped (stale-id semantics).
      let pinned: string[] = [];
      if (requested.length) {
        const valid = await prisma.review.findMany({
          where: { shop, productId, status: "PUBLISHED", id: { in: requested } },
          select: { id: true },
        });
        const validIds = new Set(valid.map((r) => r.id));
        pinned = requested.filter((id) => validIds.has(id));
      }

      let message: string;
      if (!strategy && pinned.length === 0) {
        // Reverted to default-with-no-pins → no row at all (SPEC-1.8 §3).
        await prisma.productDisplayConfig.deleteMany({ where: { shop, productId } });
        message = "Display settings reset to the store default";
      } else {
        await prisma.productDisplayConfig.upsert({
          where: { shop_productId: { shop, productId } },
          update: { strategy, pinnedIds: JSON.stringify(pinned) },
          create: { shop, productId, strategy, pinnedIds: JSON.stringify(pinned) },
        });
        message = "Display settings saved — live on the storefront within a minute";
      }

      await syncProductData(shop, productId, admin);
      return json({ ok: true, message });
    }

    // v1.9 (SPEC-1.9 §4): the "Overall reviews" homepage card. Both paths call
    // syncShopRating synchronously so the shop metafields the block SSRs from
    // (`cellexia.shop_rating` + `cellexia.shop_top_reviews`) update right away.
    if (intent === "save-overall") {
      const mode = String(form.get("mode") ?? "") === "picked" ? "picked" : "auto";

      let requested: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(form.get("pickedIds") ?? "[]"));
        if (Array.isArray(parsed)) {
          requested = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        requested = [];
      }
      // De-dupe while preserving the merchant's order.
      requested = [...new Set(requested)];
      if (requested.length > MAX_OVERALL_PICKED) {
        return json(
          {
            ok: false,
            message: `You can hand-pick up to ${MAX_OVERALL_PICKED} reviews for the homepage block.`,
          },
          { status: 400 },
        );
      }

      // Server-side validation: only PUBLISHED reviews of THIS shop (any
      // product) can be picked; anything else is silently dropped (the same
      // stale-id semantics pickTopBrandReviews applies on read).
      let picked: string[] = [];
      if (requested.length) {
        const valid = await prisma.review.findMany({
          where: { shop, status: "PUBLISHED", id: { in: requested } },
          select: { id: true },
        });
        const validIds = new Set(valid.map((r) => r.id));
        picked = requested.filter((id) => validIds.has(id));
      }

      // pickedIds are stored in both modes so switching Auto → Hand-picked
      // and back never loses the merchant's selection; auto mode simply
      // ignores them (SPEC-1.9 §1).
      await prisma.setting.upsert({
        where: { shop },
        update: { overallWidget: JSON.stringify({ mode, pickedIds: picked }) },
        create: { shop, overallWidget: JSON.stringify({ mode, pickedIds: picked }) },
      });

      await syncShopRating(shop, admin);
      return json({
        ok: true,
        message: "Overall reviews saved — the homepage block updates within a minute",
      });
    }

    if (intent === "refresh-overall") {
      await syncShopRating(shop, admin);
      return json({
        ok: true,
        message: "Homepage data refreshed — changes appear within a minute",
      });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Display order action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

type LoaderData = SerializeFrom<typeof loader>;
type EditorData = NonNullable<LoaderData["editor"]>;
type PinRow = EditorData["pinned"][number];
type OverallData = NonNullable<LoaderData["overall"]>;
type OverallRow = OverallData["picked"][number];

/**
 * Tiny inline-styled star-row example under each ChoiceList option so the
 * merchant sees what the top of the list looks like at a glance. Decorative
 * only (the description carries the meaning), hence aria-hidden.
 */
function StrategyExample({ rows }: { rows: ExampleRow[] }) {
  return (
    <span
      aria-hidden="true"
      style={{ display: "flex", flexDirection: "column", gap: "1px", marginTop: "4px" }}
    >
      {rows.map((row, index) => (
        <span
          key={index}
          style={{ display: "flex", alignItems: "baseline", gap: "6px", lineHeight: "15px" }}
        >
          <span
            style={{
              color: "#FF6200",
              fontSize: "11px",
              letterSpacing: "1px",
              whiteSpace: "nowrap",
            }}
          >
            {"★".repeat(row.stars)}
            {"☆".repeat(5 - row.stars)}
          </span>
          <span style={{ color: "#616A75", fontSize: "11px" }}>{row.note}</span>
        </span>
      ))}
    </span>
  );
}

/** One review row shared by the Featured list and the Add list. */
function ReviewRowSummary({ row }: { row: PinRow }) {
  return (
    <InlineStack gap="300" blockAlign="center" wrap={false}>
      <StarRating rating={row.rating} size={14} />
      <BlockStack gap="050">
        <Text as="span" fontWeight="semibold">
          {row.title || "Untitled review"}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          {row.excerpt ? `${row.excerpt} — ` : ""}
          {row.authorName} · {formatDate(row.createdAt)}
        </Text>
      </BlockStack>
    </InlineStack>
  );
}

export default function DisplayRoute() {
  const data = useLoaderData<typeof loader>();
  if (data.editor) {
    // Keyed by product so switching products resets the draft state.
    return (
      <ProductDisplayEditor
        key={data.editor.productId}
        defaults={data.defaults}
        editor={data.editor}
      />
    );
  }
  return (
    <DisplayOverview
      defaults={data.defaults}
      products={data.products}
      overall={data.overall}
      curation={
        data.curation ?? {
          instructions: "",
          overviewField: "accentuate.overview",
          source: "as_seen",
          refresh: "manual",
          rows: [],
          failures: [],
          budgetUsd: null,
          model: "",
          modelPriced: true,
          spendUsd: 0,
          spendMonth: "",
          batches: [],
        }
      }
    />
  );
}

function DisplayOverview({
  defaults,
  products,
  overall,
  curation,
}: {
  defaults: LoaderData["defaults"];
  products: LoaderData["products"];
  overall: LoaderData["overall"];
  curation: CurationData;
}) {
  const navigate = useNavigate();
  const saveFetcher = useFetcher<typeof action>();
  useResultToast(saveFetcher);

  const [strategy, setStrategy] = useState<string>(defaults.strategy);
  const [boostVerified, setBoostVerified] = useState(defaults.boostVerified);
  const [boostMedia, setBoostMedia] = useState(defaults.boostMedia);

  const saving = saveFetcher.state !== "idle";
  const save = () =>
    saveFetcher.submit(
      {
        intent: "save-default",
        strategy,
        boostVerified: String(boostVerified),
        boostMedia: String(boostMedia),
      },
      { method: "post" },
    );

  return (
    <Page
      title="Display order"
      subtitle="Choose which reviews shoppers see first on your product pages."
    >
      <TitleBar title="Display order" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Default order (all products)
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Applies to every product unless overridden below. Changes appear on the
                  storefront within a minute.
                </Text>
                <ChoiceList
                  title="Review order system"
                  titleHidden
                  choices={STRATEGY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    helpText: (
                      <>
                        {option.description}
                        <StrategyExample rows={option.example} />
                      </>
                    ),
                  }))}
                  selected={[strategy]}
                  onChange={(selected) => setStrategy(selected[0] ?? "amazon_top")}
                />
                <Divider />
                <BlockStack gap="150">
                  <Checkbox
                    label="Show Verified Purchase reviews first"
                    checked={boostVerified}
                    onChange={setBoostVerified}
                  />
                  <Checkbox
                    label="Show reviews with photos first"
                    checked={boostMedia}
                    onChange={setBoostMedia}
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Boosts move matching reviews to the very top. They don't apply to the
                    Balanced system — its positive-to-critical mix is the point.
                  </Text>
                </BlockStack>
                <InlineStack>
                  <Button variant="primary" onClick={save} loading={saving}>
                    Save default order
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* SPEC-1.17 §5: the card shows only while "AI curated" is picked
                somewhere — as the (unsaved or saved) default or any override. */}
            {strategy === "ai_curated" ||
            defaults.strategy === "ai_curated" ||
            products.some((p) => p.override === "ai_curated") ? (
              <CurationCard curation={curation} products={products} />
            ) : null}

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Per-product overrides
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Every product with at least one published review. Open a product to
                    pick a different order system or hand-pick featured reviews that
                    always show first.
                  </Text>
                </BlockStack>
              </Box>
              <IndexTable
                resourceName={{ singular: "product", plural: "products" }}
                itemCount={products.length}
                selectable={false}
                headings={[
                  { title: "Product" },
                  { title: "Published reviews" },
                  { title: "Review order" },
                  { title: "Featured" },
                  { title: "" },
                ]}
                emptyState={
                  <Box padding="400">
                    <BlockStack gap="200" inlineAlign="center">
                      <Text as="p" variant="headingSm">
                        No products with published reviews yet
                      </Text>
                      <Text as="p" tone="subdued">
                        Once a product has published reviews it appears here, and you can
                        customize which of its reviews shoppers see first.
                      </Text>
                    </BlockStack>
                  </Box>
                }
              >
                {products.map((product, index) => (
                  <IndexTable.Row
                    id={product.productId}
                    key={product.productId}
                    position={index}
                    onClick={() => navigate(`/app/display?product=${product.productId}`)}
                  >
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {product.productTitle ?? `Product ${product.productId}`}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          ID {product.productId}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{product.publishedCount}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {product.override ? (
                        <Badge tone="info">{STRATEGY_SHORT[product.override]}</Badge>
                      ) : (
                        <Text as="span" variant="bodySm">
                          Default ({STRATEGY_SHORT[defaults.strategy]})
                        </Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {product.pinnedCount > 0
                          ? pluralize(product.pinnedCount, "review")
                          : "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button
                        variant="plain"
                        url={`/app/display?product=${product.productId}`}
                      >
                        Edit display
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>

            {overall ? <OverallReviewsCard overall={overall} /> : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Third card on the overview (SPEC-1.9 §4): the brand-wide "Overall reviews"
 * homepage block — theme-editor explainer, Auto / Hand-picked mode, the
 * cross-product picker (cap 12, search + rating filter + product column +
 * ↑ / ↓ / Remove), the Refresh-homepage-data button and the live stats
 * preview of what the block will show.
 */
/* v1.17 (SPEC-1.17 §5) — the AI Curator card. Nothing hidden: settings,
   per-product Curate buttons, and the full status table with each agent's
   rationale in its own language. */
/** One row of the "Background runs" list (SPEC-1.20 §4/§5). Dates arrive as
 *  ISO strings — Remix's json() never returns Date objects to the client. */
interface CurationBatchRow {
  id: string;
  anthropicBatchId: string;
  status: string;
  model: string;
  requestCount: number;
  succeeded: number;
  errored: number;
  expired: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
  submittedAt: string;
  endedAt: string | null;
  appliedAt: string | null;
}

interface CurationData {
  instructions: string;
  overviewField: string;
  source: string;
  refresh: string;
  rows: Array<{
    productId: string;
    locale: string;
    ordered: number;
    reviewCount: number;
    readOf: number | null;
    publishedNow: number;
    stale: boolean;
    model: string | null;
    rationale: string;
    updatedAt: string;
  }>;
  failures: Array<{ productId: string; locale: string; status: string }>;
  /** null ⇒ no ceiling: every run is allowed, whatever it costs. */
  budgetUsd: number | null;
  model: string;
  modelPriced: boolean;
  /** Month-to-date AI curation spend; 0 once the month rolls over. */
  spendUsd: number;
  spendMonth: string;
  batches: CurationBatchRow[];
}

/** Batch processing_status → the badge the merchant sees (SPEC-1.20 §4). */
const BATCH_BADGES: Record<string, { tone: "attention" | "success" | "critical"; label: string }> = {
  in_progress: { tone: "attention", label: "Running" },
  canceling: { tone: "attention", label: "Canceling" },
  ended: { tone: "success", label: "Finished" },
  failed: { tone: "critical", label: "Failed" },
  // Set when a run could not be reached before Anthropic's 24-hour expiry;
  // whatever it had reserved against the spending limit is given back.
  expired: { tone: "critical", label: "Expired" },
};

const FAILURE_LABELS: Record<string, string> = {
  no_reviews: "not enough reviews",
  no_ai: "no Claude API key configured",
  no_product: "product not found in Shopify — it may have been deleted",
  failed: "the AI call failed — try again in a minute",
  over_budget: "stopped by your monthly spending limit",
  // Statuses only a background run can produce.
  errored: "Anthropic returned an error for this one — try again",
  canceled: "cancelled before this one ran",
  expired: "the background run expired before this one was answered",
};

function CurationCard({
  curation,
  products,
}: {
  curation: CurationData;
  products: Array<{
    productId: string;
    productTitle: string | null;
    publishedCount: number;
    override: string | null;
  }>;
}) {
  const settingsFetcher = useFetcher<typeof action>();
  const curateFetcher = useFetcher<typeof action>();
  const estimateFetcher = useFetcher<typeof action>();
  const cancelFetcher = useFetcher<typeof action>();
  useResultToast(settingsFetcher);
  useResultToast(curateFetcher);
  // Errors only — a successful estimate carries no message, just the numbers.
  useResultToast(estimateFetcher);
  useResultToast(cancelFetcher);

  const [instructions, setInstructions] = useState(curation.instructions);
  const [overviewField, setOverviewField] = useState(curation.overviewField);
  const [source, setSource] = useState(curation.source);
  const [refresh, setRefresh] = useState(curation.refresh);
  const [budget, setBudget] = useState(
    curation.budgetUsd == null ? "" : String(curation.budgetUsd),
  );
  const [openRationale, setOpenRationale] = useState<string | null>(null);
  const [productPick, setProductPick] = useState("");

  // v1.20 (SPEC-1.20 §5): no run starts before the merchant has seen what it
  // costs. Opening the modal fires the (free) estimate; the two run buttons
  // live inside it. "" as the target means "every product".
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [estimateTarget, setEstimateTarget] = useState("");
  const [estimate, setEstimate] = useState<CurationEstimate | null>(null);

  const titleById = new Map(products.map((p) => [p.productId, p.productTitle]));
  const busy = curateFetcher.state !== "idle";
  const measuring = estimateFetcher.state !== "idle";

  const lastEstimateData = useRef<unknown>(null);
  useEffect(() => {
    if (
      estimateFetcher.state !== "idle" ||
      !estimateFetcher.data ||
      estimateFetcher.data === lastEstimateData.current
    ) {
      return;
    }
    lastEstimateData.current = estimateFetcher.data;
    const data = estimateFetcher.data as { ok?: boolean; estimate?: CurationEstimate };
    if (data.ok === true && data.estimate) setEstimate(data.estimate);
  }, [estimateFetcher.state, estimateFetcher.data]);

  /** Opens the preview and measures it. `productId` "" ⇒ the whole catalog. */
  const openEstimate = (productId: string) => {
    setEstimateTarget(productId);
    // Never show the previous run's numbers while the new ones are measured.
    setEstimate(null);
    setEstimateOpen(true);
    estimateFetcher.submit(
      productId
        ? { intent: "estimate-curation", productId }
        : { intent: "estimate-curation" },
      { method: "post" },
    );
  };

  /**
   * The run must cover exactly what the preview priced. When the preview ran
   * out of time it covers only part of the catalogue, so the ids it measured
   * are sent explicitly rather than letting the run re-derive "everything".
   */
  const scopeFields = (): Record<string, string> => {
    if (estimateTarget) return { productId: estimateTarget };
    if (estimate?.truncated && estimate.productIds.length > 0) {
      return { productIds: estimate.productIds.join(",") };
    }
    return {};
  };

  const runBatch = () => {
    setEstimateOpen(false);
    curateFetcher.submit(
      {
        intent: "curate-batch",
        // The batch's OWN price, PLUS the translations the run has to make
        // first: both are billed to the same key and both are reserved
        // against the ceiling the moment the batch is submitted. Sending only
        // the batch half would let a translation-heavy run slip past.
        estimatedCost: String(
          (estimate?.batchCostUsd ?? 0) + (estimate?.translationCostUsd ?? 0),
        ),
        ...scopeFields(),
      },
      { method: "post" },
    );
  };

  const runNow = () => {
    setEstimateOpen(false);
    curateFetcher.submit({ intent: "curate", ...scopeFields() }, { method: "post" });
  };

  // Each mode is judged on its own price: a background run costs half, so a
  // ceiling that cannot fit "Run now" often fits it comfortably.
  // Nothing to run is also a reason to block: an estimate covering zero calls
  // would otherwise offer the merchant a "$0.0000" run that cannot exist.
  const nothingToRun = !estimate || estimate.calls === 0;
  const instantBlocked = nothingToRun || estimate!.budget.wouldExceed;
  const batchBlocked = nothingToRun || estimate!.budget.batchWouldExceed;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="150">
          <Text as="h2" variant="headingMd">
            AI curation (for the "AI curated" order)
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            For every language separately, a skeptical AI agent reads the product
            description and your Overview field, works out what prospects doubt or want to
            know, and puts the most credible convincing reviews first. Each language's
            agent works entirely in that language. Helpful-vote counts are never used.
            Products or languages without any curation show the Amazon-style order.
            Curation runs when you press Curate — or automatically on the schedule you
            pick below — using your Claude API key (one AI call per product per language).
            Every run shows you what it will cost before it starts.
          </Text>
        </BlockStack>

        <InlineStack gap="300" wrap blockAlign="end">
          <Box minWidth="260px">
            <TextField
              label="Overview field (Accentuate custom field)"
              value={overviewField}
              onChange={setOverviewField}
              autoComplete="off"
              placeholder="accentuate.overview"
              helpText="The product metafield holding your Overview text, as namespace.key."
            />
          </Box>
          <Box minWidth="300px">
            <Select
              label="What the agents read"
              options={[
                {
                  label: "What each language's shoppers see",
                  value: "as_seen",
                },
                {
                  label: "All reviews, translated into each language",
                  value: "all_translated",
                },
              ]}
              value={source}
              onChange={setSource}
              helpText={
                source === "all_translated"
                  ? "Every agent reads every review, translated into its language. Reviews never translated before are translated at curation time with your translation provider (each translation is billed once, then cached forever). Every language qualifies, so Curate-all runs all 17 languages per product."
                  : "Each agent reads originals in its language plus existing translations; untranslated foreign reviews are included but marked as foreign. Languages without enough reviews in that language reuse the English curation."
              }
            />
          </Box>
          <Box minWidth="260px">
            <Select
              label="Automatic refresh"
              options={[
                { label: "Manual only", value: "manual" },
                { label: "Daily", value: "daily" },
                { label: "Weekly", value: "weekly" },
              ]}
              value={refresh}
              onChange={setRefresh}
              helpText="Re-runs a curation automatically only when its reviews have changed since it last ran, at most once per day/week per product and language. The first curation of a product is always started by you. Automatic runs stop at your spending limit below."
            />
          </Box>
        </InlineStack>
        <TextField
          label="Your guidance to the agents (optional)"
          value={instructions}
          onChange={setInstructions}
          multiline={3}
          autoComplete="off"
          placeholder="e.g. Our buyers worry most about sensitive skin — prioritize credible reviews that mention it."
          helpText="Added to every agent's instructions, in every language. Write it in any language."
        />

        {/* v1.20 (SPEC-1.20 §3): the spend ceiling replaces the old daily cap.
            Saved by the same button as the settings above it. */}
        <BlockStack gap="200">
          <Divider />
          <Text as="h3" variant="headingSm">
            Spending
          </Text>
          <InlineStack gap="300" wrap blockAlign="center">
            <Box minWidth="280px">
              <TextField
                label="Stop a run if it would cost more than"
                prefix="$"
                value={budget}
                onChange={setBudget}
                autoComplete="off"
                inputMode="decimal"
                placeholder="No limit"
                helpText="Leave empty for no limit. Counts real billed tokens for curation and for the translations a curation run needs."
              />
            </Box>
            <Text as="span" variant="bodySm" tone="subdued">
              Spent this month:{" "}
              {curation.spendUsd > 0 ? formatUsd(curation.spendUsd) : "nothing yet"}
            </Text>
          </InlineStack>
          {/* A limit can only be enforced against a model this app has a
              published price for. Say so rather than let the field imply a
              protection that is not there. */}
          {!curation.modelPriced ? (
            <Text as="p" variant="bodySm" tone="caution">
              The model set in Settings ({curation.model}) has no published price in this
              app, so costs cannot be measured and a spending limit cannot be enforced for
              it. Pick one of the listed models to use the limit.
            </Text>
          ) : null}
        </BlockStack>

        <InlineStack gap="200" blockAlign="center" wrap>
          <Button
            onClick={() =>
              settingsFetcher.submit(
                {
                  intent: "save-curation-settings",
                  curationInstructions: instructions,
                  curationOverviewField: overviewField,
                  curationSource: source,
                  curationRefresh: refresh,
                  curationBudgetUsd: budget,
                },
                { method: "post" },
              )
            }
            loading={settingsFetcher.state !== "idle"}
          >
            Save curation settings
          </Button>
          <Button variant="primary" loading={busy} onClick={() => openEstimate("")}>
            Curate all products now
          </Button>
          <Text as="span" variant="bodySm" tone="subdued">
            {products.length} product(s) with published reviews.
          </Text>
        </InlineStack>
        <InlineStack gap="200" blockAlign="end" wrap>
          <Box minWidth="280px">
            <Select
              label="Curate a single product"
              options={[
                { label: "Choose a product…", value: "" },
                ...products.map((p) => ({
                  label: `${p.productTitle ?? p.productId} (${p.publishedCount} review${p.publishedCount === 1 ? "" : "s"})`,
                  value: p.productId,
                })),
              ]}
              value={productPick}
              onChange={setProductPick}
            />
          </Box>
          <Button
            disabled={!productPick}
            loading={busy}
            onClick={() => openEstimate(productPick)}
          >
            Curate this product
          </Button>
        </InlineStack>

        {/* SPEC-1.20 §5: nothing is spent until the merchant has seen the
            measured size of the run and picked a mode. */}
        <Modal
          open={estimateOpen}
          onClose={() => setEstimateOpen(false)}
          title={
            estimateTarget
              ? `Curate ${titleById.get(estimateTarget) ?? estimateTarget}?`
              : "Curate all products?"
          }
          primaryAction={{
            content: "Run in background (half price)",
            disabled: batchBlocked,
            onAction: runBatch,
          }}
          secondaryActions={[
            { content: "Run now", disabled: instantBlocked, onAction: runNow },
            { content: "Cancel", onAction: () => setEstimateOpen(false) },
          ]}
        >
          <Modal.Section>
            {measuring ? (
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" accessibilityLabel="Measuring this run" />
                <Text as="p" variant="bodyMd">
                  Measuring the exact size of this run…
                </Text>
              </InlineStack>
            ) : estimate && estimate.calls === 0 ? (
              <BlockStack gap="300">
                <Banner tone="warning" title="There is nothing to curate right now">
                  <Text as="p" variant="bodySm">
                    No product could be prepared for a run. A product needs at least 3
                    published reviews, and must still exist in Shopify.
                  </Text>
                </Banner>
                {estimate.notes.map((note, index) => (
                  <Text key={index} as="p" variant="bodySm" tone="subdued">
                    {note}
                  </Text>
                ))}
              </BlockStack>
            ) : estimate ? (
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  {estimate.calls} AI call(s) across {estimate.products} product(s) — one
                  call per product per language.
                </Text>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm">
                    Input: {estimate.inputTokens.toLocaleString("en-US")} tokens
                  </Text>
                  <Text as="p" variant="bodySm">
                    Output: about {estimate.outputTokens.toLocaleString("en-US")} tokens
                  </Text>
                </BlockStack>
                {estimate.priced ? (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Run in background (half price):{" "}
                      {formatUsd(estimate.batchCostUsd ?? 0)}
                    </Text>
                    <Text as="p" variant="bodyMd">
                      Run now: {formatUsd(estimate.instantCostUsd ?? 0)}
                    </Text>
                  </BlockStack>
                ) : (
                  <Text as="p" variant="bodySm" tone="caution">
                    No cost is shown: the configured model ({estimate.model}) has no
                    published price in this app, so any dollar figure would be a guess.
                    The token counts above still apply.
                  </Text>
                )}
                {estimate.missingTranslations > 0 ? (
                  <Text as="p" variant="bodySm">
                    {estimate.missingTranslations} review translation(s) are missing and
                    would be made first
                    {estimate.translationCostUsd != null
                      ? `, costing about ${formatUsd(estimate.translationCostUsd)} on top`
                      : ""}
                    . Each translation is billed once, then cached forever.
                  </Text>
                ) : null}
                {estimate.trimmedProducts > 0 ? (
                  <Banner tone="warning">
                    <Text as="p" variant="bodySm">
                      {estimate.trimmedProducts} product(s) have more reviews than fit in
                      one request. Review texts are shortened first; if that is still not
                      enough, reviews are dropped keeping a spread across all star ratings.
                      The status table shows how many were read for each one.
                    </Text>
                  </Banner>
                ) : null}
                {estimate.notes.map((note, index) => (
                  <Text key={index} as="p" variant="bodySm" tone="subdued">
                    {note}
                  </Text>
                ))}
                {estimate.budget.wouldExceed ? (
                  <Banner
                    tone={estimate.budget.batchWouldExceed ? "critical" : "warning"}
                    title={
                      estimate.budget.batchWouldExceed
                        ? "This run would pass your spending limit"
                        : "Only the background run fits your spending limit"
                    }
                  >
                    <Text as="p" variant="bodySm">
                      You have spent {formatUsd(estimate.budget.spent)} on AI curation
                      this month and your limit is{" "}
                      {formatUsd(estimate.budget.ceiling ?? 0)}.{" "}
                      {estimate.budget.batchWouldExceed
                        ? "Raise the limit — or clear it for no limit — and save, then measure again."
                        : "Running now would pass it, but the half-price background run still fits."}
                    </Text>
                  </Banner>
                ) : null}
                <Text as="p" variant="bodySm" tone="subdued">
                  Prices are Anthropic list prices as of {estimate.pricesAsOf}.{" "}
                  {estimate.exactPairs === 0
                    ? "No call could be measured, so the input figure is an approximation too."
                    : `Input tokens measured on ${estimate.exactPairs} of ${estimate.totalPairs} calls; output is an estimate.`}
                  {estimate.introApplied
                    ? " The cost above uses Anthropic's current promotional rate for this model."
                    : ""}
                </Text>
                {source !== curation.source ? (
                  <Text as="p" variant="bodySm" tone="caution">
                    You changed "What the agents read" without saving — save the curation
                    settings first, or this run still uses the saved setting.
                  </Text>
                ) : null}
              </BlockStack>
            ) : (
              <Text as="p" variant="bodyMd">
                This run could not be measured, so there is no cost to approve. Close this
                and try again in a minute.
              </Text>
            )}
          </Modal.Section>
        </Modal>

        {curation.failures.length > 0 ? (
          <Banner tone="warning" title="Some recent runs did not produce a curation">
            <BlockStack gap="100">
              {curation.failures.slice(0, 5).map((f, i) => (
                <Text key={`${f.productId}|${f.locale}|${i}`} as="p" variant="bodySm">
                  {(titleById.get(f.productId) ?? f.productId) +
                    " · " +
                    f.locale +
                    " — " +
                    (FAILURE_LABELS[f.status] ?? f.status)}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}

        {/* v1.20 (SPEC-1.20 §4/§5): batches submitted to Anthropic. Their
            status is refreshed on every page load; the results themselves are
            applied by the background scheduler, which checks every few
            minutes while a batch is open. */}
        <BlockStack gap="200">
          <Divider />
          <Text as="h3" variant="headingSm">
            Background runs
          </Text>
          {curation.batches.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              No background runs yet — "Run in background (half price)" in the preview
              starts one.
            </Text>
          ) : (
            <BlockStack gap="200">
              {curation.batches.map((batch) => {
                const badge = BATCH_BADGES[batch.status];
                return (
                  <InlineStack key={batch.id} gap="200" blockAlign="center" wrap>
                    {badge ? (
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    ) : (
                      <Badge>{batch.status}</Badge>
                    )}
                    <Text as="span" variant="bodySm">
                      {pluralize(batch.requestCount, "call")}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {/* Before the results are applied these are Anthropic's
                          own request counts — "answered", not yet "curated".
                          After applying, they are what this app stored. */}
                      {batch.appliedAt
                        ? `${batch.succeeded} curated · ${batch.errored} failed`
                        : `${batch.succeeded} answered · ${batch.errored} failed so far`}
                    </Text>
                    {batch.costUsd > 0 ? (
                      <Text as="span" variant="bodySm">
                        {formatUsd(batch.costUsd)}
                      </Text>
                    ) : null}
                    <Text as="span" variant="bodySm" tone="subdued">
                      Submitted {formatDateTime(batch.submittedAt)}
                    </Text>
                    {batch.status === "ended" && !batch.appliedAt ? (
                      <Button
                        size="slim"
                        loading={cancelFetcher.state !== "idle"}
                        onClick={() =>
                          cancelFetcher.submit({ intent: "apply-batches" }, { method: "post" })
                        }
                      >
                        Apply results now
                      </Button>
                    ) : batch.status === "in_progress" ? (
                      <Button
                        size="slim"
                        loading={cancelFetcher.state !== "idle"}
                        onClick={() =>
                          cancelFetcher.submit(
                            { intent: "cancel-batch", batchId: batch.anthropicBatchId },
                            { method: "post" },
                          )
                        }
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </InlineStack>
                );
              })}
            </BlockStack>
          )}
        </BlockStack>

        {curation.rows.length > 0 ? (
          <BlockStack gap="200">
            <Divider />
            <Text as="h3" variant="headingSm">
              Curations so far
            </Text>
            <IndexTable
              resourceName={{ singular: "curation", plural: "curations" }}
              itemCount={curation.rows.length}
              selectable={false}
              headings={[
                { title: "Product" },
                { title: "Language" },
                { title: "Reviews ordered" },
                { title: "Last run" },
                { title: "Model" },
                { title: "Freshness" },
                { title: "Rationale" },
              ]}
            >
              {curation.rows.map((row, index) => {
                const key = `${row.productId}|${row.locale}`;
                return (
                  <IndexTable.Row id={key} key={key} position={index}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {titleById.get(row.productId) ?? row.productId}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{row.locale}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="0">
                        <Text as="span" variant="bodySm">
                          {row.ordered} of {row.reviewCount}
                        </Text>
                        {/* v1.20: when the payload had to be trimmed, say so
                            here rather than letting the post-trim number read
                            as the product's whole review set. */}
                        {row.readOf ? (
                          <Text as="span" variant="bodySm" tone="caution">
                            read {row.reviewCount} of {row.readOf}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {formatDate(row.updatedAt)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {row.model || "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.stale ? (
                        <Badge tone="attention">Reviews changed — re-curate</Badge>
                      ) : (
                        <Badge tone="success">Up to date</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button
                        variant="plain"
                        onClick={() => setOpenRationale(openRationale === key ? null : key)}
                      >
                        {openRationale === key ? "Hide" : "Show"}
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
            {openRationale
              ? (() => {
                  const row = curation.rows.find(
                    (r) => `${r.productId}|${r.locale}` === openRationale,
                  );
                  return row ? (
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="100">
                        <Text as="h4" variant="headingSm">
                          {(titleById.get(row.productId) ?? row.productId) + " · " + row.locale}
                        </Text>
                        {/* dir="auto" so Arabic (and any RTL) rationales read right-to-left. */}
                        <div dir="auto">
                          <Text as="p" variant="bodySm">
                            {row.rationale || "(no rationale recorded)"}
                          </Text>
                        </div>
                        <InlineStack gap="200">
                          {/* Through the preview like every other run: no
                              curation starts without a cost on screen first. */}
                          <Button
                            size="slim"
                            loading={busy}
                            onClick={() => openEstimate(row.productId)}
                          >
                            Re-curate this product
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ) : null;
                })()
              : null}
          </BlockStack>
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            No curations yet — pick the "AI curated" order above (as default or for a
            product), then press "Curate all products now".
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

function OverallReviewsCard({ overall }: { overall: OverallData }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const saveFetcher = useFetcher<typeof action>();
  const refreshFetcher = useFetcher<typeof action>();
  useResultToast(saveFetcher);
  useResultToast(refreshFetcher);

  // Draft state — initialized from the loader once (the overview component
  // stays mounted across candidate-list search/pagination reloads).
  const [mode, setMode] = useState<string>(overall.mode);
  const [picked, setPicked] = useState<OverallRow[]>(overall.picked);
  const [query, setQuery] = useState(searchParams.get("q") ?? "");

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  // Debounced search → URL (same pattern as the per-product editor).
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (query === current) return;
    const timer = setTimeout(() => {
      updateParams({ q: query || null, page: null });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchParams, updateParams]);

  const pickedIds = new Set(picked.map((row) => row.id));
  const atCap = picked.length >= MAX_OVERALL_PICKED;

  const move = (index: number, delta: -1 | 1) =>
    setPicked((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const remove = (index: number) =>
    setPicked((prev) => prev.filter((_, i) => i !== index));
  const add = (row: OverallRow) =>
    setPicked((prev) =>
      prev.length >= MAX_OVERALL_PICKED || prev.some((p) => p.id === row.id)
        ? prev
        : [...prev, row],
    );

  const saving = saveFetcher.state !== "idle";
  const refreshing = refreshFetcher.state !== "idle";
  const save = () =>
    saveFetcher.submit(
      {
        intent: "save-overall",
        mode,
        pickedIds: JSON.stringify(picked.map((row) => row.id)),
      },
      { method: "post" },
    );
  const refresh = () =>
    refreshFetcher.submit({ intent: "refresh-overall" }, { method: "post" });

  const totalPages = Math.max(1, Math.ceil(overall.candidatesTotal / overall.perPage));
  const starsParam = searchParams.get("stars") ?? "";

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Overall reviews (homepage widget)
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          A brand-wide block showing your combined rating and best reviews across all
          products. Add the block in your theme editor — Theme editor → your page →
          Add section/block → Cellexia Overall Reviews.
        </Text>

        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <BlockStack gap="100">
            <Text as="span" variant="bodySm" fontWeight="semibold">
              What the block will show
            </Text>
            {overall.stats.count > 0 ? (
              <InlineStack gap="200" blockAlign="center" wrap>
                <StarRating rating={overall.stats.average} size={16} showValue />
                <Text as="span" variant="bodySm" tone="subdued">
                  Based on {overall.stats.count.toLocaleString("en-US")}{" "}
                  {overall.stats.count === 1 ? "review" : "reviews"} across your
                  products · {overall.stats.verifiedPercent}% from verified purchases
                </Text>
              </InlineStack>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                No published reviews yet — the block stays invisible on your
                storefront until reviews exist.
              </Text>
            )}
          </BlockStack>
        </Box>

        <ChoiceList
          title="Which reviews the block features"
          choices={[
            {
              value: "auto",
              label: "Auto",
              helpText:
                "Our ranking picks your strongest recent reviews across all products, max 2 per product",
            },
            {
              value: "picked",
              label: "Hand-picked",
              helpText:
                "Choose the exact reviews and their order. If you pick fewer than the block shows, the auto ranking fills the remaining spots.",
            },
          ]}
          selected={[mode]}
          onChange={(selected) => setMode(selected[0] ?? "auto")}
        />

        {mode === "picked" ? (
          <BlockStack gap="300">
            <Divider />
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h3" variant="headingSm">
                Hand-picked reviews (shown first)
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {picked.length} of {MAX_OVERALL_PICKED}
              </Text>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Reviews from any product, in this exact order. You can hand-pick up to{" "}
              {MAX_OVERALL_PICKED} reviews.
            </Text>
            {picked.length === 0 ? (
              <Text as="p" tone="subdued">
                No hand-picked reviews yet — add some from the list below, then save.
              </Text>
            ) : (
              <BlockStack gap="200">
                {picked.map((row, index) => (
                  <Box
                    key={row.id}
                    padding="200"
                    borderWidth="025"
                    borderColor="border"
                    borderRadius="200"
                  >
                    <InlineStack
                      gap="300"
                      blockAlign="center"
                      align="space-between"
                      wrap={false}
                    >
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {index + 1}.
                        </Text>
                        <ReviewRowSummary row={row} />
                      </InlineStack>
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <Box maxWidth="180px">
                          <Text as="span" variant="bodySm" tone="subdued">
                            {row.productTitle ?? `Product ${row.productId}`}
                          </Text>
                        </Box>
                        <Button
                          size="slim"
                          onClick={() => move(index, -1)}
                          disabled={index === 0}
                          accessibilityLabel={`Move ${row.title || "review"} up`}
                        >
                          ↑
                        </Button>
                        <Button
                          size="slim"
                          onClick={() => move(index, 1)}
                          disabled={index === picked.length - 1}
                          accessibilityLabel={`Move ${row.title || "review"} down`}
                        >
                          ↓
                        </Button>
                        <Button
                          size="slim"
                          tone="critical"
                          onClick={() => remove(index)}
                          accessibilityLabel={`Remove ${row.title || "review"} from the homepage block`}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}

            <Text as="h3" variant="headingSm">
              Add reviews
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <Box minWidth="260px">
                <TextField
                  label="Search all products' reviews"
                  labelHidden
                  placeholder="Search by review text or author"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
              </Box>
              <Box minWidth="150px">
                <Select
                  label="Rating"
                  labelHidden
                  options={[
                    { label: "Any rating", value: "" },
                    { label: "5 stars", value: "5" },
                    { label: "4 stars", value: "4" },
                    { label: "3 stars", value: "3" },
                    { label: "2 stars", value: "2" },
                    { label: "1 star", value: "1" },
                  ]}
                  value={starsParam}
                  onChange={(value) => updateParams({ stars: value || null, page: null })}
                />
              </Box>
            </InlineStack>
            {atCap ? (
              <Text as="p" variant="bodySm" tone="subdued">
                The hand-picked list is full ({MAX_OVERALL_PICKED}) — remove a review
                above to add another.
              </Text>
            ) : null}
            {overall.candidates.length === 0 ? (
              <Text as="p" tone="subdued">
                No published reviews match.
              </Text>
            ) : (
              <BlockStack gap="200">
                {overall.candidates.map((row) => {
                  const isPicked = pickedIds.has(row.id);
                  return (
                    <Box
                      key={row.id}
                      padding="200"
                      borderWidth="025"
                      borderColor="border"
                      borderRadius="200"
                    >
                      <InlineStack
                        gap="300"
                        blockAlign="center"
                        align="space-between"
                        wrap={false}
                      >
                        <ReviewRowSummary row={row} />
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <Box maxWidth="180px">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {row.productTitle ?? `Product ${row.productId}`}
                            </Text>
                          </Box>
                          {isPicked ? (
                            <Badge tone="info">Picked</Badge>
                          ) : (
                            <Button
                              size="slim"
                              onClick={() => add(row)}
                              disabled={atCap}
                              accessibilityLabel={`Add ${row.title || "review"} to the homepage block`}
                            >
                              Add
                            </Button>
                          )}
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  );
                })}
              </BlockStack>
            )}
            {totalPages > 1 ? (
              <InlineStack align="center">
                <Pagination
                  hasPrevious={overall.page > 1}
                  onPrevious={() =>
                    updateParams({
                      page: overall.page - 1 <= 1 ? null : String(overall.page - 1),
                    })
                  }
                  hasNext={overall.page < totalPages}
                  onNext={() => updateParams({ page: String(overall.page + 1) })}
                  label={`Page ${overall.page} of ${totalPages}`}
                />
              </InlineStack>
            ) : null}
          </BlockStack>
        ) : null}

        <Divider />
        <InlineStack gap="200" blockAlign="center" wrap>
          <Button variant="primary" onClick={save} loading={saving}>
            Save homepage reviews
          </Button>
          <Button onClick={refresh} loading={refreshing} disabled={saving}>
            Refresh homepage data
          </Button>
        </InlineStack>
        <Text as="p" variant="bodySm" tone="subdued">
          The homepage data updates automatically as reviews change; changes appear
          within a minute. Use Refresh to push the latest numbers right now.
        </Text>
      </BlockStack>
    </Card>
  );
}

function ProductDisplayEditor({
  defaults,
  editor,
}: {
  defaults: LoaderData["defaults"];
  editor: EditorData;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const saveFetcher = useFetcher<typeof action>();
  useResultToast(saveFetcher);

  // Draft state — initialized from the loader once (the component is keyed by
  // productId), preserved across candidate-list search/pagination reloads.
  const [strategy, setStrategy] = useState<string>(editor.strategy);
  const [pinned, setPinned] = useState<PinRow[]>(editor.pinned);
  const [query, setQuery] = useState(searchParams.get("q") ?? "");

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  // Debounced search → URL (same pattern as the Reviews list).
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (query === current) return;
    const timer = setTimeout(() => {
      updateParams({ q: query || null, page: null });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchParams, updateParams]);

  const pinnedIds = new Set(pinned.map((row) => row.id));
  const atCap = pinned.length >= MAX_PINNED;

  const move = (index: number, delta: -1 | 1) =>
    setPinned((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  const remove = (index: number) =>
    setPinned((prev) => prev.filter((_, i) => i !== index));
  const add = (row: PinRow) =>
    setPinned((prev) =>
      prev.length >= MAX_PINNED || prev.some((p) => p.id === row.id)
        ? prev
        : [...prev, row],
    );

  const saving = saveFetcher.state !== "idle";
  const save = () =>
    saveFetcher.submit(
      {
        intent: "save-product",
        productId: editor.productId,
        strategy,
        pinnedIds: JSON.stringify(pinned.map((row) => row.id)),
      },
      { method: "post" },
    );

  const totalPages = Math.max(1, Math.ceil(editor.candidatesTotal / editor.perPage));
  const starsParam = searchParams.get("stars") ?? "";

  return (
    <Page
      title={editor.productTitle ?? `Product ${editor.productId}`}
      subtitle={pluralize(editor.publishedCount, "published review")}
      backAction={{ content: "Display order", url: "/app/display" }}
      primaryAction={{ content: "Save", onAction: save, loading: saving }}
    >
      <TitleBar title="Display order" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <Text as="p">
                Featured reviews always appear first under the default sort. Shoppers can
                still re-sort and filter.
              </Text>
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Review order system
                </Text>
                <Select
                  label="Review order system"
                  labelHidden
                  options={[
                    {
                      label: `Use the store default (${STRATEGY_SHORT[defaults.strategy]})`,
                      value: "",
                    },
                    ...STRATEGY_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    })),
                  ]}
                  value={strategy}
                  onChange={setStrategy}
                  helpText="Orders every review below the featured ones. Changes appear on the storefront within a minute."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Featured reviews (shown first)
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {pinned.length} of {MAX_PINNED}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Hand-picked reviews shoppers see first, in this exact order. You can
                  feature up to {MAX_PINNED} reviews per product.
                </Text>
                {pinned.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No featured reviews yet — add some from the list below, then save.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {pinned.map((row, index) => (
                      <Box
                        key={row.id}
                        padding="200"
                        borderWidth="025"
                        borderColor="border"
                        borderRadius="200"
                      >
                        <InlineStack
                          gap="300"
                          blockAlign="center"
                          align="space-between"
                          wrap={false}
                        >
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {index + 1}.
                            </Text>
                            <ReviewRowSummary row={row} />
                          </InlineStack>
                          <InlineStack gap="100" blockAlign="center" wrap={false}>
                            <Button
                              size="slim"
                              onClick={() => move(index, -1)}
                              disabled={index === 0}
                              accessibilityLabel={`Move ${row.title || "review"} up`}
                            >
                              ↑
                            </Button>
                            <Button
                              size="slim"
                              onClick={() => move(index, 1)}
                              disabled={index === pinned.length - 1}
                              accessibilityLabel={`Move ${row.title || "review"} down`}
                            >
                              ↓
                            </Button>
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => remove(index)}
                              accessibilityLabel={`Remove ${row.title || "review"} from featured`}
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add reviews
                </Text>
                <InlineStack gap="200" blockAlign="end" wrap>
                  <Box minWidth="260px">
                    <TextField
                      label="Search reviews"
                      labelHidden
                      placeholder="Search by review text or author"
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setQuery("")}
                    />
                  </Box>
                  <Box minWidth="150px">
                    <Select
                      label="Rating"
                      labelHidden
                      options={[
                        { label: "Any rating", value: "" },
                        { label: "5 stars", value: "5" },
                        { label: "4 stars", value: "4" },
                        { label: "3 stars", value: "3" },
                        { label: "2 stars", value: "2" },
                        { label: "1 star", value: "1" },
                      ]}
                      value={starsParam}
                      onChange={(value) => updateParams({ stars: value || null, page: null })}
                    />
                  </Box>
                </InlineStack>
                {atCap ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    The featured list is full ({MAX_PINNED}) — remove a review above to
                    add another.
                  </Text>
                ) : null}
                {editor.candidates.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No published reviews match.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {editor.candidates.map((row) => {
                      const isFeatured = pinnedIds.has(row.id);
                      return (
                        <Box
                          key={row.id}
                          padding="200"
                          borderWidth="025"
                          borderColor="border"
                          borderRadius="200"
                        >
                          <InlineStack
                            gap="300"
                            blockAlign="center"
                            align="space-between"
                            wrap={false}
                          >
                            <ReviewRowSummary row={row} />
                            {isFeatured ? (
                              <Badge tone="info">Featured</Badge>
                            ) : (
                              <Button
                                size="slim"
                                onClick={() => add(row)}
                                disabled={atCap}
                                accessibilityLabel={`Add ${row.title || "review"} to featured`}
                              >
                                Add
                              </Button>
                            )}
                          </InlineStack>
                        </Box>
                      );
                    })}
                  </BlockStack>
                )}
                {totalPages > 1 ? (
                  <InlineStack align="center">
                    <Pagination
                      hasPrevious={editor.page > 1}
                      onPrevious={() =>
                        updateParams({
                          page: editor.page - 1 <= 1 ? null : String(editor.page - 1),
                        })
                      }
                      hasNext={editor.page < totalPages}
                      onNext={() => updateParams({ page: String(editor.page + 1) })}
                      label={`Page ${editor.page} of ${totalPages}`}
                    />
                  </InlineStack>
                ) : null}
              </BlockStack>
            </Card>

            <Box paddingBlockEnd="400">
              <InlineStack align="end">
                <Button variant="primary" onClick={save} loading={saving}>
                  Save
                </Button>
              </InlineStack>
            </Box>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
