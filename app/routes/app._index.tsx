import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  SerializeFrom,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Collapsible,
  DataTable,
  Divider,
  InlineGrid,
  InlineStack,
  Link as PolarisLink,
  Modal,
  Page,
  Popover,
  Spinner,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  DEFAULT_STAMPED_SELECTORS,
  SelectorValidationError,
  getSettings,
  parseLiveMarkets,
  sanitizeMarketHandles,
  updateSettings,
} from "~/services/settings.server";
import { syncShopSettingsMetafields } from "~/services/metafields.server";
import {
  isValidMarketHandle,
  listMarkets,
  parseObservedMarkets,
} from "~/services/markets.server";
import { getPreviewUrls } from "~/services/preview.server";
import { runStorefrontHealthCheck } from "~/services/proxyhealth.server";
import type { HealthReport } from "~/services/proxyhealth.server";
import { generateSummary } from "~/services/ai.server";
import {
  syncProductData,
  updateReviewStatuses,
} from "~/components/admin/moderation.server";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { StarRating } from "~/components/admin/StarRating";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, formatDateTime, pluralize } from "~/components/admin/labels";

/* ------------------------------------------------------------------------- *
 * Storefront connection health report (SPEC-1.6 §5)
 *
 * `runStorefrontHealthCheck` probes the shop's own storefront over HTTPS, so it
 * is far too slow to sit in the loader: the loader only ever reports the LAST
 * result (kept in a per-process in-memory cache, exactly like the proxy
 * rate-limiter) and tells the client whether to run a fresh one. A fetcher does
 * the actual run, so the Dashboard always renders immediately.
 *
 * The report shape is normalized defensively (`normalizeHealthReport`): the UI
 * survives a service that adds fields, renames `checks` or returns an unknown
 * status value — it can never crash the merchant's Dashboard.
 * ------------------------------------------------------------------------- */

/** Anchor id — Settings → "Test storefront connection" scrolls the card into view. */
const HEALTH_ANCHOR_ID = "cx-storefront-connection";

/** A cached report older than this triggers the automatic (non-blocking) re-run. */
const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cache ceiling (shops per server process) — keeps the map bounded. */
const HEALTH_CACHE_LIMIT = 200;

/** Budget for one "Re-sync all products" click (Shopify request timeouts). */
const RESYNC_MAX_PRODUCTS = 100;
const RESYNC_TIME_BUDGET_MS = 20_000;

/** Per-product failures listed back to the merchant (the rest are counted). */
const RESYNC_REPORTED_FAILURES = 5;

/** Review counts behind the "Review data" health row (SPEC-1.6.1 §B). */
interface ReviewCounts {
  total: number;
  published: number;
  pending: number;
  /** Distinct products with at least one published review. */
  products: number;
}

type HealthStatus = "pass" | "warn" | "fail";

interface HealthCheckView {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fix: string | null;
}

interface HealthReportView {
  /** ISO timestamp of the run that produced this report. */
  ranAt: string;
  overall: HealthStatus;
  checks: HealthCheckView[];
}

const HEALTH_BADGE: Record<
  HealthStatus,
  { tone: "success" | "warning" | "critical"; label: string }
> = {
  pass: { tone: "success", label: "Passed" },
  warn: { tone: "warning", label: "Warning" },
  fail: { tone: "critical", label: "Failed" },
};

const healthCache = new Map<string, HealthReportView>();

function readHealthCache(shop: string): HealthReportView | null {
  return healthCache.get(shop) ?? null;
}

function writeHealthCache(shop: string, report: HealthReportView): void {
  healthCache.delete(shop);
  healthCache.set(shop, report);
  while (healthCache.size > HEALTH_CACHE_LIMIT) {
    const oldest = healthCache.keys().next();
    if (oldest.done) break;
    healthCache.delete(oldest.value);
  }
}

function isHealthStale(report: HealthReportView | null): boolean {
  if (!report) return true;
  const ranAt = Date.parse(report.ranAt);
  return !Number.isFinite(ranAt) || Date.now() - ranAt > HEALTH_MAX_AGE_MS;
}

function toHealthStatus(value: unknown): HealthStatus | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return lower === "pass" || lower === "warn" || lower === "fail" ? lower : null;
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}

/** Coerces a service field to display text (strings, string arrays, numbers). */
function toHealthText(value: unknown, maxLength = 900): string {
  if (typeof value === "string") return clip(value.trim(), maxLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return clip(
      value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
        .join(" "),
      maxLength,
    );
  }
  return "";
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** Finds the per-check array whether the service returns it bare or wrapped. */
function readHealthChecks(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["checks", "results", "entries", "items"]) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/**
 * Turns a `HealthReport` into the plain, JSON-safe shape the card renders.
 * Returns null when the service produced no readable check — the caller then
 * reports an honest failure instead of an empty card.
 */
function normalizeHealthReport(raw: unknown, ranAt: string): HealthReportView | null {
  const checks: HealthCheckView[] = [];
  readHealthChecks(raw).forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    checks.push({
      id: toHealthText(record.id, 60) || `check-${index + 1}`,
      label:
        toHealthText(record.label, 120) ||
        toHealthText(record.title, 120) ||
        `Check ${index + 1}`,
      status: toHealthStatus(record.status) ?? "warn",
      detail:
        toHealthText(record.detail) ||
        toHealthText(record.message) ||
        toHealthText(record.description),
      fix: toHealthText(record.fix) || toHealthText(record.hint) || null,
    });
  });
  if (checks.length === 0) return null;

  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const overall =
    toHealthStatus(record.overall) ??
    toHealthStatus(record.status) ??
    (checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "pass");

  return {
    ranAt:
      toIsoTimestamp(record.ranAt) ??
      toIsoTimestamp(record.checkedAt) ??
      toIsoTimestamp(record.ts) ??
      ranAt,
    overall,
    checks,
  };
}

/* ------------------------------------------------------------------------- *
 * Server helpers (loader/action only — never reached from the browser bundle)
 * ------------------------------------------------------------------------- */

/**
 * The three review counts plus the number of products carrying published
 * reviews, as of right now. The loader derives the same numbers from queries
 * it already runs; this is for the health-check action, which runs later.
 * Returns null rather than throwing — the card then falls back to the
 * loader's snapshot.
 */
async function readReviewCounts(shop: string): Promise<ReviewCounts | null> {
  try {
    const [total, published, pending, productGroups] = await Promise.all([
      prisma.review.count({ where: { shop } }),
      prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
      prisma.review.count({ where: { shop, status: "PENDING" } }),
      prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
      }),
    ]);
    return { total, published, pending, products: productGroups.length };
  } catch (error) {
    console.error("[cellexia] reading the review counts failed", error);
    return null;
  }
}

/**
 * What the last metafield sync recorded (SPEC-1.6.1 §A): the verbatim error
 * (null when it succeeded) and when it was written.
 *
 * Both fields are read structurally from the settings row rather than through
 * a `select`, so this route compiles and runs both before and after those
 * columns exist — a Dashboard that cannot render is worse than one that cannot
 * yet show a sync error.
 */
async function readSyncOutcome(
  shop: string,
): Promise<{ error: string | null; at: number | null }> {
  try {
    const row: unknown = await prisma.setting.findUnique({ where: { shop } });
    if (!row || typeof row !== "object") return { error: null, at: null };
    const record = row as Record<string, unknown>;
    const rawError = record.lastSyncError;
    const error =
      typeof rawError === "string" && rawError.trim().length > 0 ? rawError.trim() : null;
    const rawAt = record.lastSyncAt;
    const at =
      rawAt instanceof Date && !Number.isNaN(rawAt.getTime()) ? rawAt.getTime() : null;
    return { error, at };
  } catch (error) {
    console.error("[cellexia] reading the last sync outcome failed", error);
    return { error: null, at: null };
  }
}

/** A thrown value as one line of merchant-readable text. */
function describeError(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned || "the app server did not say why";
}

function describeProductFailure(failure: { productId: string; message: string }): string {
  return `product ${failure.productId}: ${failure.message}`;
}

/**
 * The one next step for a sync error, chosen from the error text itself
 * (SPEC-1.6.1 §A: re-authenticate when it mentions access or scope, retry when
 * throttled). Verbatim errors are honest but rarely actionable on their own.
 */
function syncErrorHint(message: string): string {
  if (/throttl|rate.?limit|too many requests|query cost/i.test(message)) {
    return "Shopify is throttling the app. Wait a minute, then run the re-sync again.";
  }
  if (/scope|access|permission|denied|unauthor|forbidden|\b40[13]\b/i.test(message)) {
    return "The app is missing permission to write product metafields. Reinstall or re-open the app from Shopify admin to re-authenticate, then run the re-sync again.";
  }
  return "Run the re-sync again. If it keeps failing, this message is the verbatim answer from Shopify — check the app server logs for the full response.";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Never block the page on the health check: report the cached run and let a
  // fetcher refresh it when it is missing, older than 24 h, or when the
  // merchant arrived from Settings → "Test storefront connection".
  const forceHealthRun = new URL(request.url).searchParams.get("health") === "run";
  const cachedHealth = readHealthCache(shop);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    settings,
    previewUrls,
    totalReviews,
    publishedAgg,
    pendingCount,
    publishedThisMonth,
    syntheticPublishedCount,
    attentionRows,
    productGroups,
  ] = await Promise.all([
    getSettings(shop),
    // SPEC-1.10 §5 fix B: one tokenized URL per preview destination
    // (product page / home page / collection page).
    getPreviewUrls(admin, shop),
    prisma.review.count({ where: { shop } }),
    prisma.review.aggregate({
      where: { shop, status: "PUBLISHED" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.review.count({ where: { shop, status: "PENDING" } }),
    prisma.review.count({
      where: { shop, status: "PUBLISHED", createdAt: { gte: monthStart } },
    }),
    prisma.review.count({
      where: { shop, isSynthetic: true, status: "PUBLISHED" },
    }),
    prisma.review.findMany({
      where: {
        shop,
        OR: [{ status: "PENDING" }, { status: "PUBLISHED", reportCount: { gt: 0 } }],
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.review.groupBy({
      by: ["productId"],
      where: { shop, status: "PUBLISHED" },
      _count: { _all: true },
      _avg: { rating: true },
      _max: { createdAt: true },
    }),
  ]);

  const productIds = productGroups.map((g) => g.productId);
  const [titleRows, summaryRows] = await Promise.all([
    productIds.length
      ? prisma.review.findMany({
          where: { shop, productId: { in: productIds } },
          select: { productId: true, productTitle: true },
          distinct: ["productId"],
        })
      : Promise.resolve([]),
    productIds.length
      ? prisma.summary.findMany({
          where: { shop, productId: { in: productIds } },
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const titleByProduct = new Map(titleRows.map((r) => [r.productId, r.productTitle]));
  const summaryByProduct = new Map<string, Date>();
  for (const s of summaryRows) {
    if (!summaryByProduct.has(s.productId)) {
      summaryByProduct.set(s.productId, s.updatedAt);
    }
  }

  const products = productGroups
    .map((g) => ({
      productId: g.productId,
      title: titleByProduct.get(g.productId) ?? `Product ${g.productId}`,
      average: g._avg.rating ?? 0,
      count: g._count._all,
      lastReviewAt: g._max.createdAt,
      summaryUpdatedAt: summaryByProduct.get(g.productId) ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  // v1.14 (SPEC-1.14 §6/§7): market scope state + picker sources. listMarkets
  // degrades to { needsScope: true } when the app lacks read_markets — the UI
  // then offers observed-market chips and manual handle entry instead.
  const marketsResult = await listMarkets(admin);

  return json({
    shop,
    isLive: settings.isLive,
    marketScope: {
      liveScope: settings.liveScope === "markets" ? ("markets" as const) : ("all" as const),
      liveMarkets: parseLiveMarkets(settings),
      hideStamped: settings.hideStamped,
      stampedSelectors: settings.stampedSelectors,
      stampedDefaults: DEFAULT_STAMPED_SELECTORS,
      // Offer only handles that can actually be saved (same slug rule as the
      // sanitizer) — an exotic API handle must not pass the UI then vanish.
      markets: marketsResult.markets
        ? marketsResult.markets.filter((m) => isValidMarketHandle(m.handle))
        : null,
      needsScope: marketsResult.needsScope,
      observedMarkets: parseObservedMarkets(settings.observedMarkets),
    },
    previewUrls,
    stats: {
      average: publishedAgg._avg.rating,
      totalReviews,
      pendingCount,
      publishedThisMonth,
    },
    syntheticPublishedCount,
    setup: {
      hasAiKey: Boolean(settings.anthropicApiKey),
      hasModerated: publishedAgg._count._all > 0,
    },
    // SPEC-1.6.1 §B — the review-data health row is rendered from these, not
    // from prose the service composed, so the merchant always sees all three
    // numbers and the "reviews exist but none are published" case is
    // recognised as such. Free: the Dashboard already queried every one.
    reviewCounts: {
      total: totalReviews,
      published: publishedAgg._count._all,
      pending: pendingCount,
      products: products.length,
    },
    needsAttention: attentionRows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body.length > 180 ? `${r.body.slice(0, 180)}…` : r.body,
      authorName: r.authorName,
      productTitle: r.productTitle,
      status: r.status,
      reportCount: r.reportCount,
      createdAt: r.createdAt,
    })),
    products,
    health: {
      report: cachedHealth,
      autoRun: forceHealthRun || isHealthStale(cachedHealth),
      focus: forceHealthRun,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "approve" || intent === "reject") {
      const id = String(form.get("id") ?? "");
      if (!id) {
        return json({ ok: false, message: "Missing review id" }, { status: 400 });
      }
      const status = intent === "approve" ? "PUBLISHED" : "REJECTED";
      const changed = await updateReviewStatuses(shop, [id], status, admin);
      if (!changed) {
        return json({ ok: false, message: "Review not found" }, { status: 404 });
      }
      return json({
        ok: true,
        message: intent === "approve" ? "Review approved and published" : "Review rejected",
      });
    }

    if (intent === "go-live" || intent === "go-offline") {
      const isLive = intent === "go-live";
      const saved = await updateSettings(shop, { isLive });
      // Mirror the change onto the SHOP metafield (cellexia.live) so the theme
      // extension shows/hides the widget without a DB round-trip.
      await syncShopSettingsMetafields(admin, saved);
      const scoped = saved.liveScope === "markets" ? parseLiveMarkets(saved) : [];
      return json({
        ok: true,
        message: isLive
          ? scoped.length > 0
            ? `You're live in: ${scoped.join(", ")} — every other market is unchanged and keeps Stamped.`
            : "You're live!"
          : "The review widget is now hidden from store visitors",
      });
    }

    // v1.14 (SPEC-1.14 §7): market scope + Stamped takeover settings.
    if (intent === "save-live-scope") {
      const liveScope = String(form.get("liveScope") ?? "all") === "markets" ? "markets" : "all";
      const liveMarkets = String(form.get("liveMarkets") ?? "[]");
      const hideStamped = form.get("hideStamped") === "true";
      const selectorsRaw = String(form.get("stampedSelectors") ?? "").trim();
      // Review hardening: validate the handles that will actually SURVIVE
      // sanitization — a raw count let unsaveable handles slip through and
      // reach the metafield as an empty list.
      const surviving = JSON.parse(sanitizeMarketHandles(liveMarkets)) as string[];
      if (liveScope === "markets" && surviving.length === 0) {
        return json({
          ok: false,
          message:
            "None of the selected markets have a valid handle — pick at least one valid market (or switch back to “All markets”) before saving.",
        });
      }
      try {
        const saved = await updateSettings(shop, {
          liveScope,
          liveMarkets,
          hideStamped,
          stampedSelectors: selectorsRaw === "" ? null : selectorsRaw,
        });
        await syncShopSettingsMetafields(admin, saved);
        const handles = parseLiveMarkets(saved);
        const where =
          saved.liveScope === "markets" ? `only in: ${handles.join(", ")}` : "in all markets";
        // Review fix: when the store is ALREADY live this takes effect now —
        // say so instead of the misleading "When live…".
        const prefix = saved.isLive
          ? `Saved — in effect now. Reviews show ${where}`
          : `Saved. When you go live, reviews will show ${where}`;
        return json({
          ok: true,
          message: `${prefix}${
            saved.hideStamped ? " and Stamped is hidden there (other markets untouched)" : ""
          }.`,
        });
      } catch (error) {
        if (error instanceof SelectorValidationError) {
          return json({ ok: false, message: `Stamped selectors: ${error.message}` });
        }
        throw error;
      }
    }

    /* ---- Storefront connection test (SPEC-1.6 §5) ------------------------ */
    if (intent === "storefront-health") {
      try {
        const [raw, reviewCounts]: [HealthReport, ReviewCounts | null] =
          await Promise.all([
            runStorefrontHealthCheck(shop, admin),
            // Counts as of THIS run, so a report requested minutes after the
            // page loaded never contradicts the row it is rendered into.
            readReviewCounts(shop),
          ]);
        const report = normalizeHealthReport(raw, new Date().toISOString());
        if (!report) {
          return json(
            {
              ok: false,
              intent,
              message:
                "The storefront connection test returned no results. Please try again.",
            },
            { status: 500 },
          );
        }
        writeHealthCache(shop, report);
        return json({ ok: true, intent, report, reviewCounts });
      } catch (error) {
        console.error("[cellexia] storefront health check failed", error);
        return json(
          {
            ok: false,
            intent,
            message:
              "The storefront connection test could not be completed. Please try again.",
          },
          { status: 500 },
        );
      }
    }

    /* ---- Re-sync the product metafields that power SSR stars ------------- */
    if (intent === "resync-metafields") {
      const groups = await prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
      });
      if (groups.length === 0) {
        return json({
          ok: true,
          intent,
          message: "There are no published reviews to sync yet.",
        });
      }

      // Bounded work per click: a store with hundreds of reviewed products
      // would otherwise outlive the request. Whatever is left is reported
      // honestly so the merchant can run it again.
      const startedAt = Date.now();
      let processed = 0;
      let synced = 0;
      const failures: Array<{ productId: string; message: string }> = [];

      for (const group of groups) {
        if (processed >= RESYNC_MAX_PRODUCTS) break;
        if (processed > 0 && Date.now() - startedAt > RESYNC_TIME_BUDGET_MS) break;
        processed += 1;
        try {
          await syncProductData(shop, group.productId, admin);
          // SPEC-1.6.1 §A: a metafield write that fails no longer throws and
          // no longer disappears into a console log — it is recorded on
          // Setting.lastSyncError, which recomputeProduct clears on success.
          // Reading it back is therefore this product's real outcome, and the
          // reason this loop can report anything at all. An error stamped
          // before this run started belongs to an earlier one and is ignored.
          const outcome = await readSyncOutcome(shop);
          const recorded =
            outcome.error && (outcome.at === null || outcome.at >= startedAt)
              ? outcome.error
              : null;
          if (recorded) {
            failures.push({ productId: group.productId, message: recorded });
            console.error(
              `[cellexia] metafield re-sync reported an error for ${group.productId}: ${recorded}`,
            );
          } else {
            synced += 1;
          }
        } catch (error) {
          failures.push({ productId: group.productId, message: describeError(error) });
          console.error(`[cellexia] metafield re-sync failed for ${group.productId}`, error);
        }
      }

      const remaining = groups.length - processed;
      const parts = [`Re-synced ${pluralize(synced, "product")}`];
      if (failures.length > 0) {
        parts.push(`${pluralize(failures.length, "product")} could not be synced`);
      }
      if (remaining > 0) {
        parts.push(
          `${pluralize(remaining, "product")} left — run “Re-sync all products” again to finish`,
        );
      }

      // The first REAL error, verbatim, instead of "something went wrong":
      // this is the whole point of SPEC-1.6.1 §A. The toast keeps a short
      // form; the Dashboard card shows the full list underneath.
      const first = failures[0] ?? null;
      const summary = `${parts.join(" — ")}.`;
      return json({
        ok: failures.length === 0 && synced > 0,
        intent,
        message: first
          ? `${summary} First error — ${clip(describeProductFailure(first), 200)}`
          : summary,
        resync: {
          synced,
          failed: failures.length,
          remaining,
          firstError: first ? describeProductFailure(first) : null,
          hint: first ? syncErrorHint(first.message) : null,
          failures: failures
            .slice(0, RESYNC_REPORTED_FAILURES)
            .map((failure) => clip(describeProductFailure(failure), 300)),
        },
      });
    }

    if (intent === "regenerate-summary") {
      const productId = String(form.get("productId") ?? "");
      if (!productId) {
        return json({ ok: false, message: "Missing product id" }, { status: 400 });
      }
      const summary = await generateSummary(shop, productId, "en");
      if (!summary) {
        return json({
          ok: false,
          message: "Summary could not be generated. Check the AI settings and API key.",
        });
      }
      await syncProductData(shop, productId, admin);
      return json({ ok: true, message: "AI summary regenerated" });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Dashboard action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

/**
 * The storefront connection test changes nothing the loader renders — its
 * report travels back on the fetcher response — so skip the full Dashboard
 * re-query it would otherwise trigger. Every other submission revalidates as
 * usual (a metafield re-sync, for instance, does move the loader's numbers).
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formData,
  defaultShouldRevalidate,
}) => {
  if (formData?.get("intent") === "storefront-health") return false;
  return defaultShouldRevalidate;
};

type LoaderData = SerializeFrom<typeof loader>;

function SetupStep({
  index,
  text,
  done,
  action,
}: {
  index: number;
  text: string;
  done: boolean;
  action: ReactNode;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
      <InlineStack gap="300" blockAlign="center">
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: done ? "#B4FED2" : "#E3E3E3",
            fontSize: 12,
            fontWeight: 700,
            flex: "0 0 auto",
          }}
        >
          {index}
        </span>
        <Text as="span">{text}</Text>
        {done ? <Badge tone="success">Done</Badge> : null}
      </InlineStack>
      {action}
    </InlineStack>
  );
}

/** The three tokenized preview destinations, as serialized by the loader. */
interface PreviewUrlsView {
  product: string | null;
  home: string;
  collection: string;
}

/**
 * The multi-destination preview menu (SPEC-1.10 §5 fix B): a Popover /
 * ActionList offering the tokenized preview on the product page, the home
 * page and the collection page (resolved to the store's real catalog collection, e.g. `shop-all` — falls back to `all`, which exists on every
 * Shopify store), each opening in a new tab exactly like the old
 * single-destination button did. When the store has no product page to
 * preview on (`previewUrls.product` is null) only the product item is
 * disabled, with the explanation as its help text — home and collection stay
 * available.
 */
function PreviewMenu({
  previewUrls,
  children,
}: {
  previewUrls: PreviewUrlsView;
  children: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  const openDestination = useCallback((url: string | null) => {
    if (!url) return;
    setOpen(false);
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  return (
    <Popover
      active={open}
      activator={
        <Button onClick={toggle} disclosure>
          {children}
        </Button>
      }
      onClose={close}
      autofocusTarget="first-node"
    >
      <ActionList
        actionRole="menuitem"
        items={[
          {
            content: "Product page",
            disabled: !previewUrls.product,
            helpText: previewUrls.product
              ? undefined
              : "Add at least one product to your store first.",
            onAction: () => openDestination(previewUrls.product),
          },
          {
            content: "Home page",
            onAction: () => openDestination(previewUrls.home),
          },
          {
            content: "Collection page",
            onAction: () => openDestination(previewUrls.collection),
          },
        ]}
      />
    </Popover>
  );
}

function StatCard({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {extra}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function AttentionRow({ review }: { review: LoaderData["needsAttention"][number] }) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher);
  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";

  const submit = useCallback(
    (intent: "approve" | "reject") => {
      fetcher.submit({ intent, id: review.id }, { method: "post" });
    },
    [fetcher, review.id],
  );

  return (
    <Box paddingBlock="300">
      <InlineStack align="space-between" blockAlign="start" gap="400" wrap>
        <Box maxWidth="640px">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center" wrap>
              <StarRating rating={review.rating} size={14} />
              <PolarisLink url={`/app/reviews/${review.id}`} removeUnderline>
                <Text as="span" fontWeight="semibold">
                  {review.title || "Untitled review"}
                </Text>
              </PolarisLink>
              <StatusBadge status={review.status} />
              {review.reportCount > 0 ? (
                <Badge tone="critical">{pluralize(review.reportCount, "report")}</Badge>
              ) : null}
            </InlineStack>
            <Text as="span" variant="bodySm" tone="subdued">
              {review.authorName}
              {review.productTitle ? ` · ${review.productTitle}` : ""} ·{" "}
              {formatDate(review.createdAt)}
            </Text>
            <Text as="p" variant="bodySm">
              {review.body}
            </Text>
          </BlockStack>
        </Box>
        <InlineStack gap="200">
          <Button
            size="slim"
            onClick={() => submit("approve")}
            loading={pendingIntent === "approve"}
            disabled={busy && pendingIntent !== "approve"}
          >
            Approve
          </Button>
          <Button
            size="slim"
            tone="critical"
            onClick={() => submit("reject")}
            loading={pendingIntent === "reject"}
            disabled={busy && pendingIntent !== "reject"}
          >
            Reject
          </Button>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

function RegenerateSummaryCell({
  productId,
  summaryUpdatedAt,
}: {
  productId: string;
  summaryUpdatedAt: string | null;
}) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher);

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">
        {summaryUpdatedAt ? `Generated ${formatDateTime(summaryUpdatedAt)}` : "Not generated yet"}
      </Text>
      <Button
        size="slim"
        loading={fetcher.state !== "idle"}
        onClick={() =>
          fetcher.submit({ intent: "regenerate-summary", productId }, { method: "post" })
        }
      >
        Regenerate AI summary
      </Button>
    </InlineStack>
  );
}

/**
 * Which admin fix belongs to a health check. Matched on the check's id + label
 * so the mapping survives a service that renames an id, with the SPEC-1.6 §5
 * order as the last resort. "preview"/"token" is tested before "review" —
 * "Preview token round-trip" contains the substring "review".
 */
type HealthCheckKind =
  | "proxy"
  | "token"
  | "theme"
  | "data"
  | "metafields"
  | "database"
  | "live"
  | "other";

const HEALTH_KIND_ORDER: readonly HealthCheckKind[] = [
  "proxy",
  "token",
  "theme",
  "data",
  "metafields",
  "database",
  "live",
];

function healthCheckKind(check: HealthCheckView, index: number): HealthCheckKind {
  const haystack = `${check.id} ${check.label}`.toLowerCase();
  if (haystack.includes("proxy")) return "proxy";
  if (haystack.includes("preview") || haystack.includes("token")) return "token";
  if (
    haystack.includes("extension") ||
    haystack.includes("embed") ||
    haystack.includes("theme")
  ) {
    return "theme";
  }
  if (haystack.includes("metafield")) return "metafields";
  if (
    haystack.includes("database") ||
    haystack.includes("persist") ||
    haystack.includes("sqlite")
  ) {
    return "database";
  }
  if (haystack.includes("live")) return "live";
  if (haystack.includes("review") || haystack.includes("data")) return "data";
  return HEALTH_KIND_ORDER[index] ?? "other";
}

const STATUS_RANK: Record<HealthStatus, number> = { pass: 0, warn: 1, fail: 2 };

/** The more serious of two statuses — a row is never quietly downgraded. */
function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * The "Review data" row, rebuilt from the Dashboard's own counts
 * (SPEC-1.6.1 §B).
 *
 * Two things the merchant kept getting wrong come from this row, so it is
 * composed here rather than taken as prose from the service:
 *
 *   1. total / published / pending are ALWAYS stated, so "I definitely have
 *      reviews" and "the storefront shows none" can be reconciled in one look.
 *   2. `published === 0 && total > 0` is its own case. The generic "no
 *      published reviews" advice ("import your reviews") is actively
 *      misleading there: the reviews are already in the app, they are just
 *      waiting for approval.
 *
 * The service's own status is still honoured — a row it failed stays failed,
 * and its detail is appended so a genuine failure is never swallowed.
 */
function reviewDataRow(
  check: HealthCheckView,
  counts: ReviewCounts,
): HealthCheckView & { unpublishedOnly: boolean } {
  const summary =
    `${counts.published} published, ${counts.pending} pending, ${counts.total} total` +
    ` — ${pluralize(counts.products, "product")} with published reviews`;

  if (counts.published === 0 && counts.total > 0) {
    const headline =
      counts.total === 1
        ? "1 review exists but it is not published"
        : `${counts.total} reviews exist but none are published`;
    return {
      ...check,
      status: worstStatus(check.status, "warn"),
      detail:
        `${headline} (${summary}). ` +
        "Your storefront shows no stars, no badges and no reviews until at least one is published.",
      fix: `Approve ${
        counts.total === 1 ? "it" : "them"
      } under Reviews, or turn on Settings → General → Auto-publish new reviews.`,
      unpublishedOnly: true,
    };
  }

  if (counts.total === 0) {
    return {
      ...check,
      status: worstStatus(check.status, "warn"),
      detail: `This app holds no reviews yet (${summary}). The storefront will show no stars or badges until reviews exist.`,
      fix: "Import your existing reviews (Import / Export) or generate test data (QA data). Reviews that live in another review app are not visible to this one.",
      unpublishedOnly: false,
    };
  }

  return {
    ...check,
    detail:
      check.status === "fail" && check.detail ? `${summary}. ${check.detail}` : `${summary}.`,
    fix:
      counts.pending > 0
        ? `${pluralize(counts.pending, "review")} waiting for moderation under Reviews.`
        : check.fix,
    unpublishedOnly: false,
  };
}

/* v1.14 (SPEC-1.14 §7) — market scope + Stamped takeover card. */
function MarketScopeCard({
  marketScope,
  isLive,
}: {
  marketScope: LoaderData["marketScope"];
  isLive: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher);

  const [scope, setScope] = useState<"all" | "markets">(marketScope.liveScope);
  const [selected, setSelected] = useState<string[]>(marketScope.liveMarkets);
  const [hideStamped, setHideStamped] = useState(marketScope.hideStamped);
  const [manual, setManual] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectors, setSelectors] = useState(marketScope.stampedSelectors ?? "");

  const toggleHandle = (handle: string) =>
    setSelected((prev) =>
      prev.includes(handle) ? prev.filter((h) => h !== handle) : [...prev, handle],
    );
  const addManual = () => {
    const handle = manual.trim().toLowerCase();
    if (/^[a-z0-9-]{1,64}$/.test(handle) && !selected.includes(handle)) {
      setSelected((prev) => [...prev, handle]);
    }
    setManual("");
  };
  const save = () =>
    fetcher.submit(
      {
        intent: "save-live-scope",
        liveScope: scope,
        liveMarkets: JSON.stringify(selected),
        hideStamped: String(hideStamped),
        stampedSelectors: selectors,
      },
      { method: "post" },
    );

  // Handles offered as checkboxes: the Markets API list when available,
  // otherwise every handle the storefront has reported plus anything already
  // selected (so a saved handle never disappears from the UI).
  const apiMarkets = marketScope.markets;
  const fallbackHandles = [
    ...new Set([...marketScope.observedMarkets.map((m) => m.handle), ...selected]),
  ].sort();
  const saveDisabled = scope === "markets" && selected.length === 0;
  // Review fix: surface unsaved changes — Go live uses the SAVED scope.
  const dirty =
    scope !== marketScope.liveScope ||
    hideStamped !== marketScope.hideStamped ||
    (selectors || "") !== (marketScope.stampedSelectors ?? "") ||
    JSON.stringify([...selected].sort()) !==
      JSON.stringify([...marketScope.liveMarkets].sort());
  const saveError =
    fetcher.state === "idle" &&
    fetcher.data &&
    fetcher.data.ok === false &&
    "message" in fetcher.data
      ? String(fetcher.data.message)
      : null;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="150">
          <Text as="h2" variant="headingMd">
            Markets — where your reviews go live
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            The market of every page view is decided by Shopify itself when it renders the
            page, so this can never leak into other markets. Markets not selected here keep
            their storefront byte-for-byte unchanged — including Stamped.
          </Text>
        </BlockStack>

        <ChoiceList
          title="Visibility scope"
          titleHidden
          choices={[
            {
              label: "All markets (default)",
              value: "all",
              helpText: "Behaves exactly like before this feature existed.",
            },
            {
              label: "Only selected markets",
              value: "markets",
              helpText: isLive
                ? "Your reviews stay visible only in the markets picked below."
                : "When you press Go live, reviews appear only in the markets picked below.",
            },
          ]}
          selected={[scope]}
          onChange={(values) => setScope(values[0] === "markets" ? "markets" : "all")}
        />

        {scope === "markets" ? (
          <BlockStack gap="300">
            {apiMarkets ? (
              <BlockStack gap="100">
                {apiMarkets.map((market) => (
                  <Checkbox
                    key={market.handle}
                    label={`${market.name} (${market.handle})${market.enabled ? "" : " — inactive market"}`}
                    checked={selected.includes(market.handle)}
                    onChange={() => toggleHandle(market.handle)}
                  />
                ))}
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                {marketScope.needsScope ? (
                  <Banner tone="info" title="Market names unavailable (optional permission missing)">
                    <Text as="p">
                      Listing your markets by name needs the app's <code>read_markets</code>{" "}
                      permission (see UPDATE.md — optional). Everything below works without
                      it: open your storefront in a market (e.g. via the preview link on that
                      market's domain) and its handle appears here automatically, or type the
                      handle from Shopify admin → Settings → Markets.
                    </Text>
                  </Banner>
                ) : null}
                {fallbackHandles.length > 0 ? (
                  <BlockStack gap="100">
                    {fallbackHandles.map((handle) => (
                      <Checkbox
                        key={handle}
                        label={handle}
                        checked={selected.includes(handle)}
                        onChange={() => toggleHandle(handle)}
                      />
                    ))}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No markets detected yet — visit your storefront once (any page) and
                    refresh this page, or add a handle manually below.
                  </Text>
                )}
                <InlineStack gap="200" blockAlign="end" wrap>
                  <Box minWidth="220px">
                    <TextField
                      label="Add a market handle"
                      labelHidden
                      placeholder="market handle, e.g. eu"
                      value={manual}
                      onChange={setManual}
                      autoComplete="off"
                    />
                  </Box>
                  <Button onClick={addManual} disabled={!manual.trim()}>
                    Add
                  </Button>
                </InlineStack>
              </BlockStack>
            )}
            {selected.length > 0 ? (
              <InlineStack gap="150" wrap>
                {selected.map((handle) => (
                  <Tag key={handle} onRemove={() => toggleHandle(handle)}>
                    {handle}
                  </Tag>
                ))}
              </InlineStack>
            ) : (
              <Text as="p" tone="critical" variant="bodySm">
                Select at least one market — with none selected, nothing can be saved.
              </Text>
            )}
          </BlockStack>
        ) : null}

        <Divider />

        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Replace Stamped where Cellexia Reviews is live
          </Text>
          <Checkbox
            label="Hide Stamped reviews in the market(s) where Cellexia Reviews is live"
            checked={hideStamped}
            onChange={setHideStamped}
            helpText="Hides Stamped's product-page widget and its stars under product names (product, home and collection pages) — only where your reviews are live. Every other market keeps Stamped exactly as it is. CSS-only and instantly reversible: switch this off and Stamped is back on the next page load. The preview link shows you the swap before anything is live."
          />
          <Button
            variant="plain"
            disclosure={advancedOpen ? "up" : "down"}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            Advanced: what gets hidden
          </Button>
          <Collapsible id="cx-stamped-advanced" open={advancedOpen}>
            <BlockStack gap="200">
              <TextField
                label="CSS selectors to hide (one per line)"
                value={selectors}
                onChange={setSelectors}
                multiline={5}
                autoComplete="off"
                placeholder={marketScope.stampedDefaults.join("\n")}
                helpText="Leave empty to use the built-in list (shown above), measured from your live theme. Only edit this if Stamped's markup changes."
              />
              {selectors ? (
                <Button variant="plain" onClick={() => setSelectors("")}>
                  Reset to built-in list
                </Button>
              ) : null}
            </BlockStack>
          </Collapsible>
        </BlockStack>

        {saveError ? (
          <Text as="p" tone="critical" variant="bodySm">
            {saveError}
          </Text>
        ) : null}
        <InlineStack gap="200" blockAlign="center" wrap>
          <Button
            variant="primary"
            onClick={save}
            loading={fetcher.state !== "idle"}
            disabled={saveDisabled}
          >
            Save market settings
          </Button>
          {saveDisabled ? (
            <Text as="span" tone="subdued" variant="bodySm">
              Pick at least one market first.
            </Text>
          ) : dirty ? (
            <Text as="span" tone="caution" variant="bodySm">
              Unsaved changes — the storefront (and Go live) uses the last saved settings.
            </Text>
          ) : null}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function Dashboard() {
  const {
    shop,
    isLive,
    marketScope,
    previewUrls,
    stats,
    setup,
    needsAttention,
    products,
    syntheticPublishedCount,
    health,
    reviewCounts,
  } = useLoaderData<typeof loader>();

  /* ---- Storefront connection (SPEC-1.6 §5) ------------------------------- */
  const healthFetcher = useFetcher<typeof action>();
  const resyncFetcher = useFetcher<typeof action>();

  const runHealthCheck = useCallback(() => {
    healthFetcher.submit({ intent: "storefront-health" }, { method: "post" });
  }, [healthFetcher]);

  useResultToast(resyncFetcher);

  const healthResponse = healthFetcher.data as
    | {
        ok?: boolean;
        intent?: string;
        report?: HealthReportView;
        reviewCounts?: ReviewCounts | null;
        message?: string;
      }
    | undefined;
  const healthAnswer =
    healthResponse?.intent === "storefront-health" ? healthResponse : undefined;
  const report: HealthReportView | null =
    healthAnswer?.ok === true && healthAnswer.report
      ? healthAnswer.report
      : health.report;
  const healthError =
    healthAnswer && healthAnswer.ok === false
      ? healthAnswer.message ??
        "The storefront connection test could not be completed. Please try again."
      : null;
  const healthRunning = healthFetcher.state !== "idle";
  const resyncing = resyncFetcher.state !== "idle";

  /* ---- Re-sync outcome (SPEC-1.6.1 §A) ----------------------------------- */
  const resyncResponse = resyncFetcher.data as
    | {
        intent?: string;
        resync?: {
          synced: number;
          failed: number;
          remaining: number;
          firstError: string | null;
          hint: string | null;
          failures: string[];
        };
      }
    | undefined;
  const resyncOutcome =
    resyncResponse?.intent === "resync-metafields" && !resyncing
      ? resyncResponse.resync ?? null
      : null;

  // Any finished re-sync — successful or not — changes what the metafield
  // check would see, so the report is refreshed either way. (The toast alone
  // used to do this, and only on success.)
  const resyncHandled = useRef<unknown>(null);
  useEffect(() => {
    if (resyncFetcher.state !== "idle" || !resyncFetcher.data) return;
    if (resyncHandled.current === resyncFetcher.data) return;
    resyncHandled.current = resyncFetcher.data;
    runHealthCheck();
  }, [resyncFetcher.state, resyncFetcher.data, runHealthCheck]);

  // SPEC-1.6.1 §B — counts from the run that produced the report when there is
  // one, otherwise the loader's (fresh as of page load).
  const counts: ReviewCounts = healthAnswer?.reviewCounts ?? reviewCounts;
  const healthChecks = (report?.checks ?? []).map((check, index) => {
    const kind = healthCheckKind(check, index);
    if (kind !== "data") return { kind, check, unpublishedOnly: false };
    const { unpublishedOnly, ...view } = reviewDataRow(check, counts);
    return { kind, check: view, unpublishedOnly };
  });
  const failedChecks = healthChecks
    .filter((row) => row.check.status === "fail")
    .map((row) => row.check);
  const warnChecks = healthChecks
    .filter((row) => row.check.status === "warn")
    .map((row) => row.check);
  const hasFailedChecks = failedChecks.length > 0;
  // Recomputed rather than read from the report: the review-data row above can
  // legitimately be more severe than the service judged it.
  const overall: HealthStatus | null = !report
    ? null
    : hasFailedChecks
      ? "fail"
      : warnChecks.length > 0
        ? "warn"
        : "pass";

  // Auto-run on load when never run or older than 24 h (never blocks the page).
  const autoRunStarted = useRef(false);
  useEffect(() => {
    if (autoRunStarted.current || !health.autoRun) return;
    autoRunStarted.current = true;
    runHealthCheck();
  }, [health.autoRun, runHealthCheck]);

  // Arriving from Settings → "Test storefront connection": bring the card into view.
  const focusHandled = useRef(false);
  useEffect(() => {
    if (focusHandled.current || !health.focus) return;
    focusHandled.current = true;
    document
      .getElementById(HEALTH_ANCHOR_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [health.focus]);

  const liveFetcher = useFetcher<typeof action>();
  const [liveConfirm, setLiveConfirm] = useState<"go-live" | "go-offline" | null>(null);
  const closeLiveConfirm = useCallback(() => setLiveConfirm(null), []);
  // Going live / offline flips the "Live state" check — refresh the report.
  const handleLiveChange = useCallback(() => {
    setLiveConfirm(null);
    runHealthCheck();
  }, [runHealthCheck]);
  useResultToast(liveFetcher, handleLiveChange);
  const liveBusy = liveFetcher.state !== "idle";

  const themeEditorUrl = `https://${shop}/admin/themes/current/editor?template=product&context=apps`;
  const setupComplete = setup.hasAiKey && setup.hasModerated && isLive;

  const healthRows = healthChecks.map(({ check, kind, unpublishedOnly }, index) => {
    const badge = HEALTH_BADGE[check.status];
    const needsFix = check.status !== "pass";
    let fixAction: ReactNode = null;
    if (kind === "metafields" && needsFix) {
      fixAction = (
        <Button
          size="slim"
          loading={resyncing}
          onClick={() =>
            resyncFetcher.submit({ intent: "resync-metafields" }, { method: "post" })
          }
        >
          Re-sync all products
        </Button>
      );
    } else if (kind === "theme" && needsFix) {
      fixAction = (
        <Button size="slim" url={themeEditorUrl} external>
          Open theme editor
        </Button>
      );
    } else if (kind === "data" && needsFix) {
      // SPEC-1.6.1 §B: reviews that exist but are unpublished need approving,
      // not importing — offer the two steps that actually publish them.
      fixAction = unpublishedOnly ? (
        <InlineStack gap="200" wrap>
          <Button size="slim" variant="primary" url="/app/reviews?tab=pending">
            Approve pending reviews
          </Button>
          <Button size="slim" url="/app/settings">
            Turn on auto-publish
          </Button>
        </InlineStack>
      ) : (
        <InlineStack gap="200" wrap>
          <Button size="slim" url="/app/import-export">
            Import reviews
          </Button>
          <Button size="slim" url="/app/qa-generator">
            Generate test data
          </Button>
        </InlineStack>
      );
    } else if (kind === "token" && needsFix) {
      fixAction = (
        <Button size="slim" url="/app/settings">
          Open settings
        </Button>
      );
    } else if (kind === "live" && !isLive) {
      fixAction = (
        <Button size="slim" variant="primary" onClick={() => setLiveConfirm("go-live")}>
          Go live
        </Button>
      );
    }

    return [
      <Text as="span" fontWeight="medium" key={`hc-label-${index}`}>
        {check.label}
      </Text>,
      <Badge tone={badge.tone} key={`hc-status-${index}`}>
        {badge.label}
      </Badge>,
      <BlockStack gap="150" key={`hc-detail-${index}`}>
        {check.detail ? (
          <Text as="span" variant="bodySm">
            {check.detail}
          </Text>
        ) : null}
        {check.fix ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {check.fix}
          </Text>
        ) : null}
        {fixAction}
      </BlockStack>,
    ];
  });

  const productRows = products.map((p) => [
    <Text as="span" fontWeight="medium" key={`t-${p.productId}`}>
      {p.title}
    </Text>,
    <InlineStack gap="150" blockAlign="center" key={`a-${p.productId}`}>
      <StarRating rating={p.average} size={14} />
      <Text as="span">{p.average.toFixed(1)}</Text>
    </InlineStack>,
    p.count,
    formatDate(p.lastReviewAt),
    <RegenerateSummaryCell
      key={`r-${p.productId}`}
      productId={p.productId}
      summaryUpdatedAt={p.summaryUpdatedAt}
    />,
  ]);

  return (
    <Page title="Dashboard" subtitle="Cellexia Reviews">
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        {/* Storefront connection — the first thing the merchant sees, because
            nothing else on this page matters if the theme can't reach the app
            (SPEC-1.6 §5). */}
        <div id={HEALTH_ANCHOR_ID}>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Storefront connection
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {report
                      ? `Last checked ${formatDateTime(report.ranAt)}`
                      : healthRunning
                        ? "Running the checks…"
                        : "Not tested yet"}
                  </Text>
                </BlockStack>
                <Button onClick={runHealthCheck} loading={healthRunning}>
                  {report ? "Run test again" : "Test storefront connection"}
                </Button>
              </InlineStack>

              {healthError ? (
                <Banner
                  tone="critical"
                  title="The storefront connection test could not be completed"
                >
                  <Text as="p">{healthError}</Text>
                </Banner>
              ) : null}

              {resyncOutcome && resyncOutcome.firstError ? (
                <Banner
                  tone="critical"
                  title={`${pluralize(
                    resyncOutcome.failed,
                    "product",
                  )} could not be re-synced`}
                >
                  <BlockStack gap="200">
                    <BlockStack gap="050">
                      {resyncOutcome.failures.map((failure, index) => (
                        <Text as="p" variant="bodySm" key={`resync-fail-${index}`}>
                          Could not sync {failure}
                        </Text>
                      ))}
                      {resyncOutcome.failed > resyncOutcome.failures.length ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`…and ${
                            resyncOutcome.failed - resyncOutcome.failures.length
                          } more with the same or similar errors.`}
                        </Text>
                      ) : null}
                    </BlockStack>
                    {resyncOutcome.hint ? (
                      <Text as="p" variant="bodySm">
                        {resyncOutcome.hint}
                      </Text>
                    ) : null}
                  </BlockStack>
                </Banner>
              ) : null}

              {report ? (
                overall === "fail" ? (
                  <Banner tone="critical" title="Storefront connection needs attention">
                    <Text as="p">
                      {pluralize(failedChecks.length, "check")} failed — store visitors
                      may not see any reviews until this is fixed.
                    </Text>
                  </Banner>
                ) : overall === "warn" ? (
                  <Banner
                    tone="warning"
                    title="Storefront connection works — a few things need your attention"
                  >
                    <Text as="p">
                      Your theme can reach the app.{" "}
                      {pluralize(warnChecks.length, "check")} below{" "}
                      {warnChecks.length === 1 ? "needs" : "need"} a look.
                    </Text>
                  </Banner>
                ) : (
                  <Banner tone="success" title="Storefront connection verified">
                    <Text as="p">
                      Every check passed — your theme reaches the app, the preview works
                      on your product, home and collection pages, and your product
                      ratings are in sync.
                    </Text>
                  </Banner>
                )
              ) : healthRunning ? (
                <div role="status">
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner
                      size="small"
                      accessibilityLabel="Testing the storefront connection"
                    />
                    <Text as="span">
                      Testing the connection between your storefront and the app…
                    </Text>
                  </InlineStack>
                </div>
              ) : healthError ? null : (
                <Text as="p" tone="subdued">
                  Run the test to verify that your theme can reach the app, that the
                  preview works on your product, home and collection pages, and that
                  your product ratings are in sync.
                </Text>
              )}

              {report ? (
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={["Check", "Status", "What it means"]}
                  rows={healthRows}
                  verticalAlign="top"
                  truncate={false}
                />
              ) : null}
            </BlockStack>
          </Card>
        </div>

        {isLive ? (
          <Banner
            tone="success"
            title={
              marketScope.liveScope === "markets" && marketScope.liveMarkets.length > 0
                ? `Live in ${marketScope.liveMarkets.join(", ")} only — every other market is unchanged.`
                : "Live — visitors can see the review widget."
            }
          >
            <InlineStack gap="300" blockAlign="center" wrap>
              <PreviewMenu previewUrls={previewUrls}>Preview link</PreviewMenu>
              <Button variant="plain" onClick={() => setLiveConfirm("go-offline")}>
                Switch off
              </Button>
            </InlineStack>
          </Banner>
        ) : (
          <Banner
            tone="warning"
            title="Not live yet — store visitors can't see the review widget."
          >
            <BlockStack gap="200">
              <Text as="p">
                Preview the widget on your live theme — only you can see the preview — then go
                live when you're ready.
              </Text>
              <InlineStack gap="200" blockAlign="center" wrap>
                <PreviewMenu previewUrls={previewUrls}>Preview on your store</PreviewMenu>
                <Button variant="primary" onClick={() => setLiveConfirm("go-live")}>
                  Go live
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        <MarketScopeCard marketScope={marketScope} isLive={isLive} />

        {syntheticPublishedCount > 0 ? (
          isLive ? (
            <Banner
              tone="critical"
              title={
                syntheticPublishedCount === 1
                  ? "1 synthetic test review is visible to real shoppers — delete it before customers see it."
                  : `${syntheticPublishedCount} synthetic test reviews are visible to real shoppers — delete them before customers see them.`
              }
              action={{ content: "Open QA data", url: "/app/qa-generator" }}
            >
              <Text as="p">
                Synthetic reviews look completely real in the widget and are labeled only in
                this admin. Delete every batch on the QA data page — product ratings
                recalculate automatically.
              </Text>
            </Banner>
          ) : (
            <Banner
              tone="info"
              title={`${pluralize(syntheticPublishedCount, "synthetic test review")} ${
                syntheticPublishedCount === 1 ? "is" : "are"
              } published.`}
              action={{ content: "Open QA data", url: "/app/qa-generator" }}
            >
              <Text as="p">
                Store visitors can't see them while the widget is not live. Once live they
                look completely real to shoppers — delete every batch on the QA data page
                before you go live.
              </Text>
            </Banner>
          )
        ) : null}

        {!setupComplete ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Get started with Cellexia Reviews
              </Text>
              <SetupStep
                index={1}
                text="Add the Cellexia Reviews block to your product template in the theme editor."
                done={false}
                action={
                  <Button url={themeEditorUrl} external>
                    Open theme editor
                  </Button>
                }
              />
              <Divider />
              <SetupStep
                index={2}
                text="Add your Anthropic API key to enable AI summaries and review translation."
                done={setup.hasAiKey}
                action={<Button url="/app/settings">Open settings</Button>}
              />
              <Divider />
              <SetupStep
                index={3}
                text="Moderate your first reviews so they appear on your storefront."
                done={setup.hasModerated}
                action={<Button url="/app/reviews">Go to reviews</Button>}
              />
              <Divider />
              <SetupStep
                index={4}
                text="Preview, then go live — check the widget on your live theme, then make it visible to visitors."
                done={isLive}
                action={
                  <InlineStack gap="200">
                    <PreviewMenu previewUrls={previewUrls}>Preview</PreviewMenu>
                    {!isLive ? (
                      <Button variant="primary" onClick={() => setLiveConfirm("go-live")}>
                        Go live
                      </Button>
                    ) : null}
                  </InlineStack>
                }
              />
            </BlockStack>
          </Card>
        ) : null}

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <StatCard
            label="Average rating"
            value={stats.average != null ? stats.average.toFixed(1) : "—"}
            extra={
              stats.average != null ? <StarRating rating={stats.average} size={16} /> : undefined
            }
          />
          <StatCard label="Total reviews" value={String(stats.totalReviews)} />
          <StatCard label="Pending moderation" value={String(stats.pendingCount)} />
          <StatCard label="Published this month" value={String(stats.publishedThisMonth)} />
        </InlineGrid>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Needs attention
              </Text>
              <Button url="/app/reviews?tab=pending" variant="plain">
                View all pending
              </Button>
            </InlineStack>
            {needsAttention.length === 0 ? (
              <Text as="p" tone="subdued">
                You are all caught up — no reviews are waiting for moderation.
              </Text>
            ) : (
              <BlockStack gap="0">
                {needsAttention.map((review, i) => (
                  <BlockStack gap="0" key={review.id}>
                    {i > 0 ? <Divider /> : null}
                    <AttentionRow review={review} />
                  </BlockStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Products
            </Text>
            {products.length === 0 ? (
              <Text as="p" tone="subdued">
                No published reviews yet. Once reviews are approved they are grouped by product
                here.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text"]}
                headings={["Product", "Average", "Reviews", "Last review", "AI summary"]}
                rows={productRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Go live — shows the current storefront-connection summary and demands
          an explicit "Go live anyway" when a check failed (SPEC-1.6 §5). */}
      <Modal
        open={liveConfirm === "go-live"}
        onClose={closeLiveConfirm}
        title="Go live?"
        primaryAction={{
          content: hasFailedChecks ? "Go live anyway" : "Go live",
          destructive: hasFailedChecks,
          loading: liveBusy,
          onAction: () => liveFetcher.submit({ intent: "go-live" }, { method: "post" }),
        }}
        secondaryActions={[
          { content: "Cancel", onAction: closeLiveConfirm, disabled: liveBusy },
          ...(report && overall !== "pass"
            ? [
                {
                  content: "Run test again",
                  onAction: runHealthCheck,
                  loading: healthRunning,
                  disabled: liveBusy,
                },
              ]
            : []),
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {marketScope.liveScope === "markets" && marketScope.liveMarkets.length > 0 ? (
              <Text as="p">
                You are going live in <strong>{marketScope.liveMarkets.join(", ")}</strong>{" "}
                only. Every other market keeps Stamped and sees no change at all.
              </Text>
            ) : (
              <Text as="p">Make Cellexia Reviews visible to all store visitors?</Text>
            )}
            {report ? (
              overall === "pass" ? (
                <Banner tone="success" title="Storefront connection verified">
                  <Text as="p">
                    All {healthChecks.length} checks passed on{" "}
                    {formatDateTime(report.ranAt)}.
                  </Text>
                </Banner>
              ) : (
                <Banner
                  tone={overall === "fail" ? "critical" : "warning"}
                  title={
                    hasFailedChecks
                      ? `${pluralize(failedChecks.length, "storefront check")} failed`
                      : `${pluralize(warnChecks.length, "storefront check")} ${
                          warnChecks.length === 1 ? "needs" : "need"
                        } a look`
                  }
                >
                  <BlockStack gap="200">
                    <BlockStack gap="050">
                      {[...failedChecks, ...warnChecks].slice(0, 4).map((check, index) => (
                        <Text as="p" variant="bodySm" key={`gl-${index}`}>
                          {check.status === "fail" ? "Failed" : "Warning"}: {check.label}
                          {check.detail ? ` — ${check.detail}` : ""}
                        </Text>
                      ))}
                    </BlockStack>
                    <Text as="p" variant="bodySm">
                      {hasFailedChecks
                        ? "Going live now can leave shoppers with no reviews at all. Fix the failed checks first, or confirm with “Go live anyway”."
                        : "These are warnings, not blockers — you can go live."}
                    </Text>
                  </BlockStack>
                </Banner>
              )
            ) : healthRunning ? (
              <InlineStack gap="200" blockAlign="center">
                <Spinner
                  size="small"
                  accessibilityLabel="Testing the storefront connection"
                />
                <Text as="span" variant="bodySm">
                  Checking the storefront connection…
                </Text>
              </InlineStack>
            ) : (
              <Banner
                tone="warning"
                title="The storefront connection has not been tested yet"
              >
                <Button variant="plain" onClick={runHealthCheck}>
                  Run the test now
                </Button>
              </Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
      <ConfirmationModal
        open={liveConfirm === "go-offline"}
        title="Switch off the review widget?"
        message="Hide the review widget from all store visitors? Your data is kept."
        confirmLabel="Switch off"
        loading={liveBusy}
        onConfirm={() => liveFetcher.submit({ intent: "go-offline" }, { method: "post" })}
        onCancel={closeLiveConfirm}
      />
    </Page>
  );
}
