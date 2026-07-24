/**
 * Cellexia Reviews — tokenized live-theme preview URL builder (SPEC-1.2).
 *
 * While a store is not live, the merchant can preview the widget on their real
 * live theme through a tokenized link only they know (`?cx_preview=<token>`).
 * This module picks the best product page to open the preview on:
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
