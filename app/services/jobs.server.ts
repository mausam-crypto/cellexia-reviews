/**
 * Cellexia Reviews — background generation job runner (SPEC-1.7 §3).
 *
 * Turns the synthetic QA generator into an uncapped, multi-job, server-side
 * system: `enqueueGeneration` records a GenerationJob row and returns
 * immediately; a module-level singleton loop (setTimeout-driven, never
 * setInterval) claims QUEUED jobs and drives `generateChunk`
 * (synthetic.server.ts) with chunk parallelism 2, persisting progress, actual
 * token usage/cost and a heartbeat after EVERY chunk.
 *
 * Correctness properties (the reason this file is structured the way it is):
 *
 *   - CLAIMS ARE ATOMIC — a job is claimed with a conditional
 *     `updateMany({ where: { id, status: "QUEUED" } })`; whoever flips the
 *     row wins, so a cancel racing a claim (or a second runner instance in
 *     dev hot-reload) can never double-run a job.
 *   - CRASH RECOVERY NEVER OVERSHOOTS — `recoverStaleJobs` re-queues RUNNING
 *     jobs whose heartbeat is older than 3 minutes; when a job is (re)claimed
 *     the existing Review rows for its batchId are counted FIRST and only
 *     `target - existing` more reviews are generated — selected by EXCLUSION
 *     (only plan specs whose batch-unique reviewer name has no row yet, see
 *     planRemainingChunks), so a resume after out-of-order parallel chunks
 *     neither duplicates nor skips specs. Already-created rows always stay.
 *   - CANCELLATION IS COOPERATIVE AND KEEPS WORK — `requestCancel` flips
 *     QUEUED jobs to CANCELLED directly and only sets `cancelRequested` on
 *     RUNNING ones; the workers re-read that flag from the row returned by
 *     every per-chunk progress write, finish the in-flight chunk, and stop.
 *     A VANISHED job row (batch deleted mid-run) is treated as a cancel too —
 *     persistChunkProgress maps Prisma P2025 to `state.cancelled` so a
 *     deleted job can never keep generating (and spending) to completion.
 *   - HONEST FAILURE SEMANTICS — chunk failures are retried once inside
 *     generateChunk, then recorded in `errors[]` (capped at 20) and skipped;
 *     a job ends FAILED only when zero reviews exist for it or the AI key is
 *     missing/invalid (fatal, aborts remaining chunks).
 *   - END-OF-RUN SYNC — whenever a run created rows (COMPLETED, CANCELLED or
 *     even FAILED-on-invalid-key-mid-run), the product's aggregates +
 *     metafields are re-synced exactly once via syncProductData, using an
 *     offline session (`unauthenticated.admin`) because there is no request
 *     context here.
 */
import crypto from "node:crypto";
import type { GenerationJob } from "@prisma/client";
import prisma from "~/db.server";
import { JOB_STATUSES } from "~/types/cellexia";
import type { EstimateDTO, JobDTO, JobStatus } from "~/types/cellexia";
import { syncProductData } from "~/components/admin/moderation.server";
import { MODEL_PRICING } from "./estimate.server";
import {
  SYNTHETIC_CHUNK_SIZE,
  buildBatchPlan,
  generateChunk,
  parseSyntheticConfig,
} from "./synthetic.server";
import type { GenerateChunkResult, SyntheticConfig } from "./synthetic.server";

/* ------------------------------------------------------------------------- *
 * Work-chunking constants (SPEC-1.7 §2)
 *
 * SINGLE-INSTANCE ASSUMPTION: these limits — and the whole in-process runner —
 * assume exactly one app instance, which this app already requires for SQLite
 * and the in-memory rate limiter (docs/INSTALL.md). On a multi-instance host
 * every instance would run its own loop; the atomic QUEUED→RUNNING claim
 * keeps that *correct* (no job runs twice), but the per-shop concurrency
 * limit would multiply per instance. Keep one instance.
 * ------------------------------------------------------------------------- */

/** Reviews per Claude call — unchanged from SPEC-1.4. */
export const CHUNK_SIZE = SYNTHETIC_CHUNK_SIZE;
/** Concurrent Claude calls within one job. */
export const CHUNK_PARALLELISM = 2;
/** Jobs allowed to be RUNNING at once per shop; the rest queue. */
export const MAX_RUNNING_JOBS_PER_SHOP = 2;
/** A RUNNING job whose heartbeat is older than this is treated as crashed. */
export const STALE_HEARTBEAT_MS = 3 * 60 * 1000;

/** Defensive global valve so many shops cannot melt a single instance. */
const MAX_CONCURRENT_JOBS = 4;
/** Re-tick cadence while any job is QUEUED/RUNNING (also re-runs recovery). */
const RUNNER_ACTIVE_POLL_MS = 60_000;
/** GenerationJob.errors cap (SPEC-1.7 §1). */
const MAX_JOB_ERRORS = 20;
/** GenerationJob.error cap (SPEC-1.7 §1). */
const MAX_FATAL_ERROR_LENGTH = 500;

const NO_AI_KEY_ERROR =
  "The generator needs the Anthropic API key from Settings → AI Summary";
const INVALID_AI_KEY_ERROR =
  "The Anthropic API rejected the configured key — update it under Settings → AI Summary.";

const ACTIVE_STATUSES: JobStatus[] = ["QUEUED", "RUNNING"];
const RETRYABLE_STATUSES: JobStatus[] = ["FAILED", "CANCELLED"];

/* ------------------------------------------------------------------------- *
 * Runner singleton state
 *
 * Stored on globalThis (same pattern as db.server.ts) so dev-server module
 * reloads reuse one state object instead of starting a second loop. All
 * fields are only touched from the single JS event loop — no locking needed.
 * ------------------------------------------------------------------------- */

interface RunnerState {
  /** A setTimeout for the next tick is pending. */
  scheduled: boolean;
  /**
   * The delay the pending tick was scheduled with. Lets kickRunner tell an
   * IMMEDIATE pending tick (nothing to do) apart from a delayed 60 s poll
   * tick, which must be preempted — otherwise every "wake now" event that
   * fires while a job runs (enqueue, freed slot, status poll) would silently
   * wait out the poll cadence.
   */
  scheduledDelayMs: number;
  /** A tick is executing right now. */
  ticking: boolean;
  /** kickRunner() arrived mid-tick — run another tick immediately after. */
  kickAgain: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Jobs this process is executing right now (id → completion promise). */
  executing: Map<string, Promise<void>>;
}

const globalStore = globalThis as typeof globalThis & {
  __cellexiaJobRunner?: RunnerState;
};
const runner: RunnerState =
  globalStore.__cellexiaJobRunner ??
  ({
    scheduled: false,
    scheduledDelayMs: 0,
    ticking: false,
    kickAgain: false,
    timer: null,
    executing: new Map(),
  } satisfies RunnerState);
globalStore.__cellexiaJobRunner = runner;

/**
 * Wakes the runner. Idempotent and non-blocking (SPEC-1.7 §3): called by
 * enqueueGeneration, afterAuth, the /app/jobs/status poll and any admin
 * loader that renders the activity bar. Calling it while a tick runs flags
 * an immediate follow-up tick, which closes the race where work is enqueued
 * just after the current tick queried the table. A pending DELAYED poll tick
 * (the 60 s cadence while jobs run) is preempted with an immediate one —
 * enqueues and freed slots must be picked up now, not on the next poll.
 */
export function kickRunner(): void {
  if (runner.ticking) {
    runner.kickAgain = true;
    return;
  }
  if (runner.scheduled) {
    // An immediate tick is already pending — nothing to add. A delayed one
    // would swallow the wake-up for up to RUNNER_ACTIVE_POLL_MS: replace it
    // (scheduleTick clears the old timer before arming the new one).
    if (runner.scheduledDelayMs > 0) scheduleTick(0);
    return;
  }
  scheduleTick(0);
}

function scheduleTick(delayMs: number): void {
  if (runner.timer) clearTimeout(runner.timer);
  runner.scheduled = true;
  runner.scheduledDelayMs = delayMs;
  runner.timer = setTimeout(() => {
    void runnerTick();
  }, delayMs);
  // A polling timer must never be what keeps the process alive. Guarded call
  // because the global setTimeout type can resolve to the DOM signature
  // (number) in this codebase even though we always run under Node.
  const timer = runner.timer as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();
}

async function runnerTick(): Promise<void> {
  runner.scheduled = false;
  runner.timer = null;
  runner.ticking = true;
  runner.kickAgain = false;
  let keepPolling = false;
  try {
    await recoverStaleJobs(); // top of every loop pass (SPEC-1.7 §3)
    await claimEligibleJobs();
    const active = await prisma.generationJob.count({
      where: { status: { in: ACTIVE_STATUSES } },
    });
    keepPolling = active > 0;
  } catch (error) {
    // DB hiccup — try again on the slow cadence rather than going silent.
    console.error("[cellexia] job runner tick failed", error);
    keepPolling = true;
  } finally {
    runner.ticking = false;
    if (runner.kickAgain) {
      runner.kickAgain = false;
      scheduleTick(0);
    } else if (keepPolling) {
      scheduleTick(RUNNER_ACTIVE_POLL_MS);
    }
    // Nothing queued or running → the loop stops entirely; the next
    // kickRunner() (enqueue, afterAuth, status poll) starts it again.
  }
}

/**
 * Claims QUEUED jobs while capacity allows: fewer than
 * MAX_RUNNING_JOBS_PER_SHOP RUNNING for the job's shop, and fewer than
 * MAX_CONCURRENT_JOBS executing in this process overall.
 *
 * SHOP-FAIR: candidates are selected PER SHOP (each queued shop's oldest
 * jobs, shops visited oldest-queue-first) rather than from one global
 * oldest-first window. A single global window lets a shop with a deep queue
 * fill every candidate slot; once its per-shop limit is hit, the loop would
 * end without ever seeing another shop's younger job — starving that shop
 * for hours even though global capacity is free.
 */
async function claimEligibleJobs(): Promise<void> {
  if (runner.executing.size >= MAX_CONCURRENT_JOBS) return;
  const queuedShops = await prisma.generationJob.groupBy({
    by: ["shop"],
    where: { status: "QUEUED" },
    _min: { createdAt: true },
  });
  // FIFO across shops: the shop whose oldest queued job is oldest goes first.
  queuedShops.sort((a, b) => {
    const aMs = a._min.createdAt ? a._min.createdAt.getTime() : 0;
    const bMs = b._min.createdAt ? b._min.createdAt.getTime() : 0;
    return aMs - bMs;
  });
  // Bounded work per tick, like the old 25-row window — but now the bound is
  // 25 SHOPS, so no shop's queue depth can hide another shop's jobs.
  for (const group of queuedShops.slice(0, 25)) {
    if (runner.executing.size >= MAX_CONCURRENT_JOBS) return;
    const running = await prisma.generationJob.count({
      where: { shop: group.shop, status: "RUNNING" },
    });
    const slots = Math.min(
      MAX_RUNNING_JOBS_PER_SHOP - running,
      MAX_CONCURRENT_JOBS - runner.executing.size,
    );
    if (slots <= 0) continue;
    const candidates = await prisma.generationJob.findMany({
      where: { shop: group.shop, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: slots,
    });
    for (const candidate of candidates) {
      if (runner.executing.size >= MAX_CONCURRENT_JOBS) return;
      if (runner.executing.has(candidate.id)) continue;

      const claimed = await claimJob(candidate);
      if (!claimed) continue; // lost the race to a cancel (or another instance)

      const execution = executeJob(claimed)
        .catch(async (error) => {
          // executeJob guards its own failure modes; reaching here means the
          // database itself failed mid-run. Re-queue so the work is not lost —
          // stale recovery would do the same 3 minutes later.
          console.error(`[cellexia] job ${claimed.id} crashed`, error);
          await requeueAfterCrash(claimed.id);
        })
        .finally(() => {
          runner.executing.delete(claimed.id);
          kickRunner(); // a slot freed — pick up queued backlog immediately
        });
      runner.executing.set(claimed.id, execution);
    }
  }
}

/**
 * Atomically flips QUEUED→RUNNING and initializes the run: `created` is
 * seeded from the ACTUAL number of existing rows for the batch (the
 * resume-without-overshoot rule of SPEC-1.7 §3) and the chunk counters are
 * re-scoped to the current run so the live ETA is not skewed by pre-crash
 * progress.
 */
async function claimJob(job: GenerationJob): Promise<GenerationJob | null> {
  const existing = await prisma.review.count({
    where: { shop: job.shop, isSynthetic: true, syntheticBatchId: job.batchId },
  });
  const remaining = Math.max(0, job.target - existing);
  const now = new Date();
  const res = await prisma.generationJob.updateMany({
    where: { id: job.id, status: "QUEUED" },
    data: {
      status: "RUNNING",
      startedAt: now,
      heartbeatAt: now,
      created: existing,
      chunksDone: 0,
      chunksTotal: Math.ceil(remaining / CHUNK_SIZE),
    },
  });
  if (res.count !== 1) return null;
  return prisma.generationJob.findUnique({ where: { id: job.id } });
}

async function requeueAfterCrash(jobId: string): Promise<void> {
  try {
    await prisma.generationJob.updateMany({
      where: { id: jobId, status: "RUNNING" },
      data: { status: "QUEUED", heartbeatAt: null },
    });
  } catch (error) {
    console.error(`[cellexia] job ${jobId}: post-crash requeue failed`, error);
  }
}

/**
 * The plan-index chunks still to generate for a (re)claimed job — the
 * resume-without-overshoot rule of SPEC-1.7 §3, keeping SPEC-1.4 §C's
 * batch-unique reviewer-name invariant intact.
 *
 * Fresh jobs (claimJob counted zero existing rows) take every plan index in
 * order — no extra query, byte-identical chunking to a plain prefix walk.
 *
 * Resumed jobs resume by EXCLUSION: load the batch's existing reviewer
 * names and keep only the specs without a row. Display names are unique
 * within a plan by construction (buildBatchPlan), so they are an exact
 * resume marker even when parallel chunks completed out of order before the
 * crash/cancel — a prefix resume would both duplicate already-written specs
 * and permanently skip the missing ones. The result is additionally capped
 * at `target - existing` indices so a resume can never overshoot, even if
 * earlier (pre-fix) runs left duplicate rows behind.
 */
async function planRemainingChunks(
  shop: string,
  job: GenerationJob,
  config: SyntheticConfig,
): Promise<number[][]> {
  let missing: number[];
  if (job.created <= 0) {
    missing = Array.from({ length: job.target }, (_, i) => i);
  } else {
    const rows = await prisma.review.findMany({
      where: { shop, isSynthetic: true, syntheticBatchId: job.batchId },
      select: { authorName: true },
    });
    const existingNames = new Set<string>();
    for (const row of rows) {
      if (row.authorName) existingNames.add(row.authorName);
    }
    const plan = buildBatchPlan(config, job.batchId);
    missing = [];
    for (const spec of plan) {
      // Mirror createReview's authorName normalization (trim + slice(0, 80))
      // so the stored value always matches its plan spec.
      if (!existingNames.has(spec.displayName.trim().slice(0, 80))) {
        missing.push(spec.index);
      }
    }
    const remaining = Math.max(0, job.target - rows.length);
    if (missing.length > remaining) missing.length = remaining;
  }
  const chunks: number[][] = [];
  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    chunks.push(missing.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/* ------------------------------------------------------------------------- *
 * Job execution
 * ------------------------------------------------------------------------- */

interface RunState {
  cancelled: boolean;
  /** Fatal message (missing/invalid AI key) — aborts remaining chunks. */
  fatal: string | null;
  errors: string[];
  createdInRun: number;
  inputTokens: number;
  outputTokens: number;
  /** costUsd accumulated by PREVIOUS runs of this job (resume case). */
  baseCostUsd: number;
  model: string | null;
}

async function executeJob(job: GenerationJob): Promise<void> {
  const shop = job.shop;
  const priorErrors = parseErrorList(job.errors);

  let rawConfig: unknown = null;
  try {
    rawConfig = JSON.parse(job.config);
  } catch {
    rawConfig = null;
  }
  const parsed = parseSyntheticConfig(rawConfig);
  if (!parsed.config) {
    await writeFinalState(job.id, {
      status: "FAILED",
      error: parsed.error ?? "The stored job configuration is invalid.",
      errors: priorErrors,
    });
    return;
  }
  // `count` and `target` are the same value by construction (enqueue). Pin
  // count to target so the plan length always matches what we slice.
  const config: SyntheticConfig = { ...parsed.config, count: job.target };

  const state: RunState = {
    cancelled: job.cancelRequested,
    fatal: null,
    errors: [],
    createdInRun: 0,
    inputTokens: 0,
    outputTokens: 0,
    baseCostUsd: job.costUsd,
    model: null,
  };

  // Plan-index chunks for THIS run. A fresh job takes the whole plan in
  // order. A RESUME (crash recovery / retry-remaining) must NOT assume the
  // existing rows correspond to plan indices [0, created): with chunk
  // parallelism 2, chunks complete out of order, so a crash can leave e.g.
  // indices 8–15 written while 3–7 are missing. Resuming by prefix would
  // regenerate already-written specs (duplicate batch-unique reviewer names,
  // near-identical reviews) and permanently skip the missing ones — so the
  // remainder is selected by EXCLUSION instead (see planRemainingChunks).
  // Either way a resumed job generates exactly the remainder and can never
  // overshoot. A failure here propagates to claimEligibleJobs' catch, which
  // re-queues the job.
  let chunks: number[][] = [];
  if (!state.cancelled) {
    if (job.checkedCount > 0) {
      // The check phase had already begun on a previous run, so every
      // generation chunk finished. Deleted-by-skeptic rows would read as
      // "missing specs" to the planner, and regenerating them would pay a
      // second time for reviews the check just convicted.
      chunks = [];
    } else {
      chunks = await planRemainingChunks(shop, job, config);
    }
  }

  if (chunks.length > 0) {
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (state.cancelled || state.fatal) return;
        const index = nextIndex;
        if (index >= chunks.length) return;
        nextIndex += 1; // single-threaded event loop — no take/bump race

        const chunk = chunks[index];
        const result = await generateChunk(shop, config, job.batchId, chunk[0], chunk);
        if (result.model) state.model = result.model;
        state.createdInRun += result.created;
        state.inputTokens += result.inputTokens;
        state.outputTokens += result.outputTokens;
        for (const message of result.errors) pushJobError(state.errors, message);
        if (result.code === "no_ai_key") state.fatal = NO_AI_KEY_ERROR;
        else if (result.authFailed) state.fatal = INVALID_AI_KEY_ERROR;

        // Per-chunk persistence + heartbeat; the returned row carries the
        // current cancelRequested, which is the cooperative cancel check.
        const row = await persistChunkProgress(job.id, result, state, priorErrors);
        if (row?.cancelRequested) state.cancelled = true;

        // Throughput calibration — successful chunks only, so failed calls
        // cannot dilute the per-review token/seconds averages (§4).
        if (result.created > 0 && result.model) {
          await recordThroughput(shop, result.model, result);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_PARALLELISM, chunks.length) }, () => worker()),
    );
  }

  let totalCreated = job.created + state.createdInRun;
  let removedThisRun = 0;

  // v1.24 (SPEC-1.24 §1): the skeptical double-check phase. Runs AFTER all
  // chunks so the skeptic sees finished, stored reviews; groups of
  // skepticBatchSize; convicted rows are deleted; survivors marked qaChecked
  // so a resumed job never re-judges them. A checker failure passes reviews
  // through and says so — it must never fail a generation that succeeded.
  if (
    config.skepticCheck !== false &&
    !state.cancelled &&
    !state.fatal &&
    totalCreated > 0
  ) {
    try {
      const { getSettings } = await import("./settings.server");
      const settings = await getSettings(shop);
      if (settings.anthropicApiKey) {
        // A resumed job may reach here without generating a chunk this run,
        // leaving state.model null — the final cost must still price with the
        // shop's real model, not a hardcoded fallback.
        if (!state.model) state.model = settings.aiModel;
        const { runSkepticPass } = await import("./synthetic.server");
        const pass = await runSkepticPass(
          shop,
          settings.anthropicApiKey,
          state.model ?? settings.aiModel,
          job.batchId,
          config.skepticBatchSize ?? 20,
          async () => {
            // Doubles as the phase heartbeat: without it a long check reads
            // as a stalled job and the stale-recovery would re-claim it
            // mid-pass, running two skeptics over the same batch.
            const row = await prisma.generationJob
              .update({
                where: { id: job.id },
                data: { heartbeatAt: new Date() },
                select: { cancelRequested: true },
              })
              .catch(() => null);
            if (!row || row.cancelRequested) state.cancelled = true;
            return state.cancelled;
          },
          async (delta) => {
            // Persist PER GROUP: a crash mid-phase keeps every group already
            // judged (counters, removals, tokens are re-read on resume from
            // the row, and qaChecked rows are never re-judged).
            await prisma.generationJob
              .update({
                where: { id: job.id },
                data: {
                  checkedCount: { increment: delta.checked + delta.unchecked },
                  removedByCheck: { increment: delta.removed },
                  ...(delta.removed > 0 ? { created: { decrement: delta.removed } } : {}),
                  heartbeatAt: new Date(),
                },
              })
              .catch(() => undefined);
          },
        );
        state.inputTokens += pass.inputTokens;
        state.outputTokens += pass.outputTokens;
        totalCreated = Math.max(0, totalCreated - pass.removed);
        removedThisRun = pass.removed;
        state.createdInRun = Math.max(0, state.createdInRun - pass.removed);
        if (pass.unchecked > 0) {
          pushJobError(
            state.errors,
            `${pass.unchecked} review(s) could not be double-checked and were kept as generated.`,
          );
        }
        if (pass.removed > 0) {
          try {
            const { invalidateAskAnswers } = await import("./qna.server");
            await invalidateAskAnswers(shop);
          } catch (error) {
            console.error("[cellexia] skeptic pass: ask-cache invalidation failed", error);
          }
        }
        await prisma.generationJob
          .update({
            where: { id: job.id },
            data: {
              inputTokens: { increment: pass.inputTokens },
              outputTokens: { increment: pass.outputTokens },
              heartbeatAt: new Date(),
            },
          })
          .catch(() => undefined);
      }
    } catch (error) {
      console.error(`[cellexia] job ${job.id}: skeptic pass failed`, error);
      pushJobError(
        state.errors,
        "The double-check step failed — the generated reviews were kept as they are.",
      );
    }
  }

  let status: JobStatus;
  let fatalError: string | null = null;
  if (state.cancelled) {
    status = "CANCELLED";
  } else if (state.fatal) {
    status = "FAILED";
    fatalError = state.fatal;
  } else if (totalCreated === 0) {
    status = "FAILED";
    fatalError = state.errors[0] ?? priorErrors[0] ?? "No reviews could be generated.";
  } else {
    status = "COMPLETED";
  }

  // End-of-job aggregate + metafield sync, once per product (SPEC-1.7 §3).
  // Also runs when a resumed job finishes with rows created only by earlier
  // runs — the crash may have happened before the previous sync.
  if (
    state.createdInRun > 0 ||
    (status === "COMPLETED" && totalCreated > 0) ||
    removedThisRun > 0
  ) {
    try {
      const { unauthenticated } = await import("~/shopify.server");
      const { admin } = await unauthenticated.admin(shop);
      await syncProductData(shop, config.productId, admin);
    } catch (error) {
      console.error(`[cellexia] job ${job.id}: end-of-job product sync failed`, error);
      pushJobError(
        state.errors,
        "Reviews were created, but the product rating sync failed — it will refresh on the next moderation action.",
      );
    }
  }

  await writeFinalState(job.id, {
    status,
    error: fatalError,
    errors: [...priorErrors, ...state.errors],
    costUsd:
      state.baseCostUsd + actualCostUsd(state.model, state.inputTokens, state.outputTokens),
  });
}

async function persistChunkProgress(
  jobId: string,
  result: GenerateChunkResult,
  state: RunState,
  priorErrors: string[],
): Promise<GenerationJob | null> {
  try {
    return await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        created: { increment: result.created },
        failed: { increment: result.failed },
        chunksDone: { increment: 1 },
        inputTokens: { increment: result.inputTokens },
        outputTokens: { increment: result.outputTokens },
        // Absolute write from the shared run totals. Two workers can land
        // out of order and briefly understate the cost by one chunk — the
        // next write, or writeFinalState (which always persists the
        // authoritative end-of-run cost), corrects it.
        costUsd:
          state.baseCostUsd + actualCostUsd(state.model, state.inputTokens, state.outputTokens),
        errors: JSON.stringify([...priorErrors, ...state.errors].slice(0, MAX_JOB_ERRORS)),
        heartbeatAt: new Date(),
      },
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      // The job row is GONE (P2025) — the batch was deleted mid-run. Treat it
      // as a cancellation: the cooperative-cancel flag lives on that row, so
      // a vanished row must never mean "keep going" — otherwise the run would
      // generate (and pay for) every remaining chunk into a batch that no
      // longer exists. Defense in depth alongside the routes only deleting
      // terminal job rows. The in-flight parallel chunk may still land as the
      // documented small remnant batch (SPEC-1.7 §3/§7).
      console.error(
        `[cellexia] job ${jobId}: progress row vanished mid-run — treating as cancelled`,
      );
      state.cancelled = true;
      return null;
    }
    // Transient progress-write failure (DB hiccup). Keep generating — the
    // counters self-heal because a resume recounts rows from the DB.
    console.error(`[cellexia] job ${jobId}: progress write failed`, error);
    return null;
  }
}

async function recordThroughput(
  shop: string,
  model: string,
  result: GenerateChunkResult,
): Promise<void> {
  try {
    await prisma.modelThroughput.upsert({
      where: { shop_model: { shop, model } },
      update: {
        chunkCount: { increment: 1 },
        totalSeconds: { increment: result.seconds },
        totalReviews: { increment: result.created },
        totalInTokens: { increment: result.inputTokens },
        totalOutTokens: { increment: result.outputTokens },
      },
      create: {
        shop,
        model,
        chunkCount: 1,
        totalSeconds: result.seconds,
        totalReviews: result.created,
        totalInTokens: result.inputTokens,
        totalOutTokens: result.outputTokens,
      },
    });
  } catch (error) {
    // Calibration is best-effort; a lost sample must never fail a chunk.
    console.error("[cellexia] throughput calibration write failed", error);
  }
}

async function writeFinalState(
  jobId: string,
  final: { status: JobStatus; error: string | null; errors: string[]; costUsd?: number },
): Promise<void> {
  try {
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: final.status,
        error: final.error ? final.error.slice(0, MAX_FATAL_ERROR_LENGTH) : null,
        errors: JSON.stringify(final.errors.slice(0, MAX_JOB_ERRORS)),
        // Authoritative end-of-run cost. The per-chunk costUsd writes are
        // absolute (read-modify-write) while the token counters are atomic
        // increments; with CHUNK_PARALLELISM=2 the LAST progress write can
        // commit with a stale (one chunk short) total. Persisting the cost
        // derived from the run's complete token totals here keeps the stored
        // costUsd consistent with the row's own inputTokens/outputTokens.
        ...(final.costUsd !== undefined ? { costUsd: final.costUsd } : {}),
        finishedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  } catch (error) {
    // The row can legitimately be gone (batch deleted mid-run).
    console.error(`[cellexia] job ${jobId}: final state write failed`, error);
  }
}

/* ------------------------------------------------------------------------- *
 * Public API (SPEC-1.7 §3 signatures)
 * ------------------------------------------------------------------------- */

/**
 * Records a new generation job and wakes the runner. Returns immediately —
 * generation happens in the background. `config` must already be sanitized
 * (parseSyntheticConfig); `estimate` is the optional pre-run EstimateDTO the
 * merchant saw, stored verbatim for the jobs table.
 */
export async function enqueueGeneration(
  shop: string,
  config: SyntheticConfig,
  estimate: EstimateDTO | null,
): Promise<GenerationJob> {
  const batchId = crypto.randomUUID();
  const job = await prisma.generationJob.create({
    data: {
      shop,
      status: "QUEUED",
      productId: config.productId,
      productTitle: config.productTitle || null,
      batchId,
      config: JSON.stringify(config),
      target: config.count,
      chunksTotal: Math.ceil(config.count / CHUNK_SIZE),
      estimate: estimate ? JSON.stringify(estimate) : null,
    },
  });
  kickRunner();
  return job;
}

/** The newest jobs for the admin jobs table (50 by default and at most). */
export async function listJobs(
  shop: string,
  opts?: { limit?: number },
): Promise<JobDTO[]> {
  kickRunner(); // every admin surface that shows jobs keeps the runner alive
  const take = Math.max(1, Math.min(50, Math.floor(opts?.limit ?? 50)));
  const rows = await prisma.generationJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
  });
  const now = Date.now();
  return rows.map((row) => toJobDTO(row, now));
}

/**
 * QUEUED + RUNNING jobs for the polling endpoints (activity bar + jobs card).
 * Oldest first so "X of Y" aggregation reads in start order.
 */
export async function activeJobSummary(
  shop: string,
): Promise<{ active: number; jobs: JobDTO[] }> {
  kickRunner(); // a polling client keeps a stalled runner alive (SPEC-1.7 §5)
  const rows = await prisma.generationJob.findMany({
    where: { shop, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: "asc" },
  });
  const now = Date.now();
  const jobs = rows.map((row) => toJobDTO(row, now));
  return { active: jobs.length, jobs };
}

/**
 * Cooperative cancellation (SPEC-1.7 §3): a QUEUED job flips straight to
 * CANCELLED (atomically, so it cannot also be claimed); a RUNNING job gets
 * `cancelRequested` and stops after its in-flight chunk, KEEPING everything
 * it already created. No-op for terminal/unknown jobs.
 */
export async function requestCancel(shop: string, jobId: string): Promise<void> {
  const cancelled = await prisma.generationJob.updateMany({
    where: { id: jobId, shop, status: "QUEUED" },
    data: { status: "CANCELLED", cancelRequested: true, finishedAt: new Date() },
  });
  if (cancelled.count === 0) {
    await prisma.generationJob.updateMany({
      where: { id: jobId, shop, status: "RUNNING" },
      data: { cancelRequested: true },
    });
  }
}

/**
 * Re-queues a FAILED or CANCELLED job to generate its remaining reviews
 * (SPEC-1.7 §3). The runner recounts the batch's existing rows on claim, so
 * a retry generates exactly `target - existing` more — never duplicates.
 * Throws when the job is not in a retryable state.
 */
export async function retryJob(shop: string, jobId: string): Promise<GenerationJob> {
  const res = await prisma.generationJob.updateMany({
    where: { id: jobId, shop, status: { in: RETRYABLE_STATUSES } },
    data: {
      status: "QUEUED",
      cancelRequested: false,
      error: null,
      finishedAt: null,
      heartbeatAt: null,
    },
  });
  if (res.count !== 1) {
    throw new Error("Only failed or cancelled jobs can be retried.");
  }
  kickRunner();
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("The job no longer exists.");
  return job;
}

/**
 * Re-queues RUNNING jobs whose heartbeat is older than STALE_HEARTBEAT_MS
 * (crashed process / lost instance — SPEC-1.7 §3). Their created reviews
 * stay; the claim path honors `target` by counting existing batch rows
 * before resuming. Jobs this process is actively executing are skipped — a
 * single slow chunk must not get its own job stolen. Returns the number of
 * jobs recovered. Called from afterAuth and at the top of every runner tick.
 */
export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const stale = await prisma.generationJob.findMany({
    where: {
      status: "RUNNING",
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }],
    },
    select: { id: true },
  });
  let recovered = 0;
  for (const row of stale) {
    if (runner.executing.has(row.id)) continue;
    const res = await prisma.generationJob.updateMany({
      where: { id: row.id, status: "RUNNING" },
      data: { status: "QUEUED", heartbeatAt: null },
    });
    recovered += res.count;
  }
  if (recovered > 0) {
    console.error(`[cellexia] recovered ${recovered} stale generation job(s)`);
  }
  return recovered;
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function pushJobError(errors: string[], message: string): void {
  if (errors.length < MAX_JOB_ERRORS) errors.push(message);
}

/**
 * True for Prisma's "record required but not found" error (P2025) — the
 * signature of an update() against a deleted job row. Structural check on
 * `code` so no Prisma error class needs importing.
 */
function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}

function parseErrorList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(0, MAX_JOB_ERRORS);
  } catch {
    return [];
  }
}

function parseEstimate(raw: string | null | undefined): EstimateDTO | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EstimateDTO;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Actual USD cost of real token usage, priced with the same MODEL_PRICING
 * table the estimates use (single source of truth — SPEC-1.7 §4), including
 * the introductory-rate window while it applies. Unknown models fall back to
 * the claude-sonnet-5 row, like the estimator does.
 */
function actualCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing =
    (model ? MODEL_PRICING[model] : undefined) ??
    MODEL_PRICING["claude-sonnet-5"] ??
    ({ inPerMTok: 3, outPerMTok: 15 } as (typeof MODEL_PRICING)[string]);
  let inRate = pricing.inPerMTok;
  let outRate = pricing.outPerMTok;
  if (
    pricing.introUntil &&
    typeof pricing.introInPerMTok === "number" &&
    typeof pricing.introOutPerMTok === "number" &&
    Date.now() <= new Date(`${pricing.introUntil}T23:59:59.999Z`).getTime()
  ) {
    inRate = pricing.introInPerMTok;
    outRate = pricing.introOutPerMTok;
  }
  return (inputTokens / 1e6) * inRate + (outputTokens / 1e6) * outRate;
}

function toJobDTO(row: GenerationJob, nowMs: number): JobDTO {
  const status: JobStatus = (JOB_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as JobStatus)
    : "FAILED";
  const estimate = parseEstimate(row.estimate);

  const startedMs = row.startedAt ? row.startedAt.getTime() : null;
  const finishedMs = row.finishedAt ? row.finishedAt.getTime() : null;
  const elapsedSeconds =
    startedMs !== null
      ? Math.max(0, Math.round(((finishedMs ?? nowMs) - startedMs) / 1000))
      : null;

  // Live ETA (SPEC-1.7 §4): from this job's OWN observed chunk pace. Note:
  // elapsed / chunksDone is already the WALL-CLOCK time per completed chunk
  // (parallelism included), so remaining wall time is that pace × remaining
  // chunks — the spec's sketch divides by PARALLELISM once more, which would
  // double-count it and halve every ETA.
  let etaSeconds: number | null = null;
  if (status === "RUNNING") {
    const remainingChunks = Math.max(0, row.chunksTotal - row.chunksDone);
    if (row.chunksDone > 0 && startedMs !== null && nowMs > startedMs) {
      const wallSecondsPerChunk = (nowMs - startedMs) / 1000 / row.chunksDone;
      etaSeconds = Math.max(0, Math.round(wallSecondsPerChunk * remainingChunks));
    } else if (estimate && estimate.seconds > 0) {
      etaSeconds = estimate.seconds;
    }
  }

  return {
    id: row.id,
    status,
    productId: row.productId,
    productTitle: row.productTitle ?? null,
    batchId: row.batchId,
    target: row.target,
    created: row.created,
    failed: row.failed,
    checkedCount: row.checkedCount,
    removedByCheck: row.removedByCheck,
    chunksTotal: row.chunksTotal,
    chunksDone: row.chunksDone,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    estimate,
    error: row.error ?? null,
    errors: parseErrorList(row.errors),
    cancelRequested: row.cancelRequested,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    heartbeatAt: row.heartbeatAt ? row.heartbeatAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    etaSeconds,
    elapsedSeconds,
  };
}
