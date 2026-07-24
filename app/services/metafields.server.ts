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
 * stale SSR content disappears. Failures are logged, never thrown.
 */
export async function syncProductMetafields(
  admin: AdminClient,
  productId: string,
  stats: ProductStatsDTO,
  topReviews: TopReviewSource[],
  summary: SummaryMetafieldSource | null,
): Promise<void> {
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
    const json = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors?: Array<{ field?: unknown; message?: string; code?: string }>;
        };
      };
      errors?: unknown;
    };
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error(`[cellexia] metafieldsSet(${productId}) userErrors:`, userErrors);
    }
    if (json.errors) {
      console.error(`[cellexia] metafieldsSet(${productId}) errors:`, json.errors);
    }
  } catch (error) {
    console.error(`[cellexia] metafieldsSet(${productId}) failed`, error);
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
 */
export async function syncShopSettingsMetafields(
  admin: AdminClient,
  settings: {
    showTranslate: boolean;
    brandDisplayName: string;
    emitJsonLd: boolean;
    designTheme: string;
    isLive: boolean;
  },
): Promise<void> {
  try {
    const shopResponse = await admin.graphql(`#graphql
      query CellexiaShopId { shop { id } }`);
    const shopJson = (await shopResponse.json()) as {
      data?: { shop?: { id?: string } };
    };
    const ownerId = shopJson.data?.shop?.id;
    if (!ownerId) {
      console.error("[cellexia] syncShopSettingsMetafields: no shop id");
      return;
    }

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
    ];

    const response = await admin.graphql(METAFIELDS_SET, { variables: { metafields } });
    const json = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors?: Array<{ field?: unknown; message?: string; code?: string }>;
        };
      };
      errors?: unknown;
    };
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("[cellexia] syncShopSettingsMetafields userErrors:", userErrors);
    }
    if (json.errors) {
      console.error("[cellexia] syncShopSettingsMetafields errors:", json.errors);
    }
  } catch (error) {
    console.error("[cellexia] syncShopSettingsMetafields failed", error);
  }
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

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
