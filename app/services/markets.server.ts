/**
 * Cellexia Reviews — Shopify Markets helpers (SPEC-1.14 §6).
 *
 * `listMarkets` asks the Admin API for the shop's markets so the Dashboard
 * can offer friendly checkboxes. The `markets` query needs the
 * `read_markets` scope, which this app historically shipped WITHOUT — on
 * ACCESS_DENIED we return { needsScope: true } instead of throwing, and the
 * Dashboard falls back to observed-market chips + manual handle entry.
 *
 * `recordObservedMarket` is the zero-scope fallback's data source: storefront
 * widget/badge requests carry a `market=<handle>` param (emitted by Liquid,
 * so it is exactly the value `localization.market.handle` will compare at
 * render time). Handles are collected into Setting.observedMarkets
 * ({handle: isoTimestamp}), debounced per shop, capped at 50, fire-and-forget.
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";

type AdminClient = Pick<AdminApiContext, "graphql">;

export interface MarketInfo {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
}

export interface MarketsResult {
  markets: MarketInfo[] | null;
  /** True when the app lacks the read_markets scope. */
  needsScope: boolean;
}

const MARKETS_QUERY = `#graphql
  query CellexiaMarkets {
    markets(first: 50) {
      nodes {
        id
        name
        handle
        enabled
      }
    }
  }
`;

export async function listMarkets(admin: AdminClient): Promise<MarketsResult> {
  try {
    const response = await admin.graphql(MARKETS_QUERY);
    const json = (await response.json()) as {
      data?: { markets?: { nodes?: Array<Partial<MarketInfo>> } };
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    if (json.errors?.length) {
      const denied = json.errors.some(
        (e) =>
          e.extensions?.code === "ACCESS_DENIED" ||
          /access denied|read_markets/i.test(e.message ?? ""),
      );
      if (denied) return { markets: null, needsScope: true };
      console.error("[cellexia] markets query errors:", json.errors);
      return { markets: null, needsScope: false };
    }
    const markets = (json.data?.markets?.nodes ?? [])
      .filter(
        (node): node is MarketInfo =>
          typeof node.id === "string" &&
          typeof node.name === "string" &&
          typeof node.handle === "string",
      )
      .map((node) => ({ ...node, enabled: node.enabled !== false }));
    return { markets, needsScope: false };
  } catch (error) {
    // A thrown GraphqlQueryError also carries the response body with codes.
    const message = error instanceof Error ? error.message : String(error);
    if (/ACCESS_DENIED|read_markets/i.test(message)) {
      return { markets: null, needsScope: true };
    }
    console.error("[cellexia] markets query failed", error);
    return { markets: null, needsScope: false };
  }
}

/* ------------------------------------------------------------------------- *
 * Observed markets (zero-scope fallback)
 * ------------------------------------------------------------------------- */

const HANDLE_RE = /^[a-z0-9-]{1,64}$/;

/** True when `handle` is a saveable market handle (same rule everywhere). */
export function isValidMarketHandle(handle: unknown): boolean {
  return HANDLE_RE.test(String(handle ?? "").trim().toLowerCase());
}
const OBSERVE_DEBOUNCE_MS = 60 * 1000;
const lastObserved = new Map<string, number>(); // `${shop}|${handle}` → ts

/**
 * Fire-and-forget: remember that `handle` was seen for `shop`. Never throws;
 * never blocks the proxy response (callers do NOT await it).
 */
export function recordObservedMarket(shop: string, rawHandle: unknown): void {
  const handle = String(rawHandle ?? "").trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) return;
  const key = `${shop}|${handle}`;
  const now = Date.now();
  const last = lastObserved.get(key) ?? 0;
  if (now - last < OBSERVE_DEBOUNCE_MS) return;
  // Review fix: bound the debounce map — beyond ~1000 distinct keys just
  // reset it (worst case: one extra DB read per key, never unbounded memory).
  if (lastObserved.size > 1000) lastObserved.clear();
  lastObserved.set(key, now);

  void (async () => {
    try {
      const row = await prisma.setting.findUnique({
        where: { shop },
        select: { observedMarkets: true },
      });
      if (!row) return;
      let observed: Record<string, string> = {};
      try {
        const parsed = JSON.parse(row.observedMarkets || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          observed = parsed as Record<string, string>;
        }
      } catch {
        observed = {};
      }
      if (!(handle in observed) && Object.keys(observed).length >= 50) return;
      observed[handle] = new Date().toISOString();
      await prisma.setting.update({
        where: { shop },
        data: { observedMarkets: JSON.stringify(observed) },
      });
    } catch (error) {
      console.error("[cellexia] recordObservedMarket failed", error);
    }
  })();
}

/** Parsed accessor for Setting.observedMarkets. */
export function parseObservedMarkets(raw: string): Array<{ handle: string; lastSeen: string }> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, string>)
      .filter(([handle]) => HANDLE_RE.test(handle))
      .map(([handle, lastSeen]) => ({ handle, lastSeen: String(lastSeen) }))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  } catch {
    return [];
  }
}
