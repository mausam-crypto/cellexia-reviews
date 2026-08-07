/**
 * Cellexia Reviews — QA data page (SPEC-1.4 §C, reworked by SPEC-1.7 §5):
 * synthetic review generator with background jobs and cost/time estimates.
 *
 * Layout:
 *   1. Permanent warning banner (synthetic reviews look completely real).
 *   2. Fail-fast banner when the AI provider is off / the key is missing.
 *   3. Config card — every knob: product (resourcePicker with a Select
 *      fallback), number of reviews (uncapped since v1.7), target average
 *      rating (with a live distribution preview), verified %, languages
 *      (with a per-language share editor when more than one is selected —
 *      SPEC-1.10 §2), replies %, max helpful votes, date range, variants
 *      toggle (with a per-variant share editor incl. a "No variant" row —
 *      SPEC-1.10 §3), structured-attributes toggle, status at creation.
 *      Share editors prefill (even split / the default variant weighting),
 *      show a live "Total: N%" with a ±1 tolerance, and ship
 *      languageWeights / variantWeights in the config; the server normalizes
 *      them to exact counts by largest remainder. Next to Generate sits
 *      an optional "Estimate cost" button that renders an inline banner with
 *      token counts, USD and an "about X minutes" duration (auto-refreshed,
 *      debounced 600 ms, when the review count changes while an estimate is
 *      showing). Counts above 500 show an inline warning; counts above 5000
 *      require a typed re-confirmation in a submit modal.
 *   4. "More products in this launch" card (SPEC-1.26 §2) — the config card
 *      doubles as product 1 + the shared settings; each extra row carries a
 *      product picker and ONLY the per-product overrides (count, average,
 *      verified %, replies %, dates, variants toggle), prefilled from the
 *      main form when added. With at least one row, Estimate/Generate submit
 *      estimate-multi / generate-multi with the whole launch; without rows
 *      the single-product paths run unchanged.
 *   5. Generate enqueues a background job and returns immediately ("Generation
 *      started — you can leave this page"); the form stays filled so a second,
 *      different job can be launched right away. The job runner lives in
 *      app/services/jobs.server.ts (SPEC-1.7 §3).
 *   6. "Generation jobs" card — IndexTable of the 50 newest jobs with status
 *      badge, progress, live ETA / elapsed time, actual cost, and Cancel /
 *      Retry remaining / View reviews / Delete batch row actions. Polls
 *      /app/jobs/status every 3 s while a job is active, 30 s otherwise.
 *   7. "Existing synthetic data" card: per-batch stats with View in Reviews /
 *      Delete batch, plus Delete ALL with a typed "DELETE" confirmation.
 *      Deleting a batch also cancels + deletes its generation job row
 *      (SPEC-1.7 §7).
 *
 * All structured review fields are assigned by code in synthetic.server.ts;
 * the AI writes only title/body/reply. Rows carry isSynthetic / source /
 * syntheticBatchId / syntheticGeneratedAt — admin-only columns that are never
 * serialized to the storefront.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate, useRevalidator } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  DataTable,
  Divider,
  FormLayout,
  IndexTable,
  InlineError,
  InlineStack,
  Layout,
  Modal,
  Page,
  ProgressBar,
  RangeSlider,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import { SHOP_LOCALES } from "~/types/cellexia";
import type { EstimateDTO } from "~/types/cellexia";
import prisma from "~/db.server";
import { getSettings } from "~/services/settings.server";
import {
  MAX_SYNTHETIC_REVIEWS,
  deleteAllSynthetic,
  deleteSyntheticBatch,
  parseSyntheticConfig,
  syntheticProductIds,
  syntheticStats,
} from "~/services/synthetic.server";
import type { SyntheticStats } from "~/services/synthetic.server";
import {
  enqueueGeneration,
  kickRunner,
  listJobs,
  requestCancel,
  retryJob,
} from "~/services/jobs.server";
import { estimateGeneration } from "~/services/estimate.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { useResultToast } from "~/components/admin/useResultToast";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import {
  LOCALE_LABELS,
  formatDate,
  formatDateTime,
  pluralize,
} from "~/components/admin/labels";
import {
  formatCount,
  formatEta,
  formatUsd,
  humanDuration,
  isActiveJobStatus,
  normalizeJobList,
  useActiveJobsPoll,
} from "~/components/admin/GenerationActivityBar";
import type { JobView } from "~/components/admin/GenerationActivityBar";

const NO_AI_KEY_MESSAGE =
  "The generator needs the Anthropic API key from Settings → AI Summary";

/** Above this count the UI shows an inline cost/duration warning (SPEC-1.7 §2). */
const LARGE_BATCH_WARNING_THRESHOLD = 500;
/** Above this count the submit modal requires a typed re-confirmation (SPEC-1.7 §2). */
const LARGE_BATCH_CONFIRM_THRESHOLD = 5000;
/**
 * Client-side MIRROR of MAX_SYNTHETIC_REVIEWS in synthetic.server.ts (a
 * .server constant cannot be used in the browser bundle — keep in sync): the
 * generator's defensive per-job ceiling. Counts above it are rejected with a
 * validation error here and in the action, instead of being silently clamped
 * by parseSyntheticConfig — the merchant must never confirm a number the job
 * won't actually target (estimate honesty).
 */
const MAX_REVIEWS_PER_JOB = 100_000;
const MAX_REVIEWS_MESSAGE = "The generator supports up to 100,000 reviews per job";
/**
 * Purely a guard for the client-side distribution *preview* math (which walks
 * counts one step at a time): the generator itself is uncapped since v1.7.
 * Above this, the preview still shows correct proportions — just computed on
 * a scaled-down sample.
 */
const PREVIEW_MAX_COUNT = 100_000;

/* ------------------------------------------------------------------------- *
 * Server helpers
 * ------------------------------------------------------------------------- */

const PRODUCTS_QUERY = `#graphql
  query CellexiaQaProducts {
    products(first: 100, sortKey: TITLE) {
      nodes {
        id
        title
        handle
      }
    }
  }
`;

const PRODUCT_CONTEXT_QUERY = `#graphql
  query CellexiaQaProductContext($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      productType
      tags
      variants(first: 100) {
        nodes {
          title
        }
      }
    }
  }
`;

function numericIdFromGid(gid: unknown): string | null {
  if (typeof gid !== "string") return null;
  const match = gid.match(/\/Product\/(\d+)$/) ?? gid.match(/^(\d+)$/);
  return match ? match[1] : null;
}

/** descriptionHtml → plain text for the AI context (truncated to 4000). */
function htmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, 4000);
}

/**
 * Loose structural check for a client-echoed EstimateDTO (the DTO the
 * "Estimate cost" action returned earlier, threaded back on Generate so the
 * job row can record what the merchant saw). Anything malformed is dropped —
 * the estimate is informational and never drives generation.
 */
function parseEstimateInput(raw: string): EstimateDTO | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.inputTokens !== "number" ||
      typeof v.outputTokens !== "number" ||
      typeof v.costUsd !== "number" ||
      typeof v.seconds !== "number"
    ) {
      return null;
    }
    return value as EstimateDTO;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Loader
 * ------------------------------------------------------------------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // The jobs card is rendered here, so this loader also keeps the background
  // runner alive (idempotent, SPEC-1.7 §3).
  try {
    kickRunner();
  } catch (error) {
    console.error("[cellexia] qa-generator kickRunner failed", error);
  }

  // AI readiness drives the fail-fast banner; a settings hiccup must not
  // crash the page — it just reads as "not ready".
  let aiReady = false;
  try {
    const settings = await getSettings(shop);
    aiReady = settings.aiProvider === "anthropic" && Boolean(settings.anthropicApiKey);
  } catch (error) {
    console.error("[cellexia] qa-generator settings lookup failed", error);
  }

  const stats = await syntheticStats(shop); // never throws

  let jobs: Awaited<ReturnType<typeof listJobs>> = [];
  try {
    jobs = await listJobs(shop); // newest 50
  } catch (error) {
    console.error("[cellexia] qa-generator job list failed", error);
  }

  // Fallback product list for when the resource picker is unavailable.
  let products: Array<{ id: string; title: string; handle: string | null }> = [];
  let productListError = false;
  try {
    const response = await admin.graphql(PRODUCTS_QUERY);
    const body = (await response.json()) as {
      data?: {
        products?: {
          nodes?: Array<{ id?: string; title?: string; handle?: string | null }>;
        };
      };
      errors?: unknown;
    };
    if (body.errors) {
      console.error("[cellexia] qa-generator product list errors:", body.errors);
      productListError = true;
    } else {
      products = (body.data?.products?.nodes ?? [])
        .map((node) => {
          const id = numericIdFromGid(node?.id);
          if (!id || typeof node?.title !== "string") return null;
          return { id, title: node.title, handle: node.handle ?? null };
        })
        .filter((p): p is { id: string; title: string; handle: string | null } => p !== null);
    }
  } catch (error) {
    console.error("[cellexia] qa-generator product list failed", error);
    productListError = true;
  }

  return json({ aiReady, stats, jobs, products, productListError });
};

/* ------------------------------------------------------------------------- *
 * Action
 * ------------------------------------------------------------------------- */

/** Shops with a generate-multi currently between validation and enqueue. */
const multiLaunchInFlight = new Set<string>();

/**
 * The estimate the merchant SAW for one product of the launch, sent back by
 * the client purely as the job row's audit trail — display data, exactly the
 * trust model of the single path's `estimate` field.
 */
function estimateForProduct(rawLaunch: unknown, productId: string): EstimateDTO | null {
  if (typeof rawLaunch !== "object" || rawLaunch === null) return null;
  const estimates = (rawLaunch as { estimates?: unknown }).estimates;
  if (typeof estimates !== "object" || estimates === null) return null;
  const entry = (estimates as Record<string, unknown>)[productId];
  if (!entry) return null;
  return parseEstimateInput(JSON.stringify(entry));
}

/** SPEC-1.26 §1: the one product-context fetch, shared by single and multi. */
async function fetchGeneratorProductContext(
  admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
  productId: string,
): Promise<
  | {
      id: string;
      title: string;
      handle: string | null;
      description: string;
      productType: string | null;
      tags: string[];
      variants: string[];
    }
  | null
  | "error"
> {
  const response = await admin.graphql(PRODUCT_CONTEXT_QUERY, {
    variables: { id: `gid://shopify/Product/${productId}` },
  });
  const body = (await response.json()) as {
    data?: {
      product?: {
        id?: string;
        title?: string;
        handle?: string | null;
        descriptionHtml?: string | null;
        productType?: string | null;
        tags?: unknown;
        variants?: { nodes?: Array<{ title?: string | null }> };
      } | null;
    };
    errors?: unknown;
  };
  if (body.errors) {
    // THROTTLED/transient GraphQL errors are not "product deleted" — the
    // multi path fetches up to 20 products in one request and must tell the
    // merchant to retry, not to go looking for a product that exists.
    console.error("[cellexia] qa-generator product context errors:", body.errors);
    return "error";
  }
  if (!body.data?.product) return null;
  const product = body.data.product;
  const variants = (product.variants?.nodes ?? [])
    .map((node) => (typeof node?.title === "string" ? node.title.trim() : ""))
    .filter((title) => title && title !== "Default Title");
  const tags = Array.isArray(product.tags)
    ? product.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  return {
    id: productId,
    title: typeof product.title === "string" ? product.title : `Product ${productId}`,
    handle: typeof product.handle === "string" ? product.handle : null,
    description: htmlToText(product.descriptionHtml),
    productType:
      typeof product.productType === "string" && product.productType.trim()
        ? product.productType.trim()
        : null,
    tags: tags.slice(0, 25),
    variants,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    console.error("[cellexia] qa-generator form parse failed", error);
    return json(
      { ok: false, message: "The request could not be read. Please try again." },
      { status: 400 },
    );
  }
  const intent = String(form.get("intent") ?? "");

  try {
    /* ---- Product context for the AI (title/description/variants/…) ------ */
    if (intent === "product-context") {
      const productId = numericIdFromGid(String(form.get("productId") ?? ""));
      if (!productId) {
        return json({ ok: false, intent, message: "Invalid product reference" }, { status: 400 });
      }
      const product = await fetchGeneratorProductContext(admin, productId);
      if (product === "error") {
        return json(
          { ok: false, intent, message: "Shopify did not answer — try again in a moment" },
          { status: 502 },
        );
      }
      if (!product) {
        return json(
          { ok: false, intent, message: "The product could not be loaded" },
          { status: 404 },
        );
      }
      return json({ ok: true, intent, product });
    }

    /* ---- Multi-product launch (SPEC-1.26) ------------------------------- */
    if (intent === "estimate-multi" || intent === "generate-multi") {
      let rawLaunch: unknown = null;
      try {
        rawLaunch = JSON.parse(String(form.get("launch") ?? ""));
      } catch {
        return json(
          { ok: false, intent, message: "The launch configuration could not be parsed" },
          { status: 400 },
        );
      }
      const { parseMultiLaunch, assembleLaunchConfig } = await import("~/services/synthetic.server");
      const launch = parseMultiLaunch(rawLaunch);
      if (!launch.input) {
        return json({ ok: false, intent, message: launch.error }, { status: 400 });
      }

      if (intent === "generate-multi") {
        try {
          const settings = await getSettings(shop);
          if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) {
            return json(
              { ok: false, intent, code: "no_ai_key", message: NO_AI_KEY_MESSAGE },
              { status: 409 },
            );
          }
        } catch (error) {
          console.error("[cellexia] qa-generator settings lookup failed", error);
          return json(
            { ok: false, intent, message: "Settings could not be loaded. Please try again." },
            { status: 500 },
          );
        }
      }

      // Double-submit guard, taken BEFORE the validation pass: 20 context
      // fetches hold this request open for seconds, exactly when a second
      // click or an impatient refresh lands — which would launch everything
      // twice. estimate-multi is read-only and stays unguarded.
      if (intent === "generate-multi") {
        if (multiLaunchInFlight.has(shop)) {
          return json(
            { ok: false, intent, message: "This launch is already being started — give it a moment." },
            { status: 409 },
          );
        }
        multiLaunchInFlight.add(shop);
      }
      try {
      // ALL-OR-NOTHING (SPEC-1.26 §0): every product validates — context
      // fetch included — before a single job is queued. Errors name the row.
      const prepared: Array<{
        config: NonNullable<ReturnType<typeof parseSyntheticConfig>["config"]>;
        title: string;
      }> = [];
      for (const [i, row] of launch.input.rows.entries()) {
        const context = await fetchGeneratorProductContext(admin, row.productId);
        if (context === "error") {
          return json(
            {
              ok: false,
              intent,
              message: `Shopify did not answer while loading product ${i + 1} — usually temporary, try again. Nothing was started.`,
            },
            { status: 502 },
          );
        }
        if (!context) {
          return json(
            {
              ok: false,
              intent,
              message: `Product ${i + 1} could not be loaded from Shopify — it may have been deleted. Nothing was started.`,
            },
            { status: 400 },
          );
        }
        const parsed = assembleLaunchConfig(launch.input, row, context);
        if (!parsed.config) {
          return json(
            {
              ok: false,
              intent,
              message: `${context.title}: ${parsed.error}. Nothing was started.`,
            },
            { status: 400 },
          );
        }
        prepared.push({ config: parsed.config, title: context.title });
      }

      if (intent === "estimate-multi") {
        const perProduct: Array<{ title: string; productId: string; estimate: EstimateDTO }> = [];
        let reviews = 0;
        let costUsd = 0;
        let seconds = 0;
        let secondsHigh = 0;
        for (const item of prepared) {
          const estimate = await estimateGeneration(shop, admin, item.config);
          perProduct.push({ title: item.title, productId: item.config.productId, estimate });
          reviews += estimate.reviews;
          costUsd += estimate.costUsd;
          // Jobs queue behind each other; summed time is the honest ceiling.
          seconds += estimate.seconds;
          secondsHigh += estimate.secondsHigh;
        }
        return json({
          ok: true,
          intent,
          total: { reviews, costUsd, seconds, secondsHigh, products: prepared.length },
          perProduct,
        });
      }

      const startedJobs: Array<{ jobId: string; batchId: string; title: string }> = [];
      try {
        for (const item of prepared) {
          const job = await enqueueGeneration(shop, item.config, estimateForProduct(rawLaunch, item.config.productId));
          startedJobs.push({ jobId: job.id, batchId: job.batchId, title: item.title });
        }
      } catch (error) {
        // HONEST partial reporting: some jobs may already be queued. Saying
        // "failed, try again" here would invite a retry that duplicates them.
        console.error("[cellexia] generate-multi enqueue failed mid-launch", error);
        if (startedJobs.length > 0) {
          kickRunner();
          return json(
            {
              ok: false,
              intent,
              jobs: startedJobs,
              message: `Started ${startedJobs.length} of ${prepared.length} jobs (${startedJobs
                .map((j) => j.title)
                .join(", ")}), then hit an error. Those jobs ARE running — do not relaunch them. Start a new launch with only the remaining products.`,
            },
            { status: 500 },
          );
        }
        return json(
          { ok: false, intent, message: "The launch could not be started — nothing was queued. Try again." },
          { status: 500 },
        );
      }
      kickRunner();
      const totalReviews = prepared.reduce((sum, p) => sum + p.config.count, 0);
      return json({
        ok: true,
        intent,
        jobs: startedJobs,
        message: `${startedJobs.length} generation job(s) started — ${totalReviews} reviews across ${startedJobs.length} product(s). You can leave this page.`,
      });
      } finally {
        if (intent === "generate-multi") multiLaunchInFlight.delete(shop);
      }
    }

    /* ---- Cost & time estimate (optional, pre-generation) ---------------- */
    if (intent === "estimate") {
      let rawConfig: unknown = null;
      try {
        rawConfig = JSON.parse(String(form.get("config") ?? ""));
      } catch {
        return json(
          { ok: false, intent, message: "The generator configuration could not be parsed" },
          { status: 400 },
        );
      }
      const parsed = parseSyntheticConfig(rawConfig);
      if (!parsed.config) {
        return json({ ok: false, intent, message: parsed.error }, { status: 400 });
      }
      try {
        const estimate = await estimateGeneration(shop, admin, parsed.config);
        return json({ ok: true, intent, estimate });
      } catch (error) {
        console.error("[cellexia] qa-generator estimate failed", error);
        return json(
          { ok: false, intent, message: "The estimate could not be computed. Please try again." },
          { status: 500 },
        );
      }
    }

    /* ---- Enqueue a background generation job (SPEC-1.7 §3/§5) ----------- */
    if (intent === "generate") {
      let rawConfig: unknown = null;
      try {
        rawConfig = JSON.parse(String(form.get("config") ?? ""));
      } catch {
        return json(
          { ok: false, intent, message: "The generator configuration could not be parsed" },
          { status: 400 },
        );
      }
      // Estimate honesty: parseSyntheticConfig CLAMPS count to
      // MAX_SYNTHETIC_REVIEWS as an OOM guard, so an over-limit request must
      // be rejected here — otherwise the merchant confirms one number and the
      // job silently targets a smaller one. (The form validates this too;
      // this is the server-side backstop.)
      const rawCount = Number((rawConfig as { count?: unknown } | null)?.count);
      if (Number.isFinite(rawCount) && rawCount > MAX_SYNTHETIC_REVIEWS) {
        return json(
          {
            ok: false,
            intent,
            message: `The generator supports up to ${MAX_SYNTHETIC_REVIEWS.toLocaleString("en-US")} reviews per job`,
          },
          { status: 400 },
        );
      }
      const parsed = parseSyntheticConfig(rawConfig);
      if (!parsed.config) {
        return json({ ok: false, intent, message: parsed.error }, { status: 400 });
      }

      // Fail fast — no AI key means no generation at all (no template fallback).
      try {
        const settings = await getSettings(shop);
        if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) {
          return json(
            { ok: false, intent, code: "no_ai_key", message: NO_AI_KEY_MESSAGE },
            { status: 409 },
          );
        }
      } catch (error) {
        console.error("[cellexia] qa-generator settings lookup failed", error);
        return json(
          { ok: false, intent, message: "Settings could not be loaded. Please try again." },
          { status: 500 },
        );
      }

      // The estimate is optional (Generate never requires pressing Estimate);
      // when the client had one on screen it is recorded on the job row.
      const estimate = parseEstimateInput(String(form.get("estimate") ?? ""));
      const job = await enqueueGeneration(shop, parsed.config, estimate);
      kickRunner();
      return json({
        ok: true,
        intent,
        jobId: job.id,
        batchId: job.batchId,
        message: "Generation started — you can leave this page",
      });
    }

    /* ---- Cancel a queued/running job (cooperative, SPEC-1.7 §3) ---------- */
    if (intent === "cancel-job") {
      const jobId = String(form.get("jobId") ?? "").trim();
      if (!jobId) {
        return json({ ok: false, intent, message: "Missing job reference" }, { status: 400 });
      }
      await requestCancel(shop, jobId);
      return json({
        ok: true,
        intent,
        message: "Cancellation requested — the job stops after its current chunk",
      });
    }

    /* ---- Retry the remaining reviews of a failed/cancelled job ----------- */
    if (intent === "retry-job") {
      const jobId = String(form.get("jobId") ?? "").trim();
      if (!jobId) {
        return json({ ok: false, intent, message: "Missing job reference" }, { status: 400 });
      }
      const job = await retryJob(shop, jobId);
      kickRunner();
      return json({
        ok: true,
        intent,
        jobId: job.id,
        message: "Retry queued — the remaining reviews will be generated",
      });
    }

    /* ---- Delete one batch (also cancels + deletes its job, SPEC-1.7 §7) -- */
    if (intent === "delete-batch") {
      const batchId = String(form.get("batchId") ?? "").trim();
      if (!batchId) {
        return json({ ok: false, intent, message: "Missing batch reference" }, { status: 400 });
      }

      // Cancel any active job writing this batch before deleting its rows.
      // NOTE: a RUNNING job's in-flight chunk may still land a few reviews
      // after the delete — the batch then reappears in the stats table and
      // can simply be deleted again (cooperative cancellation, SPEC-1.7 §3).
      let jobRows: Array<{ id: string; status: string }> = [];
      try {
        jobRows = await prisma.generationJob.findMany({
          where: { shop, batchId },
          select: { id: true, status: true },
        });
      } catch (error) {
        console.error("[cellexia] qa-generator job lookup failed", error);
      }
      for (const jobRow of jobRows) {
        if (jobRow.status === "QUEUED" || jobRow.status === "RUNNING") {
          try {
            await requestCancel(shop, jobRow.id);
          } catch (error) {
            console.error(`[cellexia] qa-generator cancel failed for job ${jobRow.id}`, error);
          }
        }
      }

      const productIds = await syntheticProductIds(shop, batchId);
      const deleted = await deleteSyntheticBatch(shop, batchId);

      // Prune this batch's FINISHED job rows only. CRITICAL: never delete a
      // QUEUED/RUNNING row here — the worker observes `cancelRequested`
      // through its per-chunk progress write on that SAME row
      // (jobs.server.ts), so deleting it would let the job keep generating
      // (and spending) through every remaining chunk into the just-deleted
      // batch. The cancelled RUNNING row stays until the worker stops after
      // its in-flight chunk (deleteSyntheticBatch already performs the same
      // cancel-then-delete-terminal dance; this is a best-effort second pass
      // for rows that turned terminal in the meantime).
      try {
        await prisma.generationJob.deleteMany({
          where: { shop, batchId, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
        });
      } catch (error) {
        console.error("[cellexia] qa-generator job row delete failed", error);
      }

      let syncFailures = 0;
      for (const productId of productIds) {
        try {
          await syncProductData(shop, productId, admin);
        } catch (error) {
          syncFailures += 1;
          console.error(`[cellexia] qa-generator sync failed for ${productId}`, error);
        }
      }
      const message =
        deleted === 0
          ? jobRows.length > 0
            ? "The generation job was removed"
            : "This batch no longer exists"
          : syncFailures > 0
            ? `Deleted ${pluralize(deleted, "synthetic review")} — the product rating sync failed for ${pluralize(syncFailures, "product")}`
            : `Deleted ${pluralize(deleted, "synthetic review")}`;
      return json({ ok: true, intent, deleted, message });
    }

    /* ---- Delete ALL synthetic reviews (typed confirmation) --------------- */
    if (intent === "delete-all") {
      if (String(form.get("confirm") ?? "") !== "DELETE") {
        return json(
          { ok: false, intent, message: "Type DELETE to confirm removing all synthetic reviews" },
          { status: 400 },
        );
      }

      // Every batch's job row goes with it (SPEC-1.7 §7 applied per batch):
      // cancel the active jobs first, then remove the FINISHED job history for
      // the shop (cancelled RUNNING rows stay until their workers observe the
      // cancel and stop — see the delete-batch handler).
      try {
        const activeJobs = await prisma.generationJob.findMany({
          where: { shop, status: { in: ["QUEUED", "RUNNING"] } },
          select: { id: true },
        });
        for (const jobRow of activeJobs) {
          try {
            await requestCancel(shop, jobRow.id);
          } catch (error) {
            console.error(`[cellexia] qa-generator cancel failed for job ${jobRow.id}`, error);
          }
        }
      } catch (error) {
        console.error("[cellexia] qa-generator active job lookup failed", error);
      }

      const productIds = await syntheticProductIds(shop);
      const deleted = await deleteAllSynthetic(shop);

      // Terminal statuses only — deleting a RUNNING row would remove the very
      // row that carries the cooperative-cancel flag and let its job keep
      // generating (and spending) to completion (see the delete-batch handler).
      try {
        await prisma.generationJob.deleteMany({
          where: { shop, status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
        });
      } catch (error) {
        console.error("[cellexia] qa-generator job rows delete failed", error);
      }

      let syncFailures = 0;
      for (const productId of productIds) {
        try {
          await syncProductData(shop, productId, admin);
        } catch (error) {
          syncFailures += 1;
          console.error(`[cellexia] qa-generator sync failed for ${productId}`, error);
        }
      }
      const message =
        deleted === 0
          ? "There were no synthetic reviews to delete"
          : syncFailures > 0
            ? `Deleted all ${pluralize(deleted, "synthetic review")} — the product rating sync failed for ${pluralize(syncFailures, "product")}`
            : `Deleted all ${pluralize(deleted, "synthetic review")}`;
      return json({ ok: true, intent, deleted, message });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[cellexia] qa-generator action failed", error);
    return json(
      { ok: false, intent, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

/* ------------------------------------------------------------------------- *
 * Client helpers
 * ------------------------------------------------------------------------- */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * MIRROR of VARIANT_NONE_KEY in synthetic.server.ts (a .server constant
 * cannot be used in the browser bundle — keep in sync): the reserved
 * variantWeights key for the "No variant" editor row (SPEC-1.10 §3).
 */
const VARIANT_NONE_KEY = "__none__";

/** Share editors accept totals of 100 ± this tolerance (SPEC-1.10 §2/§3). */
const SHARE_TOTAL_TOLERANCE = 1;

/**
 * Integer percentages summing to exactly 100 — even split with the leftover
 * points handed to the first slots (largest remainder for equal weights).
 * Prefill for the language share editor (SPEC-1.10 §2).
 */
function evenSplitPercents(count: number): number[] {
  const base = Math.floor(100 / count);
  const leftover = 100 - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < leftover ? 1 : 0));
}

/**
 * Prefill for the variant share editor (SPEC-1.10 §3), mirroring the
 * pre-1.10 default weighting: ~22% of reviews get no variant, the rest
 * spreads across the real variants. Returns [noVariant, ...variants],
 * integers summing to exactly 100.
 */
function defaultVariantPercents(variantCount: number): number[] {
  const none = 22;
  const rest = 100 - none;
  const base = Math.floor(rest / variantCount);
  const leftover = rest - base * variantCount;
  return [none, ...Array.from({ length: variantCount }, (_, i) => base + (i < leftover ? 1 : 0))];
}

/** Splits `items` into rows of ≤ `size` for FormLayout.Group rendering. */
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/**
 * Sums the share fields for `keys`. `invalid` = any missing/blank field or a
 * non-numeric/negative value (the live total still reflects the parseable
 * entries so the merchant sees what the editor currently adds up to).
 */
function sharesTotal(
  shares: Record<string, string>,
  keys: readonly string[],
): { total: number; invalid: boolean } {
  let total = 0;
  let invalid = false;
  for (const key of keys) {
    const raw = (shares[key] ?? "").trim();
    if (raw === "") {
      invalid = true;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      invalid = true;
      continue;
    }
    total += n;
  }
  return { total, invalid };
}

function shareTotalOk(result: { total: number; invalid: boolean }): boolean {
  return !result.invalid && Math.abs(result.total - 100) <= SHARE_TOTAL_TOLERANCE;
}

/** "Total: N%" formatting — decimals only when the merchant typed some. */
function formatShareTotal(total: number): string {
  const rounded = Math.round(total * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * MIRROR of `deriveStarDistribution` in app/services/synthetic.server.ts for
 * the live client-side "Distribution preview" (a .server module cannot be
 * imported into the browser bundle, and file ownership forbids a shared
 * module). The function is fully deterministic, so preview === generation.
 * Keep both implementations in sync.
 */
const PREVIEW_ANCHORS: ReadonlyArray<readonly [number, readonly number[]]> = [
  [1.19, [88, 8, 2, 1, 1]],
  [1.66, [62, 22, 8, 4, 4]],
  [2.19, [38, 30, 15, 9, 8]],
  [3.02, [14, 18, 34, 20, 14]],
  [3.6, [8, 10, 22, 34, 26]],
  [4.14, [5, 5, 12, 27, 51]],
  [4.52, [3, 2, 7, 16, 72]],
  [4.74, [2, 1, 3, 9, 85]],
  [4.98, [0, 0, 0, 2, 98]],
];

function previewStarDistribution(count: number, targetAverage: number): number[] {
  const n = Math.max(1, Math.min(PREVIEW_MAX_COUNT, Math.round(count)));
  const avg = Math.min(5, Math.max(1, targetAverage));

  let lower = PREVIEW_ANCHORS[0];
  let upper = PREVIEW_ANCHORS[PREVIEW_ANCHORS.length - 1];
  for (let i = 0; i < PREVIEW_ANCHORS.length - 1; i += 1) {
    if (avg >= PREVIEW_ANCHORS[i][0] && avg <= PREVIEW_ANCHORS[i + 1][0]) {
      lower = PREVIEW_ANCHORS[i];
      upper = PREVIEW_ANCHORS[i + 1];
      break;
    }
  }
  if (avg < PREVIEW_ANCHORS[0][0]) upper = lower;
  const spanMean = upper[0] - lower[0];
  const t = spanMean > 0 ? Math.min(1, Math.max(0, (avg - lower[0]) / spanMean)) : 0;
  const shape = lower[1].map((p, i) => p + (upper[1][i] - p) * t);

  const shapeTotal = shape.reduce((a, b) => a + b, 0) || 1;
  const exact = shape.map((p) => (p / shapeTotal) * n);
  const counts = exact.map((x) => Math.floor(x));
  let assigned = counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || b.i - a.i);
  for (const { i } of order) {
    if (assigned >= n) break;
    counts[i] += 1;
    assigned += 1;
  }

  const targetSum = Math.min(5 * n, Math.max(n, Math.round(avg * n)));
  let sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
  const promoteFrom = [3, 2, 1, 0];
  const demoteFrom = [1, 2, 3, 4];
  let guard = 5 * n + 10;
  while (sum < targetSum && guard > 0) {
    guard -= 1;
    const from = promoteFrom.find((i) => counts[i] > 0);
    if (from === undefined) break;
    counts[from] -= 1;
    counts[from + 1] += 1;
    sum += 1;
  }
  while (sum > targetSum && guard > 0) {
    guard -= 1;
    const from = demoteFrom.find((i) => counts[i] > 0);
    if (from === undefined) break;
    counts[from] -= 1;
    counts[from - 1] += 1;
    sum -= 1;
  }
  return counts;
}

interface PickedProduct {
  id: string;
  title: string;
  handle: string | null;
  description: string;
  productType: string | null;
  tags: string[];
  variants: string[];
  /** True once the authoritative context (description etc.) arrived. */
  contextLoaded: boolean;
}

/** Extracts a product from an App Bridge resourcePicker payload. */
function parsePickerSelection(raw: unknown): PickedProduct | null {
  let items: unknown[] | null = null;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    const maybe = (raw as { selection?: unknown }).selection;
    if (Array.isArray(maybe)) items = maybe;
  }
  if (!items || items.length === 0) return null;
  const first = items[0];
  if (typeof first !== "object" || first === null) return null;
  const record = first as Record<string, unknown>;
  const id = numericIdFromGid(record.id);
  if (!id) return null;
  const variants: string[] = [];
  if (Array.isArray(record.variants)) {
    for (const variant of record.variants) {
      const title =
        typeof variant === "object" && variant !== null
          ? (variant as Record<string, unknown>).title
          : null;
      if (typeof title === "string" && title.trim() && title.trim() !== "Default Title") {
        variants.push(title.trim());
      }
    }
  }
  return {
    id,
    title: typeof record.title === "string" ? record.title : `Product ${id}`,
    handle: typeof record.handle === "string" ? record.handle : null,
    description: "",
    productType: null,
    tags: [],
    variants,
    contextLoaded: false,
  };
}

/* ------------------------------------------------------------------------- *
 * Multi-product launch (SPEC-1.26 §2) — client helpers
 * ------------------------------------------------------------------------- */

/**
 * MIRROR of MAX_MULTI_PRODUCTS in synthetic.server.ts (a .server constant
 * cannot be used in the browser bundle — keep in sync): a launch supports at
 * most 20 products, the main form's product included.
 */
const MAX_LAUNCH_PRODUCTS = 20;

/**
 * MIRROR of PER_PRODUCT_KEYS in synthetic.server.ts (keep in sync): the
 * fields a launch may vary per product (SPEC-1.26 §1). The client strips
 * these from the shared settings so the payload states cleanly which values
 * are launch-wide; the server strips them again as a backstop.
 */
const LAUNCH_PER_PRODUCT_KEYS = [
  "count",
  "targetAverage",
  "verifiedPercent",
  "repliesPercent",
  "assignVariants",
  "variantWeights",
  "dateStart",
  "dateEnd",
] as const;

/**
 * Product-context keys the main config carries but a launch's shared
 * settings must not — the server re-fetches every product's context itself
 * (all-or-nothing validation, SPEC-1.26 §0).
 */
const LAUNCH_PRODUCT_CONTEXT_KEYS = [
  "productId",
  "productTitle",
  "productHandle",
  "productDescription",
  "productType",
  "productTags",
  "productVariants",
] as const;

/**
 * One "More products in this launch" row (SPEC-1.26 §2): a product picker
 * plus ONLY the per-product fields, initialized from the main form's current
 * values at the moment the row was added (tweak what differs, leave the
 * rest). variantWeights is deliberately absent — omitting it lets the
 * server's default split apply (a row-level weights editor is v-next).
 */
interface ExtraRowState {
  /** Stable React key — rows can be removed from the middle of the list. */
  key: string;
  product: PickedProduct | null;
  countText: string;
  targetAverage: number;
  verifiedText: string;
  repliesText: string;
  dateStart: string;
  dateEnd: string;
  assignVariants: boolean;
  /** Merchant touched this row's variants checkbox — stop applying defaults. */
  variantsTouched: boolean;
  /**
   * Submit found no product on this row: show the subdued "pick a product or
   * remove the row" hint (a product-less row is skipped, never an error).
   */
  needsProductHint: boolean;
  errors: Record<string, string>;
}

/** Client-side view of the estimate-multi response (SPEC-1.26 §1). */
interface MultiEstimateView {
  total: {
    reviews: number;
    costUsd: number;
    seconds: number;
    secondsHigh: number;
    products: number;
  };
  perProduct: Array<{
    title: string;
    reviews: number;
    costUsd: number;
    /** The per-product estimate's honesty basis (SPEC-1.7 §4). */
    basis: "measured" | "baseline";
  }>;
  /** The estimate caveat, shown once under the totals (SPEC-1.7 §4). */
  caveat: string;
}

function normalizeMultiEstimate(raw: unknown): MultiEstimateView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const totalRaw =
    typeof v.total === "object" && v.total !== null ? (v.total as Record<string, unknown>) : null;
  if (!totalRaw || !Array.isArray(v.perProduct)) return null;
  const reviews = num(totalRaw.reviews);
  const costUsd = num(totalRaw.costUsd);
  const seconds = num(totalRaw.seconds);
  if (reviews === null || costUsd === null || seconds === null) return null;
  const perProduct: MultiEstimateView["perProduct"] = [];
  let caveat: string | null = null;
  for (const item of v.perProduct) {
    if (typeof item !== "object" || item === null) return null;
    const entry = item as Record<string, unknown>;
    const estimate =
      typeof entry.estimate === "object" && entry.estimate !== null
        ? (entry.estimate as Record<string, unknown>)
        : null;
    if (caveat === null && estimate && typeof estimate.caveat === "string" && estimate.caveat) {
      caveat = estimate.caveat;
    }
    perProduct.push({
      title: typeof entry.title === "string" && entry.title ? entry.title : "Untitled product",
      reviews: (estimate ? num(estimate.reviews) : null) ?? 0,
      costUsd: (estimate ? num(estimate.costUsd) : null) ?? 0,
      basis: estimate?.basis === "measured" ? "measured" : "baseline",
    });
  }
  return {
    total: {
      reviews,
      costUsd,
      seconds,
      secondsHigh: num(totalRaw.secondsHigh) ?? seconds,
      products: num(totalRaw.products) ?? perProduct.length,
    },
    perProduct,
    caveat: caveat ?? "Estimate only — actual usage may differ.",
  };
}

/** Client-side view of the EstimateDTO returned by intent=estimate. */
interface EstimateView {
  reviews: number;
  chunks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  seconds: number;
  secondsHigh: number;
  basis: "measured" | "baseline";
  model: string;
  pricing: { inPerMTok: number; outPerMTok: number; introUntil: string | null };
  /** Server-provided basis detail line, when present. */
  detail: string | null;
  /** Server-provided caveat ("estimate only…"), when present. */
  caveat: string | null;
}

function normalizeEstimate(raw: unknown): EstimateView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const inputTokens = num(v.inputTokens);
  const outputTokens = num(v.outputTokens);
  const costUsd = num(v.costUsd);
  const seconds = num(v.seconds);
  if (inputTokens === null || outputTokens === null || costUsd === null || seconds === null) {
    return null;
  }
  const pricingRaw =
    typeof v.pricing === "object" && v.pricing !== null
      ? (v.pricing as Record<string, unknown>)
      : {};
  return {
    reviews: num(v.reviews) ?? 0,
    chunks: num(v.chunks) ?? 0,
    inputTokens,
    outputTokens,
    costUsd,
    seconds,
    secondsHigh: num(v.secondsHigh) ?? seconds,
    basis: v.basis === "measured" ? "measured" : "baseline",
    model: typeof v.model === "string" && v.model ? v.model : "unknown model",
    pricing: {
      inPerMTok: num(pricingRaw.inPerMTok) ?? 0,
      outPerMTok: num(pricingRaw.outPerMTok) ?? 0,
      introUntil: typeof pricingRaw.introUntil === "string" ? pricingRaw.introUntil : null,
    },
    detail: typeof v.detail === "string" && v.detail ? v.detail : null,
    caveat: typeof v.caveat === "string" && v.caveat ? v.caveat : null,
  };
}

/** Whether the Sonnet 5 introductory pricing window still applies (§4). */
function introPricingApplies(introUntil: string | null): boolean {
  if (!introUntil) return false;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(introUntil)
    ? `${introUntil}T23:59:59.999Z`
    : introUntil;
  const until = new Date(iso).getTime();
  return Number.isFinite(until) && Date.now() <= until;
}

/** Subdued second line of the estimate banner: basis · pricing · caveat. */
function estimateSecondLine(view: EstimateView): string {
  const parts: string[] = [];
  parts.push(
    view.detail ??
      (view.basis === "measured"
        ? "Based on this shop's measured generation history"
        : "Based on a token count of one sample batch"),
  );
  let pricing = `${view.model}: $${view.pricing.inPerMTok}/MTok input · $${view.pricing.outPerMTok}/MTok output`;
  if (introPricingApplies(view.pricing.introUntil)) {
    pricing += ` (introductory pricing through ${formatDate(view.pricing.introUntil)})`;
  }
  parts.push(pricing);
  parts.push(view.caveat ?? "Estimate only — actual usage may differ.");
  return parts.join(" · ");
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Wall-clock duration of a finished job, in seconds (null when unknown). */
function elapsedSeconds(job: JobView): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  const start = new Date(job.startedAt).getTime();
  const end = new Date(job.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 1000;
}

function jobTimeText(job: JobView): string {
  if (job.status === "RUNNING") {
    // v1.24: all chunks written but still running = the skeptical
    // double-check is reading the batch.
    if (job.chunksTotal > 0 && job.chunksDone >= job.chunksTotal) {
      return "Double-checking…";
    }
    return job.etaSeconds !== null && job.etaSeconds > 0
      ? `${formatEta(job.etaSeconds)} left`
      : "Starting…";
  }
  if (job.status === "QUEUED") return "Queued";
  const elapsed = elapsedSeconds(job);
  return elapsed !== null ? `${humanDuration(elapsed)}` : "—";
}

function JobStatusBadge({ job }: { job: JobView }) {
  if (isActiveJobStatus(job.status) && job.cancelRequested) {
    return <Badge tone="warning">Cancelling</Badge>;
  }
  switch (job.status) {
    case "QUEUED":
      return <Badge tone="attention">Queued</Badge>;
    case "RUNNING":
      return <Badge tone="info">Running</Badge>;
    case "COMPLETED":
      return <Badge tone="success">Completed</Badge>;
    case "FAILED":
      return <Badge tone="critical">Failed</Badge>;
    case "CANCELLED":
      return <Badge>Cancelled</Badge>;
    default:
      return <Badge>{job.status}</Badge>;
  }
}

/* ------------------------------------------------------------------------- *
 * "More products in this launch" row (SPEC-1.26 §2)
 * ------------------------------------------------------------------------- */

/**
 * One extra product row. Each row owns its OWN product-context fetcher —
 * a fetcher cancels its previous submission on re-submit, so a shared one
 * would drop the first row's context load when two products are picked in
 * quick succession. Product selection mirrors the main form: resourcePicker
 * first, the loader's product list as the fallback when App Bridge exposes
 * no picker. The context fetched here is display-only (title, variant count,
 * the variants checkbox default) — on submit the server re-fetches every
 * product's context itself (SPEC-1.26 §0).
 */
function ExtraLaunchRow({
  row,
  index,
  duplicate,
  products,
  productListError,
  pickerUnavailable,
  onPickerUnavailable,
  onPatch,
  onRemove,
}: {
  row: ExtraRowState;
  index: number;
  duplicate: boolean;
  products: Array<{ id: string; title: string; handle: string | null }>;
  productListError: boolean;
  pickerUnavailable: boolean;
  onPickerUnavailable: () => void;
  onPatch: (key: string, updater: (prev: ExtraRowState) => ExtraRowState) => void;
  onRemove: (key: string) => void;
}) {
  const shopify = useAppBridge();
  const rowContextFetcher = useFetcher<typeof action>();
  const contextLoading = rowContextFetcher.state !== "idle";

  const selectRowProduct = (picked: PickedProduct) => {
    onPatch(row.key, (prev) => ({
      ...prev,
      product: picked,
      // Same default as the main form's selectProduct: variants ON when the
      // product has more than one, re-derived on every product change
      // (SPEC-1.4 §C).
      variantsTouched: false,
      assignVariants: picked.variants.length > 1,
      needsProductHint: false,
    }));
    rowContextFetcher.submit(
      { intent: "product-context", productId: picked.id },
      { method: "post" },
    );
  };

  const openRowPicker = async () => {
    try {
      const picker = (
        shopify as unknown as {
          resourcePicker?: (options: Record<string, unknown>) => Promise<unknown>;
        }
      ).resourcePicker;
      if (typeof picker !== "function") {
        onPickerUnavailable();
        return;
      }
      const raw = await picker.call(shopify, {
        type: "product",
        multiple: false,
        action: "select",
      });
      if (raw == null) return; // merchant cancelled
      const picked = parsePickerSelection(raw);
      if (picked) selectRowProduct(picked);
    } catch (error) {
      console.error("[cellexia] resourcePicker failed — falling back to the product select", error);
      onPickerUnavailable();
    }
  };

  // Authoritative context for THIS row's product (same dance as the main
  // form's contextFetcher effect).
  const lastRowContextData = useRef<unknown>(null);
  useEffect(() => {
    if (
      rowContextFetcher.state !== "idle" ||
      !rowContextFetcher.data ||
      rowContextFetcher.data === lastRowContextData.current
    ) {
      return;
    }
    lastRowContextData.current = rowContextFetcher.data;
    const data = rowContextFetcher.data as {
      ok?: boolean;
      intent?: string;
      product?: {
        id?: string;
        title?: string;
        handle?: string | null;
        description?: string;
        productType?: string | null;
        tags?: unknown;
        variants?: unknown;
      };
    };
    if (data.intent !== "product-context") return;
    if (!data.ok || !data.product || typeof data.product.id !== "string") {
      // Context failed — mark the row's product usable with title only (and
      // drop any "still loading" validation error left from a submit).
      onPatch(row.key, (prev) => {
        if (!prev.product) return prev;
        const errors = { ...prev.errors };
        delete errors.product;
        return { ...prev, product: { ...prev.product, contextLoaded: true }, errors };
      });
      return;
    }
    const incoming = data.product;
    onPatch(row.key, (prev) => {
      if (!prev.product || prev.product.id !== incoming.id) return prev; // stale response
      const variants = Array.isArray(incoming.variants)
        ? incoming.variants.filter((t): t is string => typeof t === "string")
        : prev.product.variants;
      // The context arrived — the "details are still loading" submit error no
      // longer applies.
      const errors = { ...prev.errors };
      delete errors.product;
      const next: ExtraRowState = {
        ...prev,
        errors,
        product: {
          id: prev.product.id,
          title:
            typeof incoming.title === "string" && incoming.title
              ? incoming.title
              : prev.product.title,
          handle: typeof incoming.handle === "string" ? incoming.handle : prev.product.handle,
          description: typeof incoming.description === "string" ? incoming.description : "",
          productType:
            typeof incoming.productType === "string" && incoming.productType
              ? incoming.productType
              : null,
          tags: Array.isArray(incoming.tags)
            ? incoming.tags.filter((t): t is string => typeof t === "string")
            : [],
          variants,
          contextLoaded: true,
        },
      };
      // Default ON when > 1 variant (SPEC-1.4 §C) — only while the merchant
      // hasn't touched this row's checkbox themselves.
      if (variants.length === 0) next.assignVariants = false;
      else if (!prev.variantsTouched) next.assignVariants = variants.length > 1;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowContextFetcher.state, rowContextFetcher.data]);

  const patch = (partial: Partial<ExtraRowState>) => {
    onPatch(row.key, (prev) => ({ ...prev, ...partial }));
  };

  // Screen-reader identity for this row's controls: every row renders the
  // same field set, so each label carries the row number (and product title
  // once picked) to stay unique across rows.
  const rowName = row.product
    ? `product ${index + 2}: ${row.product.title}`
    : `product ${index + 2}`;
  const rowFieldLabel = (base: string) => (
    <>
      {base}
      <Text as="span" visuallyHidden>{` — ${rowName}`}</Text>
    </>
  );

  return (
    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone="subdued">
              Product {index + 2}
            </Text>
            {row.product ? (
              <>
                <Text as="span" fontWeight="semibold">
                  {row.product.title}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {row.product.variants.length > 0
                    ? pluralize(row.product.variants.length, "variant")
                    : "no variants"}
                  {contextLoading ? " · loading details…" : ""}
                </Text>
                <Button
                  size="slim"
                  onClick={openRowPicker}
                  accessibilityLabel={`Change product — ${rowName}`}
                >
                  Change product
                </Button>
              </>
            ) : (
              <Button
                size="slim"
                onClick={openRowPicker}
                accessibilityLabel={`Select product — ${rowName}`}
              >
                Select product
              </Button>
            )}
          </InlineStack>
          <Button
            size="slim"
            tone="critical"
            onClick={() => onRemove(row.key)}
            accessibilityLabel={`Remove ${rowName} from this launch`}
          >
            Remove
          </Button>
        </InlineStack>

        {duplicate ? (
          <Text as="p" variant="bodySm" tone="caution">
            Already in this launch — this row is ignored. Pick a different product or remove it.
          </Text>
        ) : null}
        {row.needsProductHint && !row.product ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Pick a product or remove the row — rows without a product are skipped.
          </Text>
        ) : null}
        {row.errors.product ? (
          <InlineError message={row.errors.product} fieldID={`qa-launch-row-${row.key}`} />
        ) : null}

        {pickerUnavailable && !productListError ? (
          <Select
            label={rowFieldLabel("Product (first 100 shown)")}
            options={[
              { label: "Choose a product…", value: "" },
              ...products.map((p) => ({ label: p.title, value: p.id })),
            ]}
            value={row.product?.id ?? ""}
            onChange={(value) => {
              const match = products.find((p) => p.id === value);
              if (match) {
                selectRowProduct({
                  id: match.id,
                  title: match.title,
                  handle: match.handle,
                  description: "",
                  productType: null,
                  tags: [],
                  variants: [],
                  contextLoaded: false,
                });
              }
            }}
          />
        ) : null}

        <FormLayout>
          <FormLayout.Group condensed>
            <TextField
              label={rowFieldLabel("Reviews")}
              type="number"
              min={1}
              autoComplete="off"
              value={row.countText}
              onChange={(value) => patch({ countText: value })}
              error={row.errors.count}
            />
            <TextField
              label={rowFieldLabel("Verified purchases")}
              type="number"
              min={0}
              max={100}
              suffix="%"
              autoComplete="off"
              value={row.verifiedText}
              onChange={(value) => patch({ verifiedText: value })}
              error={row.errors.verified}
            />
            <TextField
              label={rowFieldLabel("Merchant replies")}
              type="number"
              min={0}
              max={100}
              suffix="%"
              autoComplete="off"
              value={row.repliesText}
              onChange={(value) => patch({ repliesText: value })}
              error={row.errors.replies}
            />
          </FormLayout.Group>
          <RangeSlider
            label={rowFieldLabel(`Average star rating: ${row.targetAverage.toFixed(1)}`)}
            min={1}
            max={5}
            step={0.1}
            value={row.targetAverage}
            onChange={(value) =>
              patch({ targetAverage: typeof value === "number" ? value : value[0] })
            }
            output
          />
          <FormLayout.Group condensed>
            <TextField
              label={rowFieldLabel("Date range start")}
              type="date"
              autoComplete="off"
              value={row.dateStart}
              onChange={(value) => patch({ dateStart: value })}
              error={row.errors.dateStart}
            />
            <TextField
              label={rowFieldLabel("Date range end")}
              type="date"
              autoComplete="off"
              value={row.dateEnd}
              onChange={(value) => patch({ dateEnd: value })}
              error={row.errors.dateEnd}
            />
          </FormLayout.Group>
          {row.product && row.product.variants.length > 0 ? (
            // Custom per-row variant weights stay a main-product feature
            // (SPEC-1.26 §2) — rows always use the server's default split.
            <Checkbox
              label={rowFieldLabel("Assign product variants")}
              checked={row.assignVariants}
              onChange={(checked) => patch({ assignVariants: checked, variantsTouched: true })}
              helpText="Weighted with the default split across this product's variants — custom weights stay a main-product feature"
            />
          ) : null}
        </FormLayout>
      </BlockStack>
    </Box>
  );
}

/* ------------------------------------------------------------------------- *
 * Route component
 * ------------------------------------------------------------------------- */

export default function QaGeneratorRoute() {
  const { aiReady, stats, jobs, products, productListError } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const contextFetcher = useFetcher<typeof action>();
  const estimateFetcher = useFetcher<typeof action>();
  const genFetcher = useFetcher<typeof action>();
  const jobFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();

  /* ---- Config state ------------------------------------------------------ */
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [pickerUnavailable, setPickerUnavailable] = useState(false);
  const [countText, setCountText] = useState("20");
  const [targetAverage, setTargetAverage] = useState(4.5);
  const [verifiedPercent, setVerifiedPercent] = useState(80);
  const [languages, setLanguages] = useState<string[]>(["en"]);
  const [repliesPercent, setRepliesPercent] = useState(15);
  const [maxVotesText, setMaxVotesText] = useState("25");
  const [dateStart, setDateStart] = useState("2025-04-01");
  const [dateEnd, setDateEnd] = useState(() => todayIso());
  const [assignVariants, setAssignVariants] = useState(false);
  const [structuredAttrs, setStructuredAttrs] = useState(true);
  const [humanTouch, setHumanTouch] = useState(50);
  const [skepticCheck, setSkepticCheck] = useState(true);
  const [skepticBatchSize, setSkepticBatchSize] = useState("20");
  const [status, setStatus] = useState<"PUBLISHED" | "PENDING">("PUBLISHED");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  // SPEC-1.10 §2/§3 — share editor fields (percent strings, keyed by locale /
  // variant title + VARIANT_NONE_KEY). Prefilled by the effects below.
  const [langShares, setLangShares] = useState<Record<string, string>>({});
  const [variantShares, setVariantShares] = useState<Record<string, string>>({});
  // SPEC-1.26 §2 — extra products in this launch. The main form doubles as
  // product 1 + the shared settings; each row carries ONLY the per-product
  // overrides.
  const [extraRows, setExtraRows] = useState<ExtraRowState[]>([]);
  const launchRowKey = useRef(0);

  /* ---- Estimate / confirm / modal state ---------------------------------- */
  const [estimateView, setEstimateView] = useState<EstimateView | null>(null);
  // The raw DTO exactly as the server returned it — threaded back on Generate
  // so the job row records what the merchant saw.
  const [estimateRaw, setEstimateRaw] = useState<unknown>(null);
  // SPEC-1.26 §2 — the combined estimate for a multi-product launch (mutually
  // exclusive on screen with the single-product estimateView).
  const [multiEstimate, setMultiEstimate] = useState<MultiEstimateView | null>(null);
  // The raw per-product EstimateDTOs exactly as estimate-multi returned them,
  // keyed by productId — threaded back on Generate as each job row's audit
  // trail (the multi twin of `estimateRaw`).
  const [multiEstimateRaw, setMultiEstimateRaw] = useState<Record<string, unknown> | null>(null);
  // `configJson` holds the single-product config, or — when `multi` — the
  // whole launch payload for generate-multi (SPEC-1.26 §2). `products` is the
  // launch's product count, captured from the payload the modal confirms.
  const [confirmLarge, setConfirmLarge] = useState<{
    configJson: string;
    total: number;
    multi?: boolean;
    products?: number;
  } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [pendingJobAction, setPendingJobAction] = useState<{
    id: string;
    kind: "cancel" | "retry";
  } | null>(null);
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllText, setDeleteAllText] = useState("");

  const estimating = estimateFetcher.state !== "idle";
  const enqueueing = genFetcher.state !== "idle";
  const jobActionBusy = jobFetcher.state !== "idle";
  const deleting = deleteFetcher.state !== "idle";

  /* ---- Job polling (3 s active / 30 s idle, paused when hidden) ---------- */
  const { summary: liveSummary, refresh: refreshJobs } = useActiveJobsPoll();

  useResultToast(contextFetcher);
  useResultToast(estimateFetcher); // errors only — a successful estimate has no message
  useResultToast(genFetcher, () => {
    // Enqueued: close the large-batch modal (if open), keep the form filled so
    // a second, different job can be launched right away, and poll instantly.
    setConfirmLarge(null);
    setConfirmText("");
    refreshJobs();
  });
  useResultToast(jobFetcher, () => {
    refreshJobs();
  });
  useResultToast(deleteFetcher, () => {
    setDeleteBatchTarget(null);
    setDeleteAllOpen(false);
    setDeleteAllText("");
    refreshJobs();
  });

  // Clear the per-row spinner as soon as the cancel/retry round-trip settles.
  useEffect(() => {
    if (jobFetcher.state === "idle") setPendingJobAction(null);
  }, [jobFetcher.state]);

  /* ---- Product selection ------------------------------------------------- */

  // Whether the merchant explicitly toggled "Assign product variants" for the
  // currently selected product — resets on every product change so the
  // context response can apply the spec default (ON when > 1 variant) without
  // overriding a deliberate choice.
  const variantsTouched = useRef(false);

  const selectProduct = (picked: PickedProduct) => {
    setProduct(picked);
    variantsTouched.current = false;
    setAssignVariants(picked.variants.length > 1);
    // A different product invalidates the on-screen estimate entirely — the
    // combined launch estimate included (the main form is product 1 of the
    // launch, SPEC-1.26 §2).
    setEstimateView(null);
    setEstimateRaw(null);
    setMultiEstimate(null);
    setMultiEstimateRaw(null);
    contextFetcher.submit(
      { intent: "product-context", productId: picked.id },
      { method: "post" },
    );
  };

  const openPicker = async () => {
    try {
      const picker = (
        shopify as unknown as {
          resourcePicker?: (options: Record<string, unknown>) => Promise<unknown>;
        }
      ).resourcePicker;
      if (typeof picker !== "function") {
        setPickerUnavailable(true);
        return;
      }
      const raw = await picker.call(shopify, {
        type: "product",
        multiple: false,
        action: "select",
      });
      if (raw == null) return; // merchant cancelled
      const picked = parsePickerSelection(raw);
      if (picked) selectProduct(picked);
    } catch (error) {
      console.error("[cellexia] resourcePicker failed — falling back to the product select", error);
      setPickerUnavailable(true);
    }
  };

  // Authoritative AI context (description, type, tags, variants).
  const lastContextData = useRef<unknown>(null);
  useEffect(() => {
    if (
      contextFetcher.state !== "idle" ||
      !contextFetcher.data ||
      contextFetcher.data === lastContextData.current
    ) {
      return;
    }
    lastContextData.current = contextFetcher.data;
    const data = contextFetcher.data as {
      ok?: boolean;
      intent?: string;
      product?: {
        id?: string;
        title?: string;
        handle?: string | null;
        description?: string;
        productType?: string | null;
        tags?: unknown;
        variants?: unknown;
      };
    };
    if (data.intent !== "product-context") return;
    if (!data.ok || !data.product || typeof data.product.id !== "string") {
      // Context failed — mark the current product usable with title only.
      setProduct((prev) => (prev ? { ...prev, contextLoaded: true } : prev));
      return;
    }
    const incoming = data.product;
    setProduct((prev) => {
      if (!prev || prev.id !== incoming.id) return prev; // stale response
      const variants = Array.isArray(incoming.variants)
        ? incoming.variants.filter((t): t is string => typeof t === "string")
        : prev.variants;
      return {
        id: prev.id,
        title:
          typeof incoming.title === "string" && incoming.title ? incoming.title : prev.title,
        handle: typeof incoming.handle === "string" ? incoming.handle : prev.handle,
        description: typeof incoming.description === "string" ? incoming.description : "",
        productType:
          typeof incoming.productType === "string" && incoming.productType
            ? incoming.productType
            : null,
        tags: Array.isArray(incoming.tags)
          ? incoming.tags.filter((t): t is string => typeof t === "string")
          : [],
        variants,
        contextLoaded: true,
      };
    });
    // Default ON when the product has more than one variant (SPEC-1.4 §C) —
    // applied only while the merchant hasn't touched the checkbox themselves.
    const incomingVariants = Array.isArray(incoming.variants)
      ? incoming.variants.filter((t): t is string => typeof t === "string")
      : [];
    if (incomingVariants.length === 0) {
      setAssignVariants(false);
    } else if (!variantsTouched.current) {
      setAssignVariants(incomingVariants.length > 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextFetcher.state, contextFetcher.data]);

  /* ---- Share editors (SPEC-1.10 §2/§3) ------------------------------------ */

  // Selection in SHOP_LOCALES order — matches both the checkbox list and the
  // server's stable ordering of config.languages.
  const orderedLanguages = useMemo(
    () => (SHOP_LOCALES as readonly string[]).filter((l) => languages.includes(l)),
    [languages],
  );
  const showLanguageShares = orderedLanguages.length > 1;

  // Re-prefill the language editor with an even split whenever the SET of
  // selected languages changes (documented in the editor's helptext) — a
  // changed selection invalidates any hand-tuned split anyway.
  const languagesKey = orderedLanguages.join("|");
  useEffect(() => {
    if (orderedLanguages.length <= 1) {
      setLangShares({});
      return;
    }
    const split = evenSplitPercents(orderedLanguages.length);
    const next: Record<string, string> = {};
    orderedLanguages.forEach((lang, i) => {
      next[lang] = String(split[i]);
    });
    setLangShares(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [languagesKey]);

  const variantShareKeys = useMemo(
    () =>
      product && product.variants.length > 0 ? [VARIANT_NONE_KEY, ...product.variants] : [],
    [product],
  );
  const showVariantShares = assignVariants && variantShareKeys.length > 0;

  // Re-prefill the variant editor with the default weighting whenever the
  // product / its variant list changes or the toggle turns on.
  const variantsKey = `${assignVariants ? "1" : "0"}|${product?.id ?? ""}|${(product?.variants ?? []).join("|")}`;
  useEffect(() => {
    if (!showVariantShares) {
      setVariantShares({});
      return;
    }
    const split = defaultVariantPercents(variantShareKeys.length - 1);
    const next: Record<string, string> = {};
    variantShareKeys.forEach((key, i) => {
      next[key] = String(split[i]);
    });
    setVariantShares(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantsKey]);

  const langShareState = useMemo(
    () => sharesTotal(langShares, orderedLanguages),
    [langShares, orderedLanguages],
  );
  const variantShareState = useMemo(
    () => sharesTotal(variantShares, variantShareKeys),
    [variantShares, variantShareKeys],
  );

  /* ---- Config assembly & validation -------------------------------------- */

  const countNumber = useMemo(() => {
    const n = Number.parseInt(countText, 10);
    return Number.isFinite(n) ? n : NaN;
  }, [countText]);

  const distributionPreview = useMemo(() => {
    const n =
      Number.isFinite(countNumber) && countNumber >= 1
        ? Math.min(PREVIEW_MAX_COUNT, countNumber)
        : 20;
    const counts = previewStarDistribution(n, targetAverage);
    const sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
    return { counts, total: n, achieved: sum / n };
  }, [countNumber, targetAverage]);

  /**
   * Validates the form and assembles the config JSON without touching any
   * state (the debounced estimate auto-refresh must not flash error text).
   */
  const computeConfig = (): {
    errors: Record<string, string>;
    configJson: string | null;
    total: number;
  } => {
    const errors: Record<string, string> = {};
    if (!product) errors._ = "Pick a product before generating reviews";
    // No product cap since v1.7 — a positive integer up to the per-job
    // ceiling (which the server would otherwise clamp to silently).
    if (!Number.isFinite(countNumber) || !Number.isSafeInteger(countNumber) || countNumber < 1) {
      errors.count = "Enter a number of reviews (1 or more)";
    } else if (countNumber > MAX_REVIEWS_PER_JOB) {
      errors.count = MAX_REVIEWS_MESSAGE;
    }
    if (languages.length === 0) errors.languages = "Select at least one language";
    const maxVotes = Number.parseInt(maxVotesText, 10);
    if (!Number.isFinite(maxVotes) || maxVotes < 0 || maxVotes > 1000) {
      errors.maxVotes = "Enter a maximum between 0 and 1000";
    }
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dayRe.test(dateStart) || Number.isNaN(new Date(dateStart).getTime())) {
      errors.dateStart = "Enter a valid start date";
    }
    if (!dayRe.test(dateEnd) || Number.isNaN(new Date(dateEnd).getTime())) {
      errors.dateEnd = "Enter a valid end date";
    }
    if (!errors.dateStart && !errors.dateEnd && dateStart > dateEnd) {
      errors.dateEnd = "The end date must be on or after the start date";
    }

    // SPEC-1.10 §2/§3 — the share editors must add up to 100% (±1) before a
    // config can carry weights. The server normalizes valid weights to exact
    // review counts by largest remainder.
    let languageWeights: Record<string, number> | null = null;
    if (showLanguageShares) {
      if (langShareState.invalid) {
        errors.languageShares = "Enter a percentage of 0 or more for every language";
      } else if (!shareTotalOk(langShareState)) {
        errors.languageShares = `Language shares must total 100% — currently ${formatShareTotal(langShareState.total)}%`;
      } else {
        languageWeights = {};
        for (const lang of orderedLanguages) {
          languageWeights[lang] = Number((langShares[lang] ?? "").trim());
        }
      }
    }
    let variantWeights: Record<string, number> | null = null;
    if (showVariantShares) {
      if (variantShareState.invalid) {
        errors.variantShares = "Enter a percentage of 0 or more for every row";
      } else if (!shareTotalOk(variantShareState)) {
        errors.variantShares = `Variant shares must total 100% — currently ${formatShareTotal(variantShareState.total)}%`;
      } else {
        variantWeights = {};
        for (const key of variantShareKeys) {
          variantWeights[key] = Number((variantShares[key] ?? "").trim());
        }
      }
    }

    if (Object.keys(errors).length > 0 || !product) {
      return { errors, configJson: null, total: 0 };
    }

    const config = {
      productId: product.id,
      productTitle: product.title,
      productHandle: product.handle,
      productDescription: product.description,
      productType: product.productType,
      productTags: product.tags,
      productVariants: product.variants,
      count: countNumber,
      targetAverage,
      verifiedPercent,
      languages,
      repliesPercent,
      maxHelpfulVotes: maxVotes,
      dateStart,
      dateEnd,
      assignVariants,
      structuredAttrs,
      humanTouch,
      skepticCheck,
      skepticBatchSize: Math.min(60, Math.max(5, Number(skepticBatchSize) || 20)),
      status,
      ...(languageWeights ? { languageWeights } : {}),
      ...(variantWeights ? { variantWeights } : {}),
    };
    return { errors, configJson: JSON.stringify(config), total: countNumber };
  };

  const validateForm = (): { configJson: string; total: number } | null => {
    const result = computeConfig();
    setFormErrors(result.errors);
    if (!result.configJson) return null;
    return { configJson: result.configJson, total: result.total };
  };

  /* ---- Multi-product launch (SPEC-1.26 §2) -------------------------------- */

  // A row whose product is already in the launch (the main product or an
  // earlier row) gets an inline warning and is EXCLUDED from submit.
  const duplicateRowKeys = useMemo(() => {
    const seen = new Set<string>(product ? [product.id] : []);
    const duplicates = new Set<string>();
    for (const row of extraRows) {
      if (!row.product) continue;
      if (seen.has(row.product.id)) duplicates.add(row.key);
      else seen.add(row.product.id);
    }
    return duplicates;
  }, [extraRows, product]);

  // Rows that actually ship: product picked and not a duplicate. Product-less
  // rows are skipped silently, with a hint at submit (SPEC-1.26 §2). When at
  // least one row ships, Estimate/Generate switch to the multi intents; with
  // none, the single-product paths run unchanged.
  const activeLaunchRows = useMemo(
    () => extraRows.filter((row) => row.product !== null && !duplicateRowKeys.has(row.key)),
    [extraRows, duplicateRowKeys],
  );
  const multiMode = activeLaunchRows.length > 0;

  // Launch total for the Generate button label — invalid row counts read as 0
  // here; validation names them properly on submit.
  const launchReviewTotal = useMemo(() => {
    let total = Number.isFinite(countNumber) && countNumber >= 1 ? countNumber : 0;
    for (const row of activeLaunchRows) {
      const n = Number.parseInt(row.countText, 10);
      if (Number.isFinite(n) && n >= 1) total += n;
    }
    return total;
  }, [countNumber, activeLaunchRows]);

  // Fingerprint of every value that feeds the launch payload — the shared
  // config, the main product row and every extra row (rows added, removed or
  // edited all change it; error/hint-only patches don't). Any change
  // invalidates the on-screen combined estimate and disowns an in-flight
  // estimate-multi response — the multi counterpart of the single path's
  // count-keyed estimate guard, so a stale total can never be shown or
  // recorded (SPEC-1.26 §2).
  const launchFingerprint = useMemo(
    () =>
      JSON.stringify([
        product?.id ?? null,
        countText,
        targetAverage,
        verifiedPercent,
        orderedLanguages,
        repliesPercent,
        maxVotesText,
        dateStart,
        dateEnd,
        assignVariants,
        structuredAttrs,
        humanTouch,
        skepticCheck,
        skepticBatchSize,
        status,
        langShares,
        variantShares,
        extraRows.map((row) => [
          row.key,
          row.product?.id ?? null,
          row.countText,
          row.targetAverage,
          row.verifiedText,
          row.repliesText,
          row.dateStart,
          row.dateEnd,
          row.assignVariants,
        ]),
      ]),
    [
      product,
      countText,
      targetAverage,
      verifiedPercent,
      orderedLanguages,
      repliesPercent,
      maxVotesText,
      dateStart,
      dateEnd,
      assignVariants,
      structuredAttrs,
      humanTouch,
      skepticCheck,
      skepticBatchSize,
      status,
      langShares,
      variantShares,
      extraRows,
    ],
  );

  // True while the launch has not changed since the last estimate-multi
  // submit — a late response is dropped once this flips false.
  const multiEstimateCurrent = useRef(false);
  const prevLaunchFingerprint = useRef(launchFingerprint);
  useEffect(() => {
    if (prevLaunchFingerprint.current === launchFingerprint) return;
    prevLaunchFingerprint.current = launchFingerprint;
    multiEstimateCurrent.current = false;
    setMultiEstimate(null);
    setMultiEstimateRaw(null);
  }, [launchFingerprint]);

  // Leaving multi mode retires the combined estimate with it (SPEC-1.26 §2).
  useEffect(() => {
    if (!multiMode) {
      multiEstimateCurrent.current = false;
      setMultiEstimate(null);
      setMultiEstimateRaw(null);
    }
  }, [multiMode]);

  const patchLaunchRow = (key: string, updater: (prev: ExtraRowState) => ExtraRowState) => {
    setExtraRows((rows) => rows.map((row) => (row.key === key ? updater(row) : row)));
  };

  const addLaunchRow = () => {
    if (extraRows.length >= MAX_LAUNCH_PRODUCTS - 1) return; // main form takes slot 1
    // Incremented OUTSIDE the state updater — React may double-invoke
    // updaters (StrictMode), and a ref mutation inside one is a side effect.
    launchRowKey.current += 1;
    const key = `launch-row-${launchRowKey.current}`;
    setExtraRows((rows) => {
      if (rows.length >= MAX_LAUNCH_PRODUCTS - 1) return rows;
      return [
        ...rows,
        {
          key,
          product: null,
          // Snapshot of the main form's CURRENT values (SPEC-1.26 §2): the
          // merchant tweaks what differs and leaves the rest. assignVariants
          // is re-derived from the row's product on pick, like the main form.
          countText,
          targetAverage,
          verifiedText: String(verifiedPercent),
          repliesText: String(repliesPercent),
          dateStart,
          dateEnd,
          assignVariants,
          variantsTouched: false,
          needsProductHint: false,
          errors: {},
        },
      ];
    });
  };

  const removeLaunchRow = (key: string) => {
    setExtraRows((rows) => rows.filter((row) => row.key !== key));
  };

  /**
   * Single-path submits with product-less rows sitting in the card: the rows
   * are skipped silently, but each gets the subdued "pick a product or remove
   * the row" hint (SPEC-1.26 §2 — a hint, never an error). The multi path
   * sets the same hint inside buildLaunchPayload.
   */
  const flagProductlessRows = () => {
    if (extraRows.length === 0) return;
    setExtraRows((rows) =>
      rows.map((row) => (row.product ? row : { ...row, needsProductHint: true })),
    );
  };

  /** Per-row validation mirroring the main form's checks. */
  const validateLaunchRowFields = (row: ExtraRowState): Record<string, string> => {
    const errors: Record<string, string> = {};
    const count = Number.parseInt(row.countText, 10);
    if (!Number.isFinite(count) || !Number.isSafeInteger(count) || count < 1) {
      errors.count = "Enter a number of reviews (1 or more)";
    } else if (count > MAX_REVIEWS_PER_JOB) {
      errors.count = MAX_REVIEWS_MESSAGE;
    }
    const verified = Number(row.verifiedText.trim());
    if (
      row.verifiedText.trim() === "" ||
      !Number.isFinite(verified) ||
      verified < 0 ||
      verified > 100
    ) {
      errors.verified = "Enter a percentage between 0 and 100";
    }
    const replies = Number(row.repliesText.trim());
    if (
      row.repliesText.trim() === "" ||
      !Number.isFinite(replies) ||
      replies < 0 ||
      replies > 100
    ) {
      errors.replies = "Enter a percentage between 0 and 100";
    }
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!dayRe.test(row.dateStart) || Number.isNaN(new Date(row.dateStart).getTime())) {
      errors.dateStart = "Enter a valid start date";
    }
    if (!dayRe.test(row.dateEnd) || Number.isNaN(new Date(row.dateEnd).getTime())) {
      errors.dateEnd = "Enter a valid end date";
    }
    if (!errors.dateStart && !errors.dateEnd && row.dateStart > row.dateEnd) {
      errors.dateEnd = "The end date must be on or after the start date";
    }
    return errors;
  };

  /**
   * Validates the WHOLE launch (main form + every shipping row) and
   * assembles the `launch` payload for estimate-multi / generate-multi
   * (SPEC-1.26 §1): shared = the main config minus the product context and
   * per-product keys; products = the main form's row first, then every extra
   * row with a product. Product-less rows get the "pick or remove" hint;
   * anything invalid renders its errors and returns null (all-or-nothing —
   * the server never sees a half-valid launch).
   */
  const buildLaunchPayload = (): {
    launchJson: string;
    total: number;
    products: number;
  } | null => {
    const validated = validateForm();
    let hasRowErrors = false;
    const nextRows = extraRows.map((row) => {
      if (!row.product) return { ...row, needsProductHint: true, errors: {} };
      if (duplicateRowKeys.has(row.key)) return { ...row, needsProductHint: false, errors: {} };
      const errors = validateLaunchRowFields(row);
      // The variants (and their count) are unknown until the row's
      // product-context fetch settles — submitting now would silently ship
      // assignVariants=false for a multi-variant product. Fail loud instead;
      // the error clears itself the moment the context lands.
      if (!row.product.contextLoaded) {
        errors.product = "Product details are still loading — give it a second";
      }
      if (Object.keys(errors).length > 0) hasRowErrors = true;
      return { ...row, needsProductHint: false, errors };
    });
    setExtraRows(nextRows);
    if (!validated || hasRowErrors) return null;

    const config = JSON.parse(validated.configJson) as Record<string, unknown>;
    const shared: Record<string, unknown> = { ...config };
    for (const key of [...LAUNCH_PER_PRODUCT_KEYS, ...LAUNCH_PRODUCT_CONTEXT_KEYS]) {
      delete shared[key];
    }

    // The main form is product 1, with ITS per-product values — custom
    // variant weights included (they stay a main-product feature).
    const mainRow: Record<string, unknown> = {
      productId: config.productId,
      count: config.count,
      targetAverage: config.targetAverage,
      verifiedPercent: config.verifiedPercent,
      repliesPercent: config.repliesPercent,
      assignVariants: config.assignVariants,
      dateStart: config.dateStart,
      dateEnd: config.dateEnd,
    };
    if (config.variantWeights) mainRow.variantWeights = config.variantWeights;

    const shippingRows = nextRows.filter(
      (row): row is ExtraRowState & { product: PickedProduct } =>
        row.product !== null && !duplicateRowKeys.has(row.key),
    );
    const productRows: Array<Record<string, unknown>> = [
      mainRow,
      // variantWeights is omitted on purpose: the server's default split
      // applies (a row-level weights editor is v-next, SPEC-1.26 §2).
      ...shippingRows.map((row) => ({
        productId: row.product.id,
        count: Number.parseInt(row.countText, 10),
        targetAverage: row.targetAverage,
        verifiedPercent: Number(row.verifiedText.trim()),
        repliesPercent: Number(row.repliesText.trim()),
        // Only decide variants when the row actually KNOWS them. A row whose
        // context fetch failed has variants [] for a product that may well
        // have variants — omitting the key lets the server derive the same
        // "on when the product has variants" default from its own fetch,
        // instead of receiving a hard false that wins over reality.
        ...(row.product.variants.length > 0
          ? { assignVariants: row.assignVariants }
          : {}),
        dateStart: row.dateStart,
        dateEnd: row.dateEnd,
      })),
    ];
    const total = productRows.reduce((sum, p) => sum + (Number(p.count) || 0), 0);
    return {
      launchJson: JSON.stringify({ shared, products: productRows }),
      total,
      products: productRows.length,
    };
  };

  /* ---- Estimate (optional; SPEC-1.7 §4/§5) -------------------------------- */

  // The review count the last estimate request was submitted for — drives the
  // debounced auto-refresh (only re-estimate when the count actually moved).
  const lastEstimateCount = useRef<number | null>(null);

  const submitEstimate = (configJson: string, total: number) => {
    lastEstimateCount.current = total;
    estimateFetcher.submit({ intent: "estimate", config: configJson }, { method: "post" });
  };

  const submitMultiEstimate = (launchJson: string) => {
    // Multi estimates never auto-refresh — reset the single-path debounce
    // guard so a later single estimate starts clean.
    lastEstimateCount.current = null;
    // The response is only credible while the launch stays exactly as
    // submitted — any form/row change flips this back off.
    multiEstimateCurrent.current = true;
    estimateFetcher.submit({ intent: "estimate-multi", launch: launchJson }, { method: "post" });
  };

  const requestEstimate = () => {
    if (estimating) return;
    // SPEC-1.26 §2: with extra rows in the launch, Estimate automatically
    // takes the multi path; with none, the single path runs unchanged.
    if (multiMode) {
      const launch = buildLaunchPayload();
      if (!launch) return;
      submitMultiEstimate(launch.launchJson);
      return;
    }
    flagProductlessRows();
    const validated = validateForm();
    if (!validated) return;
    submitEstimate(validated.configJson, validated.total);
  };

  // Debounced (600 ms) auto-refresh: while an estimate is on screen and the
  // review count changed (SPEC-1.7 §5) — and ALSO whenever the count sits
  // above the large-batch warning threshold, so the >500 inline warning and
  // the >5000 confirm modal always carry the estimated cost and duration
  // (SPEC-1.7 §2 requires the figures, not a prompt to press a button). The
  // lastEstimateCount guard keeps this from re-submitting for a count that
  // was already estimated (or whose estimate request failed).
  useEffect(() => {
    // In multi mode the on-screen figure is the combined launch estimate —
    // a single-product auto-refresh would silently replace it (SPEC-1.26 §2).
    if (multiMode) return undefined;
    const needsLargeBatchEstimate =
      Number.isFinite(countNumber) &&
      countNumber > LARGE_BATCH_WARNING_THRESHOLD &&
      product !== null &&
      contextFetcher.state === "idle"; // wait for the product context to settle
    if (!estimateView && !needsLargeBatchEstimate) return undefined;
    if (!Number.isFinite(countNumber) || countNumber < 1) return undefined;
    if (lastEstimateCount.current === countNumber) return undefined;
    const timer = setTimeout(() => {
      const { errors, configJson, total } = computeConfig();
      if (configJson && Object.keys(errors).length === 0) {
        submitEstimate(configJson, total);
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countNumber, estimateView, product, contextFetcher.state, multiMode]);

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
    const data = estimateFetcher.data as { ok?: boolean; intent?: string; estimate?: unknown };
    if (data.ok !== true) return;
    // Combined launch estimate (SPEC-1.26 §2): totals + per-product lines
    // replace the single-product banner — only one of the two is on screen.
    if (data.intent === "estimate-multi") {
      // Stale-guard: the launch changed while this round trip was in flight —
      // its totals no longer describe what Generate would submit. Drop it.
      if (!multiEstimateCurrent.current) return;
      const view = normalizeMultiEstimate(data);
      if (view) {
        // Keep the raw DTOs by productId — threaded back on Generate as the
        // per-job audit-trail estimate (`estimates` in the launch JSON).
        const rawByProduct: Record<string, unknown> = {};
        const perProductRaw = (data as { perProduct?: unknown }).perProduct;
        if (Array.isArray(perProductRaw)) {
          for (const item of perProductRaw) {
            if (typeof item !== "object" || item === null) continue;
            const entry = item as { productId?: unknown; estimate?: unknown };
            if (
              typeof entry.productId === "string" &&
              entry.productId &&
              typeof entry.estimate === "object" &&
              entry.estimate !== null
            ) {
              rawByProduct[entry.productId] = entry.estimate;
            }
          }
        }
        setMultiEstimate(view);
        setMultiEstimateRaw(Object.keys(rawByProduct).length > 0 ? rawByProduct : null);
        setEstimateView(null);
        setEstimateRaw(null);
      }
      return;
    }
    if (data.intent !== "estimate") return;
    const view = normalizeEstimate(data.estimate);
    if (view) {
      setEstimateRaw(data.estimate);
      setEstimateView(view);
      setMultiEstimate(null);
      setMultiEstimateRaw(null);
    }
  }, [estimateFetcher.state, estimateFetcher.data]);

  /* ---- Generate (enqueue a background job) -------------------------------- */

  const enqueueJob = (configJson: string, total: number) => {
    if (enqueueing) return;
    const estimateAttachment =
      estimateRaw && estimateView && estimateView.reviews === total
        ? JSON.stringify(estimateRaw)
        : "";
    genFetcher.submit(
      { intent: "generate", config: configJson, estimate: estimateAttachment },
      { method: "post" },
    );
  };

  /**
   * When a fresh combined estimate is on screen at Generate time, attach its
   * raw per-product DTOs to the launch JSON as `estimates: { [productId]:
   * EstimateDTO }` — each job row's audit trail, the multi twin of the
   * single path's `estimate` field. With no (or a mismatched) estimate the
   * key is omitted entirely.
   */
  const withLaunchEstimates = (launchJson: string): string => {
    if (!multiEstimate || !multiEstimateRaw) return launchJson;
    try {
      const parsed = JSON.parse(launchJson) as {
        products?: Array<{ count?: unknown }>;
      };
      // Belt and braces on top of the fingerprint invalidation: the estimate
      // must describe exactly this payload's review total.
      const total = Array.isArray(parsed.products)
        ? parsed.products.reduce((sum, p) => sum + (Number(p.count) || 0), 0)
        : 0;
      if (total !== multiEstimate.total.reviews) return launchJson;
      return JSON.stringify({ ...parsed, estimates: multiEstimateRaw });
    } catch {
      return launchJson;
    }
  };

  // One background job per product; the response reports every jobId and a
  // plain-language summary shown via the shared toast (SPEC-1.26 §1).
  const enqueueMultiLaunch = (launchJson: string) => {
    if (enqueueing) return;
    genFetcher.submit(
      { intent: "generate-multi", launch: withLaunchEstimates(launchJson) },
      { method: "post" },
    );
  };

  const startGeneration = () => {
    if (!aiReady || enqueueing) return;
    // SPEC-1.26 §2: extra rows switch Generate to the multi path.
    if (multiMode) {
      const launch = buildLaunchPayload();
      if (!launch) return;
      if (launch.total > LARGE_BATCH_CONFIRM_THRESHOLD) {
        // The very-large-batch confirmation (SPEC-1.7 §2) applies to the
        // LAUNCH total — and like the single path the modal must name cost
        // and duration, so fetch the combined estimate when the one on
        // screen doesn't match this launch.
        if (!estimating && (!multiEstimate || multiEstimate.total.reviews !== launch.total)) {
          submitMultiEstimate(launch.launchJson);
        }
        setConfirmText("");
        setConfirmLarge({
          configJson: launch.launchJson,
          total: launch.total,
          multi: true,
          products: launch.products,
        });
        return;
      }
      enqueueMultiLaunch(launch.launchJson);
      return;
    }
    flagProductlessRows();
    const validated = validateForm();
    if (!validated) return;
    if (validated.total > LARGE_BATCH_CONFIRM_THRESHOLD) {
      // Very large batch — re-confirm with a typed count (SPEC-1.7 §2). The
      // modal must name the estimated cost and duration, so fetch the
      // estimate right away when the one on screen doesn't match this count
      // (e.g. Generate was clicked before the debounced auto-estimate fired).
      if (!estimating && (!estimateView || estimateView.reviews !== validated.total)) {
        submitEstimate(validated.configJson, validated.total);
      }
      setConfirmText("");
      setConfirmLarge({ configJson: validated.configJson, total: validated.total });
      return;
    }
    enqueueJob(validated.configJson, validated.total);
  };

  /* ---- Jobs table: merge loader data with the live poll ------------------- */

  const loaderJobs = useMemo(() => normalizeJobList(jobs as unknown), [jobs]);

  const mergedJobs = useMemo(() => {
    if (!liveSummary) return loaderJobs;
    const liveById = new Map(liveSummary.jobs.map((job) => [job.id, job] as const));
    const merged = loaderJobs.map((job) => {
      const live = liveById.get(job.id);
      if (live) liveById.delete(job.id);
      return live ?? job;
    });
    // Jobs enqueued since the last loader run (e.g. from another tab) appear
    // at the top until the revalidation below refreshes the canonical list.
    const fresh = [...liveById.values()];
    return [...fresh, ...merged].slice(0, 50);
  }, [loaderJobs, liveSummary]);

  // When the set of active jobs changes between polls (a job started,
  // finished, failed or got cancelled), re-run the loader so terminal rows
  // show their final status/cost/duration.
  const prevActiveIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!liveSummary) return;
    const current = new Set(
      liveSummary.jobs.filter((job) => isActiveJobStatus(job.status)).map((job) => job.id),
    );
    const previous = prevActiveIds.current;
    prevActiveIds.current = current;
    if (!previous) return;
    let changed = current.size !== previous.size;
    if (!changed) {
      for (const id of current) {
        if (!previous.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (changed && revalidator.state === "idle") revalidator.revalidate();
  }, [liveSummary, revalidator]);

  const cancelJob = (job: JobView) => {
    if (jobActionBusy) return;
    setPendingJobAction({ id: job.id, kind: "cancel" });
    jobFetcher.submit({ intent: "cancel-job", jobId: job.id }, { method: "post" });
  };

  const retryJobRemaining = (job: JobView) => {
    if (jobActionBusy) return;
    setPendingJobAction({ id: job.id, kind: "retry" });
    jobFetcher.submit({ intent: "retry-job", jobId: job.id }, { method: "post" });
  };

  /* ---- Deletions --------------------------------------------------------- */

  const confirmDeleteBatch = () => {
    if (!deleteBatchTarget || deleting) return;
    deleteFetcher.submit(
      { intent: "delete-batch", batchId: deleteBatchTarget },
      { method: "post" },
    );
  };

  const confirmDeleteAll = () => {
    if (deleting || deleteAllText !== "DELETE") return;
    deleteFetcher.submit({ intent: "delete-all", confirm: deleteAllText }, { method: "post" });
  };

  /* ---- Derived view state ------------------------------------------------ */

  const typedStats = stats as SyntheticStats;
  const languageChoices = useMemo(
    () =>
      SHOP_LOCALES.map((locale) => ({
        label: LOCALE_LABELS[locale] ?? locale,
        value: locale,
      })),
    [],
  );
  const productOptions = useMemo(
    () => [
      { label: "Choose a product…", value: "" },
      ...products.map((p) => ({ label: p.title, value: p.id })),
    ],
    [products],
  );
  const targetBatch = deleteBatchTarget
    ? typedStats.batches.find((b) => b.batchId === deleteBatchTarget) ?? null
    : null;
  const contextLoading = contextFetcher.state !== "idle";
  const maxPreviewCount = Math.max(1, ...distributionPreview.counts);
  const estimateMatchesCount =
    estimateView !== null &&
    Number.isFinite(countNumber) &&
    estimateView.reviews === countNumber;

  const batchRows = typedStats.batches.map((batch) => [
    <Text as="span" variant="bodySm" key={`id-${batch.batchId}`}>
      <span style={{ fontFamily: "monospace" }}>{batch.batchId.slice(0, 8)}</span>
    </Text>,
    batch.productTitle ?? `Product ${batch.productId}`,
    batch.count,
    batch.generatedAt ? formatDateTime(batch.generatedAt) : "—",
    <InlineStack gap="200" key={`actions-${batch.batchId}`}>
      <Button
        size="slim"
        onClick={() => navigate(`/app/reviews?batch=${encodeURIComponent(batch.batchId)}`)}
      >
        View in Reviews
      </Button>
      <Button
        size="slim"
        tone="critical"
        disabled={deleting}
        onClick={() => setDeleteBatchTarget(batch.batchId)}
      >
        Delete batch
      </Button>
    </InlineStack>,
  ]);

  const jobRows = mergedJobs.map((job, index) => {
    const active = isActiveJobStatus(job.status);
    const canRetry =
      (job.status === "FAILED" || job.status === "CANCELLED") && job.created < job.target;
    const progress =
      job.target > 0 ? Math.min(100, Math.round((job.created / job.target) * 100)) : 0;
    return (
      <IndexTable.Row id={job.id} key={job.id} position={index}>
        <IndexTable.Cell>
          <JobStatusBadge job={job} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd">
              {job.productTitle ?? `Product ${job.productId}`}
            </Text>
            {job.status === "COMPLETED" && job.errors && job.errors.length > 0 ? (
              <Text as="p" variant="bodySm" tone="caution">
                {truncateText(job.errors[0], 140)}
              </Text>
            ) : null}
            {job.status === "FAILED" && job.error ? (
              <Text as="span" variant="bodySm" tone="critical">
                {truncateText(job.error, 140)}
              </Text>
            ) : null}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="100">
            <Text as="span" variant="bodySm">
              {formatCount(job.created)} / {formatCount(job.target)}
              {job.failed > 0 ? ` · ${formatCount(job.failed)} failed` : ""}
              {(job.removedByCheck ?? 0) > 0
                ? ` · ${formatCount(job.removedByCheck ?? 0)} removed by the double-check`
                : ""}
            </Text>
            <div style={{ minWidth: 120 }}>
              <ProgressBar progress={progress} size="small" />
            </div>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {jobTimeText(job)}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" variant="bodySm">
            {job.costUsd > 0 ? formatUsd(job.costUsd) : "—"}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <InlineStack gap="200" wrap>
            {active ? (
              <Button
                size="slim"
                disabled={job.cancelRequested || jobActionBusy}
                loading={pendingJobAction?.id === job.id && pendingJobAction.kind === "cancel"}
                onClick={() => cancelJob(job)}
              >
                Cancel
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                size="slim"
                disabled={jobActionBusy}
                loading={pendingJobAction?.id === job.id && pendingJobAction.kind === "retry"}
                onClick={() => retryJobRemaining(job)}
              >
                Retry remaining
              </Button>
            ) : null}
            {job.created > 0 && job.batchId ? (
              <Button
                size="slim"
                onClick={() =>
                  navigate(`/app/reviews?batch=${encodeURIComponent(job.batchId)}`)
                }
              >
                View reviews
              </Button>
            ) : null}
            {job.batchId ? (
              <Button
                size="slim"
                tone="critical"
                disabled={deleting}
                onClick={() => setDeleteBatchTarget(job.batchId)}
              >
                Delete batch
              </Button>
            ) : null}
          </InlineStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="QA data">
      <TitleBar title="QA data" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Permanent warning — never dismissible (SPEC-1.4 §C). */}
            <Banner tone="warning" title="Synthetic reviews look completely real in the widget.">
              <Text as="p">
                They are labeled only in this admin. Delete every batch before going live to
                real customers.
              </Text>
            </Banner>

            {!aiReady ? (
              <Banner
                tone="critical"
                title="AI generation is unavailable"
                action={{ content: "Open Settings", onAction: () => navigate("/app/settings") }}
              >
                <Text as="p">{NO_AI_KEY_MESSAGE}.</Text>
              </Banner>
            ) : null}

            {/* ---- Config card ------------------------------------------- */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Generate a batch
                </Text>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Product
                  </Text>
                  {product ? (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Text as="span" fontWeight="semibold">
                        {product.title}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {product.variants.length > 0
                          ? pluralize(product.variants.length, "variant")
                          : "no variants"}
                        {contextLoading ? " · loading details…" : ""}
                      </Text>
                      <Button size="slim" onClick={openPicker}>
                        Change product
                      </Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200">
                      <Button onClick={openPicker}>Select product</Button>
                    </InlineStack>
                  )}
                  {pickerUnavailable ? (
                    <BlockStack gap="100">
                      {productListError ? (
                        <Banner tone="warning" title="The product list could not be loaded">
                          <Text as="p">
                            The product picker is unavailable and the fallback list failed to
                            load. Reload the page and try again.
                          </Text>
                        </Banner>
                      ) : (
                        <Select
                          label="Product (first 100 shown)"
                          options={productOptions}
                          value={product?.id ?? ""}
                          onChange={(value) => {
                            const match = products.find((p) => p.id === value);
                            if (match) {
                              selectProduct({
                                id: match.id,
                                title: match.title,
                                handle: match.handle,
                                description: "",
                                productType: null,
                                tags: [],
                                variants: [],
                                contextLoaded: false,
                              });
                            }
                          }}
                        />
                      )}
                    </BlockStack>
                  ) : null}
                  {formErrors._ ? (
                    <InlineError message={formErrors._} fieldID="qa-product" />
                  ) : null}
                </BlockStack>

                <Divider />

                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="Number of reviews"
                      type="number"
                      min={1}
                      autoComplete="off"
                      value={countText}
                      onChange={setCountText}
                      error={formErrors.count}
                      helpText="Up to 100,000 per job — large batches generate in the background"
                    />
                    <TextField
                      label="Max helpful votes per review"
                      type="number"
                      min={0}
                      max={1000}
                      autoComplete="off"
                      value={maxVotesText}
                      onChange={setMaxVotesText}
                      error={formErrors.maxVotes}
                      helpText="Votes follow a long tail — most reviews get 0–1"
                    />
                  </FormLayout.Group>

                  {/* In multi mode the warning weighs the LAUNCH total — the
                      main field alone can sit under the threshold while the
                      launch as a whole is well above it (SPEC-1.7 §2). */}
                  {multiMode && launchReviewTotal > LARGE_BATCH_WARNING_THRESHOLD ? (
                    <Banner
                      tone="warning"
                      title={`Large launch: ${formatCount(launchReviewTotal)} reviews across ${pluralize(activeLaunchRows.length + 1, "product")}`}
                    >
                      <Text as="p">
                        {multiEstimate && multiEstimate.total.reviews === launchReviewTotal
                          ? `Estimated ${formatUsd(multiEstimate.total.costUsd)} in API usage and ${formatEta(multiEstimate.total.seconds, multiEstimate.total.secondsHigh)}.`
                          : estimating
                            ? "Estimating the API cost and duration…"
                            : "Use “Estimate cost” to see the projected API spend and duration before generating."}
                      </Text>
                    </Banner>
                  ) : !multiMode &&
                    Number.isFinite(countNumber) &&
                    countNumber > LARGE_BATCH_WARNING_THRESHOLD ? (
                    <Banner
                      tone="warning"
                      title={`Large batch: ${formatCount(countNumber)} reviews`}
                    >
                      <Text as="p">
                        {estimateMatchesCount && estimateView
                          ? `Estimated ${formatUsd(estimateView.costUsd)} in API usage and ${formatEta(estimateView.seconds, estimateView.secondsHigh)}.`
                          : estimating
                            ? "Estimating the API cost and duration…"
                            : "Use “Estimate cost” to see the projected API spend and duration before generating."}
                      </Text>
                    </Banner>
                  ) : null}

                  <RangeSlider
                    label={`Average star rating: ${targetAverage.toFixed(1)}`}
                    min={1}
                    max={5}
                    step={0.1}
                    value={targetAverage}
                    onChange={(value) =>
                      setTargetAverage(typeof value === "number" ? value : value[0])
                    }
                    output
                  />

                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <BlockStack gap="150">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodySm" fontWeight="semibold">
                          Distribution preview
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          achieved average {distributionPreview.achieved.toFixed(2)}
                        </Text>
                      </InlineStack>
                      {[5, 4, 3, 2, 1].map((star) => {
                        const count = distributionPreview.counts[star - 1];
                        const percent = Math.round((count / distributionPreview.total) * 100);
                        return (
                          <InlineStack gap="200" blockAlign="center" key={star} wrap={false}>
                            <div style={{ width: 44, flexShrink: 0 }}>
                              <Text as="span" variant="bodySm">
                                {star} star
                              </Text>
                            </div>
                            <div
                              style={{
                                flexGrow: 1,
                                height: 12,
                                background: "#E3E3E3",
                                borderRadius: 6,
                                overflow: "hidden",
                              }}
                              role="img"
                              aria-label={`${star} star: ${count} reviews (${percent}%)`}
                            >
                              <div
                                style={{
                                  width: `${Math.round((count / maxPreviewCount) * 100)}%`,
                                  height: "100%",
                                  background: "#FF6200",
                                  borderRadius: 6,
                                }}
                              />
                            </div>
                            <div style={{ width: 90, flexShrink: 0, textAlign: "right" }}>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {count} ({percent}%)
                              </Text>
                            </div>
                          </InlineStack>
                        );
                      })}
                    </BlockStack>
                  </Box>

                  <FormLayout.Group>
                    <RangeSlider
                      label={`Verified purchases: ${verifiedPercent}%`}
                      min={0}
                      max={100}
                      step={1}
                      value={verifiedPercent}
                      onChange={(value) =>
                        setVerifiedPercent(typeof value === "number" ? value : value[0])
                      }
                      output
                    />
                    <RangeSlider
                      label={`Merchant replies: ${repliesPercent}%`}
                      min={0}
                      max={100}
                      step={1}
                      value={repliesPercent}
                      onChange={(value) =>
                        setRepliesPercent(typeof value === "number" ? value : value[0])
                      }
                      output
                    />
                  </FormLayout.Group>

                  <BlockStack gap="100">
                    <ChoiceList
                      allowMultiple
                      title="Languages"
                      choices={languageChoices}
                      selected={languages}
                      onChange={setLanguages}
                    />
                    {formErrors.languages ? (
                      <InlineError message={formErrors.languages} fieldID="qa-languages" />
                    ) : null}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {showLanguageShares
                        ? "Reviews follow the language shares below. Reviewer names, text and replies follow the assignment."
                        : "Reviews split evenly across the selected languages (with a little jitter). Reviewer names, text and replies follow the assignment."}
                    </Text>
                  </BlockStack>

                  {/* ---- Language distribution (SPEC-1.10 §2) ------------- */}
                  {showLanguageShares ? (
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center" wrap>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            Language distribution
                          </Text>
                          <Text
                            as="span"
                            variant="bodySm"
                            tone={shareTotalOk(langShareState) ? "subdued" : "critical"}
                          >
                            Total: {formatShareTotal(langShareState.total)}%
                          </Text>
                        </InlineStack>
                        <FormLayout>
                          {chunkArray(orderedLanguages, 4).map((row) => (
                            <FormLayout.Group condensed key={row.join("|")}>
                              {row.map((lang) => (
                                <TextField
                                  key={lang}
                                  label={LOCALE_LABELS[lang] ?? lang}
                                  type="number"
                                  min={0}
                                  suffix="%"
                                  autoComplete="off"
                                  value={langShares[lang] ?? ""}
                                  onChange={(value) =>
                                    setLangShares((prev) => ({ ...prev, [lang]: value }))
                                  }
                                />
                              ))}
                            </FormLayout.Group>
                          ))}
                        </FormLayout>
                        {formErrors.languageShares ? (
                          <InlineError
                            message={formErrors.languageShares}
                            fieldID="qa-language-shares"
                          />
                        ) : null}
                        <Text as="p" variant="bodySm" tone="subdued">
                          Prefilled with an even split (changing the selection resets it).
                          The total must be 100% — being off by 1 is fine; the exact review
                          counts are matched to the shares automatically.
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : null}

                  <FormLayout.Group>
                    <TextField
                      label="Date range start"
                      type="date"
                      autoComplete="off"
                      value={dateStart}
                      onChange={setDateStart}
                      error={formErrors.dateStart}
                    />
                    <TextField
                      label="Date range end"
                      type="date"
                      autoComplete="off"
                      value={dateEnd}
                      onChange={setDateEnd}
                      error={formErrors.dateEnd}
                      helpText="Review dates spread across the range with a mild recency bias"
                    />
                  </FormLayout.Group>

                  <FormLayout.Group>
                    <Checkbox
                      label="Assign product variants"
                      checked={assignVariants}
                      disabled={(product?.variants.length ?? 0) === 0}
                      onChange={(checked) => {
                        variantsTouched.current = true;
                        setAssignVariants(checked);
                      }}
                      helpText={
                        (product?.variants.length ?? 0) === 0
                          ? "This product has no variants"
                          : showVariantShares
                            ? "Reviews follow the variant shares below"
                            : "Weighted randomly across the real variants; some reviews get none"
                      }
                    />
                    <Checkbox
                      label="Fill structured attributes"
                      checked={structuredAttrs}
                      onChange={setStructuredAttrs}
                      helpText="Age, skin concerns, time using and results seen — coherent with each rating"
                    />
                  </FormLayout.Group>

                  {/* v1.25: the human-touch dial. */}
                  <RangeSlider
                    label={`Human touch level: ${humanTouch}`}
                    value={humanTouch}
                    onChange={(value) => setHumanTouch(typeof value === "number" ? value : value[0])}
                    min={0}
                    max={100}
                    step={5}
                    output
                    helpText="How human the writing reads. 0 = every review polished. 50 = about half carry a small slip (a typo, a lowercase start). 100 = most reviews read hurried, with grammar slips and imperfect capitalization. Mistakes never change facts or ratings."
                  />

                  {/* v1.24 (SPEC-1.24): the skeptical double-check. */}
                  <FormLayout.Group>
                    <Checkbox
                      label="Skeptical double-check"
                      checked={skepticCheck}
                      onChange={setSkepticCheck}
                      helpText="After generating, a skeptical AI agent re-reads every review hunting for signs of AI writing and removes the ones it convicts. The job report shows how many were removed — so a batch can finish slightly under the requested count. Costs a little extra (included in the estimate)."
                    />
                    <TextField
                      label="Reviews per check"
                      type="number"
                      value={skepticBatchSize}
                      onChange={setSkepticBatchSize}
                      autoComplete="off"
                      min={5}
                      max={60}
                      disabled={!skepticCheck}
                      helpText="How many reviews the skeptic reads per call (5–60). More per call = cheaper and better at spotting repetition across reviews; fewer = closer scrutiny of each one."
                    />
                  </FormLayout.Group>

                  {/* ---- Variant distribution (SPEC-1.10 §3) --------------- */}
                  {showVariantShares ? (
                    <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center" wrap>
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            Variant distribution
                          </Text>
                          <Text
                            as="span"
                            variant="bodySm"
                            tone={shareTotalOk(variantShareState) ? "subdued" : "critical"}
                          >
                            Total: {formatShareTotal(variantShareState.total)}%
                          </Text>
                        </InlineStack>
                        <FormLayout>
                          {chunkArray(variantShareKeys, 4).map((row) => (
                            <FormLayout.Group condensed key={row.join("|")}>
                              {row.map((key) => (
                                <TextField
                                  key={key}
                                  label={key === VARIANT_NONE_KEY ? "No variant" : key}
                                  type="number"
                                  min={0}
                                  suffix="%"
                                  autoComplete="off"
                                  value={variantShares[key] ?? ""}
                                  onChange={(value) =>
                                    setVariantShares((prev) => ({ ...prev, [key]: value }))
                                  }
                                />
                              ))}
                            </FormLayout.Group>
                          ))}
                        </FormLayout>
                        {formErrors.variantShares ? (
                          <InlineError
                            message={formErrors.variantShares}
                            fieldID="qa-variant-shares"
                          />
                        ) : null}
                        <Text as="p" variant="bodySm" tone="subdued">
                          Prefilled with the default weighting (about 1 in 5 reviews mentions
                          no variant). The total must be 100% — being off by 1 is fine; the
                          exact review counts are matched to the shares automatically.
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : null}

                  <Select
                    label="Status at creation"
                    options={[
                      { label: "Published", value: "PUBLISHED" },
                      { label: "Pending", value: "PENDING" },
                    ]}
                    value={status}
                    onChange={(value) => setStatus(value === "PENDING" ? "PENDING" : "PUBLISHED")}
                  />
                </FormLayout>

                {/* ---- Combined launch estimate (SPEC-1.26 §2) ------------ */}
                {multiEstimate ? (
                  <Banner
                    tone="info"
                    title={`${pluralize(multiEstimate.total.products, "product")} · ${formatCount(multiEstimate.total.reviews)} reviews · ≈ ${formatUsd(multiEstimate.total.costUsd)} · ${formatEta(multiEstimate.total.seconds, multiEstimate.total.secondsHigh)}`}
                    onDismiss={() => {
                      setMultiEstimate(null);
                      setMultiEstimateRaw(null);
                    }}
                  >
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        {multiEstimate.caveat}
                      </Text>
                      {multiEstimate.perProduct.map((p, i) => (
                        <Text as="p" variant="bodySm" tone="subdued" key={`${i}-${p.title}`}>
                          {truncateText(p.title, 60)} · {formatCount(p.reviews)} reviews ·{" "}
                          {formatUsd(p.costUsd)} ({p.basis})
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}

                {/* ---- Inline cost & time estimate (SPEC-1.7 §5) ---------- */}
                {estimateView ? (
                  <Banner
                    tone="info"
                    title={`≈ ${formatCount(estimateView.inputTokens)} input + ${formatCount(estimateView.outputTokens)} output tokens · ≈ ${formatUsd(estimateView.costUsd)} · ${formatEta(estimateView.seconds, estimateView.secondsHigh)}`}
                    onDismiss={() => {
                      setEstimateView(null);
                      setEstimateRaw(null);
                    }}
                  >
                    <Text as="p" variant="bodySm" tone="subdued">
                      {estimateSecondLine(estimateView)}
                      {estimating ? " · Updating…" : ""}
                    </Text>
                  </Banner>
                ) : null}

                <InlineStack gap="200" blockAlign="center">
                  <Button
                    variant="primary"
                    onClick={startGeneration}
                    loading={enqueueing}
                    disabled={!aiReady || enqueueing || !product || contextLoading}
                  >
                    {multiMode
                      ? `Generate ${formatCount(launchReviewTotal)} reviews · ${pluralize(activeLaunchRows.length + 1, "product")}`
                      : Number.isFinite(countNumber) && countNumber >= 1
                        ? countNumber === 1
                          ? "Generate 1 review"
                          : `Generate ${formatCount(countNumber)} reviews`
                        : "Generate reviews"}
                  </Button>
                  <Button
                    onClick={requestEstimate}
                    loading={estimating}
                    disabled={!product || contextLoading || estimating}
                  >
                    Estimate cost
                  </Button>
                  {!aiReady ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Add the Anthropic API key in Settings to enable the generator.
                    </Text>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---- More products in this launch (SPEC-1.26 §2) ------------ */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  More products in this launch
                </Text>
                <Text as="p" tone="subdued">
                  Everything configured above applies to every product in the launch —
                  languages, human touch, the skeptical double-check, structured attributes,
                  status and helpful-votes cap. Each product added here only overrides what
                  differs: review count, star average, verified and reply percentages, dates
                  and the variant toggle. Each row is a copy of the settings above from the
                  moment you added it — changing the settings above later does not update
                  existing rows. Each product runs as its own background job.
                </Text>
                {extraRows.map((row, index) => (
                  <ExtraLaunchRow
                    key={row.key}
                    row={row}
                    index={index}
                    duplicate={duplicateRowKeys.has(row.key)}
                    products={products}
                    productListError={productListError}
                    pickerUnavailable={pickerUnavailable}
                    onPickerUnavailable={() => setPickerUnavailable(true)}
                    onPatch={patchLaunchRow}
                    onRemove={removeLaunchRow}
                  />
                ))}
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    onClick={addLaunchRow}
                    disabled={extraRows.length >= MAX_LAUNCH_PRODUCTS - 1}
                  >
                    Add product
                  </Button>
                  {extraRows.length >= MAX_LAUNCH_PRODUCTS - 1 ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      A launch supports up to {MAX_LAUNCH_PRODUCTS} products, the product
                      above included.
                    </Text>
                  ) : null}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---- Generation jobs (SPEC-1.7 §5) -------------------------- */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Generation jobs
                </Text>
                {mergedJobs.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No generation jobs yet. Jobs run in the background — you can leave this
                    page while they generate.
                  </Text>
                ) : (
                  <IndexTable
                    itemCount={mergedJobs.length}
                    selectable={false}
                    resourceName={{ singular: "job", plural: "jobs" }}
                    headings={[
                      { title: "Status" },
                      { title: "Product" },
                      { title: "Progress" },
                      { title: "Time" },
                      { title: "Cost" },
                      { title: "Actions" },
                    ]}
                  >
                    {jobRows}
                  </IndexTable>
                )}
              </BlockStack>
            </Card>

            {/* ---- Batch management -------------------------------------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Existing synthetic data
                  </Text>
                  <Button
                    tone="critical"
                    disabled={typedStats.total === 0 || deleting}
                    onClick={() => {
                      setDeleteAllText("");
                      setDeleteAllOpen(true);
                    }}
                  >
                    Delete ALL synthetic reviews
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {typedStats.total === 0
                    ? "No synthetic reviews in this store."
                    : `${pluralize(typedStats.total, "synthetic review")} (${typedStats.published} published and visible wherever the widget is live).`}
                </Text>
                {typedStats.batches.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "text", "text"]}
                    headings={["Batch", "Product", "Reviews", "Generated", "Actions"]}
                    rows={batchRows}
                  />
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* ---- Very large batch: typed re-confirmation (SPEC-1.7 §2) ------- */}
      <Modal
        open={confirmLarge !== null}
        onClose={() => {
          if (!enqueueing) {
            setConfirmLarge(null);
            setConfirmText("");
          }
        }}
        title={
          confirmLarge ? `Generate ${formatCount(confirmLarge.total)} reviews?` : "Generate?"
        }
        primaryAction={{
          content: confirmLarge
            ? `Generate ${formatCount(confirmLarge.total)} reviews`
            : "Generate",
          disabled: !confirmLarge || confirmText.trim() !== String(confirmLarge.total),
          loading: enqueueing,
          onAction: () => {
            if (!confirmLarge) return;
            // Multi launches confirm the LAUNCH total and submit the whole
            // payload to generate-multi (SPEC-1.26 §2).
            if (confirmLarge.multi) enqueueMultiLaunch(confirmLarge.configJson);
            else enqueueJob(confirmLarge.configJson, confirmLarge.total);
          },
        }}
        secondaryActions={[
          {
            content: "Cancel",
            disabled: enqueueing,
            onAction: () => {
              setConfirmLarge(null);
              setConfirmText("");
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              {/* Review and product counts come from the payload this modal
                  confirms (confirmLarge), NEVER from the estimate — the
                  estimate only ever contributes cost/duration, and only when
                  it matches this exact payload. */}
              {confirmLarge?.multi
                ? multiEstimate && multiEstimate.total.reviews === confirmLarge.total
                  ? `Estimated ${formatUsd(multiEstimate.total.costUsd)} in API usage and ${formatEta(multiEstimate.total.seconds, multiEstimate.total.secondsHigh)} for ${formatCount(confirmLarge.total)} reviews across ${pluralize(confirmLarge.products ?? multiEstimate.total.products, "product")}. The jobs run in the background — you can leave this page while they generate.`
                  : estimating
                    ? `Calculating the estimated cost and duration for ${formatCount(confirmLarge.total)} reviews across ${pluralize(confirmLarge.products ?? 1, "product")}… The jobs run in the background — you can leave this page while they generate.`
                    : `This launch totals ${formatCount(confirmLarge.total)} reviews across ${pluralize(confirmLarge.products ?? 1, "product")} — a very large batch. Consider pressing “Estimate cost” first to see the projected API spend and duration. The jobs run in the background — you can leave this page while they generate.`
                : confirmLarge && estimateView && estimateView.reviews === confirmLarge.total
                  ? `Estimated ${formatUsd(estimateView.costUsd)} in API usage and ${formatEta(estimateView.seconds, estimateView.secondsHigh)}. The job runs in the background — you can leave this page while it generates.`
                  : estimating
                    ? "Calculating the estimated cost and duration… The job runs in the background — you can leave this page while it generates."
                    : "This is a very large batch. Consider pressing “Estimate cost” first to see the projected API spend and duration. The job runs in the background — you can leave this page while it generates."}
            </Text>
            <TextField
              label={
                confirmLarge
                  ? `Type ${confirmLarge.total} to confirm`
                  : "Type the review count to confirm"
              }
              autoComplete="off"
              value={confirmText}
              onChange={setConfirmText}
              disabled={enqueueing}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ---- Delete one batch ------------------------------------------- */}
      <ConfirmationModal
        open={deleteBatchTarget !== null}
        title="Delete this synthetic batch?"
        message={
          targetBatch
            ? `This permanently deletes ${pluralize(targetBatch.count, "synthetic review")} for “${targetBatch.productTitle ?? `Product ${targetBatch.productId}`}”, and cancels and removes any generation job for this batch. The product rating updates automatically.`
            : "This permanently deletes every review in this batch, and cancels and removes its generation job. The product rating updates automatically."
        }
        confirmLabel="Delete batch"
        loading={deleting}
        onConfirm={confirmDeleteBatch}
        onCancel={() => {
          if (!deleting) setDeleteBatchTarget(null);
        }}
      />

      {/* ---- Delete ALL (typed confirmation) ----------------------------- */}
      <Modal
        open={deleteAllOpen}
        onClose={() => {
          if (!deleting) {
            setDeleteAllOpen(false);
            setDeleteAllText("");
          }
        }}
        title="Delete ALL synthetic reviews?"
        primaryAction={{
          content: `Delete ${pluralize(typedStats.total, "review")}`,
          destructive: true,
          disabled: deleteAllText !== "DELETE",
          loading: deleting,
          onAction: confirmDeleteAll,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            disabled: deleting,
            onAction: () => {
              setDeleteAllOpen(false);
              setDeleteAllText("");
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              This permanently deletes {pluralize(typedStats.total, "synthetic review")} across
              all batches, including their media, votes and cached translations. Any active
              generation jobs are cancelled (a running job stops after its current chunk) and
              finished job history is removed. Affected product ratings update automatically.
              This cannot be undone.
            </Text>
            <TextField
              label='Type "DELETE" to confirm'
              autoComplete="off"
              value={deleteAllText}
              onChange={setDeleteAllText}
              disabled={deleting}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
