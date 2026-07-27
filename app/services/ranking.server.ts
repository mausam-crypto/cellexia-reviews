/**
 * Cellexia Reviews — review display-order (ranking) service (SPEC-1.8 §2).
 *
 * Resolves which reviews a shopper sees first:
 *   - getEffectiveDisplay(shop, productId) merges the shop-wide default
 *     (Setting.rankingStrategy / rankingBoosts) with the per-product override
 *     (ProductDisplayConfig.strategy, null = inherit) and the product's pinned
 *     ("featured") review ids.
 *   - strategyOrderBy(strategy, boosts) turns a non-balanced strategy into a
 *     Prisma orderBy array. Every strategy is secondary-keyed by
 *     `createdAt desc`, then `id desc`, so pagination is fully deterministic
 *     (skip/take can never duplicate or drop a row across pages on ties).
 *   - fetchRankedPage(...) computes one page. The plain case (no pins,
 *     non-balanced) returns `{ ids: null, orderBy }` and the caller pages with
 *     its own skip/take; pins and the balanced interleave return the explicit
 *     `ids` for the page in final display order.
 *
 * Strategy semantics (SPEC-1.8 §2), before the createdAt/id tail:
 *   amazon_top      helpfulCount desc, verified desc      (the pre-1.8 "top")
 *   top_positive    rating desc, helpfulCount desc
 *   most_recent     (createdAt tail only)
 *   verified_first  verified desc, helpfulCount desc
 *   media_first     media count desc, helpfulCount desc
 *   balanced        3 positive (rating >= 4) : 1 critical (rating <= 3)
 *                   interleave, each side helpfulCount desc, createdAt desc,
 *                   id desc — see balancedPageIds for the slot math.
 *
 * Boosts prepend orderBy keys — boostVerified (`verified desc`) first, then
 * boostMedia (media count desc) when both are set — and duplicate keys are
 * dropped, so a boost the strategy already leads with is a no-op. Boosts never
 * apply to `balanced`: its positive/critical structure is the point.
 *
 * Pinned reviews are the CALLER's gate: listReviews passes `pinnedIds` through
 * only for the unfiltered "top" sort (a filtered view must honor the filter,
 * not the pins) and aggregates' SSR selection always qualifies. This module
 * validates them — unpublished, other-product or stale ids are silently
 * dropped — pins occupy the first global slots in their stored order, and the
 * strategy-ranked remainder excludes them (`id notIn`), offset by the pin
 * count, so page boundaries stay deterministic and duplicate-free.
 */
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { MAX_PINNED_REVIEWS, RANKING_STRATEGIES } from "~/types/cellexia";
import type { RankingStrategy } from "~/types/cellexia";
import { getSettings } from "./settings.server";

/** The display configuration in effect for one product (SPEC-1.8 §2). */
export interface EffectiveDisplay {
  strategy: RankingStrategy;
  boosts: { boostVerified: boolean; boostMedia: boolean };
  pinnedIds: string[];
}

/** One ranked page, as computed by fetchRankedPage. */
export interface RankedPage {
  /**
   * Explicit review ids for the page in final display order, or null when the
   * page is expressible as a single orderBy the caller pages itself (no pins,
   * non-balanced strategy) — `orderBy` is always set in that case.
   */
  ids: string[] | null;
  orderBy?: Prisma.ReviewOrderByWithRelationInput[];
}

/**
 * Resolve the display configuration in effect for a product: the per-product
 * strategy override when present, else the shop default, else "amazon_top";
 * the shop-wide boosts; and the product's pinned ids (capped at
 * MAX_PINNED_REVIEWS, unvalidated here — fetchRankedPage drops stale ids).
 * Unknown stored values degrade to the defaults instead of throwing.
 */
export async function getEffectiveDisplay(
  shop: string,
  productId: string,
): Promise<EffectiveDisplay> {
  const pid = String(productId);
  const [settings, config] = await Promise.all([
    getSettings(shop),
    prisma.productDisplayConfig.findUnique({
      where: { shop_productId: { shop, productId: pid } },
    }),
  ]);

  return {
    strategy:
      normalizeStrategy(config?.strategy) ??
      normalizeStrategy(settings.rankingStrategy) ??
      "amazon_top",
    boosts: parseBoosts(settings.rankingBoosts),
    pinnedIds: parsePinnedIds(config?.pinnedIds),
  };
}

/**
 * Base orderBy keys per non-balanced strategy, WITHOUT the shared
 * `createdAt desc, id desc` tail that strategyOrderBy always appends.
 * amazon_top must stay byte-compatible with the historical "top" ordering
 * (helpfulCount desc, verified desc, createdAt desc) — only the deterministic
 * `id desc` tail is new, which can reorder nothing but previously-unspecified
 * ties.
 */
const BASE_ORDER: Record<
  Exclude<RankingStrategy, "balanced">,
  Prisma.ReviewOrderByWithRelationInput[]
> = {
  amazon_top: [{ helpfulCount: "desc" }, { verified: "desc" }],
  top_positive: [{ rating: "desc" }, { helpfulCount: "desc" }],
  most_recent: [],
  verified_first: [{ verified: "desc" }, { helpfulCount: "desc" }],
  media_first: [{ media: { _count: "desc" } }, { helpfulCount: "desc" }],
};

/**
 * The Prisma orderBy for a non-balanced strategy, boosts prepended and
 * duplicate keys removed (first occurrence wins, so a boost the strategy
 * already leads with changes nothing). `balanced` is not expressible as one
 * orderBy — fetchRankedPage interleaves two ordered sides instead — so a
 * defensive caller passing it gets the default strategy's keys (boosts
 * skipped, as balanced never takes boosts) rather than a throw.
 */
export function strategyOrderBy(
  strategy: RankingStrategy,
  boosts: EffectiveDisplay["boosts"],
): Prisma.ReviewOrderByWithRelationInput[] {
  const keys: Prisma.ReviewOrderByWithRelationInput[] = [];
  if (strategy !== "balanced") {
    if (boosts.boostVerified) keys.push({ verified: "desc" });
    if (boosts.boostMedia) keys.push({ media: { _count: "desc" } });
  }
  keys.push(...BASE_ORDER[strategy === "balanced" ? "amazon_top" : strategy]);
  keys.push({ createdAt: "desc" }, { id: "desc" });
  return dedupeOrderKeys(keys);
}

/**
 * Compute one page of ranked reviews for a product.
 *
 * `where` is the caller's full filter (it already contains shop/productId/
 * status plus any shopper filters). `display.pinnedIds` must be passed as []
 * whenever pins do not apply (filtered views — listReviews enforces that).
 *
 * Page math with P valid pins: global slots [0, P) are the pins in stored
 * order; the strategy-ranked remainder (which excludes the pinned ids) covers
 * slots [P, total). A page over slots [start, end) therefore serves
 * `pins[start..min(end,P))` first, then remainder rows with
 * skip = max(0, start - P) — deterministic offsets, no duplicates on any page.
 */
export async function fetchRankedPage(
  shop: string,
  productId: string,
  display: EffectiveDisplay,
  page: number,
  perPage: number,
  where: Prisma.ReviewWhereInput,
): Promise<RankedPage> {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const size = Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 1;
  const start = (safePage - 1) * size;
  const end = start + size;

  // Stale, unpublished or other-product ids are silently dropped; the stored
  // order of the survivors is preserved.
  const pins =
    display.pinnedIds.length > 0
      ? await resolvePinnedIds(shop, productId, display.pinnedIds)
      : [];

  // Plain path: a single orderBy the caller pages with its own skip/take.
  if (pins.length === 0 && display.strategy !== "balanced") {
    return { ids: null, orderBy: strategyOrderBy(display.strategy, display.boosts) };
  }

  const pagePins = pins.slice(Math.min(start, pins.length), Math.min(end, pins.length));
  const remainderSkip = Math.max(0, start - pins.length);
  const remainderTake = size - pagePins.length;
  // AND keeps this correct even if `where` already constrains `id` (defense
  // in depth — pins are never combined with a topic filter by the callers).
  const remainderWhere: Prisma.ReviewWhereInput =
    pins.length > 0 ? { AND: [where, { id: { notIn: pins } }] } : where;

  let remainderIds: string[] = [];
  if (remainderTake > 0) {
    if (display.strategy === "balanced") {
      remainderIds = await balancedPageIds(remainderWhere, remainderSkip, remainderTake);
    } else {
      const rows = await prisma.review.findMany({
        where: remainderWhere,
        orderBy: strategyOrderBy(display.strategy, display.boosts),
        skip: remainderSkip,
        take: remainderTake,
        select: { id: true },
      });
      remainderIds = rows.map((row) => row.id);
    }
  }

  return { ids: [...pagePins, ...remainderIds] };
}

/* ------------------------------------------------------------------------- *
 * Balanced interleave (SPEC-1.8 §2)
 * ------------------------------------------------------------------------- */

/** Both balanced sides are ordered identically within themselves. */
const BALANCED_SIDE_ORDER: Prisma.ReviewOrderByWithRelationInput[] = [
  { helpfulCount: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
];

/*
 * Deterministic 3:1 interleave. Global slot i (0-based) is CRITICAL when
 * i % 4 === 3, POSITIVE otherwise, giving the pattern P P P C P P P C …
 *
 * Loop-free helpers (both proven by the table below):
 *   critBefore(n) = floor(n / 4)      critical slots among [0, n)
 *   posBefore(n)  = n - floor(n / 4)  positive slots among [0, n)
 *   posSlotOf(k)  = 4*floor(k / 3) + (k % 3)   slot of the k-th positive
 *
 * Unit-style assertions for slots 0..12 — side and index-within-side of each
 * slot, plus the helper values at n = slot (side index of a positive slot s
 * is posBefore(s); of a critical slot s it is critBefore(s) = floor(s / 4)):
 *
 *   slot | side | sideIndex | posBefore(slot) | critBefore(slot)
 *   -----+------+-----------+-----------------+-----------------
 *     0  | pos  |     0     |        0        |        0
 *     1  | pos  |     1     |        1        |        0
 *     2  | pos  |     2     |        2        |        0
 *     3  | crit |     0     |        3        |        0
 *     4  | pos  |     3     |        3        |        1
 *     5  | pos  |     4     |        4        |        1
 *     6  | pos  |     5     |        5        |        1
 *     7  | crit |     1     |        6        |        1
 *     8  | pos  |     6     |        6        |        2
 *     9  | pos  |     7     |        7        |        2
 *    10  | pos  |     8     |        8        |        2
 *    11  | crit |     2     |        9        |        2
 *    12  | pos  |     9     |        9        |        3
 *
 * Exhaustion fill: with finite side totals PT (positive) and CT (critical),
 * the ideal pattern holds for every slot below
 *   breakSlot = min( posSlotOf(PT),  4*CT + 3 )
 * (the first slot whose ideal side would need an item that doesn't exist —
 * the two can never coincide, positive slots are ≢ 3 (mod 4)). From breakSlot
 * on, every remaining slot fills from the surviving side in its own order,
 * and because every slot before s consumed exactly one item, that side's
 * index at slot s is simply s - PT (critical fill) or s - CT (positive fill).
 * Assertions:
 *   PT=7, CT=1 → P0 P1 P2 C0 P3 P4 P5 P6   (breakSlot = 7 = 4*1+3; slot 7 is
 *                                            positive index 7 - CT = 6)
 *   PT=3, CT=3 → P0 P1 P2 C0 C1 C2         (breakSlot = 4 = posSlotOf(3);
 *                                            slots 4,5 are critical indexes
 *                                            4-3=1 and 5-3=2)
 *   PT=0, CT=2 → C0 C1                     (breakSlot = 0; slot s index s)
 * The sequence ends at slot PT + CT.
 */

/** Critical slots among [0, n) — see the assertion table above. */
function critBefore(n: number): number {
  return Math.floor(n / 4);
}

/** Positive slots among [0, n) — see the assertion table above. */
function posBefore(n: number): number {
  return n - Math.floor(n / 4);
}

/** Global slot of the k-th (0-based) positive item in the ideal pattern. */
function posSlotOf(k: number): number {
  return 4 * Math.floor(k / 3) + (k % 3);
}

/**
 * The explicit review ids for balanced slots [start, start + take), computed
 * from two cheap side counts plus one paged query per side. The skips/takes
 * for both sides come from the loop-free helpers above (the ideal region uses
 * posBefore/critBefore deltas; the fill region is a contiguous continuation —
 * contiguity holds because the ideal side-index at breakSlot equals
 * breakSlot - otherSideTotal, see the module comment). The only loop is the
 * ≤ take-sized assembly walk that merges the two fetched id lists slot by
 * slot.
 */
async function balancedPageIds(
  where: Prisma.ReviewWhereInput,
  start: number,
  take: number,
): Promise<string[]> {
  const positiveWhere: Prisma.ReviewWhereInput = { AND: [where, { rating: { gte: 4 } }] };
  const criticalWhere: Prisma.ReviewWhereInput = { AND: [where, { rating: { lte: 3 } }] };

  const [posTotal, critTotal] = await Promise.all([
    prisma.review.count({ where: positiveWhere }),
    prisma.review.count({ where: criticalWhere }),
  ]);

  const total = posTotal + critTotal;
  const from = Math.min(start, total);
  const to = Math.min(start + take, total);
  if (to <= from) return [];

  const posBreak = posSlotOf(posTotal);
  const critBreak = 4 * critTotal + 3;
  const breakSlot = Math.min(posBreak, critBreak);

  // Ideal-pattern region of this page: [from, min(to, breakSlot)).
  let posSkip = 0;
  let posTake = 0;
  let critSkip = 0;
  let critTake = 0;
  const idealTo = Math.min(to, breakSlot);
  if (idealTo > from) {
    posSkip = posBefore(from);
    posTake = posBefore(idealTo) - posBefore(from);
    critSkip = critBefore(from);
    critTake = critBefore(idealTo) - critBefore(from);
  }

  // Fill region: [max(from, breakSlot), to) — all one side, contiguous with
  // the ideal region's range for that side.
  const fillFrom = Math.max(from, breakSlot);
  if (to > fillFrom) {
    const fillTake = to - fillFrom;
    if (posBreak <= critBreak) {
      // Positives exhausted first — the fill is critical, index s - posTotal.
      if (critTake === 0) critSkip = fillFrom - posTotal;
      critTake += fillTake;
    } else {
      // Criticals exhausted first — the fill is positive, index s - critTotal.
      if (posTake === 0) posSkip = fillFrom - critTotal;
      posTake += fillTake;
    }
  }

  const [posRows, critRows] = await Promise.all([
    posTake > 0
      ? prisma.review.findMany({
          where: positiveWhere,
          orderBy: BALANCED_SIDE_ORDER,
          skip: posSkip,
          take: posTake,
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
    critTake > 0
      ? prisma.review.findMany({
          where: criticalWhere,
          orderBy: BALANCED_SIDE_ORDER,
          skip: critSkip,
          take: critTake,
          select: { id: true },
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);
  const posIds = posRows.map((row) => row.id);
  const critIds = critRows.map((row) => row.id);

  // Assembly walk over this page's slots only. If a concurrent write made a
  // side shorter than its count promised, degrade by draining the other side
  // instead of emitting a hole.
  const ids: string[] = [];
  let p = 0;
  let c = 0;
  for (let slot = from; slot < to; slot += 1) {
    const wantCritical =
      slot < breakSlot ? slot % 4 === 3 : posBreak <= critBreak;
    if (wantCritical) {
      if (c < critIds.length) ids.push(critIds[c++]);
      else if (p < posIds.length) ids.push(posIds[p++]);
    } else {
      if (p < posIds.length) ids.push(posIds[p++]);
      else if (c < critIds.length) ids.push(critIds[c++]);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

/**
 * Keep only pinned ids that are PUBLISHED reviews of this product, in their
 * stored order. Deleted, unpublished and cross-product ids vanish silently —
 * a stale pin must never blank a page or leak a non-published review.
 */
async function resolvePinnedIds(
  shop: string,
  productId: string,
  pinnedIds: string[],
): Promise<string[]> {
  const rows = await prisma.review.findMany({
    where: {
      shop,
      productId: String(productId),
      status: "PUBLISHED",
      id: { in: pinnedIds },
    },
    select: { id: true },
  });
  const published = new Set(rows.map((row) => row.id));
  return pinnedIds.filter((id) => published.has(id));
}

function normalizeStrategy(value: string | null | undefined): RankingStrategy | null {
  return value && (RANKING_STRATEGIES as readonly string[]).includes(value)
    ? (value as RankingStrategy)
    : null;
}

/** Tolerant read of Setting.rankingBoosts — anything malformed means "off". */
function parseBoosts(raw: string | null | undefined): EffectiveDisplay["boosts"] {
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const flags =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { boostVerified?: unknown; boostMedia?: unknown })
      : {};
  return {
    boostVerified: flags.boostVerified === true,
    boostMedia: flags.boostMedia === true,
  };
}

/**
 * Tolerant read of ProductDisplayConfig.pinnedIds: a JSON string[] — anything
 * else yields []. Duplicates keep their first position; the list is capped at
 * MAX_PINNED_REVIEWS defensively (the admin validates the cap on both ends).
 */
function parsePinnedIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string" && entry && !out.includes(entry)) out.push(entry);
    if (out.length >= MAX_PINNED_REVIEWS) break;
  }
  return out;
}

/** Drop repeated orderBy keys (first occurrence wins). */
function dedupeOrderKeys(
  keys: Prisma.ReviewOrderByWithRelationInput[],
): Prisma.ReviewOrderByWithRelationInput[] {
  const seen = new Set<string>();
  const out: Prisma.ReviewOrderByWithRelationInput[] = [];
  for (const key of keys) {
    const name = Object.keys(key)[0];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(key);
  }
  return out;
}
