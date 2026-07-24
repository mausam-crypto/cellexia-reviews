/**
 * Cellexia Reviews — verified-purchase detection.
 *
 * A review is a "verified purchase" when the shop has an order containing the
 * reviewed product for that customer. Lookup order of preference:
 *   1. by `logged_in_customer_id` from the signed app-proxy params,
 *   2. by the submitted email address (orders search `email:` query).
 *
 * Requires the `read_orders` scope. Any GraphQL/network failure returns false
 * — verification is best-effort and must never block a submission.
 */
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` yields
 * `AdminApiContextWithoutRest`, which the package's `/server` entry does not
 * re-export. This module only uses `graphql`, so accept exactly that —
 * contexts with and without REST both satisfy it structurally.
 */
type AdminApiContext = Pick<BaseAdminApiContext, "graphql">;

const ORDERS_QUERY = `#graphql
  query CellexiaVerifiedOrders($query: String!) {
    orders(first: 20, query: $query) {
      nodes {
        id
        lineItems(first: 50) {
          nodes {
            product {
              id
            }
          }
        }
      }
    }
  }
`;

interface OrdersQueryResult {
  data?: {
    orders?: {
      nodes?: Array<{
        id?: string;
        lineItems?: {
          nodes?: Array<{ product?: { id?: string | null } | null }>;
        };
      }>;
    };
  };
  errors?: unknown;
}

export async function isVerifiedPurchase(
  admin: AdminApiContext,
  productId: string,
  email?: string,
  customerId?: string,
): Promise<boolean> {
  const pid = String(productId).replace(/\D/g, "");
  if (!pid) return false;

  const queries: string[] = [];
  const numericCustomerId = customerId ? String(customerId).replace(/\D/g, "") : "";
  if (numericCustomerId) queries.push(`customer_id:${numericCustomerId}`);
  const safeEmail = email ? String(email).trim().toLowerCase().replace(/["\\\s]/g, "") : "";
  if (safeEmail && safeEmail.includes("@")) queries.push(`email:"${safeEmail}"`);
  if (queries.length === 0) return false;

  for (const query of queries) {
    try {
      const response = await admin.graphql(ORDERS_QUERY, { variables: { query } });
      const json = (await response.json()) as OrdersQueryResult;
      if (json.errors) {
        console.error("[cellexia] verified-purchase orders query errors:", json.errors);
        continue;
      }
      const orders = json.data?.orders?.nodes ?? [];
      for (const order of orders) {
        const lineItems = order.lineItems?.nodes ?? [];
        for (const item of lineItems) {
          const gid = item.product?.id;
          if (gid && gid.endsWith(`/${pid}`)) return true;
        }
      }
    } catch (error) {
      console.error("[cellexia] verified-purchase lookup failed", error);
    }
  }

  return false;
}
