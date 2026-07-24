/**
 * Cellexia Reviews — CSV import machinery (SPEC-1.4 §A).
 *
 * The review import pipeline shared by the Import / Export page (source
 * "csv-import") and the Bulk add page (source "bulk-add"):
 *
 *   - `validateRows`     raw parsed CSV records → typed `ImportRowInput`s +
 *                        per-row `RowError`s (generic template columns, preset
 *                        header mappings, tolerant date parsing, verified §5
 *                        option keys — invalid keys are row errors, never
 *                        silent drops).
 *   - `resolveProducts`  one batched Admin API lookup for product_id /
 *                        product_handle references.
 *   - `importRows`       duplicate-skipping persistence of validated rows
 *                        (chunk-sized calls; the route drives sequential
 *                        200-row chunks and a final aggregate re-sync).
 *
 * Also exports the template / export CSV builders so the route stays thin.
 * Everything here is defensive: client-supplied data is re-validated, Shopify
 * API failures surface as readable errors, and one bad row never aborts a
 * whole chunk.
 */
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";
// @ts-ignore -- papaparse ships without bundled type declarations
import Papa from "papaparse";

import prisma from "~/db.server";
import {
  AGE_RANGES,
  RESULTS_SEEN,
  REVIEW_STATUSES,
  SHOP_LOCALES,
  SKIN_CONCERNS,
  TIME_USING,
} from "~/types/cellexia";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` yields
 * `AdminApiContextWithoutRest`, which the package's `/server` entry does not
 * re-export. This module only uses `graphql`, so accept exactly that —
 * contexts with and without REST both satisfy it structurally.
 */
export type AdminClient = Pick<BaseAdminApiContext, "graphql">;

// ─── Limits & template columns ───────────────────────────────────────────────

/** Hard cap on rows per uploaded file (validated client- and server-side). */
export const MAX_IMPORT_ROWS = 10000;
/** Rows per sequential import chunk (SPEC-1.4 §A). */
export const IMPORT_CHUNK_SIZE = 200;
/** Rows per dry-run validation request. */
export const DRY_RUN_CHUNK_SIZE = 1000;
/** First N validation errors shown inline; the rest go to the report CSV. */
export const ERROR_TABLE_LIMIT = 50;

const MAX_IMAGES = 5;
const MAX_VIDEOS = 1;
const MAX_URL_LENGTH = 1000;
const MAX_HELPFUL = 1000000;
const MAX_FINALIZE_PRODUCTS = 2000;

/**
 * The documented generic import template (SPEC-1.4 §A). `skin_concerns`,
 * `results_seen` and `image_urls` are pipe-separated; dates accept ISO 8601,
 * YYYY-MM-DD, DD/MM/YYYY and MM/DD/YYYY (ambiguity resolved by the UI's
 * "Date format" select); `verified` accepts true/false/1/0/yes/no.
 */
export const TEMPLATE_COLUMNS = [
  "product_id",
  "product_handle",
  "rating",
  "title",
  "body",
  "author_name",
  "author_email",
  "date",
  "verified",
  "language",
  "country",
  "variant_title",
  "age_range",
  "skin_concerns",
  "time_using",
  "results_seen",
  "helpful_count",
  "reply",
  "reply_date",
  "image_urls",
  "video_url",
  "status",
] as const;

/**
 * Export column set: the template columns (identical names, so an export
 * re-imports as-is) plus `product_title` (informational) and the v1.4
 * provenance columns `is_synthetic`, `source`, `synthetic_batch_id`.
 */
export const EXPORT_COLUMNS = [
  "product_id",
  "product_handle",
  "product_title",
  ...TEMPLATE_COLUMNS.slice(2),
  "is_synthetic",
  "source",
  "synthetic_batch_id",
] as string[];

// ─── Public types ────────────────────────────────────────────────────────────

export type ImportPresetKey = "generic" | "judgeme" | "loox" | "yotpo";

/** How ambiguous all-numeric dates (both parts ≤ 12) are interpreted. */
export type ImportDateFormat = "auto" | "dmy" | "mdy";

export interface ImportPreset {
  key: ImportPresetKey;
  /** Default "auto": ISO / YYYY-MM-DD; ambiguous slash dates read as MM/DD/YYYY. */
  dateFormat?: ImportDateFormat;
}

/** One validation/persistence problem, addressed to a CSV row + column. */
export interface RowError {
  /** 1-based CSV row number (the header is row 1, data starts at row 2). */
  row: number;
  /** Template column name, or "_" for whole-row problems. */
  field: string;
  code: string;
  message: string;
}

/** Media descriptor carried by Bulk add rows (uploaded files or pasted URLs). */
export interface ImportMediaInput {
  type: "IMAGE" | "VIDEO";
  fileGid?: string | null;
  url?: string | null;
  thumbUrl?: string | null;
}

/** A fully validated, typed review row ready for `importRows`. */
export interface ImportRowInput {
  /** Original CSV row number, used to address errors back to the file. */
  row: number;
  /** Numeric Shopify product id as string, when the row referenced one. */
  productId: string | null;
  productHandle: string | null;
  /** Informational (export round-trip); the resolved product title wins. */
  productTitle: string | null;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorEmail: string | null;
  /** ISO 8601, or null → "now" at creation time. */
  createdAt: string | null;
  verified: boolean;
  language: string;
  country: string | null;
  variantTitle: string | null;
  ageRange: string | null;
  skinConcerns: string[];
  timeUsing: string | null;
  resultsSeen: string[];
  helpfulCount: number;
  reply: string | null;
  /** ISO 8601; when a reply exists without a date it defaults to date + 2 days. */
  replyAt: string | null;
  imageUrls: string[];
  videoUrl: string | null;
  /** Row-level status override; null → the import's default status applies. */
  status: "PENDING" | "PUBLISHED" | "REJECTED" | "SPAM" | null;
  /** Bulk add only: pre-uploaded media (fileGids/urls). Overrides imageUrls/videoUrl. */
  media?: ImportMediaInput[];
}

export interface ImportRowsResult {
  created: number;
  skippedDuplicates: number;
  errors: RowError[];
  /**
   * Numeric ids of products that received new reviews — the route accumulates
   * these across chunks and re-syncs each product once via finalize-import.
   */
  productIds: string[];
}

export interface ResolvedProduct {
  /** Numeric Shopify product id as string. */
  id: string;
  title: string;
  handle: string;
}

// ─── Preset header mappings ──────────────────────────────────────────────────

type InternalField =
  | "productId"
  | "productHandle"
  | "productTitle"
  | "rating"
  | "title"
  | "body"
  | "authorName"
  | "authorEmail"
  | "date"
  | "verified"
  | "language"
  | "country"
  | "variantTitle"
  | "ageRange"
  | "skinConcerns"
  | "timeUsing"
  | "resultsSeen"
  | "helpfulCount"
  | "reply"
  | "replyDate"
  | "imageUrls"
  | "videoUrl"
  | "status";

interface PresetDef {
  label: string;
  /** Internal field → header candidates (normalized snake_case), first hit wins. */
  map: Partial<Record<InternalField, string[]>>;
  /** Distinctive headers used for client-side auto-detection (≥2 must match). */
  detect: string[];
}

const PRESET_DEFS: Record<ImportPresetKey, PresetDef> = {
  generic: {
    label: "Generic template (Cellexia format)",
    map: {
      productId: ["product_id", "productId"],
      productHandle: ["product_handle", "productHandle"],
      productTitle: ["product_title", "productTitle"],
      rating: ["rating"],
      title: ["title"],
      body: ["body"],
      authorName: ["author_name", "authorName"],
      authorEmail: ["author_email", "authorEmail"],
      // created_at kept as fallback so pre-1.4 exports still round-trip.
      date: ["date", "created_at", "createdAt"],
      verified: ["verified"],
      language: ["language"],
      country: ["country"],
      variantTitle: ["variant_title", "variantTitle"],
      ageRange: ["age_range", "ageRange"],
      skinConcerns: ["skin_concerns", "skinConcerns"],
      timeUsing: ["time_using", "timeUsing"],
      resultsSeen: ["results_seen", "resultsSeen"],
      helpfulCount: ["helpful_count", "helpfulCount"],
      reply: ["reply"],
      replyDate: ["reply_date", "reply_at", "replyAt", "replyDate"],
      // media_urls kept as fallback for pre-1.4 exports (mixed images/videos —
      // video-looking URLs are promoted to the video slot automatically).
      imageUrls: ["image_urls", "imageUrls", "media_urls"],
      videoUrl: ["video_url", "videoUrl"],
      status: ["status"],
    },
    detect: ["author_name", "body", "skin_concerns", "image_urls"],
  },
  judgeme: {
    label: "Judge.me",
    map: {
      productId: ["product_id"],
      productHandle: ["product_handle"],
      productTitle: ["product_title"],
      rating: ["rating"],
      title: ["title", "review_title"],
      body: ["body", "review_body", "content"],
      authorName: ["reviewer_name", "name"],
      authorEmail: ["reviewer_email", "email"],
      date: ["review_date", "created_at", "date"],
      country: ["reviewer_country", "location"],
      verified: ["verified", "verified_purchase"],
      reply: ["reply"],
      replyDate: ["reply_date"],
      imageUrls: ["picture_urls", "pictures"],
      videoUrl: ["video_url"],
    },
    detect: ["reviewer_name", "reviewer_email", "review_date", "picture_urls"],
  },
  loox: {
    label: "Loox",
    map: {
      productId: ["product_id"],
      productHandle: ["product_handle"],
      rating: ["rating"],
      body: ["review", "body"],
      authorName: ["name", "reviewer_name"],
      authorEmail: ["email", "reviewer_email"],
      date: ["created_at", "submission_date", "date"],
      verified: ["verified_purchase", "verified"],
      imageUrls: ["photo_url", "photo_urls", "photos"],
      videoUrl: ["video_url"],
    },
    detect: ["review", "photo_url", "submission_date"],
  },
  yotpo: {
    label: "Yotpo",
    map: {
      productId: ["product_id"],
      productTitle: ["product_title"],
      rating: ["review_score", "score", "rating"],
      title: ["review_title"],
      body: ["review_content", "content", "body"],
      authorName: ["display_name", "reviewer_name", "user_display_name"],
      authorEmail: ["email", "user_email", "reviewer_email"],
      date: ["review_creation_date", "date", "created_at"],
      verified: ["verified_buyer", "is_verified_buyer", "verified"],
      imageUrls: ["image_urls", "picture_urls"],
      videoUrl: ["video_url"],
    },
    detect: ["review_content", "review_score", "display_name", "review_title"],
  },
};

export interface ImportPresetOption {
  key: ImportPresetKey;
  label: string;
  /** Distinctive normalized headers; ≥2 matches ⇒ this preset is detected. */
  detect: string[];
}

/** Serializable preset metadata for the route loader (select + auto-detection). */
export function getImportPresets(): ImportPresetOption[] {
  return (Object.keys(PRESET_DEFS) as ImportPresetKey[]).map((key) => ({
    key,
    label: PRESET_DEFS[key].label,
    detect: [...PRESET_DEFS[key].detect],
  }));
}

/** Coerces an untrusted preset key (form data) to a known one. */
export function toPresetKey(value: unknown): ImportPresetKey {
  const key = String(value ?? "");
  return key in PRESET_DEFS ? (key as ImportPresetKey) : "generic";
}

/** Coerces an untrusted date-format value (form data) to a known one. */
export function toDateFormat(value: unknown): ImportDateFormat {
  const v = String(value ?? "");
  return v === "dmy" || v === "mdy" ? v : "auto";
}

// ─── Small parsing helpers ───────────────────────────────────────────────────

const VERIFIED_TRUE = new Set([
  "true",
  "1",
  "yes",
  "y",
  "buyer",
  "verified",
  "verified_purchase",
  "verified purchase",
  "verified_buyer",
  "verified buyer",
]);
const VERIFIED_FALSE = new Set(["false", "0", "no", "n", "unverified", "not verified"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(raw: Record<string, unknown>, candidates: string[] | undefined): string {
  if (!candidates) return "";
  for (const key of candidates) {
    const value = raw[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

/** Extracts a numeric product id from "8654…", "gid://shopify/Product/8654…" etc. */
export function extractNumericId(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const gid = trimmed.match(/gid:\/\/shopify\/Product\/(\d+)/i);
  if (gid) return gid[1];
  const matches = trimmed.match(/\d{5,}/g);
  if (!matches) return "";
  return matches.reduce((a, b) => (b.length > a.length ? b : a), "");
}

function normalizeHandle(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+\/products\//i, "")
    .split(/[?#/]/)[0]
    .replace(/[^a-z0-9._-]/g, "");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && value.length <= MAX_URL_LENGTH;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Splits a pipe-separated cell (tolerating , ; and newlines for option keys). */
function splitKeys(value: string): string[] {
  return value
    .split(/[|,;\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Splits a URL list cell on pipes ONLY (URLs may legally contain commas). */
function splitUrls(value: string): string[] {
  return value
    .split("|")
    .map((v) => v.trim())
    .filter(Boolean);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tolerant date parsing (SPEC-1.4 §A): ISO 8601, YYYY-MM-DD, DD/MM/YYYY,
 * MM/DD/YYYY (also -, . separators). When both day and month are ≤ 12 the
 * explicit `format` decides; "auto" reads ambiguous dates as MM/DD/YYYY.
 * Returns { iso: null } for empty input and { error } for unparseable input.
 */
export function parseImportDate(
  value: string,
  format: ImportDateFormat,
): { iso: string | null; error?: string } {
  const raw = String(value ?? "").trim();
  if (!raw) return { iso: null };

  // ISO 8601 date or datetime (2026-05-14, 2026-05-14T09:30:00Z, with space).
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw)) {
    const normalized = raw.includes("T") || !raw.includes(" ") ? raw : raw.replace(" ", "T");
    const d = new Date(normalized.length === 10 ? `${normalized}T00:00:00.000Z` : normalized);
    if (!Number.isNaN(d.getTime())) return checkedIso(d);
    return { iso: null, error: `"${truncate(raw, 40)}" is not a valid ISO date` };
  }

  // YYYY/MM/DD (and dot/dash variants with a leading 4-digit year).
  const ymd = raw.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (ymd) return fromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), raw);

  // DD/MM/YYYY or MM/DD/YYYY (also - and . separators).
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    const year = Number(dmy[3]);
    let day: number;
    let month: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else if (a > 12 && b > 12) {
      return { iso: null, error: `"${truncate(raw, 40)}" is not a valid date` };
    } else if (format === "dmy") {
      day = a;
      month = b;
    } else {
      // "mdy" and "auto" both read ambiguous dates as MM/DD/YYYY.
      month = a;
      day = b;
    }
    return fromParts(year, month, day, raw);
  }

  // Last resort: let the JS engine try (RFC 2822 style, exotic exports).
  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) return checkedIso(fallback);
  return {
    iso: null,
    error: `"${truncate(raw, 40)}" is not a recognized date (use ISO 8601, YYYY-MM-DD, DD/MM/YYYY or MM/DD/YYYY)`,
  };
}

function fromParts(
  year: number,
  month: number,
  day: number,
  raw: string,
): { iso: string | null; error?: string } {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return { iso: null, error: `"${truncate(raw, 40)}" is not a valid calendar date` };
  }
  return checkedIso(d);
}

function checkedIso(d: Date): { iso: string | null; error?: string } {
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) {
    return { iso: null, error: `The year ${year} is outside the supported range (1990–2100)` };
  }
  return { iso: d.toISOString() };
}

function matchLocale(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "en";
  const lower = raw.toLowerCase();
  const exact = (SHOP_LOCALES as readonly string[]).find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  // "en-US" → "en"; "pt" → "pt-PT" (primary-subtag matching, both directions).
  const primary = lower.split("-")[0];
  const byPrimary = (SHOP_LOCALES as readonly string[]).find(
    (l) => l.toLowerCase() === primary || l.toLowerCase().split("-")[0] === primary,
  );
  return byPrimary ?? null;
}

// ─── validateRows ────────────────────────────────────────────────────────────

/**
 * Validates raw parsed CSV records (papaparse output with normalized
 * snake_case headers; each record may carry `_row`, its original 1-based CSV
 * row number) against the generic template contract, using the preset's
 * header mapping. A row with ANY error is excluded from `valid` — invalid
 * option keys are errors, never silent drops (SPEC-1.4 §A).
 */
export function validateRows(
  rows: unknown[],
  preset: ImportPreset,
): { valid: ImportRowInput[]; errors: RowError[] } {
  const valid: ImportRowInput[] = [];
  const errors: RowError[] = [];
  if (!Array.isArray(rows)) return { valid, errors };

  const def = PRESET_DEFS[toPresetKey(preset?.key)];
  const dateFormat = toDateFormat(preset?.dateFormat);

  rows.slice(0, MAX_IMPORT_ROWS).forEach((item, index) => {
    const fallbackRow = index + 2;
    if (!isRecord(item)) {
      errors.push({
        row: fallbackRow,
        field: "_",
        code: "not_a_row",
        message: "This row could not be read as CSV data",
      });
      return;
    }
    const raw = item;
    const rowNum =
      typeof raw._row === "number" && Number.isFinite(raw._row) && raw._row > 0
        ? Math.trunc(raw._row)
        : fallbackRow;
    const rowErrors: RowError[] = [];
    const fail = (field: string, code: string, message: string) =>
      rowErrors.push({ row: rowNum, field, code, message });
    const get = (field: InternalField) => pick(raw, def.map[field]);

    // Product reference — id and/or handle; at least one required.
    const idRaw = get("productId");
    const productId = idRaw ? extractNumericId(idRaw) : "";
    if (idRaw && !productId) {
      fail(
        "product_id",
        "invalid_product",
        `"${truncate(idRaw, 60)}" is not a numeric Shopify product id`,
      );
    }
    const handleRaw = get("productHandle");
    const productHandle = handleRaw ? normalizeHandle(handleRaw) : "";
    if (handleRaw && !productHandle) {
      fail(
        "product_handle",
        "invalid_product",
        `"${truncate(handleRaw, 60)}" is not a valid product handle`,
      );
    }
    if (!idRaw && !handleRaw) {
      fail(
        "product_id",
        "missing_product",
        "Each row needs a product_id or a product_handle",
      );
    }

    // Rating 1–5.
    const ratingRaw = get("rating");
    const rating = Math.round(Number.parseFloat(ratingRaw));
    if (!ratingRaw) fail("rating", "missing_rating", "Rating is required");
    else if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      fail("rating", "invalid_rating", `Rating "${truncate(ratingRaw, 20)}" must be between 1 and 5`);
    }

    // Body + author (required).
    const body = truncate(get("body"), 5000);
    if (!body) fail("body", "missing_body", "The review body is required");
    const authorName = truncate(get("authorName"), 80);
    if (!authorName) fail("author_name", "missing_author", "The reviewer name is required");

    // Email (optional, but must be valid when present).
    const emailRaw = get("authorEmail");
    let authorEmail: string | null = null;
    if (emailRaw) {
      if (EMAIL_RE.test(emailRaw)) authorEmail = emailRaw.toLowerCase().slice(0, 254);
      else fail("author_email", "invalid_email", `"${truncate(emailRaw, 60)}" is not a valid email address`);
    }

    // Dates.
    const dateParsed = parseImportDate(get("date"), dateFormat);
    if (dateParsed.error) fail("date", "invalid_date", dateParsed.error);
    const replyDateParsed = parseImportDate(get("replyDate"), dateFormat);
    if (replyDateParsed.error) fail("reply_date", "invalid_date", replyDateParsed.error);

    // Verified true/false/1/0/yes/no (+ platform spellings from the presets).
    const verifiedRaw = get("verified").toLowerCase();
    let verified = false;
    if (VERIFIED_TRUE.has(verifiedRaw)) verified = true;
    else if (verifiedRaw && !VERIFIED_FALSE.has(verifiedRaw)) {
      fail(
        "verified",
        "invalid_verified",
        `Verified "${truncate(verifiedRaw, 20)}" must be true/false, 1/0 or yes/no`,
      );
    }

    // Language (SHOP_LOCALES; tolerant of regional variants; empty → en).
    const languageRaw = get("language");
    const language = matchLocale(languageRaw);
    if (language === null) {
      fail(
        "language",
        "invalid_language",
        `"${truncate(languageRaw, 20)}" is not one of the store languages (${SHOP_LOCALES.join(", ")})`,
      );
    }

    // Country: tolerant — only 2-letter codes are kept (preset "location"
    // columns often contain free text; that is not worth failing a row over).
    const countryRaw = get("country");
    const country = /^[A-Za-z]{2}$/.test(countryRaw) ? countryRaw.toUpperCase() : null;

    // §5 option keys — invalid keys are row errors, not silent drops.
    const ageRangeRaw = get("ageRange");
    const ageRange = ageRangeRaw
      ? (AGE_RANGES as readonly string[]).includes(ageRangeRaw)
        ? ageRangeRaw
        : null
      : null;
    if (ageRangeRaw && !ageRange) {
      fail(
        "age_range",
        "invalid_option",
        `"${truncate(ageRangeRaw, 30)}" is not a valid age_range key (${AGE_RANGES.join(", ")})`,
      );
    }
    const timeUsingRaw = get("timeUsing");
    const timeUsing = timeUsingRaw
      ? (TIME_USING as readonly string[]).includes(timeUsingRaw)
        ? timeUsingRaw
        : null
      : null;
    if (timeUsingRaw && !timeUsing) {
      fail(
        "time_using",
        "invalid_option",
        `"${truncate(timeUsingRaw, 30)}" is not a valid time_using key (${TIME_USING.join(", ")})`,
      );
    }
    const skinConcerns = dedupe(splitKeys(get("skinConcerns")));
    const badSkin = skinConcerns.filter((k) => !(SKIN_CONCERNS as readonly string[]).includes(k));
    if (badSkin.length) {
      fail(
        "skin_concerns",
        "invalid_option",
        `Invalid skin_concerns key(s): ${truncate(badSkin.join(", "), 80)} (valid: ${SKIN_CONCERNS.join(", ")})`,
      );
    }
    const resultsSeen = dedupe(splitKeys(get("resultsSeen")));
    const badResults = resultsSeen.filter((k) => !(RESULTS_SEEN as readonly string[]).includes(k));
    if (badResults.length) {
      fail(
        "results_seen",
        "invalid_option",
        `Invalid results_seen key(s): ${truncate(badResults.join(", "), 80)} (valid: ${RESULTS_SEEN.join(", ")})`,
      );
    }

    // Helpful count.
    const helpfulRaw = get("helpfulCount");
    let helpfulCount = 0;
    if (helpfulRaw) {
      if (/^\d+$/.test(helpfulRaw)) helpfulCount = Math.min(Number.parseInt(helpfulRaw, 10), MAX_HELPFUL);
      else {
        fail(
          "helpful_count",
          "invalid_number",
          `helpful_count "${truncate(helpfulRaw, 20)}" must be a whole number ≥ 0`,
        );
      }
    }

    // Media URLs: image_urls pipe-separated ≤ 5; video_url single. URLs that
    // look like videos inside image_urls are promoted to the video slot
    // (pre-1.4 exports used one mixed media_urls column).
    const imageUrls: string[] = [];
    const videoUrls: string[] = [];
    for (const url of splitUrls(get("imageUrls"))) {
      if (!isHttpUrl(url)) {
        fail("image_urls", "invalid_url", `"${truncate(url, 80)}" is not a valid http(s) URL`);
      } else if (isVideoUrl(url)) videoUrls.push(url);
      else imageUrls.push(url);
    }
    for (const url of splitUrls(get("videoUrl"))) {
      if (!isHttpUrl(url)) {
        fail("video_url", "invalid_url", `"${truncate(url, 80)}" is not a valid http(s) URL`);
      } else videoUrls.push(url);
    }
    if (imageUrls.length > MAX_IMAGES) {
      fail("image_urls", "too_many_images", `At most ${MAX_IMAGES} image URLs per review (found ${imageUrls.length})`);
    }
    if (videoUrls.length > MAX_VIDEOS) {
      fail("video_url", "too_many_videos", `At most ${MAX_VIDEOS} video URL per review (found ${videoUrls.length})`);
    }

    // Row-level status override.
    const statusRaw = get("status").toUpperCase();
    let status: ImportRowInput["status"] = null;
    if (statusRaw) {
      if ((REVIEW_STATUSES as readonly string[]).includes(statusRaw)) {
        status = statusRaw as ImportRowInput["status"];
      } else {
        fail(
          "status",
          "invalid_status",
          `"${truncate(statusRaw, 20)}" is not a valid status (${REVIEW_STATUSES.join(", ")} or empty)`,
        );
      }
    }

    // Bulk add media passthrough (already-uploaded files / typed URLs).
    const media = sanitizeMedia(raw.media);
    if (media.error) fail("media", media.error.code, media.error.message);

    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }

    const reply = truncate(get("reply"), 5000) || null;
    valid.push({
      row: rowNum,
      productId: productId || null,
      productHandle: productHandle || null,
      productTitle: truncate(get("productTitle"), 255) || null,
      rating,
      title: truncate(get("title"), 150) || null,
      body,
      authorName,
      authorEmail,
      createdAt: dateParsed.iso,
      verified,
      language: language ?? "en",
      country,
      variantTitle: truncate(get("variantTitle"), 120) || null,
      ageRange,
      skinConcerns,
      timeUsing,
      resultsSeen,
      helpfulCount,
      reply,
      replyAt: reply ? replyDateParsed.iso : null,
      imageUrls: imageUrls.slice(0, MAX_IMAGES),
      videoUrl: videoUrls[0] ?? null,
      status,
      ...(media.items.length ? { media: media.items } : {}),
    });
  });

  return { valid, errors };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function sanitizeMedia(value: unknown): {
  items: ImportMediaInput[];
  error?: { code: string; message: string };
} {
  if (!Array.isArray(value) || value.length === 0) return { items: [] };
  const items: ImportMediaInput[] = [];
  let images = 0;
  let videos = 0;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = entry.type === "VIDEO" ? "VIDEO" : entry.type === "IMAGE" ? "IMAGE" : null;
    const fileGid =
      typeof entry.fileGid === "string" && entry.fileGid.startsWith("gid://") ? entry.fileGid : null;
    const url = typeof entry.url === "string" && isHttpUrl(entry.url) ? entry.url : null;
    const thumbUrl =
      typeof entry.thumbUrl === "string" && isHttpUrl(entry.thumbUrl) ? entry.thumbUrl : null;
    if (!type || (!fileGid && !url)) continue;
    if (type === "IMAGE") images += 1;
    else videos += 1;
    items.push({ type, fileGid, url, thumbUrl });
  }
  if (images > MAX_IMAGES || videos > MAX_VIDEOS) {
    return {
      items: [],
      error: {
        code: "too_many_media",
        message: `At most ${MAX_IMAGES} images and ${MAX_VIDEOS} video per review`,
      },
    };
  }
  return { items };
}

// ─── resolveProducts ─────────────────────────────────────────────────────────

const PRODUCTS_BY_ID_QUERY = `#graphql
  query CellexiaImportProductsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
      }
    }
  }
`;

interface ProductNode {
  id?: string | null;
  title?: string | null;
  handle?: string | null;
}

/**
 * Resolves product references (numeric ids and/or handles) in batched Admin
 * API calls. The returned map is keyed by BOTH the numeric id and the
 * lowercased handle of every resolved product, so callers can look up
 * whichever reference the row carried. Throws a descriptive Error when
 * Shopify cannot be reached — a missing entry means "product not found".
 */
export async function resolveProducts(
  admin: AdminClient,
  refs: Array<{ productId?: string; handle?: string }>,
): Promise<Map<string, ResolvedProduct>> {
  const map = new Map<string, ResolvedProduct>();
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== "object") continue;
    if (ref.productId) {
      const id = extractNumericId(String(ref.productId));
      if (id) ids.add(id);
    }
    if (ref.handle) {
      const handle = normalizeHandle(String(ref.handle));
      if (handle) handles.add(handle);
    }
  }

  const register = (node: ProductNode | null | undefined) => {
    if (!node?.id) return;
    const numeric = extractNumericId(node.id);
    if (!numeric) return;
    const product: ResolvedProduct = {
      id: numeric,
      title: String(node.title ?? "").slice(0, 255),
      handle: String(node.handle ?? "").toLowerCase(),
    };
    if (product.handle) map.set(product.handle, product);
    map.set(numeric, product);
  };

  // Handles first (aliased search queries), so id entries win on the freak
  // collision of an all-numeric handle with a different product's id.
  const handleList = [...handles];
  for (let i = 0; i < handleList.length; i += 20) {
    const batch = handleList.slice(i, i + 20);
    const fields = batch
      .map(
        (handle, index) =>
          `h${index}: products(first: 1, query: ${JSON.stringify(`handle:"${handle}"`)}) { nodes { id title handle } }`,
      )
      .join("\n");
    const query = `#graphql\nquery CellexiaImportProductsByHandle {\n${fields}\n}`;
    let body: {
      data?: Record<string, { nodes?: ProductNode[] } | null>;
      errors?: unknown;
    };
    try {
      const response = await admin.graphql(query);
      body = (await response.json()) as typeof body;
    } catch (error) {
      console.error("[cellexia] product handle lookup failed", error);
      throw new Error("Shopify product lookup failed — please try again");
    }
    if (body.errors) {
      console.error("[cellexia] product handle lookup errors:", body.errors);
      throw new Error("Shopify product lookup failed — please try again");
    }
    batch.forEach((_handle, index) => register(body.data?.[`h${index}`]?.nodes?.[0]));
  }

  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 100) {
    const batch = idList.slice(i, i + 100);
    let body: { data?: { nodes?: Array<ProductNode | null> }; errors?: unknown };
    try {
      const response = await admin.graphql(PRODUCTS_BY_ID_QUERY, {
        variables: { ids: batch.map((id) => `gid://shopify/Product/${id}`) },
      });
      body = (await response.json()) as typeof body;
    } catch (error) {
      console.error("[cellexia] product id lookup failed", error);
      throw new Error("Shopify product lookup failed — please try again");
    }
    if (body.errors) {
      console.error("[cellexia] product id lookup errors:", body.errors);
      throw new Error("Shopify product lookup failed — please try again");
    }
    for (const node of body.data?.nodes ?? []) register(node);
  }

  return map;
}

/** The resolved product for a row, trying its id first, then its handle. */
export function lookupResolved(
  resolved: Map<string, ResolvedProduct>,
  row: Pick<ImportRowInput, "productId" | "productHandle">,
): ResolvedProduct | null {
  if (row.productId) {
    const hit = resolved.get(row.productId);
    if (hit) return hit;
  }
  if (row.productHandle) {
    const hit = resolved.get(row.productHandle.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// ─── importRows ──────────────────────────────────────────────────────────────

/**
 * Persists one chunk of validated rows for `shop`. Every row is defensively
 * re-validated (chunks arrive from the client), its product reference is
 * resolved against Shopify, and duplicates are skipped: a row is a duplicate
 * when an existing review matches (shop, productId, lowercased authorEmail OR
 * authorName, exact body) — counted separately, never an error. One failing
 * row never aborts the chunk. Aggregate re-sync is NOT done here — the caller
 * collects `productIds` across chunks and finalizes once per product.
 */
export async function importRows(
  shop: string,
  admin: AdminClient,
  rows: ImportRowInput[],
  opts: { defaultStatus: "PUBLISHED" | "PENDING"; source: "csv-import" | "bulk-add" },
): Promise<ImportRowsResult> {
  const errors: RowError[] = [];
  const result: ImportRowsResult = { created: 0, skippedDuplicates: 0, errors, productIds: [] };
  if (!Array.isArray(rows) || rows.length === 0) return result;

  const source = opts?.source === "bulk-add" ? "bulk-add" : "csv-import";
  // Failsafe: an unexpected defaultStatus lands reviews in moderation, not live.
  const defaultStatus = opts?.defaultStatus === "PUBLISHED" ? "PUBLISHED" : "PENDING";

  // Defensive re-validation — importRows may be handed client-shaped data.
  const sanitized: ImportRowInput[] = [];
  for (const [index, candidate] of rows.slice(0, IMPORT_CHUNK_SIZE * 2).entries()) {
    const row = coerceRow(candidate, index + 2);
    if (row) sanitized.push(row);
    else {
      errors.push({
        row: rowNumberOf(candidate, index + 2),
        field: "_",
        code: "invalid_row",
        message: "The row is malformed and was skipped",
      });
    }
  }
  if (!sanitized.length) return result;

  // Resolve every product reference in one batched pass.
  let resolved: Map<string, ResolvedProduct>;
  try {
    resolved = await resolveProducts(
      admin,
      sanitized.map((row) => ({
        productId: row.productId ?? undefined,
        handle: row.productHandle ?? undefined,
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shopify product lookup failed";
    for (const row of sanitized) {
      errors.push({ row: row.row, field: "product_id", code: "product_lookup_failed", message });
    }
    return result;
  }

  interface PreparedRow {
    row: ImportRowInput;
    product: ResolvedProduct;
  }
  const prepared: PreparedRow[] = [];
  for (const row of sanitized) {
    const product = lookupResolved(resolved, row);
    if (!product) {
      const ref = row.productId ?? row.productHandle ?? "?";
      errors.push({
        row: row.row,
        field: row.productId ? "product_id" : "product_handle",
        code: "product_not_found",
        message: `No product in this store matches "${truncate(String(ref), 60)}"`,
      });
      continue;
    }
    prepared.push({ row, product });
  }
  if (!prepared.length) return result;

  // Duplicate detection: one query for all candidate (productId, body) pairs.
  const dupSet = new Set<string>();
  try {
    const existing = await prisma.review.findMany({
      where: {
        shop,
        productId: { in: dedupe(prepared.map((p) => p.product.id)) },
        body: { in: dedupe(prepared.map((p) => p.row.body)) },
      },
      select: { productId: true, body: true, authorEmail: true, authorName: true },
    });
    for (const ex of existing) {
      // JSON tuple keys are unambiguous even when a body or name contains a
      // would-be delimiter character (plain concatenation could collide).
      if (ex.authorEmail) {
        dupSet.add(JSON.stringify([ex.productId, ex.body, "e", ex.authorEmail.toLowerCase()]));
      }
      dupSet.add(JSON.stringify([ex.productId, ex.body, "n", ex.authorName]));
    }
  } catch (error) {
    console.error("[cellexia] duplicate lookup failed", error);
    for (const { row } of prepared) {
      errors.push({
        row: row.row,
        field: "_",
        code: "db_error",
        message: "The database could not be read — nothing was imported for this chunk",
      });
    }
    return result;
  }

  const affectedProducts = new Set<string>();
  for (const { row, product } of prepared) {
    const emailKey = row.authorEmail
      ? JSON.stringify([product.id, row.body, "e", row.authorEmail])
      : null;
    const nameKey = JSON.stringify([product.id, row.body, "n", row.authorName]);
    if ((emailKey && dupSet.has(emailKey)) || dupSet.has(nameKey)) {
      result.skippedDuplicates += 1;
      continue;
    }

    const createdAt = row.createdAt ? new Date(row.createdAt) : null;
    // Reply date defaults to the review date + 2 days when a reply has no date.
    const replyAt = row.reply
      ? row.replyAt
        ? new Date(row.replyAt)
        : new Date((createdAt ?? new Date()).getTime() + 2 * 24 * 60 * 60 * 1000)
      : null;

    try {
      await prisma.review.create({
        data: {
          shop,
          productId: product.id,
          productTitle: product.title || row.productTitle,
          productHandle: product.handle || row.productHandle,
          rating: row.rating,
          title: row.title,
          body: row.body,
          language: row.language,
          authorName: row.authorName,
          authorEmail: row.authorEmail,
          country: row.country,
          variantTitle: row.variantTitle,
          verified: row.verified,
          status: row.status ?? defaultStatus,
          ageRange: row.ageRange,
          skinConcerns: JSON.stringify(row.skinConcerns),
          timeUsing: row.timeUsing,
          resultsSeen: JSON.stringify(row.resultsSeen),
          helpfulCount: row.helpfulCount,
          reply: row.reply,
          replyAt,
          createdAt: createdAt ?? undefined,
          isSynthetic: false,
          source,
          media: buildMediaCreate(row),
        },
      });
      result.created += 1;
      affectedProducts.add(product.id);
      // Also skip identical rows later in this same chunk.
      if (emailKey) dupSet.add(emailKey);
      dupSet.add(nameKey);
    } catch (error) {
      console.error(`[cellexia] import row ${row.row} failed`, error);
      errors.push({
        row: row.row,
        field: "_",
        code: "db_error",
        message: "The review could not be saved (database error)",
      });
    }
  }

  result.productIds = [...affectedProducts];
  return result;
}

function rowNumberOf(candidate: unknown, fallback: number): number {
  if (isRecord(candidate) && typeof candidate.row === "number" && Number.isFinite(candidate.row)) {
    return Math.trunc(candidate.row);
  }
  return fallback;
}

/** Re-validates a client-supplied ImportRowInput; null when unusable. */
function coerceRow(value: unknown, fallbackRow: number): ImportRowInput | null {
  if (!isRecord(value)) return null;
  const v = value;

  const rating = Math.round(Number(v.rating));
  const body = typeof v.body === "string" ? truncate(v.body.trim(), 5000) : "";
  const authorName = typeof v.authorName === "string" ? truncate(v.authorName.trim(), 80) : "";
  if (!body || !authorName || !Number.isFinite(rating) || rating < 1 || rating > 5) return null;

  const productId = typeof v.productId === "string" ? extractNumericId(v.productId) : "";
  const productHandle = typeof v.productHandle === "string" ? normalizeHandle(v.productHandle) : "";
  if (!productId && !productHandle) return null;

  const optStr = (key: string, max = 255): string | null => {
    const val = v[key];
    return typeof val === "string" && val.trim() ? truncate(val.trim(), max) : null;
  };
  const isoOrNull = (key: string): string | null => {
    const val = optStr(key, 40);
    if (!val) return null;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const keyArray = (key: string, allowed: readonly string[]): string[] => {
    const val = v[key];
    if (!Array.isArray(val)) return [];
    return dedupe(val.filter((k): k is string => typeof k === "string" && allowed.includes(k)));
  };

  const emailRaw = optStr("authorEmail", 254);
  const languageRaw = optStr("language") ?? "en";
  const ageRangeRaw = optStr("ageRange") ?? "";
  const timeUsingRaw = optStr("timeUsing") ?? "";
  const countryRaw = optStr("country") ?? "";
  const statusRaw = optStr("status") ?? "";
  const helpful = Number.parseInt(String(v.helpfulCount ?? "0"), 10);
  const media = sanitizeMedia(v.media);
  const imageUrls = Array.isArray(v.imageUrls)
    ? v.imageUrls
        .filter((u): u is string => typeof u === "string" && isHttpUrl(u))
        .slice(0, MAX_IMAGES)
    : [];
  const videoUrl =
    typeof v.videoUrl === "string" && isHttpUrl(v.videoUrl) ? v.videoUrl : null;
  const reply = optStr("reply", 5000);

  return {
    row: rowNumberOf(value, fallbackRow),
    productId: productId || null,
    productHandle: productHandle || null,
    productTitle: optStr("productTitle"),
    rating,
    title: optStr("title", 150),
    body,
    authorName,
    authorEmail: emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw.toLowerCase() : null,
    createdAt: isoOrNull("createdAt"),
    verified: v.verified === true || v.verified === "true",
    language: matchLocale(languageRaw) ?? "en",
    country: /^[A-Za-z]{2}$/.test(countryRaw) ? countryRaw.toUpperCase() : null,
    variantTitle: optStr("variantTitle", 120),
    ageRange: (AGE_RANGES as readonly string[]).includes(ageRangeRaw) ? ageRangeRaw : null,
    skinConcerns: keyArray("skinConcerns", SKIN_CONCERNS),
    timeUsing: (TIME_USING as readonly string[]).includes(timeUsingRaw) ? timeUsingRaw : null,
    resultsSeen: keyArray("resultsSeen", RESULTS_SEEN),
    helpfulCount: Number.isFinite(helpful) && helpful > 0 ? Math.min(helpful, MAX_HELPFUL) : 0,
    reply,
    replyAt: reply ? isoOrNull("replyAt") : null,
    imageUrls,
    videoUrl,
    status: (REVIEW_STATUSES as readonly string[]).includes(statusRaw.toUpperCase())
      ? (statusRaw.toUpperCase() as ImportRowInput["status"])
      : null,
    ...(media.error || media.items.length === 0 ? {} : { media: media.items }),
  };
}

function buildMediaCreate(row: ImportRowInput):
  | {
      create: Array<{
        type: string;
        fileGid?: string | null;
        url: string | null;
        thumbUrl: string | null;
        position: number;
      }>;
    }
  | undefined {
  // Bulk add rows carry pre-uploaded media (fileGids and/or URLs) — they
  // override the CSV URL columns entirely.
  if (row.media && row.media.length) {
    return {
      create: row.media.slice(0, MAX_IMAGES + MAX_VIDEOS).map((m, position) => ({
        type: m.type === "VIDEO" ? "VIDEO" : "IMAGE",
        fileGid: m.fileGid ?? null,
        url: m.url ?? null,
        thumbUrl: m.thumbUrl ?? (m.type === "IMAGE" ? m.url ?? null : null),
        position,
      })),
    };
  }
  const entries: Array<{ type: string; url: string; thumbUrl: string | null }> = [
    ...row.imageUrls.slice(0, MAX_IMAGES).map((url) => ({
      type: "IMAGE",
      url,
      thumbUrl: url,
    })),
    ...(row.videoUrl ? [{ type: "VIDEO", url: row.videoUrl, thumbUrl: null }] : []),
  ];
  if (!entries.length) return undefined;
  return {
    create: entries.map((m, position) => ({ ...m, position })),
  };
}

// ─── finalize helper ─────────────────────────────────────────────────────────

/** Validates + dedupes the finalize-import product id list from the client. */
export function sanitizeProductIdList(value: unknown): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const ids = parsed
    .map((id) => (typeof id === "string" || typeof id === "number" ? String(id).trim() : ""))
    .filter((id) => /^\d+$/.test(id));
  return dedupe(ids).slice(0, MAX_FINALIZE_PRODUCTS);
}

// ─── Template & export CSV builders ──────────────────────────────────────────

/**
 * Neutralizes spreadsheet formula injection (OWASP CSV injection): a cell
 * starting with =, +, -, @, tab or CR executes as a formula when the export is
 * opened in Excel/LibreOffice/Google Sheets. Visitor-controlled fields
 * (title, body, author name/email, …) get a leading apostrophe so spreadsheets
 * treat them as plain text.
 */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The downloadable generic template: header row + 2 realistic example rows. */
export function buildImportTemplateCsv(): string {
  const rows = [
    [
      "", // product_id (either id or handle works)
      "cellular-renewal-cream",
      "5",
      "Visible results in three weeks",
      "My fine lines around the eyes are noticeably softer and my skin feels deeply hydrated all day. I use it every night after cleansing.",
      "Amelia R.",
      "amelia@example.com",
      "2026-05-14",
      "true",
      "en",
      "US",
      "50 ml",
      "45_54",
      "fine_lines|dryness",
      "m1_3",
      "smoother|hydration",
      "12",
      "Thank you Amelia — we're delighted the night routine is working for you!",
      "2026-05-16",
      "https://example.com/photos/amelia-before.jpg|https://example.com/photos/amelia-after.jpg",
      "",
      "PUBLISHED",
    ],
    [
      "8654321098765",
      "",
      "4",
      "",
      "Très bonne crème, texture légère qui pénètre vite. Encore un peu tôt pour juger des résultats.",
      "Claire Dubois",
      "",
      "2026-06-02T09:30:00Z",
      "no",
      "fr",
      "FR",
      "",
      "",
      "",
      "w1_4",
      "too_early",
      "0",
      "",
      "",
      "",
      "https://example.com/videos/routine.mp4",
      "PENDING",
    ],
  ];
  return Papa.unparse({ fields: [...TEMPLATE_COLUMNS], data: rows });
}

/**
 * Builds the full review export CSV for a shop. Column names match the
 * generic import template exactly (plus product_title and the provenance
 * columns), so an export re-imports as-is.
 */
export async function buildReviewExportCsv(
  shop: string,
): Promise<{ csv: string; count: number }> {
  const reviews = await prisma.review.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: { media: { orderBy: { position: "asc" } } },
  });
  const data = reviews.map((r) => {
    const imageUrls = r.media
      .filter((m) => m.type !== "VIDEO" && m.url)
      .map((m) => m.url as string);
    const videoUrl = r.media.find((m) => m.type === "VIDEO" && m.url)?.url ?? "";
    return [
      r.productId,
      csvSafe(r.productHandle ?? ""),
      csvSafe(r.productTitle ?? ""),
      r.rating,
      csvSafe(r.title ?? ""),
      csvSafe(r.body),
      csvSafe(r.authorName),
      csvSafe(r.authorEmail ?? ""),
      r.createdAt.toISOString(),
      r.verified ? "true" : "false",
      r.language,
      r.country ?? "",
      csvSafe(r.variantTitle ?? ""),
      r.ageRange ?? "",
      parseStoredKeys(r.skinConcerns).join("|"),
      r.timeUsing ?? "",
      parseStoredKeys(r.resultsSeen).join("|"),
      r.helpfulCount,
      csvSafe(r.reply ?? ""),
      r.replyAt ? r.replyAt.toISOString() : "",
      imageUrls.join("|"),
      videoUrl,
      r.status,
      r.isSynthetic ? "true" : "false",
      r.source ?? "",
      r.syntheticBatchId ?? "",
    ];
  });
  return { csv: Papa.unparse({ fields: EXPORT_COLUMNS, data }), count: reviews.length };
}

/** Parses a JSON-array-of-strings column (Review.skinConcerns / resultsSeen). */
function parseStoredKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
