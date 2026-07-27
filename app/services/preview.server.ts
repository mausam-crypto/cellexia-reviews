/**
 * Cellexia Reviews — tokenized live-theme preview URL builder
 * (SPEC-1.2, SPEC-1.10 §5 fix B).
 *
 * While a store is not live, the merchant can preview the widget on their real
 * live theme through a tokenized link only they know (`?cx_preview=<token>`).
 *
 * v1.10 makes the preview multi-destination: `getPreviewUrls` returns one
 * tokenized URL per storefront surface — the product page (full widget), the
 * home page (Overall reviews block + card badges) and the collection page
 * (card badges; the handle is resolved to the store's real catalog collection,
 * Shopify) — so merchants can open the preview directly on any page instead
 * of having to navigate there from a tokenized product page.
 *
 * Product-page choice (unchanged from SPEC-1.2):
 *   1. the shop's most-reviewed product (Review table) that has a handle,
 *   2. any review with a product handle,
 *   3. the first active product from the Admin API,
 *   4. null — the store has no product page to preview on.
 *
 * The token comes from `getSettings`, which lazily generates and persists
 * `Setting.previewToken`, so links stay stable until the merchant regenerates
 * them from Settings → Data ("Regenerate preview link").
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";
import { getSettings } from "~/services/settings.server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` yields
 * `AdminApiContextWithoutRest` — which the package's public `/server` entry
 * does not re-export. This module only ever uses `graphql`, so accept exactly
 * that: contexts with and without REST both satisfy it.
 */
type AdminClient = Pick<AdminApiContext, "graphql">;

const ACTIVE_PRODUCT_QUERY = `#graphql
  query CellexiaPreviewProduct {
    products(first: 1, query: "status:active") {
      nodes {
        handle
      }
    }
  }
`;

interface ActiveProductResult {
  data?: {
    products?: {
      nodes?: Array<{ handle?: string | null }>;
    };
  };
  errors?: unknown;
}

/**
 * Returns the tokenized storefront preview URL for the shop —
 * `https://{shop}/products/{handle}?cx_preview={previewToken}` — or null when
 * the store has no product page to open the preview on.
 */
export async function getPreviewUrl(admin: AdminClient, shop: string): Promise<string | null> {
  const handle = await findPreviewProductHandle(admin, shop);
  if (!handle) return null;

  const settings = await getSettings(shop);
  const token = settings.previewToken;
  if (!token) {
    // getSettings lazily generates and persists the token; this guard only
    // narrows the nullable column type and covers a failed lazy init.
    return null;
  }

  return `https://${shop}/products/${encodeURIComponent(handle)}?cx_preview=${encodeURIComponent(
    token,
  )}`;
}

/**
 * The three tokenized preview destinations (SPEC-1.10 §5 fix B).
 *
 * `product` is null when the store has no product page to preview on — the
 * admin disables that menu item only; home and collection are always
 * available (the collection handle resolves to the store's catalog collection,
 * falling back to Shopify's implicit `all`).
 */
export interface PreviewUrls {
  product: string | null;
  home: string;
  collection: string;
}

/**
 * Returns the tokenized preview URLs for every preview destination:
 * `https://{shop}/products/{handle}?cx_preview={t}` (or null without a
 * product), `https://{shop}/?cx_preview={t}` and
 * `https://{shop}/collections/{resolved-handle}?cx_preview={t}` (see
 * findPreviewCollectionHandle for the resolution order).
 */
export async function getPreviewUrls(admin: AdminClient, shop: string): Promise<PreviewUrls> {
  const [handle, collectionHandle, settings] = await Promise.all([
    findPreviewProductHandle(admin, shop),
    findPreviewCollectionHandle(admin, shop),
    getSettings(shop),
  ]);

  // getSettings lazily generates and persists the token, so it is present in
  // practice; the fallback only narrows the nullable column type. An empty
  // token degrades to plain storefront URLs (the not-live gating simply shows
  // nothing) — it never breaks the Dashboard.
  const token = settings.previewToken;
  const query = `?cx_preview=${encodeURIComponent(token ?? "")}`;
  const base = `https://${shop}`;

  return {
    // Same corner-case semantics as getPreviewUrl: no handle OR no token ⇒ null.
    product:
      handle && token ? `${base}/products/${encodeURIComponent(handle)}${query}` : null,
    home: `${base}/${query}`,
    collection: `${base}/collections/${encodeURIComponent(collectionHandle)}${query}`,
  };
}

/**
 * Picks the collection the merchant would actually call their catalog page.
 *
 * Merchants rarely use Shopify's implicit `/collections/all`; stores like
 * Cellexia's use a hand-made "shop-all" collection, and previewing the
 * implicit one shows a page shoppers never visit. Resolution order:
 *   1. a published collection whose handle is one of PREFERRED_COLLECTION_HANDLES
 *      (in that order);
 *   2. the first published collection returned by the Admin API;
 *   3. the literal `all` (always renderable on Shopify).
 * Cached per shop for 10 minutes — the Dashboard calls this on every load.
 */
const PREFERRED_COLLECTION_HANDLES = ["shop-all", "all", "all-products", "shop"];
const COLLECTION_CACHE_TTL_MS = 10 * 60 * 1000;
const collectionCache = new Map<string, { handle: string; expires: number }>();

const PREVIEW_COLLECTIONS_QUERY = `#graphql
  query CellexiaPreviewCollections {
    collections(first: 50, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        handle
        publishedOnCurrentPublication
      }
    }
  }
`;

async function findPreviewCollectionHandle(admin: AdminClient, shop: string): Promise<string> {
  const cached = collectionCache.get(shop);
  if (cached && cached.expires > Date.now()) return cached.handle;

  let handle = "all";
  try {
    const response = await admin.graphql(PREVIEW_COLLECTIONS_QUERY);
    const json = (await response.json()) as {
      data?: {
        collections?: {
          nodes?: Array<{ handle?: string; publishedOnCurrentPublication?: boolean }>;
        };
      };
    };
    const published = (json.data?.collections?.nodes ?? []).filter(
      (node): node is { handle: string; publishedOnCurrentPublication?: boolean } =>
        typeof node.handle === "string" &&
        node.handle.length > 0 &&
        node.publishedOnCurrentPublication !== false,
    );
    const preferred = PREFERRED_COLLECTION_HANDLES.map((wanted) =>
      published.find((node) => node.handle === wanted),
    ).find(Boolean);
    handle = preferred?.handle ?? published[0]?.handle ?? "all";
  } catch (error) {
    console.error("[cellexia] preview collection lookup failed", error);
  }

  collectionCache.set(shop, { handle, expires: Date.now() + COLLECTION_CACHE_TTL_MS });
  return handle;
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

/** Non-null, non-empty product-handle filter for Review rows. */
function hasHandleFilter() {
  return { NOT: [{ productHandle: null }, { productHandle: "" }] };
}

async function findPreviewProductHandle(
  admin: AdminClient,
  shop: string,
): Promise<string | null> {
  // 1. The shop's most-reviewed product, when one of its reviews has a handle.
  const groups = await prisma.review.groupBy({
    by: ["productId"],
    where: { shop },
    _count: { _all: true },
  });
  if (groups.length > 0) {
    const top = [...groups].sort((a, b) => b._count._all - a._count._all)[0];
    const row = await prisma.review.findFirst({
      where: { shop, productId: top.productId, ...hasHandleFilter() },
      orderBy: { createdAt: "desc" },
      select: { productHandle: true },
    });
    const handle = row?.productHandle?.trim();
    if (handle) return handle;
  }

  // 2. Any review with a product handle.
  const anyRow = await prisma.review.findFirst({
    where: { shop, ...hasHandleFilter() },
    orderBy: { createdAt: "desc" },
    select: { productHandle: true },
  });
  const anyHandle = anyRow?.productHandle?.trim();
  if (anyHandle) return anyHandle;

  // 3. First active product via the Admin API. Best-effort: a GraphQL hiccup
  //    must never break the dashboard — it only disables the preview button.
  try {
    const response = await admin.graphql(ACTIVE_PRODUCT_QUERY);
    const json = (await response.json()) as ActiveProductResult;
    if (json.errors) {
      console.error("[cellexia] preview product query errors:", json.errors);
      return null;
    }
    const handle = json.data?.products?.nodes?.[0]?.handle?.trim();
    return handle ? handle : null;
  } catch (error) {
    console.error("[cellexia] preview product lookup failed", error);
    return null;
  }
}
