/**
 * Cellexia Reviews — Bulk add (SPEC-1.4 §B).
 *
 * Lets the merchant enter many reviews for ONE product directly in the admin —
 * no CSV file. Flow:
 *
 *   1. Pick a product (App Bridge v4 `shopify.resourcePicker`; when the picker
 *      is unavailable, a plain Select over the loader's first 100 products).
 *   2. Compose reviews in a full composer card (rating, title, body, author,
 *      email, date, verified, language, variant, structured attributes,
 *      reply + reply date, media: up to 5 image URLs + 1 video URL *and*
 *      DropZone uploads that go through `uploadReviewMedia` in the admin
 *      context — URL and uploaded media can mix, ≤ 5 images + 1 video total).
 *   3. "Add to list" stages rows client-side (IndexTable with Edit / Remove;
 *      leaving the page warns via `beforeunload` while the list is non-empty).
 *   4. "Save N reviews" submits sequential chunks of 25 through
 *      `importRows(..., { source: "bulk-add" })` with a progress readout;
 *      per-row errors surface back into the staging list (failed rows stay,
 *      saved rows clear), then a finalize step re-syncs the product's
 *      aggregates + metafields once.
 *
 * Multi-product migrations belong in the CSV import (said so in the help text).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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
  DropZone,
  FormLayout,
  InlineError,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Text,
  TextField,
  IndexTable,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import {
  AGE_RANGES,
  MAX_AUTHOR_NAME_LENGTH,
  MAX_BODY_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REVIEW,
  MAX_TITLE_LENGTH,
  MAX_VIDEO_BYTES,
  MAX_VIDEOS_PER_REVIEW,
  RESULTS_SEEN,
  SHOP_LOCALES,
  SKIN_CONCERNS,
  TIME_USING,
} from "~/types/cellexia";
import { importRows } from "~/services/import.server";
import type { ImportMediaInput, ImportRowInput } from "~/services/import.server";
import { uploadReviewMedia } from "~/services/files.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { StarRating } from "~/components/admin/StarRating";
import { useResultToast } from "~/components/admin/useResultToast";
import {
  AGE_RANGE_LABELS,
  LOCALE_LABELS,
  RESULTS_SEEN_LABELS,
  SKIN_CONCERN_LABELS,
  TIME_USING_LABELS,
  formatDate,
  pluralize,
} from "~/components/admin/labels";

/* ------------------------------------------------------------------------- *
 * Constants & shared shapes
 * ------------------------------------------------------------------------- */

/** Reviews saved per chunk (SPEC-1.4 §B). */
const SAVE_CHUNK_SIZE = 25;
/** Hard cap on the staging list so a runaway session can't OOM the browser. */
const MAX_STAGED_ROWS = 1000;

const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;
const VIDEO_MIME = ["video/mp4", "video/quicktime", "video/webm"];
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;

interface StagedMediaItem {
  clientId: string;
  type: "IMAGE" | "VIDEO";
  /** "url" = external URL typed in; "upload" = file already in Shopify Files. */
  kind: "url" | "upload";
  url?: string;
  fileGid?: string;
  fileName?: string;
}

interface StagedReview {
  clientId: string;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** YYYY-MM-DD. */
  date: string;
  verified: boolean;
  language: string;
  variantTitle: string;
  ageRange: string;
  skinConcerns: string[];
  timeUsing: string;
  resultsSeen: string[];
  reply: string;
  /** YYYY-MM-DD or "". */
  replyDate: string;
  media: StagedMediaItem[];
  /** Server-side error from the last save attempt, if any. */
  error?: string | null;
}

interface PickedProduct {
  /** Numeric Shopify product id as a string. */
  id: string;
  title: string;
  handle: string | null;
  variants: string[];
}

/* ------------------------------------------------------------------------- *
 * Loader — fallback product list for when the resource picker is unavailable
 * ------------------------------------------------------------------------- */

const PRODUCTS_QUERY = `#graphql
  query CellexiaBulkAddProducts {
    products(first: 100, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        status
      }
    }
  }
`;

const PRODUCT_DETAILS_QUERY = `#graphql
  query CellexiaBulkAddProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  // Best-effort: a GraphQL hiccup must not break the page — the resource
  // picker is the primary selection path and works without this list.
  let products: Array<{ id: string; title: string; handle: string | null }> = [];
  let productListError = false;
  try {
    const response = await admin.graphql(PRODUCTS_QUERY);
    const body = (await response.json()) as {
      data?: {
        products?: {
          nodes?: Array<{
            id?: string;
            title?: string;
            handle?: string | null;
            status?: string;
          }>;
        };
      };
      errors?: unknown;
    };
    if (body.errors) {
      console.error("[cellexia] bulk-add product list query errors:", body.errors);
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
    console.error("[cellexia] bulk-add product list failed", error);
    productListError = true;
  }

  return json({ products, productListError });
};

/* ------------------------------------------------------------------------- *
 * Action — product details, media uploads, chunked save, finalize
 * ------------------------------------------------------------------------- */

interface SaveRowFailure {
  clientId: string;
  message: string;
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function keyArray(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const key of value) {
    if (typeof key === "string" && allowed.includes(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

/** Parses "YYYY-MM-DD" (or a full ISO timestamp) into an ISO string, or null. */
function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T12:00:00.000Z`)
    : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Server-side re-validation of one staged row coming from the client, shaped
 * as a typed `ImportRowInput` for `importRows` (SPEC-1.4 §A). `rowNumber` is
 * echoed back in `RowError.row`, which lets the route address failures to the
 * exact staged row. This runs in addition to `importRows`' own validation so a
 * malformed payload can never reach the import machinery in a surprising
 * shape — and so the merchant gets a specific message instead of a generic
 * "malformed row".
 */
function sanitizeStagedRow(
  value: unknown,
  productId: string,
  rowNumber: number,
): { row: ImportRowInput | null; error: string | null } {
  if (typeof value !== "object" || value === null) {
    return { row: null, error: "Malformed row payload" };
  }
  const v = value as Record<string, unknown>;

  const rating = Math.round(Number(v.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { row: null, error: "Rating must be between 1 and 5" };
  }
  const body = str(v.body, MAX_BODY_LENGTH);
  if (!body) return { row: null, error: "The review body is required" };
  const authorName = str(v.authorName, MAX_AUTHOR_NAME_LENGTH);
  if (!authorName) return { row: null, error: "The reviewer name is required" };

  const emailRaw = str(v.authorEmail, 254).toLowerCase();
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return { row: null, error: "The email address is not valid" };
  }

  const languageRaw = str(v.language, 10);
  const language =
    (SHOP_LOCALES as readonly string[]).find(
      (locale) => locale.toLowerCase() === languageRaw.toLowerCase(),
    ) ?? "en";

  const createdAt = isoDateOrNull(v.date);
  const replyText = str(v.reply, MAX_BODY_LENGTH);
  // When a reply has no explicit date, importRows defaults it to the review
  // date + 2 days — pass null and let that single implementation apply.
  const replyAt = replyText ? isoDateOrNull(v.replyDate) : null;

  // Media: uploaded files carry a Shopify File GID, typed URLs stay external.
  // `ImportRowInput.media` overrides the CSV URL columns inside importRows.
  const media: ImportMediaInput[] = [];
  let images = 0;
  let videos = 0;
  if (Array.isArray(v.media)) {
    for (const item of v.media) {
      if (typeof item !== "object" || item === null) continue;
      const m = item as Record<string, unknown>;
      const type = m.type === "VIDEO" ? "VIDEO" : m.type === "IMAGE" ? "IMAGE" : null;
      if (!type) continue;
      const fileGid =
        typeof m.fileGid === "string" && m.fileGid.startsWith("gid://shopify/")
          ? m.fileGid
          : null;
      const url = isHttpUrl(m.url) ? m.url : null;
      if (!fileGid && !url) continue;
      if (type === "IMAGE" && images >= MAX_IMAGES_PER_REVIEW) continue;
      if (type === "VIDEO" && videos >= MAX_VIDEOS_PER_REVIEW) continue;
      if (type === "IMAGE") images += 1;
      else videos += 1;
      media.push({ type, fileGid, url, thumbUrl: null });
    }
  }

  const ageRangeRaw = str(v.ageRange, 20);
  const timeUsingRaw = str(v.timeUsing, 20);
  const countryRaw = str(v.country, 2);
  const imageUrls = media
    .filter((m) => m.type === "IMAGE" && m.url)
    .map((m) => m.url as string);
  const videoUrl = media.find((m) => m.type === "VIDEO" && m.url)?.url ?? null;

  const row: ImportRowInput = {
    row: rowNumber,
    productId,
    productHandle: null,
    productTitle: null,
    rating,
    title: str(v.title, MAX_TITLE_LENGTH) || null,
    body,
    authorName,
    authorEmail: emailRaw || null,
    createdAt,
    verified: v.verified === true || v.verified === "true",
    language,
    country: /^[A-Za-z]{2}$/.test(countryRaw) ? countryRaw.toUpperCase() : null,
    variantTitle: str(v.variantTitle, 120) || null,
    ageRange: (AGE_RANGES as readonly string[]).includes(ageRangeRaw) ? ageRangeRaw : null,
    skinConcerns: keyArray(v.skinConcerns, SKIN_CONCERNS),
    timeUsing: (TIME_USING as readonly string[]).includes(timeUsingRaw) ? timeUsingRaw : null,
    resultsSeen: keyArray(v.resultsSeen, RESULTS_SEEN),
    helpfulCount: 0,
    reply: replyText || null,
    replyAt,
    imageUrls,
    videoUrl,
    // The save-time status select applies to the whole run via defaultStatus.
    status: null,
    ...(media.length ? { media } : {}),
  };
  return { row, error: null };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    console.error("[cellexia] bulk-add form parse failed", error);
    return json(
      { ok: false, message: "The request could not be read. Please try again." },
      { status: 400 },
    );
  }
  const intent = String(form.get("intent") ?? "");

  try {
    /* ---- Product details (title / handle / variants) -------------------- */
    if (intent === "product-details") {
      const productId = numericIdFromGid(String(form.get("productId") ?? ""));
      if (!productId) {
        return json({ ok: false, intent, message: "Invalid product reference" }, { status: 400 });
      }
      const response = await admin.graphql(PRODUCT_DETAILS_QUERY, {
        variables: { id: `gid://shopify/Product/${productId}` },
      });
      const body = (await response.json()) as {
        data?: {
          product?: {
            id?: string;
            title?: string;
            handle?: string | null;
            variants?: { nodes?: Array<{ title?: string | null }> };
          } | null;
        };
        errors?: unknown;
      };
      if (body.errors || !body.data?.product) {
        if (body.errors) {
          console.error("[cellexia] bulk-add product details errors:", body.errors);
        }
        return json(
          { ok: false, intent, message: "The product could not be loaded" },
          { status: 404 },
        );
      }
      const product = body.data.product;
      const variants = (product.variants?.nodes ?? [])
        .map((node) => (typeof node?.title === "string" ? node.title.trim() : ""))
        // Shopify's placeholder variant on single-variant products.
        .filter((title) => title && title !== "Default Title");
      return json({
        ok: true,
        intent,
        product: {
          id: productId,
          title: product.title ?? "",
          handle: product.handle ?? null,
          variants,
        },
      });
    }

    /* ---- Media upload (DropZone → Shopify Files) ------------------------ */
    if (intent === "upload-media") {
      const clientId = str(form.get("clientId"), 64);
      const type = form.get("type") === "VIDEO" ? "VIDEO" : "IMAGE";
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return json(
          { ok: false, intent, clientId, message: "No file received" },
          { status: 400 },
        );
      }
      // Same caps as the storefront submission path (SPEC §6).
      const maxBytes = type === "VIDEO" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (file.size > maxBytes) {
        return json(
          {
            ok: false,
            intent,
            clientId,
            message: `The file is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`,
          },
          { status: 422 },
        );
      }
      const mime = (file.type || "").toLowerCase();
      const name = file.name || "";
      const typeOk =
        type === "VIDEO"
          ? VIDEO_MIME.includes(mime) || VIDEO_EXT.test(name)
          : IMAGE_MIME.includes(mime) || IMAGE_EXT.test(name);
      if (!typeOk) {
        return json(
          {
            ok: false,
            intent,
            clientId,
            message:
              type === "VIDEO"
                ? "Videos must be MP4, MOV or WebM"
                : "Images must be JPEG, PNG, WebP or HEIC",
          },
          { status: 422 },
        );
      }
      const { fileGid } = await uploadReviewMedia(admin, file, type);
      return json({
        ok: true,
        intent,
        clientId,
        type,
        fileGid,
        fileName: name || (type === "VIDEO" ? "video" : "image"),
      });
    }

    /* ---- One chunk of staged rows → importRows -------------------------- */
    if (intent === "save-chunk") {
      const productId = numericIdFromGid(String(form.get("productId") ?? ""));
      if (!productId) {
        return json({ ok: false, intent, message: "Pick a product first" }, { status: 400 });
      }
      // Fail safe (matches importRows): anything unexpected lands in
      // moderation rather than live on the storefront.
      const defaultStatus =
        form.get("defaultStatus") === "PUBLISHED" ? ("PUBLISHED" as const) : ("PENDING" as const);

      let rawRows: unknown[] = [];
      let clientIds: string[] = [];
      try {
        const parsedRows = JSON.parse(String(form.get("rows") ?? "[]"));
        const parsedIds = JSON.parse(String(form.get("clientIds") ?? "[]"));
        if (Array.isArray(parsedRows)) rawRows = parsedRows.slice(0, SAVE_CHUNK_SIZE);
        if (Array.isArray(parsedIds)) {
          clientIds = parsedIds
            .filter((id): id is string => typeof id === "string")
            .slice(0, SAVE_CHUNK_SIZE);
        }
      } catch {
        return json(
          { ok: false, intent, message: "The rows payload could not be parsed" },
          { status: 400 },
        );
      }
      if (!rawRows.length || rawRows.length !== clientIds.length) {
        return json(
          { ok: false, intent, message: "No valid rows in this chunk" },
          { status: 400 },
        );
      }

      const failed: SaveRowFailure[] = [];
      const validRows: ImportRowInput[] = [];
      const validClientIds: string[] = [];
      rawRows.forEach((raw, index) => {
        // `row` numbers are 1-based positions in validRows; importRows echoes
        // them back in RowError.row, which maps errors to staged rows exactly.
        const { row, error } = sanitizeStagedRow(raw, productId, validRows.length + 1);
        if (row) {
          validRows.push(row);
          validClientIds.push(clientIds[index]);
        } else {
          failed.push({ clientId: clientIds[index], message: error ?? "Invalid row" });
        }
      });

      let created = 0;
      let skippedDuplicates = 0;
      if (validRows.length) {
        const result = await importRows(shop, admin, validRows, {
          defaultStatus,
          source: "bulk-add",
        });
        created = Number.isFinite(result.created) ? result.created : 0;
        skippedDuplicates = Number.isFinite(result.skippedDuplicates)
          ? result.skippedDuplicates
          : 0;
        for (const rowError of result.errors ?? []) {
          const n = Number(rowError?.row);
          const index =
            Number.isInteger(n) && n >= 1 && n <= validRows.length ? n - 1 : null;
          const message =
            typeof rowError?.message === "string" && rowError.message
              ? rowError.message
              : "This review could not be saved";
          if (index !== null) {
            const clientId = validClientIds[index];
            if (!failed.some((f) => f.clientId === clientId)) {
              failed.push({ clientId, message });
            }
          } else {
            console.error("[cellexia] bulk-add unmappable row error:", rowError);
          }
        }
      }

      return json({ ok: true, intent, created, skippedDuplicates, failed });
    }

    /* ---- Finalize: aggregates + metafields re-sync once ----------------- */
    if (intent === "finalize") {
      const productId = numericIdFromGid(String(form.get("productId") ?? ""));
      if (!productId) {
        return json({ ok: false, intent, message: "Invalid product reference" }, { status: 400 });
      }
      try {
        await syncProductData(shop, productId, admin);
        return json({ ok: true, intent, synced: true });
      } catch (error) {
        // Reviews are already saved — report the sync failure honestly but
        // don't fail the whole save.
        console.error(`[cellexia] bulk-add aggregate sync failed for ${productId}`, error);
        return json({
          ok: true,
          intent,
          synced: false,
          message:
            "Reviews saved, but the product rating sync failed — it will refresh on the next moderation action.",
        });
      }
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[cellexia] bulk-add action failed", error);
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

function makeClientId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the counter-based id
  }
  return `cx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface ComposerState {
  rating: number;
  title: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  verified: boolean;
  language: string;
  variantTitle: string;
  ageRange: string;
  skinConcerns: string[];
  timeUsing: string;
  resultsSeen: string[];
  reply: string;
  replyDate: string;
  /** External image URL inputs (≤ 5 combined with uploads). */
  imageUrls: string[];
  videoUrl: string;
  /** Files already uploaded to Shopify Files via the DropZone. */
  uploads: StagedMediaItem[];
}

function emptyComposer(previous?: ComposerState): ComposerState {
  return {
    rating: 0,
    title: "",
    body: "",
    authorName: "",
    authorEmail: "",
    // Convenience for bulk entry: sticky date / language / verified / variant.
    date: previous?.date ?? todayIso(),
    verified: previous?.verified ?? false,
    language: previous?.language ?? "en",
    variantTitle: previous?.variantTitle ?? "",
    ageRange: "",
    skinConcerns: [],
    timeUsing: "",
    resultsSeen: [],
    reply: "",
    replyDate: "",
    imageUrls: [],
    videoUrl: "",
    uploads: [],
  };
}

/** Splits a staged row back into composer state for the Edit action. */
function composerFromStaged(row: StagedReview): ComposerState {
  return {
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    date: row.date,
    verified: row.verified,
    language: row.language,
    variantTitle: row.variantTitle,
    ageRange: row.ageRange,
    skinConcerns: [...row.skinConcerns],
    timeUsing: row.timeUsing,
    resultsSeen: [...row.resultsSeen],
    reply: row.reply,
    replyDate: row.replyDate,
    imageUrls: row.media
      .filter((m) => m.kind === "url" && m.type === "IMAGE" && m.url)
      .map((m) => m.url as string),
    videoUrl: row.media.find((m) => m.kind === "url" && m.type === "VIDEO")?.url ?? "",
    uploads: row.media.filter((m) => m.kind === "upload"),
  };
}

/** Extracts a PickedProduct from an App Bridge resourcePicker payload. */
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
    variants,
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function classifyDroppedFile(file: File): "IMAGE" | "VIDEO" | null {
  const mime = (file.type || "").toLowerCase();
  const name = file.name || "";
  if (IMAGE_MIME.includes(mime) || IMAGE_EXT.test(name)) return "IMAGE";
  if (VIDEO_MIME.includes(mime) || VIDEO_EXT.test(name)) return "VIDEO";
  return null;
}

/* ------------------------------------------------------------------------- *
 * Small presentational components
 * ------------------------------------------------------------------------- */

const PICKER_STAR_PATH =
  "M12 1.9l2.98 6.05 6.68.97-4.83 4.71 1.14 6.65L12 17.14l-5.97 3.14 1.14-6.65-4.83-4.71 6.68-.97L12 1.9z";

function StarPicker({
  value,
  onChange,
  disabled,
  error,
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
  error?: string;
}) {
  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodyMd" fontWeight="medium">
        Rating
      </Text>
      <InlineStack gap="100" blockAlign="center">
        <span role="radiogroup" aria-label="Star rating" style={{ display: "inline-flex", gap: 2 }}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={value === star}
              aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
              disabled={disabled}
              onClick={() => onChange(star)}
              style={{
                background: "none",
                border: "none",
                padding: 2,
                margin: 0,
                cursor: disabled ? "default" : "pointer",
                lineHeight: 0,
                color: star <= value ? "#FF6200" : "#D5D9D9",
              }}
            >
              <svg
                width={26}
                height={26}
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                <path d={PICKER_STAR_PATH} />
              </svg>
            </button>
          ))}
        </span>
        {value > 0 ? (
          <Text as="span" variant="bodySm" tone="subdued">
            {value} of 5
          </Text>
        ) : null}
      </InlineStack>
      {error ? <InlineError message={error} fieldID="bulk-add-rating" /> : null}
    </BlockStack>
  );
}

function MediaCountBadge({ media }: { media: StagedMediaItem[] }) {
  if (!media.length) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        —
      </Text>
    );
  }
  const images = media.filter((m) => m.type === "IMAGE").length;
  const videos = media.filter((m) => m.type === "VIDEO").length;
  const parts: string[] = [];
  if (images) parts.push(`${images} ${images === 1 ? "image" : "images"}`);
  if (videos) parts.push(`${videos} video`);
  return (
    <Text as="span" variant="bodySm">
      {parts.join(" + ")}
    </Text>
  );
}

/* ------------------------------------------------------------------------- *
 * Save-run state machine shapes
 * ------------------------------------------------------------------------- */

interface SaveRun {
  productId: string;
  status: "PUBLISHED" | "PENDING";
  chunks: StagedReview[][];
  /** Index of the chunk currently in flight. */
  index: number;
  total: number;
  processed: number;
  created: number;
  duplicates: number;
  failed: number;
  phase: "chunks" | "finalize";
}

interface SaveSummary {
  created: number;
  duplicates: number;
  failed: number;
  syncMessage: string | null;
  aborted: boolean;
}

interface PendingUpload {
  clientId: string;
  type: "IMAGE" | "VIDEO";
  file: File;
}

function countImages(composer: ComposerState): number {
  return (
    composer.imageUrls.filter((url) => url.trim()).length +
    composer.uploads.filter((item) => item.type === "IMAGE").length
  );
}

function countVideos(composer: ComposerState): number {
  return (
    (composer.videoUrl.trim() ? 1 : 0) +
    composer.uploads.filter((item) => item.type === "VIDEO").length
  );
}

function validateComposer(composer: ComposerState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (composer.rating < 1 || composer.rating > 5) {
    errors.rating = "Select a star rating";
  }
  if (!composer.body.trim()) {
    errors.body = "The review body is required";
  } else if (composer.body.length > MAX_BODY_LENGTH) {
    errors.body = `The review body can be at most ${MAX_BODY_LENGTH} characters`;
  }
  if (!composer.authorName.trim()) {
    errors.authorName = "The reviewer name is required";
  }
  const email = composer.authorEmail.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.authorEmail = "Enter a valid email address";
  }
  if (!composer.date || Number.isNaN(new Date(composer.date).getTime())) {
    errors.date = "Enter a valid review date";
  }
  if (composer.replyDate && Number.isNaN(new Date(composer.replyDate).getTime())) {
    errors.replyDate = "Enter a valid reply date";
  }
  composer.imageUrls.forEach((url, index) => {
    const trimmed = url.trim();
    if (trimmed && !isValidHttpUrl(trimmed)) {
      errors[`imageUrl${index}`] = "Enter a full http(s) URL";
    }
  });
  const video = composer.videoUrl.trim();
  if (video && !isValidHttpUrl(video)) {
    errors.videoUrl = "Enter a full http(s) URL";
  }
  if (countImages(composer) > MAX_IMAGES_PER_REVIEW) {
    errors.media = `A review can have at most ${MAX_IMAGES_PER_REVIEW} images (URLs and uploads combined)`;
  }
  if (countVideos(composer) > MAX_VIDEOS_PER_REVIEW) {
    errors.media = "A review can have at most 1 video (URL or upload)";
  }
  return errors;
}

function buildStagedRow(composer: ComposerState, clientId: string): StagedReview {
  const media: StagedMediaItem[] = [];
  for (const url of composer.imageUrls.map((u) => u.trim()).filter(Boolean)) {
    media.push({ clientId: makeClientId(), type: "IMAGE", kind: "url", url });
  }
  for (const upload of composer.uploads.filter((u) => u.type === "IMAGE")) {
    media.push(upload);
  }
  const videoUrl = composer.videoUrl.trim();
  if (videoUrl) {
    media.push({ clientId: makeClientId(), type: "VIDEO", kind: "url", url: videoUrl });
  }
  for (const upload of composer.uploads.filter((u) => u.type === "VIDEO")) {
    media.push(upload);
  }
  return {
    clientId,
    rating: composer.rating,
    title: composer.title.trim(),
    body: composer.body.trim(),
    authorName: composer.authorName.trim(),
    authorEmail: composer.authorEmail.trim(),
    date: composer.date,
    verified: composer.verified,
    language: composer.language,
    variantTitle: composer.variantTitle,
    ageRange: composer.ageRange,
    skinConcerns: [...composer.skinConcerns],
    timeUsing: composer.timeUsing,
    resultsSeen: [...composer.resultsSeen],
    reply: composer.reply.trim(),
    replyDate: composer.replyDate,
    media,
    error: null,
  };
}

/** JSON payload for one staged row, as sent to the save-chunk action. */
function rowPayload(row: StagedReview): Record<string, unknown> {
  return {
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    date: row.date,
    verified: row.verified,
    language: row.language,
    variantTitle: row.variantTitle,
    ageRange: row.ageRange,
    skinConcerns: row.skinConcerns,
    timeUsing: row.timeUsing,
    resultsSeen: row.resultsSeen,
    reply: row.reply,
    replyDate: row.replyDate,
    media: row.media.map((item) => ({
      type: item.type,
      fileGid: item.fileGid ?? null,
      url: item.url ?? null,
    })),
  };
}

/* ------------------------------------------------------------------------- *
 * Route component
 * ------------------------------------------------------------------------- */

export default function BulkAddRoute() {
  const { products, productListError } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const detailsFetcher = useFetcher<typeof action>();
  const uploadFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();

  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [pickerUnavailable, setPickerUnavailable] = useState(false);
  const [composer, setComposer] = useState<ComposerState>(() => emptyComposer());
  const [composerErrors, setComposerErrors] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedReview[]>([]);
  const [defaultStatus, setDefaultStatus] = useState<"PUBLISHED" | "PENDING">("PUBLISHED");
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadNotices, setUploadNotices] = useState<string[]>([]);
  const [saveRun, setSaveRun] = useState<SaveRun | null>(null);
  const [summary, setSummary] = useState<SaveSummary | null>(null);

  // Error results from all three fetchers carry `{ ok:false, message }` and
  // surface as error toasts; successful ones are silent (no `message`) except
  // the finalize sync warning.
  useResultToast(detailsFetcher);
  useResultToast(uploadFetcher);
  useResultToast(saveFetcher);

  const saving = saveRun !== null;

  /* ---- Leaving-the-page guard while work would be lost ------------------ */
  useEffect(() => {
    const dirty = staged.length > 0 || saving || pendingUploads.length > 0;
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [staged.length, saving, pendingUploads.length]);

  /* ---- Product selection ------------------------------------------------ */

  const selectProduct = (picked: PickedProduct) => {
    if (staged.length > 0 || saving) return;
    setProduct(picked);
    setComposer((prev) => ({ ...prev, variantTitle: "" }));
    setSummary(null);
    detailsFetcher.submit(
      { intent: "product-details", productId: picked.id },
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
      if (raw == null) return; // merchant cancelled the picker
      const picked = parsePickerSelection(raw);
      if (picked) selectProduct(picked);
    } catch (error) {
      console.error("[cellexia] resourcePicker failed — falling back to the product select", error);
      setPickerUnavailable(true);
    }
  };

  // Authoritative product details (title / handle / variants) from the server.
  const lastDetailsData = useRef<unknown>(null);
  useEffect(() => {
    if (
      detailsFetcher.state !== "idle" ||
      !detailsFetcher.data ||
      detailsFetcher.data === lastDetailsData.current
    ) {
      return;
    }
    lastDetailsData.current = detailsFetcher.data;
    const data = detailsFetcher.data as {
      ok?: boolean;
      intent?: string;
      product?: { id?: string; title?: string; handle?: string | null; variants?: unknown };
    };
    if (data.intent !== "product-details" || !data.ok || !data.product) return;
    const incoming = data.product;
    if (typeof incoming.id !== "string") return;
    setProduct((prev) => {
      if (!prev || prev.id !== incoming.id) return prev; // stale response
      return {
        id: incoming.id,
        title:
          typeof incoming.title === "string" && incoming.title ? incoming.title : prev.title,
        handle: typeof incoming.handle === "string" ? incoming.handle : prev.handle,
        variants: Array.isArray(incoming.variants)
          ? incoming.variants.filter((t): t is string => typeof t === "string")
          : prev.variants,
      };
    });
  }, [detailsFetcher.state, detailsFetcher.data]);

  /* ---- Upload queue (one file at a time through uploadReviewMedia) ------ */

  const activeUploadId = useRef<string | null>(null);
  const lastUploadData = useRef<unknown>(null);

  // Process finished uploads first…
  useEffect(() => {
    if (
      uploadFetcher.state !== "idle" ||
      !uploadFetcher.data ||
      uploadFetcher.data === lastUploadData.current
    ) {
      return;
    }
    lastUploadData.current = uploadFetcher.data;
    const data = uploadFetcher.data as {
      ok?: boolean;
      intent?: string;
      clientId?: string;
      type?: string;
      fileGid?: string;
      fileName?: string;
    };
    if (data.intent !== "upload-media") return;
    const clientId = typeof data.clientId === "string" && data.clientId ? data.clientId : null;
    if (data.ok && clientId && typeof data.fileGid === "string") {
      const type = data.type === "VIDEO" ? ("VIDEO" as const) : ("IMAGE" as const);
      setComposer((prev) => {
        // Re-check the caps — a URL may have been typed while uploading.
        if (type === "IMAGE" && countImages(prev) >= MAX_IMAGES_PER_REVIEW) return prev;
        if (type === "VIDEO" && countVideos(prev) >= MAX_VIDEOS_PER_REVIEW) return prev;
        return {
          ...prev,
          uploads: [
            ...prev.uploads,
            {
              clientId,
              type,
              kind: "upload",
              fileGid: data.fileGid,
              fileName: typeof data.fileName === "string" ? data.fileName : undefined,
            },
          ],
        };
      });
    }
    // Failures were already toasted by useResultToast — just advance the queue.
    setPendingUploads((prev) =>
      clientId ? prev.filter((item) => item.clientId !== clientId) : prev.slice(1),
    );
    activeUploadId.current = null;
  }, [uploadFetcher.state, uploadFetcher.data]);

  // …then submit the next queued file.
  useEffect(() => {
    if (uploadFetcher.state !== "idle" || activeUploadId.current) return;
    const next = pendingUploads[0];
    if (!next) return;
    activeUploadId.current = next.clientId;
    const form = new FormData();
    form.append("intent", "upload-media");
    form.append("clientId", next.clientId);
    form.append("type", next.type);
    form.append("file", next.file, next.file.name);
    uploadFetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  }, [pendingUploads, uploadFetcher]);

  const handleDrop = useCallback(
    (_dropped: File[], accepted: File[], rejected: File[]) => {
      const notices: string[] = [];
      let images =
        countImages(composer) + pendingUploads.filter((p) => p.type === "IMAGE").length;
      let videos =
        countVideos(composer) + pendingUploads.filter((p) => p.type === "VIDEO").length;
      const additions: PendingUpload[] = [];
      for (const file of accepted) {
        const type = classifyDroppedFile(file);
        if (!type) {
          notices.push(`${file.name}: unsupported file type`);
          continue;
        }
        if (type === "IMAGE" && file.size > MAX_IMAGE_BYTES) {
          notices.push(`${file.name}: images can be at most 8 MB`);
          continue;
        }
        if (type === "VIDEO" && file.size > MAX_VIDEO_BYTES) {
          notices.push(`${file.name}: videos can be at most 80 MB`);
          continue;
        }
        if (type === "IMAGE" && images >= MAX_IMAGES_PER_REVIEW) {
          notices.push(`${file.name}: a review can have at most ${MAX_IMAGES_PER_REVIEW} images`);
          continue;
        }
        if (type === "VIDEO" && videos >= MAX_VIDEOS_PER_REVIEW) {
          notices.push(`${file.name}: a review can have at most 1 video`);
          continue;
        }
        if (type === "IMAGE") images += 1;
        else videos += 1;
        additions.push({ clientId: makeClientId(), type, file });
      }
      for (const file of rejected) {
        notices.push(`${file.name}: unsupported file type`);
      }
      if (additions.length) setPendingUploads((prev) => [...prev, ...additions]);
      setUploadNotices(notices);
    },
    [composer, pendingUploads],
  );

  /* ---- Staging list ----------------------------------------------------- */

  const addToList = () => {
    const errors = validateComposer(composer);
    if (pendingUploads.length > 0) {
      errors.media = "Wait for the media uploads to finish first";
    }
    if (!product) {
      errors._ = "Choose a product before adding reviews to the list";
    }
    if (!editingId && staged.length >= MAX_STAGED_ROWS) {
      errors._ = `The list is limited to ${MAX_STAGED_ROWS} reviews per save — save these first`;
    }
    setComposerErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const row = buildStagedRow(composer, editingId ?? makeClientId());
    setStaged((prev) =>
      editingId ? prev.map((r) => (r.clientId === editingId ? row : r)) : [...prev, row],
    );
    setEditingId(null);
    setComposer(emptyComposer(composer));
    setComposerErrors({});
  };

  const editRow = (clientId: string) => {
    if (saving) return;
    const row = staged.find((r) => r.clientId === clientId);
    if (!row) return;
    setEditingId(clientId);
    setComposer(composerFromStaged(row));
    setComposerErrors({});
    setUploadNotices([]);
    if (typeof document !== "undefined") {
      document
        .getElementById("bulk-add-composer")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const removeRow = (clientId: string) => {
    if (saving) return;
    setStaged((prev) => prev.filter((r) => r.clientId !== clientId));
    if (editingId === clientId) {
      setEditingId(null);
      setComposer(emptyComposer(composer));
      setComposerErrors({});
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
    setComposer(emptyComposer(composer));
    setComposerErrors({});
  };

  /* ---- Chunked save through importRows ---------------------------------- */

  const submitChunk = (run: SaveRun, index: number) => {
    const chunk = run.chunks[index];
    saveFetcher.submit(
      {
        intent: "save-chunk",
        productId: run.productId,
        defaultStatus: run.status,
        rows: JSON.stringify(chunk.map(rowPayload)),
        clientIds: JSON.stringify(chunk.map((r) => r.clientId)),
      },
      { method: "post" },
    );
  };

  const startSave = () => {
    if (!product || staged.length === 0 || saving || pendingUploads.length > 0) return;
    const rows = staged.map((r) => ({ ...r, error: null }));
    const chunks: StagedReview[][] = [];
    for (let i = 0; i < rows.length; i += SAVE_CHUNK_SIZE) {
      chunks.push(rows.slice(i, i + SAVE_CHUNK_SIZE));
    }
    setSummary(null);
    setStaged((prev) => prev.map((r) => ({ ...r, error: null })));
    const run: SaveRun = {
      productId: product.id,
      status: defaultStatus,
      chunks,
      index: 0,
      total: rows.length,
      processed: 0,
      created: 0,
      duplicates: 0,
      failed: 0,
      phase: "chunks",
    };
    setSaveRun(run);
    submitChunk(run, 0);
  };

  const lastSaveData = useRef<unknown>(null);
  useEffect(() => {
    if (
      saveFetcher.state !== "idle" ||
      !saveFetcher.data ||
      saveFetcher.data === lastSaveData.current ||
      !saveRun
    ) {
      return;
    }
    lastSaveData.current = saveFetcher.data;
    const data = saveFetcher.data as {
      ok?: boolean;
      intent?: string;
      created?: number;
      skippedDuplicates?: number;
      failed?: Array<{ clientId?: string; message?: string }>;
      synced?: boolean;
      message?: string;
    };

    if (data.intent === "save-chunk" && saveRun.phase === "chunks") {
      const chunk = saveRun.chunks[saveRun.index] ?? [];
      const chunkIds = new Set(chunk.map((r) => r.clientId));

      if (data.ok !== true) {
        // The whole chunk failed (500 / bad payload) — keep its rows with a
        // generic error and stop; already-saved chunks stay saved.
        const message = data.message || "The save failed. Please try again.";
        setStaged((prev) =>
          prev.map((r) => (chunkIds.has(r.clientId) ? { ...r, error: message } : r)),
        );
        setSummary({
          created: saveRun.created,
          duplicates: saveRun.duplicates,
          failed: saveRun.failed + chunk.length,
          syncMessage: null,
          aborted: true,
        });
        setSaveRun(null);
        return;
      }

      const failedById = new Map<string, string>();
      for (const failure of data.failed ?? []) {
        if (typeof failure?.clientId === "string") {
          failedById.set(
            failure.clientId,
            typeof failure.message === "string" && failure.message
              ? failure.message
              : "This review could not be saved",
          );
        }
      }
      // Failed rows stay in the list with their error; saved rows clear.
      setStaged((prev) =>
        prev.flatMap((r) => {
          if (!chunkIds.has(r.clientId)) return [r];
          const error = failedById.get(r.clientId);
          return error ? [{ ...r, error }] : [];
        }),
      );

      const next: SaveRun = {
        ...saveRun,
        index: saveRun.index + 1,
        processed: saveRun.processed + chunk.length,
        created: saveRun.created + (Number.isFinite(data.created) ? Number(data.created) : 0),
        duplicates:
          saveRun.duplicates +
          (Number.isFinite(data.skippedDuplicates) ? Number(data.skippedDuplicates) : 0),
        failed: saveRun.failed + failedById.size,
      };
      if (next.index < next.chunks.length) {
        setSaveRun(next);
        submitChunk(next, next.index);
      } else {
        setSaveRun({ ...next, phase: "finalize" });
        saveFetcher.submit(
          { intent: "finalize", productId: saveRun.productId },
          { method: "post" },
        );
      }
      return;
    }

    if (data.intent === "finalize" && saveRun.phase === "finalize") {
      setSummary({
        created: saveRun.created,
        duplicates: saveRun.duplicates,
        failed: saveRun.failed,
        syncMessage:
          data.ok !== true
            ? "Reviews saved, but the product rating sync failed — it will refresh on the next moderation action."
            : data.synced === false && typeof data.message === "string"
              ? data.message
              : null,
        aborted: false,
      });
      setSaveRun(null);
      return;
    }

    if (data.intent !== "save-chunk" && data.intent !== "finalize") {
      // Unexpected response shape — end the run so the UI can't get stuck.
      setSummary({
        created: saveRun.created,
        duplicates: saveRun.duplicates,
        failed: saveRun.failed,
        syncMessage: "The save ended unexpectedly — check the list below and try again.",
        aborted: true,
      });
      setSaveRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data, saveRun]);

  /* ---- Derived view state ----------------------------------------------- */

  const productOptions = useMemo(
    () => [
      { label: "Choose a product…", value: "" },
      ...products.map((p) => ({ label: p.title, value: p.id })),
    ],
    [products],
  );

  const variantOptions = useMemo(() => {
    const variants = product?.variants ?? [];
    return [
      { label: "No variant", value: "" },
      ...variants.map((title) => ({ label: title, value: title })),
    ];
  }, [product]);

  const languageOptions = useMemo(
    () =>
      SHOP_LOCALES.map((locale) => ({
        label: LOCALE_LABELS[locale] ?? locale,
        value: locale,
      })),
    [],
  );

  const imagesUsed =
    countImages(composer) + pendingUploads.filter((p) => p.type === "IMAGE").length;
  const videosUsed =
    countVideos(composer) + pendingUploads.filter((p) => p.type === "VIDEO").length;
  const failedRows = staged.filter((r) => r.error).length;
  const productLocked = staged.length > 0 || saving;

  const addImageDisabled =
    composer.imageUrls.length +
      composer.uploads.filter((u) => u.type === "IMAGE").length +
      pendingUploads.filter((p) => p.type === "IMAGE").length >=
    MAX_IMAGES_PER_REVIEW;
  const videoUploadPresent =
    composer.uploads.some((u) => u.type === "VIDEO") ||
    pendingUploads.some((p) => p.type === "VIDEO");
  const saveProgress = saveRun
    ? Math.min(100, Math.round((saveRun.processed / Math.max(1, saveRun.total)) * 100))
    : 0;

  return (
    <Page title="Bulk add">
      <TitleBar title="Bulk add" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {summary ? (
              <Banner
                tone={summary.aborted ? "critical" : summary.failed > 0 ? "warning" : "success"}
                title={
                  summary.aborted
                    ? `Save interrupted — ${pluralize(summary.created, "review")} created before the failure`
                    : `${pluralize(summary.created, "review")} created (${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"} skipped, ${summary.failed} failed)`
                }
                onDismiss={() => setSummary(null)}
              >
                <BlockStack gap="100">
                  {summary.failed > 0 || summary.aborted ? (
                    <Text as="p">
                      Rows that could not be saved stayed in the list below with their error —
                      fix and save them again, or remove them.
                    </Text>
                  ) : null}
                  {summary.syncMessage ? <Text as="p">{summary.syncMessage}</Text> : null}
                  {summary.created > 0 && !summary.syncMessage ? (
                    <Text as="p">
                      The product&apos;s rating, metafields and star snippets were updated.
                    </Text>
                  ) : null}
                </BlockStack>
              </Banner>
            ) : null}

            {/* ---- Product ---------------------------------------------- */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Product
                </Text>
                <Text as="p" tone="subdued">
                  Bulk add creates reviews for one product at a time. Migrating reviews for
                  several products at once? Use the CSV import on the Import / Export page
                  instead.
                </Text>
                {product ? (
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">
                        {product.title}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Product ID {product.id}
                        {product.handle ? ` · ${product.handle}` : ""}
                      </Text>
                    </BlockStack>
                    {detailsFetcher.state !== "idle" ? (
                      <InlineStack gap="100" blockAlign="center">
                        <Spinner size="small" accessibilityLabel="Loading product details" />
                        <Text as="span" variant="bodySm" tone="subdued">
                          Loading variants…
                        </Text>
                      </InlineStack>
                    ) : null}
                    <Button
                      onClick={() => setProduct(null)}
                      disabled={productLocked}
                    >
                      Change product
                    </Button>
                    {productLocked ? (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Save or remove the staged reviews to switch products.
                      </Text>
                    ) : null}
                  </InlineStack>
                ) : (
                  <BlockStack gap="300">
                    <InlineStack gap="200">
                      <Button variant="primary" onClick={openPicker}>
                        Select product
                      </Button>
                    </InlineStack>
                    {pickerUnavailable ? (
                      products.length > 0 ? (
                        <Select
                          label="Product"
                          options={productOptions}
                          value=""
                          onChange={(value) => {
                            const match = products.find((p) => p.id === value);
                            if (match) {
                              selectProduct({
                                id: match.id,
                                title: match.title,
                                handle: match.handle,
                                variants: [],
                              });
                            }
                          }}
                          helpText="The product picker is unavailable, so pick from your first 100 products."
                        />
                      ) : (
                        <Banner tone="critical" title="Products could not be loaded">
                          <Text as="p">
                            The product picker is unavailable and the product list failed to
                            load{productListError ? "" : " (no products found)"}. Reload the
                            page and try again.
                          </Text>
                        </Banner>
                      )
                    ) : null}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* ---- Composer --------------------------------------------- */}
            <div id="bulk-add-composer">
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      {editingId ? "Edit staged review" : "Review composer"}
                    </Text>
                    {editingId ? <Badge tone="attention">Editing</Badge> : null}
                  </InlineStack>
                  <FormLayout>
                    <StarPicker
                      value={composer.rating}
                      onChange={(rating) => setComposer((prev) => ({ ...prev, rating }))}
                      disabled={saving}
                      error={composerErrors.rating}
                    />
                    <TextField
                      label="Title"
                      value={composer.title}
                      onChange={(title) => setComposer((prev) => ({ ...prev, title }))}
                      maxLength={MAX_TITLE_LENGTH}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <TextField
                      label="Review body"
                      value={composer.body}
                      onChange={(body) => setComposer((prev) => ({ ...prev, body }))}
                      multiline={4}
                      maxLength={MAX_BODY_LENGTH}
                      autoComplete="off"
                      requiredIndicator
                      error={composerErrors.body}
                      disabled={saving}
                    />
                    <FormLayout.Group>
                      <TextField
                        label="Reviewer name"
                        value={composer.authorName}
                        onChange={(authorName) =>
                          setComposer((prev) => ({ ...prev, authorName }))
                        }
                        maxLength={MAX_AUTHOR_NAME_LENGTH}
                        autoComplete="off"
                        requiredIndicator
                        error={composerErrors.authorName}
                        disabled={saving}
                      />
                      <TextField
                        label="Reviewer email"
                        type="email"
                        value={composer.authorEmail}
                        onChange={(authorEmail) =>
                          setComposer((prev) => ({ ...prev, authorEmail }))
                        }
                        autoComplete="off"
                        helpText="Optional — never shown publicly. Used for duplicate detection and GDPR erasure."
                        error={composerErrors.authorEmail}
                        disabled={saving}
                      />
                    </FormLayout.Group>
                    <FormLayout.Group>
                      <TextField
                        label="Review date"
                        type="date"
                        value={composer.date}
                        onChange={(date) => setComposer((prev) => ({ ...prev, date }))}
                        autoComplete="off"
                        error={composerErrors.date}
                        disabled={saving}
                      />
                      <Select
                        label="Language"
                        options={languageOptions}
                        value={composer.language}
                        onChange={(language) => setComposer((prev) => ({ ...prev, language }))}
                        disabled={saving}
                      />
                      {variantOptions.length > 1 ? (
                        <Select
                          label="Variant"
                          options={variantOptions}
                          value={composer.variantTitle}
                          onChange={(variantTitle) =>
                            setComposer((prev) => ({ ...prev, variantTitle }))
                          }
                          disabled={saving}
                        />
                      ) : null}
                    </FormLayout.Group>
                    <Checkbox
                      label="Verified purchase"
                      checked={composer.verified}
                      onChange={(verified) => setComposer((prev) => ({ ...prev, verified }))}
                      disabled={saving}
                    />

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Structured attributes (optional)
                    </Text>
                    <FormLayout.Group>
                      <Select
                        label="Age range"
                        options={[
                          { label: "Not specified", value: "" },
                          ...AGE_RANGES.map((key) => ({
                            label: AGE_RANGE_LABELS[key] ?? key,
                            value: key,
                          })),
                        ]}
                        value={composer.ageRange}
                        onChange={(ageRange) => setComposer((prev) => ({ ...prev, ageRange }))}
                        disabled={saving}
                      />
                      <Select
                        label="Time using the product"
                        options={[
                          { label: "Not specified", value: "" },
                          ...TIME_USING.map((key) => ({
                            label: TIME_USING_LABELS[key] ?? key,
                            value: key,
                          })),
                        ]}
                        value={composer.timeUsing}
                        onChange={(timeUsing) =>
                          setComposer((prev) => ({ ...prev, timeUsing }))
                        }
                        disabled={saving}
                      />
                    </FormLayout.Group>
                    <FormLayout.Group>
                      <ChoiceList
                        allowMultiple
                        title="Skin concerns"
                        choices={SKIN_CONCERNS.map((key) => ({
                          label: SKIN_CONCERN_LABELS[key] ?? key,
                          value: key,
                        }))}
                        selected={composer.skinConcerns}
                        onChange={(skinConcerns) =>
                          setComposer((prev) => ({ ...prev, skinConcerns }))
                        }
                        disabled={saving}
                      />
                      <ChoiceList
                        allowMultiple
                        title="Results seen"
                        choices={RESULTS_SEEN.map((key) => ({
                          label: RESULTS_SEEN_LABELS[key] ?? key,
                          value: key,
                        }))}
                        selected={composer.resultsSeen}
                        onChange={(resultsSeen) =>
                          setComposer((prev) => ({ ...prev, resultsSeen }))
                        }
                        disabled={saving}
                      />
                    </FormLayout.Group>

                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Brand reply (optional)
                    </Text>
                    <TextField
                      label="Reply"
                      value={composer.reply}
                      onChange={(reply) => setComposer((prev) => ({ ...prev, reply }))}
                      multiline={2}
                      maxLength={MAX_BODY_LENGTH}
                      autoComplete="off"
                      disabled={saving}
                    />
                    <TextField
                      label="Reply date"
                      type="date"
                      value={composer.replyDate}
                      onChange={(replyDate) => setComposer((prev) => ({ ...prev, replyDate }))}
                      autoComplete="off"
                      helpText="Defaults to 2 days after the review date when a reply is set."
                      error={composerErrors.replyDate}
                      disabled={saving}
                    />

                    <Divider />
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Media
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Up to {MAX_IMAGES_PER_REVIEW} images and 1 video per review — typed
                        URLs and uploaded files combined. Currently: {imagesUsed} image
                        {imagesUsed === 1 ? "" : "s"}, {videosUsed} video
                        {videosUsed === 1 ? "" : "s"}.
                      </Text>
                      {composer.imageUrls.map((url, index) => (
                        <InlineStack key={index} gap="200" blockAlign="start" wrap={false}>
                          <Box width="100%">
                            <TextField
                              label={`Image URL ${index + 1}`}
                              labelHidden={index > 0}
                              placeholder="https://…"
                              value={url}
                              onChange={(value) =>
                                setComposer((prev) => ({
                                  ...prev,
                                  imageUrls: prev.imageUrls.map((u, i) =>
                                    i === index ? value : u,
                                  ),
                                }))
                              }
                              autoComplete="off"
                              error={composerErrors[`imageUrl${index}`]}
                              disabled={saving}
                            />
                          </Box>
                          <Button
                            onClick={() =>
                              setComposer((prev) => ({
                                ...prev,
                                imageUrls: prev.imageUrls.filter((_, i) => i !== index),
                              }))
                            }
                            disabled={saving}
                            accessibilityLabel={`Remove image URL ${index + 1}`}
                          >
                            Remove
                          </Button>
                        </InlineStack>
                      ))}
                      <InlineStack gap="200">
                        <Button
                          onClick={() =>
                            setComposer((prev) => ({
                              ...prev,
                              imageUrls: [...prev.imageUrls, ""],
                            }))
                          }
                          disabled={saving || addImageDisabled}
                        >
                          Add image URL
                        </Button>
                      </InlineStack>
                      <TextField
                        label="Video URL"
                        placeholder="https://…"
                        value={composer.videoUrl}
                        onChange={(videoUrl) => setComposer((prev) => ({ ...prev, videoUrl }))}
                        autoComplete="off"
                        error={composerErrors.videoUrl}
                        disabled={saving || videoUploadPresent}
                        helpText={
                          videoUploadPresent
                            ? "An uploaded video already counts as this review's video."
                            : undefined
                        }
                      />
                      <DropZone
                        accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.webm"
                        allowMultiple
                        onDrop={handleDrop}
                        disabled={saving}
                        label="Upload media"
                        labelHidden
                      >
                        <DropZone.FileUpload
                          actionTitle="Add images or a video"
                          actionHint="JPEG, PNG, WebP or HEIC up to 8 MB · MP4, MOV or WebM up to 80 MB"
                        />
                      </DropZone>
                      {pendingUploads.length > 0 ? (
                        <InlineStack gap="200" blockAlign="center">
                          <Spinner size="small" accessibilityLabel="Uploading media" />
                          <Text as="span" variant="bodySm" tone="subdued">
                            Uploading {pendingUploads[0].file.name}
                            {pendingUploads.length > 1
                              ? ` (+${pendingUploads.length - 1} queued)`
                              : ""}
                            …
                          </Text>
                        </InlineStack>
                      ) : null}
                      {composer.uploads.length > 0 ? (
                        <BlockStack gap="100">
                          {composer.uploads.map((upload) => (
                            <InlineStack key={upload.clientId} gap="200" blockAlign="center">
                              <Badge tone="success">
                                {upload.type === "VIDEO" ? "Video" : "Image"}
                              </Badge>
                              <Text as="span" variant="bodySm">
                                {upload.fileName ?? "Uploaded file"}
                              </Text>
                              <Button
                                variant="plain"
                                tone="critical"
                                onClick={() =>
                                  setComposer((prev) => ({
                                    ...prev,
                                    uploads: prev.uploads.filter(
                                      (u) => u.clientId !== upload.clientId,
                                    ),
                                  }))
                                }
                                disabled={saving}
                                accessibilityLabel={`Remove ${upload.fileName ?? "uploaded file"}`}
                              >
                                Remove
                              </Button>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      ) : null}
                      {uploadNotices.length > 0 ? (
                        <Banner
                          tone="warning"
                          title="Some files were not added"
                          onDismiss={() => setUploadNotices([])}
                        >
                          <BlockStack gap="050">
                            {uploadNotices.map((notice, index) => (
                              <Text key={index} as="p" variant="bodySm">
                                {notice}
                              </Text>
                            ))}
                          </BlockStack>
                        </Banner>
                      ) : null}
                      {composerErrors.media ? (
                        <InlineError message={composerErrors.media} fieldID="bulk-add-media" />
                      ) : null}
                    </BlockStack>

                    {composerErrors._ ? (
                      <InlineError message={composerErrors._} fieldID="bulk-add-general" />
                    ) : null}
                    <InlineStack gap="200">
                      <Button
                        variant="primary"
                        onClick={addToList}
                        disabled={saving || pendingUploads.length > 0}
                      >
                        {editingId ? "Update review" : "Add to list"}
                      </Button>
                      {editingId ? (
                        <Button onClick={cancelEdit} disabled={saving}>
                          Cancel edit
                        </Button>
                      ) : null}
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </Card>
            </div>

            {/* ---- Staging list ----------------------------------------- */}
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Staged reviews ({staged.length})
                  </Text>
                  {failedRows > 0 ? (
                    <Banner tone="warning" title={`${pluralize(failedRows, "review")} failed to save`}>
                      <Text as="p">
                        Edit the failed rows below and save again, or remove them.
                      </Text>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Box>
              <IndexTable
                resourceName={{ singular: "staged review", plural: "staged reviews" }}
                itemCount={staged.length}
                selectable={false}
                headings={[
                  { title: "Rating" },
                  { title: "Review" },
                  { title: "Name" },
                  { title: "Date" },
                  { title: "Verified" },
                  { title: "Media" },
                  { title: "Actions" },
                ]}
                emptyState={
                  <Box padding="400">
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingSm">
                        Nothing staged yet
                      </Text>
                      <Text as="p" tone="subdued">
                        Compose a review above and select “Add to list”. Nothing is saved
                        until you select “Save”.
                      </Text>
                    </BlockStack>
                  </Box>
                }
              >
                {staged.map((row, index) => (
                  <IndexTable.Row
                    id={row.clientId}
                    key={row.clientId}
                    position={index}
                    tone={row.error ? "critical" : undefined}
                  >
                    <IndexTable.Cell>
                      <StarRating rating={row.rating} size={14} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {row.title || "Untitled review"}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {row.body.length > 90 ? `${row.body.slice(0, 90)}…` : row.body}
                        </Text>
                        {row.error ? (
                          <Text as="span" variant="bodySm" tone="critical">
                            {row.error}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{row.authorName}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {formatDate(row.date)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.verified ? (
                        <Badge tone="success">Verified</Badge>
                      ) : (
                        <Text as="span" variant="bodySm" tone="subdued">
                          —
                        </Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <MediaCountBadge media={row.media} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button
                          variant="plain"
                          onClick={() => editRow(row.clientId)}
                          disabled={saving}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeRow(row.clientId)}
                          disabled={saving}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>

            {/* ---- Save ------------------------------------------------- */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Save
                </Text>
                <Select
                  label="Status for saved reviews"
                  options={[
                    { label: "Published (visible in the widget)", value: "PUBLISHED" },
                    { label: "Pending (waits in moderation)", value: "PENDING" },
                  ]}
                  value={defaultStatus}
                  onChange={(value) =>
                    setDefaultStatus(value === "PENDING" ? "PENDING" : "PUBLISHED")
                  }
                  disabled={saving}
                  helpText="Applies to every review in this save. Duplicates (same reviewer and text on this product) are skipped automatically."
                />
                <InlineStack gap="300" blockAlign="center">
                  <Button
                    variant="primary"
                    onClick={startSave}
                    disabled={
                      !product || staged.length === 0 || saving || pendingUploads.length > 0
                    }
                    loading={saving}
                  >
                    {`Save ${pluralize(staged.length, "review")}`}
                  </Button>
                  {!product && staged.length > 0 ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Choose a product first.
                    </Text>
                  ) : null}
                  {pendingUploads.length > 0 ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      Waiting for media uploads to finish…
                    </Text>
                  ) : null}
                </InlineStack>
                {saveRun ? (
                  <BlockStack gap="100">
                    <ProgressBar progress={saveProgress} size="small" />
                    <Text as="span" variant="bodySm" tone="subdued">
                      {saveRun.phase === "finalize"
                        ? "Syncing the product rating and metafields…"
                        : `Saving ${saveRun.processed} of ${saveRun.total}…`}
                    </Text>
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}


