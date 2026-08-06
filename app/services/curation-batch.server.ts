/**
 * Cellexia Reviews — AI curation via the Anthropic Message Batches API
 * (SPEC-1.20 §4). Bulk curation is not latency-sensitive, and batches bill at
 * HALF the standard rate, so "Curate all" defaults here.
 *
 * Raw HTTP (this app does not use the SDK):
 *   POST /v1/messages/batches            {requests:[{custom_id, params}]}
 *   GET  /v1/messages/batches/{id}       processing_status, request_counts,
 *                                        results_url (null until "ended")
 *   GET  <results_url>                   JSONL, one result per line
 *   POST /v1/messages/batches/{id}/cancel
 *
 * A batch result is applied through applyCurationResponse — the SAME
 * validation, MIN_ORDER floor, dash scrub and upsert as an instant run — so
 * batch and instant curations are behaviourally identical. The candidate set
 * is rebuilt at apply time from the same deterministic assembly, which is
 * what lets id validation work without persisting every candidate set; that
 * rebuild deliberately touches neither Shopify nor the translation provider,
 * because a result that has already been paid for must not be discarded by
 * anything outside this app's own database.
 */
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import prisma from "~/db.server";
import {
  anthropicMessageParams,
  applyCurationResponse,
  buildCurationRequest,
  rebuildCurationTarget,
} from "./curation.server";
import type { ProductContextCache } from "./curation.server";
import { costUsd } from "./pricing.server";
import { getSettings } from "./settings.server";
import { addSpend, adjustSpend, checkBudget, currentMonth } from "./spend.server";

type AdminClient = Pick<AdminApiContext, "graphql">;

const BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic's own ceiling is 100k requests / 256 MB; stay well inside it. */
const MAX_REQUESTS_PER_BATCH = 2000;
/**
 * ...and the request-count bound alone is not enough: an uncapped payload can
 * be well over a megabyte, so 2000 of them would blow past 256 MB (and the
 * memory of the process building the body). Cut the batch on bytes too and
 * report the remainder as skipped so the admin can submit a second batch.
 */
const MAX_BATCH_BYTES = 96 * 1024 * 1024;
/**
 * How long one poll owns the job of applying a batch. Long enough that a slow
 * apply is never interrupted, short enough that a process killed mid-apply
 * does not strand paid-for results for long.
 */
const CLAIM_TTL_MS = 20 * 60 * 1000;
/** How long one submit may hold the per-shop lock before it is considered dead. */
const SUBMIT_LOCK_TTL_MS = 15 * 60 * 1000;
/** Anthropic expires a batch after 24 h; past this it cannot still be running. */
const BATCH_MAX_LIFETIME_MS = 26 * 60 * 60 * 1000;
/** ...and past this its reservation has certainly outlived its usefulness. */
const STALE_RESERVATION_MS = 30 * 60 * 60 * 1000;

/** custom_id must match ^[a-zA-Z0-9_-]{1,64}$ (Anthropic contract). */
export function batchCustomId(productId: string, locale: string): string | null {
  const id = `c_${productId}_${locale}`;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null;
}

/**
 * What a batch stores per request. `sourceCount` is how many reviews were
 * published when the payload was BUILT — the agent answered about that set,
 * so it is what staleness must be judged against. Recomputing it at apply
 * time (up to 24 hours later) would stamp the curation as having read reviews
 * it never saw, and the auto-refresh sweep would then never re-run it.
 */
export interface BatchPair {
  productId: string;
  locale: string;
  sourceCount?: number;
  /** How many the agent actually read. Paired with sourceCount, same moment. */
  reviewCount?: number;
}

export function parseCustomId(
  customId: string,
  pairs: Record<string, BatchPair>,
): BatchPair | null {
  return pairs[customId] ?? null;
}

function headers(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

export type SubmitResult =
  | { status: "ok"; batchId: string; requestCount: number; skipped: number }
  | { status: "no_ai" | "no_pairs" | "failed" | "already_running" }
  | { status: "over_budget"; spent: number; ceiling: number };

/**
 * Builds every (product, locale) payload and submits them as ONE batch.
 * Pairs whose custom_id would be invalid, or that cannot be built, are
 * reported as `skipped` rather than silently dropped.
 */
export async function submitCurationBatch(
  shop: string,
  admin: AdminClient,
  pairs: Array<{ productId: string; locale: string }>,
  estimatedCostUsd = 0,
): Promise<SubmitResult> {
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return { status: "no_ai" };

  const budget = await checkBudget(shop, estimatedCostUsd);
  if (!budget.ok && budget.ceiling != null) {
    return { status: "over_budget", spent: budget.spent, ceiling: budget.ceiling };
  }

  // One open batch at a time — and the guard is a LOCK, not a look. Building
  // payloads takes seconds to minutes, so a plain "is one already running?"
  // check would let two clicks both pass before either had created a row, and
  // the same work would be submitted and billed twice.
  if (await hasOpenBatch(shop)) return { status: "already_running" };
  if (!(await acquireSubmitLock(shop))) return { status: "already_running" };
  try {
    return await buildAndSubmit(shop, admin, pairs, estimatedCostUsd, settings);
  } finally {
    await releaseSubmitLock(shop);
  }
}

/**
 * Compare-and-set on Setting.curationBatchLock: the update only matches when
 * the lock is free or has expired, so exactly one caller can hold it.
 */
async function acquireSubmitLock(shop: string): Promise<boolean> {
  const now = new Date();
  const expiry = new Date(now.getTime() - SUBMIT_LOCK_TTL_MS);
  const taken = await prisma.setting.updateMany({
    where: { shop, OR: [{ curationBatchLock: null }, { curationBatchLock: { lt: expiry } }] },
    data: { curationBatchLock: now },
  });
  return taken.count === 1;
}

async function releaseSubmitLock(shop: string): Promise<void> {
  await prisma.setting
    .update({ where: { shop }, data: { curationBatchLock: null } })
    .catch(() => undefined);
}

async function buildAndSubmit(
  shop: string,
  admin: AdminClient,
  pairs: Array<{ productId: string; locale: string }>,
  estimatedCostUsd: number,
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<SubmitResult> {
  // Re-check under the lock: the run that held it before us may have just
  // created the batch this one would duplicate.
  if (await hasOpenBatch(shop)) return { status: "already_running" };
  const apiKey = settings.anthropicApiKey;
  if (!apiKey) return { status: "no_ai" };

  const requests: Array<{ custom_id: string; params: Record<string, unknown> }> = [];
  const map: Record<string, BatchPair> = {};
  let skipped = 0;
  let bytes = 0;
  let truncatedAt: number | null = null;
  // One Shopify fetch per product across all 17 locales of this submit.
  const contextCache: ProductContextCache = new Map();

  const considered = pairs.slice(0, MAX_REQUESTS_PER_BATCH);
  for (const [position, pair] of considered.entries()) {
    const customId = batchCustomId(pair.productId, pair.locale);
    if (!customId || map[customId]) {
      skipped += 1;
      continue;
    }
    const built = await buildCurationRequest(shop, admin, pair.productId, pair.locale, {
      contextCache,
    });
    if (built.status !== "ok") {
      skipped += 1;
      continue;
    }
    // Approximate the wire size (payloads are overwhelmingly ASCII review
    // text; the JSON envelope is noise beside it) and stop before 256 MB.
    bytes += built.request.system.length + built.request.userContent.length + 256;
    if (bytes > MAX_BATCH_BYTES && requests.length > 0) {
      truncatedAt = position;
      break;
    }
    requests.push({
      custom_id: customId,
      // The SAME params builder the instant path uses — including the
      // thinking override, without which a background run on Sonnet 5 thinks
      // its max_tokens away and truncates exactly like the instant bug did.
      params: anthropicMessageParams(built.request),
    });
    map[customId] = {
      productId: pair.productId,
      locale: pair.locale,
      // Trimmed runs record the published total; untrimmed ones read everything.
      sourceCount: built.request.trimmedFrom ?? built.request.candidates.length,
      reviewCount: built.request.candidates.length,
    };
  }
  const skippedByBytes = truncatedAt != null ? considered.length - truncatedAt : 0;
  skipped += skippedByBytes;
  if (pairs.length > MAX_REQUESTS_PER_BATCH) skipped += pairs.length - MAX_REQUESTS_PER_BATCH;
  if (requests.length === 0) return { status: "no_pairs" };

  try {
    const response = await fetch(BATCHES_URL, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`[cellexia] batch submit failed ${response.status}: ${detail.slice(0, 300)}`);
      return { status: "failed" };
    }
    const data = (await response.json()) as { id?: string };
    if (!data.id) return { status: "failed" };

    // Reserve the estimated cost immediately. A batch bills up to 24 hours
    // later, so without this a merchant $40 into a $50 ceiling could submit
    // ten $9 batches, each passing a check that sees only $40 spent. The
    // reservation is reconciled to the real cost when the results land, and
    // released in full if the batch is cancelled.
    // Pro-rate ONLY for the byte truncation, and only over the pairs that
    // would have built. The estimate already excluded pairs that cannot be
    // prepared (no product, too few reviews), so scaling by every skip would
    // discount a cost that was never included in the first place.
    const attempted = requests.length + skippedByBytes;
    const reservedUsd =
      skippedByBytes > 0 && attempted > 0
        ? Math.max(0, estimatedCostUsd) * (requests.length / attempted)
        : Math.max(0, estimatedCostUsd);

    // Charge the ledger BEFORE storing the row, and undo it if the row does
    // not store: a reservation the row claims but the ledger never took would
    // be "released" later against money that was never charged.
    const reservedMonth = currentMonth();
    await addSpend(shop, reservedUsd);
    try {
      await prisma.curationBatch.create({
        data: {
          shop,
          anthropicBatchId: data.id,
          status: "in_progress",
          model: settings.aiModel,
          requestCount: requests.length,
          pairs: JSON.stringify(map),
          reservedUsd,
          reservedMonth,
        },
      });
    } catch (error) {
      // The batch is live at Anthropic but we have no row for it, so we could
      // never poll it, apply it, or account for it — and it would bill. Cancel
      // it at the source, then give the reservation back.
      console.error("[cellexia] batch row could not be stored; cancelling at Anthropic", error);
      await fetch(`${BATCHES_URL}/${data.id}/cancel`, {
        method: "POST",
        headers: headers(apiKey),
      }).catch(() => undefined);
      await adjustSpend(shop, -reservedUsd, reservedMonth);
      return { status: "failed" };
    }
    return { status: "ok", batchId: data.id, requestCount: requests.length, skipped };
  } catch (error) {
    console.error("[cellexia] batch submit request failed", error);
    return { status: "failed" };
  }
}

interface BatchStatusPayload {
  processing_status?: string;
  results_url?: string | null;
  request_counts?: {
    processing?: number;
    succeeded?: number;
    errored?: number;
    canceled?: number;
    expired?: number;
  };
  ended_at?: string | null;
}

function openBatches(shop: string) {
  return prisma.curationBatch.findMany({
    where: { shop, status: { in: ["in_progress", "canceling", "ended"] }, appliedAt: null },
    orderBy: { submittedAt: "asc" },
    take: 5,
  });
}

/**
 * Refreshes the STATUS of every open batch and stores it — one cheap GET per
 * batch, at most five, in parallel. Applies nothing. This is what the admin
 * page calls: a page load must never be held open while hundreds of curations
 * are written. Returns how many batches are still unfinished.
 */
export async function refreshBatchStatuses(shop: string): Promise<{ open: number }> {
  const settings = await getSettings(shop);
  if (!settings.anthropicApiKey) return { open: 0 };
  const open = await openBatches(shop);
  if (open.length === 0) return { open: 0 };

  const statuses = await Promise.all(
    open.map((batch) => fetchBatchStatus(batch.anthropicBatchId, settings.anthropicApiKey!)),
  );
  let unfinished = 0;
  for (const [i, data] of statuses.entries()) {
    if (!data) {
      unfinished += 1;
      continue;
    }
    await storeBatchStatus(open[i].id, open[i].status, data);
    if (data.processing_status !== "ended") unfinished += 1;
  }
  return { open: unfinished };
}

async function fetchBatchStatus(
  anthropicBatchId: string,
  apiKey: string,
): Promise<BatchStatusPayload | null> {
  try {
    const response = await fetch(`${BATCHES_URL}/${anthropicBatchId}`, {
      headers: headers(apiKey),
    });
    if (!response.ok) {
      console.error(`[cellexia] batch poll failed ${response.status}`);
      return null;
    }
    return (await response.json()) as BatchStatusPayload;
  } catch (error) {
    console.error("[cellexia] batch poll error", error);
    return null;
  }
}

async function storeBatchStatus(
  rowId: string,
  fallbackStatus: string,
  data: BatchStatusPayload,
): Promise<void> {
  const counts = data.request_counts ?? {};
  await prisma.curationBatch.update({
    where: { id: rowId },
    data: {
      status: data.processing_status ?? fallbackStatus,
      succeeded: counts.succeeded ?? 0,
      errored: counts.errored ?? 0,
      expired: counts.expired ?? 0,
      endedAt: data.ended_at ? new Date(data.ended_at) : null,
    },
  });
}

/**
 * Polls every unfinished batch for the shop, and APPLIES the results of any
 * that have ended. This is the scheduler's entry point — it can take minutes
 * on a large catalogue, so nothing user-facing should await it. Safe to call
 * repeatedly: applying is claim-guarded, so a result set is never applied
 * twice.
 */
export async function pollCurationBatches(
  shop: string,
): Promise<{ polled: number; applied: number }> {
  const settings = await getSettings(shop);
  if (!settings.anthropicApiKey) return { polled: 0, applied: 0 };

  const open = await openBatches(shop);
  let applied = 0;

  for (const batch of open) {
    try {
      const data = await fetchBatchStatus(batch.anthropicBatchId, settings.anthropicApiKey);
      if (!data) continue;
      await storeBatchStatus(batch.id, batch.status, data);
      if (data.processing_status !== "ended" || !data.results_url) continue;

      // Parse BEFORE claiming: a row whose pairs JSON is corrupt can never be
      // applied, and claiming it would just retry the same failure forever.
      let parsedPairs: Record<string, BatchPair>;
      try {
        parsedPairs = JSON.parse(batch.pairs) as Record<string, BatchPair>;
      } catch {
        console.error(`[cellexia] batch ${batch.anthropicBatchId} has unreadable pairs; failing it`);
        const heldUsd = batch.reservedUsd;
        const heldMonth = batch.reservedMonth || currentMonth();
        await prisma.curationBatch.update({
          where: { id: batch.id },
          data: {
            status: "failed",
            reservedUsd: 0,
            appliedAt: new Date(),
            error: "The record of what this run covered could not be read.",
          },
        });
        await adjustSpend(shop, -heldUsd, heldMonth);
        continue;
      }

      // Atomically CLAIM the batch before applying. The scheduler can run in
      // more than one process, and the admin's "Apply results now" can race
      // it; without this, two callers could apply the same results twice.
      // updateMany with the guard is a compare-and-set: exactly one wins.
      // The claim is deliberately separate from appliedAt — a process that
      // dies mid-apply leaves a claim that GOES STALE and is retried, rather
      // than a batch marked applied whose results never landed.
      const now = Date.now();
      const claim = await prisma.curationBatch.updateMany({
        where: {
          id: batch.id,
          appliedAt: null,
          OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now - CLAIM_TTL_MS) } }],
        },
        data: { claimedAt: new Date(now) },
      });
      if (claim.count !== 1) continue;

      try {
        const ok = await applyBatchResults(
          shop,
          batch.id,
          batch.anthropicBatchId,
          data.results_url,
          settings.anthropicApiKey,
          batch.model,
          parsedPairs,
        );
        if (ok) applied += 1;
      } catch (error) {
        // Anything that throws mid-apply must release the claim, or the batch
        // waits out CLAIM_TTL_MS for nothing. Anthropic keeps results for 29
        // days, so the next poll can simply try again.
        console.error("[cellexia] batch apply failed, releasing claim", error);
        await prisma.curationBatch
          .updateMany({ where: { id: batch.id }, data: { claimedAt: null } })
          .catch(() => undefined);
      }
    } catch (error) {
      console.error("[cellexia] batch poll error", error);
    }
  }
  return { polled: open.length, applied };
}

/**
 * Streams the JSONL result file and applies each line. A malformed line, or
 * one whose custom_id is unknown, is counted as a failure for that pair and
 * never aborts the rest of the file.
 */
async function applyBatchResults(
  shop: string,
  rowId: string,
  anthropicBatchId: string,
  resultsUrl: string,
  apiKey: string,
  model: string,
  pairs: Record<string, BatchPair>,
): Promise<boolean> {
  // Read the reservation NOW, not from the row this poll started with: a
  // cancel between the two would already have released it, and reconciling
  // against a stale figure would give the same money back twice.
  const current = await prisma.curationBatch.findUnique({
    where: { id: rowId },
    select: { reservedUsd: true, reservedMonth: true },
  });
  const reservedUsd = current?.reservedUsd ?? 0;
  const reservedMonth = current?.reservedMonth || currentMonth();
  // The API key travels with this request, so only ever send it to Anthropic.
  // results_url comes back from the API, but a redirect to object storage (or
  // a compromised response) must not be handed our credentials — Node's fetch
  // strips Authorization across origins, not custom headers like x-api-key.
  const response = await fetchBatchResults(resultsUrl, apiKey);
  if (!response || !response.ok) {
    console.error(`[cellexia] batch results fetch failed ${response?.status ?? "blocked"}`);
    // Release the claim so the next poll can retry (results live 29 days).
    await prisma.curationBatch
      .update({ where: { id: rowId }, data: { claimedAt: null } })
      .catch(() => undefined);
    return false;
  }
  const text = await response.text();

  let inputTokens = 0;
  let outputTokens = 0;
  let succeeded = 0;
  let failed = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: {
      custom_id?: string;
      result?: {
        type?: string;
        message?: {
          content?: Array<{ type?: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
          stop_reason?: string;
        };
      };
    };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      failed += 1;
      continue;
    }
    const pair = parsed.custom_id ? parseCustomId(parsed.custom_id, pairs) : null;
    if (!pair) {
      failed += 1;
      continue;
    }
    const usage = parsed.result?.message?.usage;
    inputTokens += Number(usage?.input_tokens ?? 0) || 0;
    outputTokens += Number(usage?.output_tokens ?? 0) || 0;

    if (parsed.result?.type !== "succeeded") {
      failed += 1;
      recordBatchFailure(shop, pair, parsed.result?.type ?? "errored");
      continue;
    }
    const body = Array.isArray(parsed.result.message?.content)
      ? parsed.result.message!.content!
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n")
      : "";
    if (!body) {
      failed += 1;
      recordBatchFailure(shop, pair, "failed");
      continue;
    }
    // Rebuild the candidate set so ids validate against what the agent was
    // given. Deterministic assembly makes this exact, and it deliberately
    // touches neither Shopify nor the translation provider: this result is
    // already paid for, so nothing outside our own database may cause it to
    // be discarded.
    const rebuilt = await rebuildCurationTarget(shop, pair.productId, pair.locale);
    if (rebuilt.status !== "ok") {
      failed += 1;
      recordBatchFailure(shop, pair, rebuilt.status);
      continue;
    }
    // Stamp the row with the model that actually produced it, not whatever
    // the shop happens to be set to now.
    const result = await applyCurationResponse(
      shop,
      pair.productId,
      { ...rebuilt.request, model },
      body,
      // Stamp what was published AT SUBMIT, not now: reviews added in the
      // meantime were never shown to this agent, and the row must read as
      // stale so the next refresh picks them up.
      { sourceCount: pair.sourceCount, reviewCount: pair.reviewCount },
    );
    if (result.status === "ok") succeeded += 1;
    else {
      failed += 1;
      recordBatchFailure(shop, pair, result.status);
    }
  }

  // Reconcile. Both ledger moves are gated on a compare-and-set against the
  // row, so a retry after a partial failure cannot repeat either of them.
  const actualUsd = costUsd({ model, inputTokens, outputTokens, batch: true }) ?? 0;

  // Release the reservation exactly once: zero it in the row FIRST, and only
  // credit the ledger if this call is the one that zeroed it. The credit goes
  // to the month it was charged to — a batch submitted on the 31st can land
  // on the 1st, and subtracting it from the new month would wipe out real
  // spend that reservation was never part of.
  if (reservedUsd > 0) {
    const cleared = await prisma.curationBatch.updateMany({
      where: { id: rowId, reservedUsd: { gt: 0 } },
      data: { reservedUsd: 0, reservedMonth: "" },
    });
    if (cleared.count === 1) await adjustSpend(shop, -reservedUsd, reservedMonth);
  }

  // Charge the real cost exactly once, for the same reason: the appliedAt
  // guard means only the call that finalizes the row moves the ledger.
  const finalized = await prisma.curationBatch.updateMany({
    where: { id: rowId, appliedAt: null },
    data: {
      status: "ended",
      succeeded,
      errored: failed,
      inputTokens,
      outputTokens,
      costUsd: actualUsd,
      // Only NOW is the batch really applied — the claim above only said
      // "this poll is doing it".
      appliedAt: new Date(),
    },
  });
  if (finalized.count === 1) await addSpend(shop, actualUsd);
  console.log(
    `[cellexia] batch ${anthropicBatchId} applied: ${succeeded} ok, ${failed} failed`,
  );
  return true;
}

function isAnthropicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * Fetches the JSONL results, sending the API key ONLY to Anthropic itself.
 * `results_url` is currently an authenticated api.anthropic.com endpoint, but
 * it is a value the API hands us, and it may redirect to object storage.
 * Node's fetch strips `Authorization` across origins — it does not strip a
 * custom `x-api-key` — so redirects are followed by hand: the key goes to
 * Anthropic hosts, and a redirect off-origin is re-fetched unauthenticated
 * (a presigned URL needs no key) rather than leaking the credential.
 */
async function fetchBatchResults(resultsUrl: string, apiKey: string): Promise<Response | null> {
  let url = resultsUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const authed = isAnthropicUrl(url);
    const response = await fetch(url, {
      headers: authed ? headers(apiKey) : { accept: "application/x-jsonlines, */*" },
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = new URL(location, url).toString();
  }
  console.error("[cellexia] batch results fetch exceeded the redirect limit");
  return null;
}

/** Batch failures ride the same recent-failures list as instant runs. */
function recordBatchFailure(
  shop: string,
  pair: { productId: string; locale: string },
  status: string,
): void {
  void import("./curation.server")
    .then((mod) => mod.recordExternalFailure(shop, pair.productId, pair.locale, status))
    .catch(() => {
      /* reporting only — never break result application */
    });
}

/**
 * Releases the reservation of any batch that is long past Anthropic's 24-hour
 * expiry and still has not been applied — the app could not reach it, so the
 * money it was holding back must not sit against the merchant's ceiling
 * forever. Called from the scheduler on every tick.
 */
export async function releaseStaleReservations(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RESERVATION_MS);
  const stale = await prisma.curationBatch.findMany({
    where: { appliedAt: null, reservedUsd: { gt: 0 }, submittedAt: { lt: cutoff } },
    select: { id: true, shop: true, reservedUsd: true, reservedMonth: true },
    take: 50,
  });
  for (const row of stale) {
    const heldUsd = row.reservedUsd;
    const heldMonth = row.reservedMonth || currentMonth();
    // Compare-and-set again: zero it first, credit only if we were the one
    // that zeroed it, so two sweeps cannot both hand the money back.
    const cleared = await prisma.curationBatch.updateMany({
      where: { id: row.id, reservedUsd: { gt: 0 } },
      data: { reservedUsd: 0, reservedMonth: "" },
    });
    if (cleared.count !== 1) continue;
    await adjustSpend(row.shop, -heldUsd, heldMonth);
    // ONLY the money is released. The status is deliberately left alone:
    // Anthropic keeps results for 29 days, and marking the batch finished
    // here would drop it out of the poll and abandon results the merchant
    // has already paid for. If it does land later, its real cost is recorded
    // then, and the reservation is already zero so nothing double-counts.
  }
  return stale.length;
}

export async function cancelCurationBatch(shop: string, batchId: string): Promise<boolean> {
  const settings = await getSettings(shop);
  if (!settings.anthropicApiKey) return false;
  const row = await prisma.curationBatch.findFirst({ where: { shop, anthropicBatchId: batchId } });
  if (!row) return false;
  try {
    const response = await fetch(`${BATCHES_URL}/${batchId}/cancel`, {
      method: "POST",
      headers: headers(settings.anthropicApiKey),
    });
    if (!response.ok) return false;
    // Give the reservation back now. Anthropic still bills for any request
    // that had already completed, and the poll that applies the cancelled
    // batch's partial results records that real cost — so releasing here
    // cannot double-count.
    // Read the reservation BEFORE the write that clears it — never after.
    const heldUsd = row.reservedUsd;
    const heldMonth = row.reservedMonth || currentMonth();
    const cleared = await prisma.curationBatch.updateMany({
      where: { id: row.id, reservedUsd: { gt: 0 } },
      data: { status: "canceling", reservedUsd: 0, reservedMonth: "" },
    });
    if (cleared.count === 1) {
      await adjustSpend(shop, -heldUsd, heldMonth);
    } else {
      await prisma.curationBatch.update({ where: { id: row.id }, data: { status: "canceling" } });
    }
    return true;
  } catch (error) {
    console.error("[cellexia] batch cancel failed", error);
    return false;
  }
}

/** Batches shown on the admin card (most recent first). */
export async function recentCurationBatches(shop: string, take = 5) {
  return prisma.curationBatch.findMany({
    where: { shop },
    orderBy: { submittedAt: "desc" },
    take,
  });
}

/**
 * Is a background run genuinely still going? Bounded by time, not just by
 * status: a batch stuck at "in_progress" because the app could never reach
 * Anthropic again would otherwise block every future run forever. Anthropic
 * expires batches after 24 hours, so anything older than that cannot still
 * be running whatever the stored status says.
 */
export async function hasOpenBatch(shop: string): Promise<boolean> {
  const count = await prisma.curationBatch.count({
    where: {
      shop,
      status: { in: ["in_progress", "canceling"] },
      submittedAt: { gt: new Date(Date.now() - BATCH_MAX_LIFETIME_MS) },
    },
  });
  return count > 0;
}
