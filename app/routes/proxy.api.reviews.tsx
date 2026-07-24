/**
 * Storefront proxy: `/apps/cellexia-reviews/api/reviews` → `/proxy/api/reviews`.
 *
 * GET  — paginated, filterable review list (SPEC §6), cached 60 s.
 *        Lazily resolves pending Shopify Files CDN URLs before listing.
 * POST — multipart review submission with honeypot, timing check, strict
 *        option-key validation, magic-byte media validation and rate
 *        limiting (SPEC §6/§10).
 */

import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  UploadHandlerPart,
} from "@remix-run/node";
import {
  json,
  MaxPartSizeExceededError,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import prisma from "~/db.server";
import { unauthenticated } from "~/shopify.server";
import {
  AGE_RANGES,
  RESULTS_SEEN,
  SKIN_CONCERNS,
  SORTS,
  TIME_USING,
  type Sort,
} from "~/types/cellexia";
import {
  NO_STORE_HEADERS,
  REVIEWS_CACHE_HEADERS,
  errorJson,
  getClientIp,
  hashClientIp,
  matchShopLocale,
  readMagicBytes,
  requireLiveOrPreview,
  sniffMediaKind,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { createReview, listReviews } from "~/services/reviews.server";
import { recomputeProduct } from "~/services/aggregates.server";
import { isVerifiedPurchase } from "~/services/verified.server";
import { resolveMediaUrls, uploadReviewMedia } from "~/services/files.server";
import { getSettings } from "~/services/settings.server";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

const MAX_IMAGES = 5;
const MAX_VIDEOS = 1;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // 80 MB
// 5 images + 1 video + generous multipart/field overhead.
const MAX_BODY_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + MAX_VIDEO_BYTES + 2 * 1024 * 1024;

const TITLE_MAX = 150;
const BODY_MAX = 5000;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const VARIANT_MAX = 150;
const QUERY_MAX = 200;
const MIN_FORM_MS = 3000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOPIC_KEY_RE = /^[a-z0-9_-]{1,64}$/i;
const PRODUCT_HANDLE_RE = /^[a-z0-9-]{1,255}$/;

// ---------------------------------------------------------------------------
// GET /apps/cellexia-reviews/api/reviews
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;

  // SPEC-1.2 gating: not-live shops serve zero data unless the request
  // carries the current preview token (`preview_token` query param).
  if (!(await requireLiveOrPreview(shop, request))) {
    return errorJson(403, { _: "not_live" });
  }

  const params = new URL(request.url).searchParams;
  const errors: Record<string, string> = {};

  const productId = (params.get("product_id") ?? "").trim();
  if (!productId) {
    errors.product_id = "required";
  } else if (!/^\d+$/.test(productId)) {
    errors.product_id = "invalid";
  }

  const page = parsePositiveInt(params.get("page"), 1);

  let sort: Sort = "top";
  const sortRaw = params.get("sort");
  if (sortRaw != null && sortRaw !== "") {
    if ((SORTS as readonly string[]).includes(sortRaw)) {
      sort = sortRaw as Sort;
    } else {
      errors.sort = "invalid";
    }
  }

  let stars: number | undefined;
  const starsRaw = params.get("stars");
  if (starsRaw != null && starsRaw !== "") {
    if (/^[1-5]$/.test(starsRaw.trim())) {
      stars = Number.parseInt(starsRaw.trim(), 10);
    } else {
      errors.stars = "invalid";
    }
  }

  const verified = parseFlag(params.get("verified"));
  if (verified === "invalid") errors.verified = "invalid";
  const withMedia = parseFlag(params.get("with_media"));
  if (withMedia === "invalid") errors.with_media = "invalid";

  const ageRange = parseOptionKey(params.get("age_range"), AGE_RANGES);
  if (ageRange === "invalid") errors.age_range = "invalid";
  const timeUsing = parseOptionKey(params.get("time_using"), TIME_USING);
  if (timeUsing === "invalid") errors.time_using = "invalid";
  const skinConcern = parseOptionKey(params.get("skin_concern"), SKIN_CONCERNS);
  if (skinConcern === "invalid") errors.skin_concern = "invalid";
  const resultsSeen = parseOptionKey(params.get("results_seen"), RESULTS_SEEN);
  if (resultsSeen === "invalid") errors.results_seen = "invalid";

  let topic: string | undefined;
  const topicRaw = params.get("topic");
  if (topicRaw != null && topicRaw !== "") {
    if (TOPIC_KEY_RE.test(topicRaw.trim())) {
      topic = topicRaw.trim();
    } else {
      errors.topic = "invalid";
    }
  }

  const qRaw = (params.get("q") ?? "").trim();
  const q = qRaw ? qRaw.slice(0, QUERY_MAX) : undefined;

  const locale = matchShopLocale(params.get("locale"));

  if (Object.keys(errors).length > 0) return errorJson(422, errors);

  let perPage: number;
  const perPageRaw = params.get("per_page");
  if (perPageRaw != null && perPageRaw !== "" && /^\d+$/.test(perPageRaw.trim())) {
    perPage = clamp(Number.parseInt(perPageRaw.trim(), 10), 1, 50);
  } else {
    let fallback = 10;
    try {
      const settings = await getSettings(shop);
      fallback = settings.reviewsPerPage;
    } catch (error) {
      console.error("[cellexia] getSettings failed, using per_page default", error);
    }
    perPage = clamp(fallback, 1, 50);
  }

  // Lazily fill CDN URLs for media Shopify had not finished processing when
  // the review was submitted; the subsequent list query then sees them.
  try {
    const unresolved = await prisma.reviewMedia.findMany({
      where: { url: null, review: { shop, productId, status: "PUBLISHED" } },
      select: { id: true },
      take: 50,
    });
    if (unresolved.length > 0) {
      const { admin } = await unauthenticated.admin(shop);
      await resolveMediaUrls(admin, unresolved.map((m) => m.id));
    }
  } catch (error) {
    console.error("[cellexia] lazy media URL resolution failed", error);
  }

  try {
    const list = await listReviews(shop, {
      productId,
      page,
      perPage,
      sort,
      stars,
      verified: verified === true ? true : undefined,
      withMedia: withMedia === true ? true : undefined,
      ageRange: ageRange === "invalid" ? undefined : ageRange,
      skinConcern: skinConcern === "invalid" ? undefined : skinConcern,
      timeUsing: timeUsing === "invalid" ? undefined : timeUsing,
      resultsSeen: resultsSeen === "invalid" ? undefined : resultsSeen,
      topic,
      q,
      locale,
    });
    return json(list, { headers: REVIEWS_CACHE_HEADERS });
  } catch (error) {
    console.error("[cellexia] listReviews failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

// ---------------------------------------------------------------------------
// POST /apps/cellexia-reviews/api/reviews (multipart/form-data)
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return errorJson(405, { _: "method_not_allowed" });
  }

  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "submit")) {
    return errorJson(429, { _: "rate_limited" });
  }

  // Body-size gates (SPEC §10). A chunked request carries no Content-Length,
  // so a missing/invalid header is refused outright (411 Length Required)
  // instead of buffering an unbounded stream; a declared size over budget is
  // a 413. Browsers always send Content-Length for form submissions.
  const contentLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return errorJson(411, { _: "length_required" });
  }
  if (contentLength > MAX_BODY_BYTES) {
    return errorJson(413, { media: "too_large" });
  }

  // Stream-parse the multipart body with hard byte budgets so that even a
  // client lying about Content-Length can never buffer more than
  // MAX_VIDEO_BYTES per part or MAX_BODY_BYTES in total — parsing aborts the
  // moment either budget is exceeded.
  const uploadHandler = unstable_createMemoryUploadHandler({
    maxPartSize: MAX_VIDEO_BYTES,
  });
  const budget = { remaining: MAX_BODY_BYTES };
  let formData: FormData;
  try {
    formData = await unstable_parseMultipartFormData(request, (part) =>
      uploadHandler(withByteBudget(part, budget)),
    );
  } catch (error) {
    if (
      error instanceof BodyBudgetExceededError ||
      error instanceof MaxPartSizeExceededError
    ) {
      return errorJson(413, { media: "too_large" });
    }
    console.error("[cellexia] review form parse failed", error);
    return errorJson(422, { _: "invalid_form" });
  }

  // SPEC-1.2 gating: the preview token comes from the multipart form parsed
  // above (the request stream is consumed — never re-read it here).
  const previewToken = formField(formData, "preview_token") || null;
  if (!(await requireLiveOrPreview(shop, request, previewToken))) {
    return errorJson(403, { _: "not_live" });
  }

  // --- Spam gates -----------------------------------------------------------

  // Honeypot: the visually hidden `website` field must be empty.
  if (formField(formData, "website") !== "") {
    return errorJson(422, { _: "spam" });
  }

  // Timing gate: reject forms submitted less than 3 s after opening.
  const tStart = Number(formField(formData, "t_start"));
  if (!Number.isFinite(tStart) || tStart <= 0 || Date.now() - tStart < MIN_FORM_MS) {
    return errorJson(422, { _: "too_fast" });
  }

  // --- Field validation -----------------------------------------------------

  const errors: Record<string, string> = {};

  const productId = formField(formData, "product_id");
  if (!productId) {
    errors.product_id = "required";
  } else if (!/^\d+$/.test(productId)) {
    errors.product_id = "invalid";
  }

  const ratingRaw = formField(formData, "rating");
  const rating = /^[1-5]$/.test(ratingRaw) ? Number.parseInt(ratingRaw, 10) : NaN;
  if (!Number.isInteger(rating)) errors.rating = "invalid";

  const title = formField(formData, "title");
  if (title.length > TITLE_MAX) errors.title = "too_long";

  const body = formField(formData, "body");
  if (!body) {
    errors.body = "required";
  } else if (body.length > BODY_MAX) {
    errors.body = "too_long";
  }

  const authorName = formField(formData, "author_name");
  if (!authorName) {
    errors.author_name = "required";
  } else if (authorName.length > NAME_MAX) {
    errors.author_name = "too_long";
  }

  const authorEmail = formField(formData, "author_email");
  if (!authorEmail) {
    errors.author_email = "required";
  } else if (authorEmail.length > EMAIL_MAX || !EMAIL_RE.test(authorEmail)) {
    errors.author_email = "invalid";
  }

  const language = matchShopLocale(formField(formData, "language"));

  // Structured options: every key MUST be one of the §5 arrays → 422 otherwise.
  const ageRange = parseOptionKey(formField(formData, "age_range") || null, AGE_RANGES);
  if (ageRange === "invalid") errors.age_range = "invalid";
  const timeUsing = parseOptionKey(formField(formData, "time_using") || null, TIME_USING);
  if (timeUsing === "invalid") errors.time_using = "invalid";
  const skinConcerns = parseOptionKeyArray(formField(formData, "skin_concerns"), SKIN_CONCERNS);
  if (skinConcerns === null) errors.skin_concerns = "invalid";
  const resultsSeen = parseOptionKeyArray(formField(formData, "results_seen"), RESULTS_SEEN);
  if (resultsSeen === null) errors.results_seen = "invalid";

  const variantTitle = formField(formData, "variant_title").slice(0, VARIANT_MAX);

  // v1.5 (SPEC-1.5 §4): optional product handle from the widget root's
  // data-product-handle attribute, persisted for the sitewide badges
  // endpoint. Auxiliary metadata only — a value that does not match the
  // Shopify handle shape is dropped rather than failing the submission, so
  // existing stores keep their v1.4.1 submit behavior.
  const productHandleRaw = formField(formData, "product_handle").toLowerCase();
  const productHandle = PRODUCT_HANDLE_RE.test(productHandleRaw) ? productHandleRaw : "";

  // --- Media validation (count caps, size caps, magic bytes) ----------------

  const rawFiles: File[] = [];
  for (const name of ["media[]", "media"]) {
    for (const value of formData.getAll(name)) {
      if (value instanceof File && value.size > 0) rawFiles.push(value);
    }
  }

  const mediaFiles: { file: File; kind: "IMAGE" | "VIDEO" }[] = [];
  if (rawFiles.length > MAX_IMAGES + MAX_VIDEOS) {
    errors.media = "too_many";
  } else {
    let imageCount = 0;
    let videoCount = 0;
    for (const file of rawFiles) {
      const kind = sniffMediaKind(await readMagicBytes(file));
      if (kind === null) {
        errors.media = "invalid_type";
        break;
      }
      if (kind === "IMAGE") {
        imageCount += 1;
        if (file.size > MAX_IMAGE_BYTES) {
          errors.media = "too_large";
          break;
        }
      } else {
        videoCount += 1;
        if (file.size > MAX_VIDEO_BYTES) {
          errors.media = "too_large";
          break;
        }
      }
      mediaFiles.push({ file, kind });
    }
    if (!errors.media && (imageCount > MAX_IMAGES || videoCount > MAX_VIDEOS)) {
      errors.media = "too_many";
    }
  }

  if (Object.keys(errors).length > 0) return errorJson(422, errors);

  // --- Verified purchase + media upload (needs an offline admin client) -----

  let admin: AdminClient | null = null;
  try {
    admin = (await unauthenticated.admin(shop)).admin;
  } catch (error) {
    console.error("[cellexia] unauthenticated admin client unavailable", error);
  }

  let verified = false;
  if (admin) {
    try {
      verified = await isVerifiedPurchase(admin, productId, authorEmail, auth.customerId);
    } catch (error) {
      console.error("[cellexia] verified-purchase lookup failed", error);
      verified = false;
    }
  }

  const media: { type: "IMAGE" | "VIDEO"; fileGid: string; position: number }[] = [];
  if (mediaFiles.length > 0) {
    if (!admin) return errorJson(500, { media: "upload_failed" });
    try {
      for (let position = 0; position < mediaFiles.length; position++) {
        const { file, kind } = mediaFiles[position];
        const { fileGid } = await uploadReviewMedia(admin, file, kind);
        media.push({ type: kind, fileGid, position });
      }
    } catch (error) {
      console.error("[cellexia] review media upload failed", error);
      return errorJson(500, { media: "upload_failed" });
    }
  }

  // --- Create ---------------------------------------------------------------

  try {
    const review = await createReview(shop, {
      productId,
      productHandle: productHandle || undefined,
      rating,
      title: title || undefined,
      body,
      language,
      authorName,
      authorEmail,
      customerId: auth.customerId,
      variantTitle: variantTitle || undefined,
      verified,
      ageRange: ageRange === "invalid" ? undefined : ageRange,
      skinConcerns: skinConcerns ?? [],
      timeUsing: timeUsing === "invalid" ? undefined : timeUsing,
      resultsSeen: resultsSeen ?? [],
      ipHash: hashClientIp(ip),
      media,
    });

    const status: "PENDING" | "PUBLISHED" =
      review.status === "PUBLISHED" ? "PUBLISHED" : "PENDING";

    // Auto-published reviews change the aggregates immediately.
    if (status === "PUBLISHED" && admin) {
      try {
        await recomputeProduct(shop, productId, admin);
      } catch (error) {
        console.error("[cellexia] recomputeProduct after auto-publish failed", error);
      }
    }

    return json({ ok: true, status }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[cellexia] createReview failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Thrown while parsing when the combined multipart parts exceed MAX_BODY_BYTES. */
class BodyBudgetExceededError extends Error {
  constructor() {
    super("multipart body exceeds the maximum allowed size");
    this.name = "BodyBudgetExceededError";
  }
}

/**
 * Wrap an upload-handler part so its bytes count against a budget shared by
 * the whole request; the stream throws (aborting the parse) as soon as the
 * budget is exhausted.
 */
function withByteBudget(
  part: UploadHandlerPart,
  budget: { remaining: number },
): UploadHandlerPart {
  async function* data(): AsyncIterable<Uint8Array> {
    for await (const chunk of part.data) {
      budget.remaining -= chunk.byteLength;
      if (budget.remaining < 0) throw new BodyBudgetExceededError();
      yield chunk;
    }
  }
  return { ...part, data: data() };
}

function formField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw == null || raw === "" || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return parsed >= 1 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `"1"` → true, absent/empty/`"0"` → undefined, anything else → "invalid". */
function parseFlag(raw: string | null): true | undefined | "invalid" {
  if (raw == null || raw === "" || raw === "0") return undefined;
  if (raw === "1") return true;
  return "invalid";
}

/**
 * Validate a single option key against one of the §5 arrays.
 * Absent/empty → undefined; unknown key → "invalid".
 */
function parseOptionKey<T extends string>(
  raw: string | null,
  allowed: readonly T[],
): T | undefined | "invalid" {
  if (raw == null || raw === "") return undefined;
  const trimmed = raw.trim();
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  return "invalid";
}

/**
 * Parse a JSON array of option keys, validating every key against the given
 * §5 array. Empty input → []. Any malformed JSON, non-string entry or unknown
 * key → null (route responds 422).
 */
function parseOptionKeyArray<T extends string>(
  raw: string,
  allowed: readonly T[],
): T[] | null {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: T[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) {
      return null;
    }
    if (!out.includes(entry as T)) out.push(entry as T);
  }
  return out;
}
