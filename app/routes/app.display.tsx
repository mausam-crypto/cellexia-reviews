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
import { useCallback, useEffect, useState } from "react";
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
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { RANKING_STRATEGIES } from "~/types/cellexia";
import type { RankingStrategy } from "~/types/cellexia";
import { getSettings } from "~/services/settings.server";
import { computeShopStats, syncShopRating } from "~/services/brand.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { StarRating } from "~/components/admin/StarRating";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, pluralize } from "~/components/admin/labels";

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

  return json({
    defaults,
    editor: null,
    products,
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
    />
  );
}

function DisplayOverview({
  defaults,
  products,
  overall,
}: {
  defaults: LoaderData["defaults"];
  products: LoaderData["products"];
  overall: LoaderData["overall"];
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
