/**
 * Cellexia Reviews — product metafield sync (namespace `cellexia`).
 *
 * Five PRODUCT metafields power instant SSR + JSON-LD in the theme extension:
 *   rating        number_decimal   average rating, e.g. "4.6"
 *   rating_count  number_integer   published review count
 *   distribution  json             {"5":{"count":..,"percent":..}, ...}
 *   top_reviews   json             up to 3 reviews for SSR + rich snippets
 *   summary       json             default-locale {text, topics:[{key,label,count,sentiment}]}
 *
 * `ensureMetafieldDefinitions` is idempotent (called from afterAuth): "taken"
 * userErrors from metafieldDefinitionCreate are ignored. `syncProductMetafields`
 * writes values via metafieldsSet; failures are logged, never thrown, so a
 * metafield hiccup can never break a moderation action.
 *
 * v1.6.1 (SPEC-1.6.1 §A): "logged, never thrown" used to mean "invisible" —
 * the merchant had no way to learn that Shopify had been rejecting every write
 * (missing scope, throttling, a definition/type conflict) while product pages
 * quietly served stale or absent stars. `syncProductMetafields` therefore also
 * REPORTS: it returns `{ ok, error }` with a compact, merchant-readable reason,
 * which `recomputeProduct` persists to `Setting.lastSyncError` and the admin's
 * storefront health check shows verbatim. It still never throws.
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { ProductStatsDTO } from "~/types/cellexia";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` / `unauthenticated.admin`
 * yield `AdminApiContextWithoutRest` — which the package's public `/server`
 * entry does not re-export. This module only ever uses `graphql`, so accept
 * exactly that: contexts with and without REST both satisfy it.
 */
type AdminClient = Pick<AdminApiContext, "graphql">;

const NAMESPACE = "cellexia";

/**
 * Fallback app-proxy subpath (SPEC-1.6 §2). Mirrors the `Setting.proxySubpath`
 * schema default and `[app_proxy] subpath` in shopify.app.example.toml; the
 * detected value normally arrives from the caller. Kept local so this module
 * stays a leaf (proxyhealth.server.ts imports it, never the other way round).
 */
const FALLBACK_PROXY_SUBPATH = "cellexia-reviews";

/** Shopify app-proxy subpath shape — `/apps/<subpath>/api`. */
const PROXY_SUBPATH_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Normalize a proxy subpath for the `cellexia.proxy_path` metafield. Anything
 * that is not a usable subpath (blank, whitespace, slashes, wrong shape) falls
 * back to the shipped default, which is also what cx-proxy.liquid assumes when
 * the metafield is missing — so Liquid and the server can never disagree.
 */
export function sanitizeProxySubpath(value: string | null | undefined): string {
  const candidate = (value ?? "").trim().toLowerCase();
  return PROXY_SUBPATH_RE.test(candidate) ? candidate : FALLBACK_PROXY_SUBPATH;
}

/** Structural review shape accepted for the top_reviews metafield (prisma Review rows satisfy it). */
export interface TopReviewSource {
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  createdAt: Date | string;
  verified: boolean;
}

/** Default-locale summary shape written to the `summary` metafield. */
export interface SummaryMetafieldSource {
  text: string;
  topics: Array<{ key: string; label: string; count: number; sentiment: string }>;
}

/**
 * Outcome of one product metafield write (SPEC-1.6.1 §A).
 *
 * `error` is a single line, already capped at `MAX_SYNC_ERROR_CHARS`, safe to
 * persist and to show a merchant verbatim: it is Shopify's own wording, and
 * the values written here (ratings, counts, review excerpts) carry no
 * credentials, so an echoed rejection cannot leak a secret.
 */
export interface MetafieldSyncResult {
  /** True when Shopify accepted every metafield in the write. */
  ok: boolean;
  /** Compact reason for the failure, or null when `ok` is true. */
  error: string | null;
}

/** Longest sync error persisted and surfaced to the merchant (SPEC-1.6.1 §A). */
const MAX_SYNC_ERROR_CHARS = 500;

/** Last-resort wording when a failure carries no usable message at all. */
const UNKNOWN_SYNC_ERROR = "Shopify rejected the metafield write without giving a reason.";

const DEFINITIONS: ReadonlyArray<{
  name: string;
  key: string;
  type: string;
  description: string;
}> = [
  {
    name: "Rating",
    key: "rating",
    type: "number_decimal",
    description: "Average customer review rating (Cellexia Reviews).",
  },
  {
    name: "Rating count",
    key: "rating_count",
    type: "number_integer",
    description: "Number of published customer reviews (Cellexia Reviews).",
  },
  {
    name: "Rating distribution",
    key: "distribution",
    type: "json",
    description: "Per-star review counts and percentages (Cellexia Reviews).",
  },
  {
    name: "Top reviews",
    key: "top_reviews",
    type: "json",
    description: "Top published reviews for SSR and JSON-LD (Cellexia Reviews).",
  },
  {
    name: "AI summary",
    key: "summary",
    type: "json",
    description: "Default-locale AI review summary and topics (Cellexia Reviews).",
  },
];

const METAFIELD_DEFINITION_CREATE = `#graphql
  mutation CellexiaMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation CellexiaMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * Creates the five `cellexia` PRODUCT metafield definitions. Idempotent:
 * "taken"/already-exists userErrors are ignored, other errors are logged.
 * Never throws — afterAuth must not fail because of definitions.
 */
export async function ensureMetafieldDefinitions(admin: AdminClient): Promise<void> {
  for (const definition of DEFINITIONS) {
    try {
      const response = await admin.graphql(METAFIELD_DEFINITION_CREATE, {
        variables: {
          definition: {
            name: definition.name,
            namespace: NAMESPACE,
            key: definition.key,
            type: definition.type,
            description: definition.description,
            ownerType: "PRODUCT",
          },
        },
      });
      const json = (await response.json()) as {
        data?: {
          metafieldDefinitionCreate?: {
            userErrors?: Array<{ message?: string; code?: string }>;
          };
        };
        errors?: unknown;
      };
      const userErrors = json.data?.metafieldDefinitionCreate?.userErrors ?? [];
      const realErrors = userErrors.filter((error) => !isAlreadyExistsError(error));
      if (realErrors.length > 0) {
        console.error(
          `[cellexia] metafieldDefinitionCreate(${definition.key}) userErrors:`,
          realErrors,
        );
      }
      if (json.errors) {
        console.error(
          `[cellexia] metafieldDefinitionCreate(${definition.key}) errors:`,
          json.errors,
        );
      }
    } catch (error) {
      console.error(`[cellexia] metafieldDefinitionCreate(${definition.key}) failed`, error);
    }
  }
}

/**
 * Writes the five product metafields from the current aggregates. `summary`
 * may be null (no AI summary yet / cleared) — it is written as JSON `null` so
 * stale SSR content disappears.
 *
 * Never throws: every failure mode (GraphQL `userErrors`, top-level GraphQL
 * errors such as throttling or a missing scope, a non-JSON/non-200 answer, a
 * network error) is logged as before AND returned as
 * `{ ok: false, error: <one compact line> }`, so the caller can persist it and
 * the admin can show the merchant what is actually wrong (SPEC-1.6.1 §A).
 */
export async function syncProductMetafields(
  admin: AdminClient,
  productId: string,
  stats: ProductStatsDTO,
  topReviews: TopReviewSource[],
  summary: SummaryMetafieldSource | null,
): Promise<MetafieldSyncResult> {
  const ownerId = toProductGid(productId);

  const topReviewsValue = topReviews.slice(0, 3).map((review) => ({
    rating: review.rating,
    title: review.title ?? "",
    body: review.body.slice(0, 400),
    author: review.authorName,
    date: toIsoDate(review.createdAt),
    verified: review.verified,
  }));

  const summaryValue = summary
    ? {
        text: summary.text,
        topics: summary.topics.map((topic) => ({
          key: topic.key,
          label: topic.label,
          count: topic.count,
          sentiment: topic.sentiment,
        })),
      }
    : null;

  const metafields = [
    {
      ownerId,
      namespace: NAMESPACE,
      key: "rating",
      type: "number_decimal",
      value: stats.average.toFixed(1),
    },
    {
      ownerId,
      namespace: NAMESPACE,
      key: "rating_count",
      type: "number_integer",
      value: String(stats.count),
    },
    {
      ownerId,
      namespace: NAMESPACE,
      key: "distribution",
      type: "json",
      value: JSON.stringify(stats.distribution),
    },
    {
      ownerId,
      namespace: NAMESPACE,
      key: "top_reviews",
      type: "json",
      value: JSON.stringify(topReviewsValue),
    },
    {
      ownerId,
      namespace: NAMESPACE,
      key: "summary",
      type: "json",
      value: JSON.stringify(summaryValue),
    },
  ];

  try {
    const response = await admin.graphql(METAFIELDS_SET, { variables: { metafields } });

    // A rejected write can also come back as a non-JSON body (an HTML error
    // page from an edge proxy, an empty 5xx). Parsing must not turn that into
    // a thrown error that hides the HTTP status.
    let json: MetafieldsSetResponse | null = null;
    try {
      json = (await response.json()) as MetafieldsSetResponse;
    } catch {
      json = null;
    }

    const userErrors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error(`[cellexia] metafieldsSet(${productId}) userErrors:`, userErrors);
    }
    if (json?.errors) {
      console.error(`[cellexia] metafieldsSet(${productId}) errors:`, json.errors);
    }

    const failure = firstMetafieldFailure(json, response.status, response.ok);
    if (failure) {
      if (!userErrors.length && !json?.errors) {
        console.error(`[cellexia] metafieldsSet(${productId}) failed: ${failure}`);
      }
      return { ok: false, error: compactSyncError(failure) };
    }

    return { ok: true, error: null };
  } catch (error) {
    console.error(`[cellexia] metafieldsSet(${productId}) failed`, error);
    return { ok: false, error: compactSyncError(thrownErrorMessage(error)) };
  }
}

/**
 * Mirrors the storefront-relevant admin settings onto SHOP metafields so the
 * theme app extension can read them from Liquid (reviews.liquid reads
 * cellexia.show_translate / cellexia.brand_display_name /
 * cellexia.design_theme / cellexia.live, cx-jsonld.liquid reads
 * cellexia.emit_jsonld and cellexia.live). Called on every settings save and
 * from afterAuth. Failures are logged, never thrown — the storefront treats
 * an absent metafield as the default-on behaviour (SPEC-1.2: an absent
 * `cellexia.live` is treated as live, which keeps v1.0/v1.1 upgrades neutral;
 * new installs get it written `false` by afterAuth).
 *
 * v1.6 (SPEC-1.6 §2/§3) adds two more:
 *   proxy_path     the app-proxy subpath cx-proxy.liquid builds the storefront
 *                  API base from — one source of truth for the path.
 *   preview_token  the shop's current preview token, emitted by the extension
 *                  ONLY when `request.design_mode` is true so the merchant
 *                  sees real data inside the theme editor. A blank/missing
 *                  token is skipped rather than written empty (Shopify rejects
 *                  blank single_line_text_field values), which leaves the
 *                  previous value in place until a real token exists.
 */
export async function syncShopSettingsMetafields(
  admin: AdminClient,
  settings: {
    showTranslate: boolean;
    brandDisplayName: string;
    emitJsonLd: boolean;
    designTheme: string;
    isLive: boolean;
    previewToken: string | null;
    proxySubpath?: string | null;
  },
): Promise<void> {
  try {
    const ownerId = await fetchShopId(admin, "syncShopSettingsMetafields");
    if (!ownerId) return;

    const metafields = [
      {
        ownerId,
        namespace: NAMESPACE,
        key: "show_translate",
        type: "boolean",
        value: settings.showTranslate ? "true" : "false",
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "brand_display_name",
        type: "single_line_text_field",
        value: settings.brandDisplayName || "Cellexia",
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "emit_jsonld",
        type: "boolean",
        value: settings.emitJsonLd ? "true" : "false",
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "design_theme",
        type: "single_line_text_field",
        value: settings.designTheme || "amazon",
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "live",
        type: "boolean",
        value: settings.isLive ? "true" : "false",
      },
      {
        ownerId,
        namespace: NAMESPACE,
        key: "proxy_path",
        type: "single_line_text_field",
        value: sanitizeProxySubpath(settings.proxySubpath),
      },
    ];

    const previewToken = (settings.previewToken ?? "").trim();
    if (previewToken) {
      metafields.push({
        ownerId,
        namespace: NAMESPACE,
        key: "preview_token",
        type: "single_line_text_field",
        value: previewToken,
      });
    }

    await writeShopMetafields(admin, "syncShopSettingsMetafields", metafields);
  } catch (error) {
    console.error("[cellexia] syncShopSettingsMetafields failed", error);
  }
}

/**
 * Writes only the `cellexia.proxy_path` SHOP metafield (SPEC-1.6 §2).
 *
 * Called by `probeProxySubpath` the moment auto-discovery confirms which
 * subpath this install actually serves, so the theme extension follows the
 * detected path without waiting for a settings save. Failures are logged,
 * never thrown — a metafield hiccup must not fail an install or a health
 * check, and cx-proxy.liquid falls back to the shipped default.
 */
export async function setShopProxyPathMetafield(
  admin: AdminClient,
  subpath: string,
): Promise<void> {
  try {
    const ownerId = await fetchShopId(admin, "setShopProxyPathMetafield");
    if (!ownerId) return;

    await writeShopMetafields(admin, "setShopProxyPathMetafield", [
      {
        ownerId,
        namespace: NAMESPACE,
        key: "proxy_path",
        type: "single_line_text_field",
        value: sanitizeProxySubpath(subpath),
      },
    ]);
  } catch (error) {
    console.error("[cellexia] setShopProxyPathMetafield failed", error);
  }
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

interface ShopMetafieldInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

/** GraphQL userError as returned by metafieldsSet. `field` is a path array. */
interface MetafieldUserError {
  field?: unknown;
  message?: string;
  code?: string;
}

/** Parsed metafieldsSet response — both error channels are optional. */
interface MetafieldsSetResponse {
  data?: {
    metafieldsSet?: {
      userErrors?: MetafieldUserError[];
    };
  };
  errors?: unknown;
}

/* --- Sync failure reporting (SPEC-1.6.1 §A) -------------------------------- */

/**
 * The one reason to report for a metafieldsSet answer, or null when the write
 * succeeded. Priority follows how specific each channel is:
 *
 *   1. the first `userErrors` entry — Shopify explaining which metafield it
 *      refused and why (`field: message (code)`), by far the most actionable;
 *   2. a top-level GraphQL error — throttling, a missing scope, a malformed
 *      query: it applies to the whole request, so any one of them is the story;
 *   3. an unreadable body or a non-2xx status — nothing structured to quote,
 *      so report what is known: the HTTP status.
 */
function firstMetafieldFailure(
  json: MetafieldsSetResponse | null,
  status: number,
  ok: boolean,
): string | null {
  const userError = json?.data?.metafieldsSet?.userErrors?.[0];
  if (userError) return formatUserError(userError);

  const graphqlError = formatGraphqlError(json?.errors);
  if (graphqlError) return graphqlError;

  if (json === null) {
    return `Shopify returned HTTP ${status} and a response the app could not read as JSON.`;
  }
  if (!ok) return `Shopify returned HTTP ${status}.`;

  return null;
}

/** `field: message (code)` — each part omitted when Shopify did not send it. */
function formatUserError(error: MetafieldUserError): string {
  const field = formatUserErrorField(error.field);
  const message = (error.message ?? "").trim();
  const code = (error.code ?? "").trim();
  const head = field && message ? `${field}: ${message}` : field || message;
  if (!head) return code ? `(${code})` : UNKNOWN_SYNC_ERROR;
  return code ? `${head} (${code})` : head;
}

/**
 * GraphQL `field` is a path array (`["metafields", "0", "value"]`); older
 * shapes send a plain string. Both become a dotted path.
 */
function formatUserErrorField(field: unknown): string {
  if (typeof field === "string") return field.trim();
  if (!Array.isArray(field)) return "";
  return field
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map((part) => part.trim())
    .join(".");
}

/**
 * The first top-level GraphQL error as `message (code)`. Tolerates every shape
 * the client can hand back: the spec's array of `{ message, extensions.code }`,
 * a single object, or a bare string.
 */
function formatGraphqlError(errors: unknown): string | null {
  const first = Array.isArray(errors) ? errors[0] : errors;
  if (first === null || first === undefined) return null;

  if (typeof first === "string") return first.trim() || null;

  if (typeof first === "object") {
    const record = first as { message?: unknown; extensions?: { code?: unknown } };
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const code =
      typeof record.extensions?.code === "string" ? record.extensions.code.trim() : "";
    if (message) return code ? `${message} (${code})` : message;
    if (code) return `(${code})`;
  }

  return null;
}

/**
 * Message for a thrown failure. `GraphqlQueryError` from the Shopify client
 * carries the useful part in `body.errors`, not in `message` ("GraphQL query
 * returned errors"), so unwrap it when it is there.
 */
function thrownErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim() || UNKNOWN_SYNC_ERROR;

  if (typeof error === "object" && error !== null) {
    const record = error as { message?: unknown; body?: { errors?: unknown } };
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const nested = formatGraphqlError(record.body?.errors);
    if (message && nested && !message.includes(nested)) return `${message}: ${nested}`;
    if (message) return message;
    if (nested) return nested;
  }

  const text = String(error ?? "").trim();
  return text && text !== "[object Object]" ? text : UNKNOWN_SYNC_ERROR;
}

/**
 * One line, at most `MAX_SYNC_ERROR_CHARS` characters (the ellipsis counts), so
 * the value is safe for a database column, a JSON response and a Polaris table
 * cell no matter how verbose Shopify was.
 */
function compactSyncError(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return UNKNOWN_SYNC_ERROR;
  return cleaned.length > MAX_SYNC_ERROR_CHARS
    ? `${cleaned.slice(0, MAX_SYNC_ERROR_CHARS - 1)}…`
    : cleaned;
}

/** The SHOP GID, or null when the query fails (logged, never thrown). */
async function fetchShopId(admin: AdminClient, context: string): Promise<string | null> {
  const response = await admin.graphql(`#graphql
      query CellexiaShopId { shop { id } }`);
  const json = (await response.json()) as {
    data?: { shop?: { id?: string } };
  };
  const ownerId = json.data?.shop?.id;
  if (!ownerId) {
    console.error(`[cellexia] ${context}: no shop id`);
    return null;
  }
  return ownerId;
}

/** metafieldsSet for SHOP-owned metafields; userErrors/errors are logged. */
async function writeShopMetafields(
  admin: AdminClient,
  context: string,
  metafields: ShopMetafieldInput[],
): Promise<void> {
  const response = await admin.graphql(METAFIELDS_SET, { variables: { metafields } });
  const json = (await response.json()) as MetafieldsSetResponse;
  const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error(`[cellexia] ${context} userErrors:`, userErrors);
  }
  if (json.errors) {
    console.error(`[cellexia] ${context} errors:`, json.errors);
  }
}

function isAlreadyExistsError(error: { message?: string; code?: string }): boolean {
  if (error.code && ["TAKEN", "DUPLICATE_KEY"].includes(error.code)) return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("taken") ||
    message.includes("already exists") ||
    message.includes("in use")
  );
}

function toProductGid(productId: string): string {
  const id = String(productId);
  return id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`;
}

function toIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
}
