/**
 * Cellexia Reviews — AI Curator automatic refresh (SPEC-1.18 §2).
 *
 * An in-process hourly sweep that re-queues ONLY (product, locale) pairs
 * which (a) already have a stored curation, (b) are stale (SPEC-1.17
 * staleness), and (c) whose last run is at least one refresh window old
 * (daily = 24 h, weekly = 7 d). First-time curation is never automatic.
 *
 * Only shops that explicitly opted in (Setting.curationRefresh = daily |
 * weekly) are swept; everything runs through queueCurationPairs, so the
 * shared rails (the merchant's spend ceiling, concurrency 2, 10-min debounce,
 * failure recording) apply unchanged.
 *
 * Mechanics mirror jobs.server.ts: globalThis-stored singleton so dev
 * module reloads never double-arm, an unref'd setTimeout chain (never
 * setInterval), armed idempotently from the Display-page loader and from
 * listReviews — arming is a no-op once armed, and the proxy path never
 * runs a sweep inline. Admin API access uses the offline session
 * (unauthenticated.admin), the jobs.server.ts pattern; a shop without an
 * offline session is skipped quietly until the next sweep.
 */
import prisma from "~/db.server";
import {
  asCurationSource,
  curationStatus,
  lastCurationAttempt,
  qualifyingLocales,
  queueCurationPairs,
  checkBudget,
} from "./curation.server";
import { getSettings } from "./settings.server";

const FIRST_TICK_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/**
 * While a Message Batch is still open the sweep runs far more often: the
 * admin page only refreshes batch STATUS (applying results there would hang
 * the page load), so this chain is what actually applies them, and an hour of
 * "finished but not applied" would feel broken.
 */
const OPEN_BATCH_INTERVAL_MS = 5 * 60 * 1000;
/** Max (product, locale) pairs one sweep will qualify and queue. */
const SWEEP_MAX_PAIRS = 300;
const REFRESH_WINDOWS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

interface SchedulerState {
  armed: boolean;
  sweeping: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const globalStore = globalThis as typeof globalThis & {
  __cellexiaCurationScheduler?: SchedulerState;
};
const state: SchedulerState =
  globalStore.__cellexiaCurationScheduler ?? { armed: false, sweeping: false, timer: null };
globalStore.__cellexiaCurationScheduler = state;

/** Idempotent: arms the hourly sweep chain once per process. */
export function ensureCurationScheduler(): void {
  if (state.armed) return;
  state.armed = true;
  schedule(FIRST_TICK_MS);
}

function schedule(delayMs: number): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void tick();
  }, delayMs);
  // The sweep timer must never be what keeps the process alive.
  const timer = state.timer as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  if (state.sweeping) {
    schedule(SWEEP_INTERVAL_MS);
    return;
  }
  state.sweeping = true;
  let openBatchesRemain = false;
  try {
    const shops = await prisma.setting.findMany({
      where: { curationRefresh: { in: ["daily", "weekly"] } },
      select: { shop: true },
    });
    for (const { shop } of shops) {
      try {
        await sweepShopCurations(shop);
      } catch (error) {
        console.error(`[cellexia] curation sweep failed for ${shop}`, error);
      }
    }
    // v1.20 (SPEC-1.20 §4): advance any open Message Batch, for EVERY shop
    // that has one — not just shops on an auto-refresh schedule, since a
    // batch is usually started by hand. Applying is claim-guarded, so this
    // racing the admin page is safe.
    try {
      openBatchesRemain = await pollOpenBatches();
    } catch (error) {
      console.error("[cellexia] batch poll sweep failed", error);
    }
  } catch (error) {
    console.error("[cellexia] curation sweep failed", error);
  } finally {
    state.sweeping = false;
    schedule(openBatchesRemain ? OPEN_BATCH_INTERVAL_MS : SWEEP_INTERVAL_MS);
  }
}

/**
 * One shop's sweep — exported for tests (pass `now` for determinism).
 * Queues stale, window-old existing curations; returns how many were queued.
 */
export async function sweepShopCurations(
  shop: string,
  now: number = Date.now(),
): Promise<{ queued: number }> {
  const settings = await getSettings(shop);
  const window = REFRESH_WINDOWS[settings.curationRefresh] ?? null;
  if (!window) return { queued: 0 };
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return { queued: 0 };

  // v1.20 (SPEC-1.20 §3): the daily cap is gone. The sweep still stops early
  // when the shop's spend ceiling is already reached, so a budget-capped shop
  // costs each sweep nothing.
  const budget = await checkBudget(shop, 0);
  if (!budget.ok) return { queued: 0 };

  const rows = await curationStatus(shop);
  // Window math uses the last ATTEMPT, not just the last success —
  // AiCuration.updatedAt only advances when a run stores a curation, so
  // without this a persistently failing pair would be retried every hourly
  // sweep (billing model calls against the merchant's ceiling) instead of
  // once per refresh window.
  const due = rows.filter(
    (r) =>
      r.stale &&
      now - Math.max(r.updatedAt.getTime(), lastCurationAttempt(shop, r.productId, r.locale)) >=
        window,
  );
  if (due.length === 0) return { queued: 0 };

  // Re-check qualification per product with the CURRENT review set: this
  // skips products that dropped below 3 published reviews (guaranteed
  // no_reviews) and, in as_seen mode, locales that no longer have enough
  // local texts — a stale row alone is not a license to burn a model call.
  const source = asCurationSource(settings.curationSource);
  // Bound one sweep's qualification queries so a huge backlog can't turn a
  // single hourly tick into thousands of queries; the rest is picked up by
  // later sweeps.
  const dueNow = due.slice(0, SWEEP_MAX_PAIRS);
  const byProduct = new Map<string, typeof due>();
  for (const r of dueNow) {
    const list = byProduct.get(r.productId) ?? [];
    list.push(r);
    byProduct.set(r.productId, list);
  }
  const pairs: Array<{ productId: string; locale: string }> = [];
  for (const [productId, dueRows] of byProduct) {
    const locales = await qualifyingLocales(shop, productId, source);
    for (const r of dueRows) {
      if (locales.includes(r.locale)) pairs.push({ productId, locale: r.locale });
    }
  }
  if (pairs.length === 0) return { queued: 0 };

  let admin;
  try {
    const { unauthenticated } = await import("~/shopify.server");
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    console.error(`[cellexia] curation sweep: no offline session for ${shop}`, error);
    return { queued: 0 };
  }

  const summary = await queueCurationPairs(shop, admin, pairs);
  if (summary.queued > 0) {
    console.log(`[cellexia] curation auto-refresh queued ${summary.queued} run(s) for ${shop}`);
  }
  return { queued: summary.queued };
}

/**
 * v1.20: polls every shop with an unfinished curation batch. Runs on the same
 * unref'd timer chain as the refresh sweep; each shop is isolated so one bad
 * offline session cannot stop the others.
 */
async function pollOpenBatches(): Promise<boolean> {
  const where = { status: { in: ["in_progress", "canceling", "ended"] }, appliedAt: null };
  const rows = await prisma.curationBatch.findMany({
    where,
    select: { shop: true },
    distinct: ["shop"],
    take: 25,
  });
  if (rows.length === 0) return false;
  const { pollCurationBatches, releaseStaleReservations } = await import(
    "./curation-batch.server"
  );
  // Any batch we could never reach has held money back long enough.
  await releaseStaleReservations().catch((error) => {
    console.error("[cellexia] stale reservation release failed", error);
    return 0;
  });
  // No offline Shopify session is needed: applying a batch reads only this
  // app's own database. Requiring one would mean a shop whose session had
  // lapsed could never collect results it had already paid for.
  for (const { shop } of rows) {
    try {
      await pollCurationBatches(shop);
    } catch (error) {
      console.error(`[cellexia] batch poll failed for ${shop}`, error);
    }
  }
  // Anything still unapplied keeps the fast tick going.
  const remaining = await prisma.curationBatch.count({ where });
  return remaining > 0;
}
