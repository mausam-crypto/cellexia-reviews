/**
 * Cellexia Reviews — QA data page (SPEC-1.4 §C): synthetic review generator.
 *
 * Layout:
 *   1. Permanent warning banner (synthetic reviews look completely real).
 *   2. Fail-fast banner when the AI provider is off / the key is missing.
 *   3. Config card — every knob: product (resourcePicker with a Select
 *      fallback), number of reviews, target average rating (with a live
 *      distribution preview), verified %, languages, replies %, max helpful
 *      votes, date range, variants toggle, structured-attributes toggle,
 *      status at creation.
 *   4. Generation runs as sequential fetcher chunks of 8 reviews with a
 *      progress readout ("Generating 17 of 40…"); the first chunk mints the
 *      batchId and later chunks thread it back as a hidden form field. A
 *      finalize step re-syncs the product's aggregates + metafields once.
 *      Partial failures are reported honestly in the summary banner.
 *   5. "Existing synthetic data" card: per-batch stats with View in Reviews /
 *      Delete batch, plus Delete ALL with a typed "DELETE" confirmation.
 *
 * All structured review fields are assigned by code in synthetic.server.ts;
 * the AI writes only title/body/reply. Rows carry isSynthetic / source /
 * syntheticBatchId / syntheticGeneratedAt — admin-only columns that are never
 * serialized to the storefront.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
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
import { getSettings } from "~/services/settings.server";
import {
  deleteAllSynthetic,
  deleteSyntheticBatch,
  generateSyntheticChunk,
  isValidBatchId,
  parseSyntheticConfig,
  syntheticProductIds,
  syntheticStats,
} from "~/services/synthetic.server";
import type { SyntheticStats } from "~/services/synthetic.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { useResultToast } from "~/components/admin/useResultToast";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { LOCALE_LABELS, formatDateTime, pluralize } from "~/components/admin/labels";

const NO_AI_KEY_MESSAGE =
  "The generator needs the Anthropic API key from Settings → AI Summary";

/**
 * Batch size cap, shared by client-side validation and the preview. Kept as a
 * local constant because MAX_SYNTHETIC_PER_BATCH lives in a `.server` module
 * that must never reach the browser bundle (synthetic.server.ts clamps
 * server-side to the same value).
 */
const MAX_PER_BATCH = 200;

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

/* ------------------------------------------------------------------------- *
 * Loader
 * ------------------------------------------------------------------------- */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

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

  return json({ aiReady, stats, products, productListError });
};

/* ------------------------------------------------------------------------- *
 * Action
 * ------------------------------------------------------------------------- */

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
      if (body.errors || !body.data?.product) {
        if (body.errors) {
          console.error("[cellexia] qa-generator product context errors:", body.errors);
        }
        return json(
          { ok: false, intent, message: "The product could not be loaded" },
          { status: 404 },
        );
      }
      const product = body.data.product;
      const variants = (product.variants?.nodes ?? [])
        .map((node) => (typeof node?.title === "string" ? node.title.trim() : ""))
        .filter((title) => title && title !== "Default Title");
      const tags = Array.isArray(product.tags)
        ? product.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
        : [];
      return json({
        ok: true,
        intent,
        product: {
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
        },
      });
    }

    /* ---- One generation chunk of 8 reviews ------------------------------ */
    if (intent === "generate-chunk") {
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

      // The batchId travels as a hidden form field on every chunk after the
      // first; an empty value tells the service to mint a fresh UUID.
      const batchIdRaw = String(form.get("batchId") ?? "").trim();
      if (batchIdRaw && !isValidBatchId(batchIdRaw)) {
        return json({ ok: false, intent, message: "Invalid batch reference" }, { status: 400 });
      }
      const startRaw = Number(form.get("start"));
      const start = Number.isFinite(startRaw)
        ? Math.min(Math.max(0, Math.floor(startRaw)), MAX_PER_BATCH - 1)
        : 0;

      const result = await generateSyntheticChunk(
        shop,
        parsed.config,
        batchIdRaw || null,
        start,
      );
      if (result.code === "no_ai_key") {
        return json(
          { ok: false, intent, code: "no_ai_key", message: NO_AI_KEY_MESSAGE },
          { status: 409 },
        );
      }
      return json({ ok: true, intent, result });
    }

    /* ---- Finalize: aggregates + metafields re-sync once ----------------- */
    if (intent === "finalize-batch") {
      const productId = numericIdFromGid(String(form.get("productId") ?? ""));
      if (!productId) {
        return json({ ok: false, intent, message: "Invalid product reference" }, { status: 400 });
      }
      try {
        await syncProductData(shop, productId, admin);
        return json({ ok: true, intent, synced: true });
      } catch (error) {
        // The reviews exist either way — report the sync failure honestly.
        console.error(`[cellexia] qa-generator aggregate sync failed for ${productId}`, error);
        return json({
          ok: true,
          intent,
          synced: false,
          syncMessage:
            "Reviews were created, but the product rating sync failed — it will refresh on the next moderation action.",
        });
      }
    }

    /* ---- Delete one batch ------------------------------------------------ */
    if (intent === "delete-batch") {
      const batchId = String(form.get("batchId") ?? "").trim();
      if (!batchId) {
        return json({ ok: false, intent, message: "Missing batch reference" }, { status: 400 });
      }
      const productIds = await syntheticProductIds(shop, batchId);
      const deleted = await deleteSyntheticBatch(shop, batchId);
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
          ? "This batch no longer exists"
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
      const productIds = await syntheticProductIds(shop);
      const deleted = await deleteAllSynthetic(shop);
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
  const n = Math.max(1, Math.min(MAX_PER_BATCH, Math.round(count)));
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

interface GenRun {
  /** "" until the first chunk response mints the batchId. */
  batchId: string;
  productId: string;
  configJson: string;
  total: number;
  /** Reviews attempted so far (chunk starts are derived from this). */
  completed: number;
  created: number;
  failed: number;
  errors: string[];
  phase: "chunks" | "finalize";
}

interface GenSummary {
  batchId: string;
  created: number;
  failed: number;
  errors: string[];
  syncMessage: string | null;
  aborted: boolean;
}

const MAX_UI_ERRORS = 8;

/* ------------------------------------------------------------------------- *
 * Route component
 * ------------------------------------------------------------------------- */

export default function QaGeneratorRoute() {
  const { aiReady, stats, products, productListError } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const contextFetcher = useFetcher<typeof action>();
  const genFetcher = useFetcher<typeof action>();
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
  const [status, setStatus] = useState<"PUBLISHED" | "PENDING">("PUBLISHED");
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  /* ---- Run / summary / modal state -------------------------------------- */
  const [run, setRun] = useState<GenRun | null>(null);
  const [summary, setSummary] = useState<GenSummary | null>(null);
  const [deleteBatchTarget, setDeleteBatchTarget] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllText, setDeleteAllText] = useState("");

  const generating = run !== null;
  const deleting = deleteFetcher.state !== "idle";

  useResultToast(contextFetcher);
  useResultToast(deleteFetcher, () => {
    setDeleteBatchTarget(null);
    setDeleteAllOpen(false);
    setDeleteAllText("");
  });

  /* ---- Leaving-the-page guard while a run is active ---------------------- */
  useEffect(() => {
    if (!generating) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [generating]);

  /* ---- Product selection ------------------------------------------------- */

  // Whether the merchant explicitly toggled "Assign product variants" for the
  // currently selected product — resets on every product change so the
  // context response can apply the spec default (ON when > 1 variant) without
  // overriding a deliberate choice.
  const variantsTouched = useRef(false);

  const selectProduct = (picked: PickedProduct) => {
    if (generating) return;
    setProduct(picked);
    variantsTouched.current = false;
    setAssignVariants(picked.variants.length > 1);
    setSummary(null);
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

  /* ---- Config assembly & validation -------------------------------------- */

  const countNumber = useMemo(() => {
    const n = Number.parseInt(countText, 10);
    return Number.isFinite(n) ? n : NaN;
  }, [countText]);

  const distributionPreview = useMemo(() => {
    const n =
      Number.isFinite(countNumber) && countNumber >= 1
        ? Math.min(MAX_PER_BATCH, countNumber)
        : 20;
    const counts = previewStarDistribution(n, targetAverage);
    const sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
    return { counts, total: n, achieved: sum / n };
  }, [countNumber, targetAverage]);

  const validateForm = (): { configJson: string; total: number } | null => {
    const errors: Record<string, string> = {};
    if (!product) errors._ = "Pick a product before generating reviews";
    if (!Number.isFinite(countNumber) || countNumber < 1 || countNumber > MAX_PER_BATCH) {
      errors.count = `Enter a number of reviews between 1 and ${MAX_PER_BATCH}`;
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
    setFormErrors(errors);
    if (Object.keys(errors).length > 0 || !product) return null;

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
      status,
    };
    return { configJson: JSON.stringify(config), total: countNumber };
  };

  /* ---- Generation run (sequential chunks of 8) --------------------------- */

  const submitChunk = (current: GenRun) => {
    genFetcher.submit(
      {
        intent: "generate-chunk",
        config: current.configJson,
        // Hidden field threading the batchId to every chunk after the first.
        batchId: current.batchId,
        start: String(current.completed),
      },
      { method: "post" },
    );
  };

  const startGeneration = () => {
    if (generating || !aiReady) return;
    const validated = validateForm();
    if (!validated || !product) return;
    setSummary(null);
    const initial: GenRun = {
      batchId: "",
      productId: product.id,
      configJson: validated.configJson,
      total: validated.total,
      completed: 0,
      created: 0,
      failed: 0,
      errors: [],
      phase: "chunks",
    };
    setRun(initial);
    submitChunk(initial);
  };

  const lastGenData = useRef<unknown>(null);
  useEffect(() => {
    if (
      genFetcher.state !== "idle" ||
      !genFetcher.data ||
      genFetcher.data === lastGenData.current ||
      !run
    ) {
      return;
    }
    lastGenData.current = genFetcher.data;
    const data = genFetcher.data as {
      ok?: boolean;
      intent?: string;
      message?: string;
      code?: string;
      synced?: boolean;
      syncMessage?: string;
      result?: {
        batchId?: string;
        processed?: number;
        created?: number;
        failed?: number;
        errors?: unknown;
        done?: boolean;
      };
    };

    if (data.intent === "generate-chunk" && run.phase === "chunks") {
      if (data.ok !== true || !data.result) {
        // Hard failure (no AI key / bad config / 500) — stop honestly.
        setSummary({
          batchId: run.batchId,
          created: run.created,
          failed: run.failed,
          errors: [
            ...(run.errors.length ? run.errors : []),
            typeof data.message === "string" && data.message
              ? data.message
              : "The generation failed. Please try again.",
          ].slice(0, MAX_UI_ERRORS),
          syncMessage: null,
          aborted: true,
        });
        setRun(null);
        return;
      }

      const result = data.result;
      const processed = Number.isFinite(result.processed) ? Number(result.processed) : 0;
      const chunkErrors = Array.isArray(result.errors)
        ? result.errors.filter((e): e is string => typeof e === "string")
        : [];
      const next: GenRun = {
        ...run,
        batchId:
          typeof result.batchId === "string" && result.batchId ? result.batchId : run.batchId,
        completed: run.completed + processed,
        created: run.created + (Number.isFinite(result.created) ? Number(result.created) : 0),
        failed: run.failed + (Number.isFinite(result.failed) ? Number(result.failed) : 0),
        errors: [...run.errors, ...chunkErrors].slice(0, MAX_UI_ERRORS),
      };

      const done = result.done === true || processed === 0 || next.completed >= next.total;
      if (!done) {
        setRun(next);
        submitChunk(next);
        return;
      }
      if (next.created > 0) {
        setRun({ ...next, phase: "finalize" });
        genFetcher.submit(
          { intent: "finalize-batch", productId: next.productId, batchId: next.batchId },
          { method: "post" },
        );
      } else {
        // Nothing was created — no aggregates to sync.
        setSummary({
          batchId: next.batchId,
          created: 0,
          failed: next.failed,
          errors: next.errors,
          syncMessage: null,
          aborted: false,
        });
        setRun(null);
      }
      return;
    }

    if (data.intent === "finalize-batch" && run.phase === "finalize") {
      setSummary({
        batchId: run.batchId,
        created: run.created,
        failed: run.failed,
        errors: run.errors,
        syncMessage:
          data.ok !== true
            ? "Reviews were created, but the product rating sync failed — it will refresh on the next moderation action."
            : data.synced === false && typeof data.syncMessage === "string"
              ? data.syncMessage
              : null,
        aborted: false,
      });
      setRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genFetcher.state, genFetcher.data, run]);

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
  const progressPercent = run
    ? Math.min(100, Math.round((run.completed / Math.max(1, run.total)) * 100))
    : 0;
  const contextLoading = contextFetcher.state !== "idle";
  const maxPreviewCount = Math.max(1, ...distributionPreview.counts);

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
        disabled={generating || deleting}
        onClick={() => setDeleteBatchTarget(batch.batchId)}
      >
        Delete batch
      </Button>
    </InlineStack>,
  ]);

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

            {summary ? (
              <Banner
                tone={
                  summary.aborted
                    ? "critical"
                    : summary.failed > 0 || summary.syncMessage
                      ? "warning"
                      : "success"
                }
                title={
                  summary.aborted
                    ? `Generation stopped — ${pluralize(summary.created, "review")} created before the failure`
                    : summary.failed > 0
                      ? `Generated ${pluralize(summary.created, "review")} — ${summary.failed} failed`
                      : `Generated ${pluralize(summary.created, "synthetic review")}`
                }
                onDismiss={() => setSummary(null)}
                action={
                  summary.created > 0 && summary.batchId
                    ? {
                        content: "View in Reviews",
                        onAction: () =>
                          navigate(
                            `/app/reviews?batch=${encodeURIComponent(summary.batchId)}`,
                          ),
                      }
                    : undefined
                }
              >
                <BlockStack gap="100">
                  {summary.errors.length > 0 ? (
                    <BlockStack gap="050">
                      {summary.errors.map((error, index) => (
                        <Text as="p" variant="bodySm" key={index}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  ) : null}
                  {summary.syncMessage ? <Text as="p">{summary.syncMessage}</Text> : null}
                  {(summary.aborted || summary.failed > 0) && summary.created > 0 ? (
                    <Text as="p" variant="bodySm">
                      The partially generated batch is listed below — delete it if you don't
                      want to keep it.
                    </Text>
                  ) : null}
                </BlockStack>
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
                      <Button size="slim" disabled={generating} onClick={openPicker}>
                        Change product
                      </Button>
                    </InlineStack>
                  ) : (
                    <InlineStack gap="200">
                      <Button onClick={openPicker} disabled={generating}>
                        Select product
                      </Button>
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
                          disabled={generating}
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
                      max={MAX_PER_BATCH}
                      autoComplete="off"
                      value={countText}
                      onChange={setCountText}
                      disabled={generating}
                      error={formErrors.count}
                      helpText={`1–${MAX_PER_BATCH} per batch`}
                    />
                    <TextField
                      label="Max helpful votes per review"
                      type="number"
                      min={0}
                      max={1000}
                      autoComplete="off"
                      value={maxVotesText}
                      onChange={setMaxVotesText}
                      disabled={generating}
                      error={formErrors.maxVotes}
                      helpText="Votes follow a long tail — most reviews get 0–1"
                    />
                  </FormLayout.Group>

                  <RangeSlider
                    label={`Average star rating: ${targetAverage.toFixed(1)}`}
                    min={1}
                    max={5}
                    step={0.1}
                    value={targetAverage}
                    disabled={generating}
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
                                  background: "#FFA41C",
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
                      disabled={generating}
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
                      disabled={generating}
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
                      disabled={generating}
                      onChange={setLanguages}
                    />
                    {formErrors.languages ? (
                      <InlineError message={formErrors.languages} fieldID="qa-languages" />
                    ) : null}
                    <Text as="p" variant="bodySm" tone="subdued">
                      Reviews split evenly across the selected languages (with a little
                      jitter). Reviewer names, text and replies follow the assignment.
                    </Text>
                  </BlockStack>

                  <FormLayout.Group>
                    <TextField
                      label="Date range start"
                      type="date"
                      autoComplete="off"
                      value={dateStart}
                      onChange={setDateStart}
                      disabled={generating}
                      error={formErrors.dateStart}
                    />
                    <TextField
                      label="Date range end"
                      type="date"
                      autoComplete="off"
                      value={dateEnd}
                      onChange={setDateEnd}
                      disabled={generating}
                      error={formErrors.dateEnd}
                      helpText="Review dates spread across the range with a mild recency bias"
                    />
                  </FormLayout.Group>

                  <FormLayout.Group>
                    <Checkbox
                      label="Assign product variants"
                      checked={assignVariants}
                      disabled={generating || (product?.variants.length ?? 0) === 0}
                      onChange={(checked) => {
                        variantsTouched.current = true;
                        setAssignVariants(checked);
                      }}
                      helpText={
                        (product?.variants.length ?? 0) === 0
                          ? "This product has no variants"
                          : "Weighted randomly across the real variants; some reviews get none"
                      }
                    />
                    <Checkbox
                      label="Fill structured attributes"
                      checked={structuredAttrs}
                      disabled={generating}
                      onChange={setStructuredAttrs}
                      helpText="Age, skin concerns, time using and results seen — coherent with each rating"
                    />
                  </FormLayout.Group>

                  <Select
                    label="Status at creation"
                    options={[
                      { label: "Published", value: "PUBLISHED" },
                      { label: "Pending", value: "PENDING" },
                    ]}
                    value={status}
                    disabled={generating}
                    onChange={(value) => setStatus(value === "PENDING" ? "PENDING" : "PUBLISHED")}
                  />
                </FormLayout>

                {run ? (
                  <BlockStack gap="200">
                    <div role="status">
                      <Text as="p" fontWeight="semibold">
                        {run.phase === "finalize"
                          ? "Updating product rating and metafields…"
                          : `Generating ${Math.min(run.completed + 1, run.total)} of ${run.total}…`}
                      </Text>
                    </div>
                    <ProgressBar progress={progressPercent} size="small" />
                  </BlockStack>
                ) : null}

                <InlineStack gap="200" blockAlign="center">
                  <Button
                    variant="primary"
                    onClick={startGeneration}
                    loading={generating}
                    disabled={!aiReady || generating || !product || contextLoading}
                  >
                    {Number.isFinite(countNumber) && countNumber >= 1
                      ? `Generate ${pluralize(Math.min(countNumber, MAX_PER_BATCH), "review")}`
                      : "Generate reviews"}
                  </Button>
                  {!aiReady ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Add the Anthropic API key in Settings to enable the generator.
                    </Text>
                  ) : null}
                </InlineStack>
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
                    disabled={typedStats.total === 0 || generating || deleting}
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

      {/* ---- Delete one batch ------------------------------------------- */}
      <ConfirmationModal
        open={deleteBatchTarget !== null}
        title="Delete this synthetic batch?"
        message={
          targetBatch
            ? `This permanently deletes ${pluralize(targetBatch.count, "synthetic review")} for “${targetBatch.productTitle ?? `Product ${targetBatch.productId}`}”. The product rating updates automatically.`
            : "This permanently deletes every review in this batch. The product rating updates automatically."
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
              all batches, including their media, votes and cached translations. Affected
              product ratings update automatically. This cannot be undone.
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
