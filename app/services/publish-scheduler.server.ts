/**
 * Cellexia Reviews — scheduled auto-publish of QA-generated batches
 * (SPEC-1.30).
 *
 * A generation job whose config carries `publishAt` writes its reviews as
 * PENDING; this in-process scheduler flips the batch to PUBLISHED once BOTH
 * are true: the job is terminal (COMPLETED / FAILED / CANCELLED — the
 * skeptic pass has fully finished, so a publish can never race a deletion)
 * and the scheduled UTC instant has passed. Whatever the batch created is
 * published — a cancelled or failed job keeps its rows (SPEC-1.7 §3), and
 * the merchant scheduled those rows to appear at that time.
 *
 * Mechanics mirror jobs.server.ts: a globalThis singleton (dev module
 * reloads never double-arm), an unref'd setTimeout chain (never
 * setInterval), armed idempotently from kickRunner (i.e. every admin
 * surface, poll and afterAuth) and from listReviews (storefront traffic).
 * Unlike the hourly curation sweep, the chain arms itself for the EXACT next
 * due instant (capped at 6 h re-check), so a 06:00 UTC schedule publishes at
 * 06:00, not "within the hour". The runner kicks this scheduler when a
 * scheduled job reaches its final state, which covers the common case of the
 * instant passing mid-generation.
 *
 * Correctness core: the claim (a compare-and-set on `publishedAt: null` +
 * terminal status) and the review flip run inside ONE database transaction.
 * The CAS re-checks the job's status at flip time, so a "Retry remaining"
 * that re-queued the job after the sweep's snapshot can never have this
 * sweep publish its fresh, not-yet-skeptic-checked rows (the CAS fails, the
 * flip never runs, and the retry's own end-of-run kick publishes later —
 * retryJob clears publishedAt). And because the two writes commit together,
 * a crash or transient failure can never leave the reviews flipped but the
 * job unclaimed (which would make the NEXT sweep see "0 rows to flip" and
 * skip the post-publish sync forever). The only crash residue left is losing
 * the post-commit sync itself — the same class as the job runner's
 * end-of-run sync failure: metafields refresh on the next moderation action.
 *
 * SINGLE-INSTANCE ASSUMPTION: like the job runner, this sweep assumes the
 * one-instance deployment the app already requires (SQLite, in-memory rate
 * limiter — docs/INSTALL.md).
 */
import prisma from "~/db.server";

/** Job states whose batch is finished changing (skeptic pass included). */
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];
/** Bound one sweep's work; a full window re-ticks immediately for the rest. */
const SWEEP_TAKE = 100;
/**
 * Floor for armed delays: absorbs bursts of kicks into one sweep and keeps
 * an overdue-but-still-running job from hot-looping the chain.
 */
const MIN_DELAY_MS = 5 * 1000;
/**
 * Ceiling for armed delays. A far-future schedule re-checks on this cadence
 * instead of trusting one multi-day timer; it is also the crash-safety poll
 * while an overdue job is still generating (the runner's end-of-job kick is
 * the prompt path — this only catches a kick that never came).
 */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Delay for the bootstrap tick armed by ensurePublishScheduler. */
const BOOT_DELAY_MS = 1000;
/** Retry cadence after a per-job publish failure (transient DB/session). */
const RETRY_DELAY_MS = 5 * 60 * 1000;
/** Mirror of the jobs.server error-list cap (SPEC-1.7 §1). */
const MAX_JOB_ERRORS = 20;

interface PublishSchedulerState {
  /** A setTimeout for the next tick is pending. */
  scheduled: boolean;
  /** Delay the pending tick was armed with — lets a kick preempt a slow one. */
  scheduledDelayMs: number;
  /** A tick is executing right now. */
  ticking: boolean;
  /** A kick arrived mid-tick — run another tick immediately after. */
  kickAgain: boolean;
  /**
   * The last tick found NO unpublished scheduled job at all — the chain is
   * stopped and ensurePublishScheduler is a no-op until the next kick
   * (enqueue of a scheduled job / end of one's run) clears this. Without the
   * flag, every 3-second admin status poll would re-arm a pointless sweep.
   */
  empty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const globalStore = globalThis as typeof globalThis & {
  __cellexiaPublishScheduler?: PublishSchedulerState;
};
const state: PublishSchedulerState = globalStore.__cellexiaPublishScheduler ?? {
  scheduled: false,
  scheduledDelayMs: 0,
  ticking: false,
  kickAgain: false,
  empty: false,
  timer: null,
};
globalStore.__cellexiaPublishScheduler = state;

/**
 * Idempotent, cheap arming — called from kickRunner and listReviews. Starts
 * one bootstrap tick when the chain is idle AND the last tick saw scheduled
 * work (or none has run yet, e.g. right after boot); the tick chain then
 * keeps itself armed for exactly as long as scheduled publishes exist.
 */
export function ensurePublishScheduler(): void {
  if (state.ticking || state.scheduled || state.empty) return;
  schedule(BOOT_DELAY_MS);
}

/**
 * Wakes the scheduler NOW — called when a scheduled job is enqueued and when
 * one reaches its final state (jobs.server). Clears the empty-stop flag and
 * preempts a delayed timer, the kickRunner pattern.
 */
export function kickPublishScheduler(): void {
  state.empty = false;
  if (state.ticking) {
    state.kickAgain = true;
    return;
  }
  if (state.scheduled && state.scheduledDelayMs <= MIN_DELAY_MS) return;
  schedule(MIN_DELAY_MS);
}

function schedule(delayMs: number): void {
  if (state.timer) clearTimeout(state.timer);
  state.scheduled = true;
  state.scheduledDelayMs = delayMs;
  state.timer = setTimeout(() => {
    void tick();
  }, delayMs);
  // The publish timer must never be what keeps the process alive.
  const timer = state.timer as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  state.scheduled = false;
  state.timer = null;
  state.ticking = true;
  state.kickAgain = false;
  let nextDelayMs: number | null = RETRY_DELAY_MS; // DB hiccup → retry soon
  try {
    const swept = await sweepScheduledPublishes();
    const next = await computeNextDelay();
    // Overdue schedules still queued/running wait on GENERATION. Normally
    // the runner finishes them and kicks us — but after a process restart on
    // a shop with only STOREFRONT traffic, nothing else ever wakes the
    // runner to recover the stranded job, so the scheduled publish would
    // silently slip. Checked on EVERY tick — window ticks included, or a
    // long backlog drain would defer the revival for its whole duration.
    // Dynamic import: the runner imports this module statically.
    if (next.overdueWaiting > 0) {
      const { kickRunner } = await import("./jobs.server");
      kickRunner();
    }
    if (swept.window) {
      // A full window with real progress — more due work is likely waiting.
      nextDelayMs = 0;
    } else {
      const candidates: number[] = [];
      if (next.futureDelayMs !== null) candidates.push(next.futureDelayMs);
      // Non-terminal overdue rides the slow net (the end-of-run kick and the
      // revival above are its prompt paths).
      if (next.overdueWaiting > 0) candidates.push(MAX_DELAY_MS);
      // Terminal overdue is claimable NOW. More of it than this sweep's
      // failures means jobs turned due mid-sweep (the sweep's own query ran
      // earlier) — sweep again promptly. Exactly the failures ⇒ they were
      // just attempted: retry on the slow cadence, never a 5 s hot-loop.
      if (next.overdueReady > 0) {
        candidates.push(next.overdueReady > swept.failed ? MIN_DELAY_MS : RETRY_DELAY_MS);
      }
      nextDelayMs = candidates.length > 0 ? Math.min(...candidates) : null;
      // A due job whose publish just failed must retry on the short cadence,
      // not the 6 h far-future re-check.
      if (swept.failed > 0) {
        nextDelayMs = Math.min(nextDelayMs ?? RETRY_DELAY_MS, RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    console.error("[cellexia] publish scheduler tick failed", error);
  } finally {
    state.ticking = false;
    if (state.kickAgain) {
      state.kickAgain = false;
      schedule(MIN_DELAY_MS);
    } else if (nextDelayMs !== null) {
      schedule(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, nextDelayMs)));
    } else {
      // Nothing scheduled anywhere → the chain stops; the next kick restarts it.
      state.empty = true;
    }
  }
}

/**
 * The three INDEPENDENT signals the tick's timer math needs, so no bucket
 * can mask another: the delay to the earliest FUTURE unpublished instant,
 * how many overdue unpublished schedules are TERMINAL (claimable right now —
 * e.g. they turned due while the sweep was already running), and how many
 * are NON-terminal (still generating — their prompt path is the runner's
 * end-of-run kick; they also trigger the stranded-runner revival).
 */
async function computeNextDelay(now: number = Date.now()): Promise<{
  futureDelayMs: number | null;
  overdueReady: number;
  overdueWaiting: number;
}> {
  const future = await prisma.generationJob.findFirst({
    where: { publishAt: { gt: new Date(now) }, publishedAt: null },
    orderBy: { publishAt: "asc" },
    select: { publishAt: true },
  });
  const overdueReady = await prisma.generationJob.count({
    where: {
      publishAt: { lte: new Date(now) },
      publishedAt: null,
      status: { in: TERMINAL_STATUSES },
    },
  });
  const overdueWaiting = await prisma.generationJob.count({
    where: {
      publishAt: { lte: new Date(now) },
      publishedAt: null,
      status: { notIn: TERMINAL_STATUSES },
    },
  });
  return {
    futureDelayMs: future?.publishAt ? future.publishAt.getTime() - now + 250 : null,
    overdueReady,
    overdueWaiting,
  };
}

/**
 * One sweep: publishes every due batch. Exported for tests (pass `now` for
 * determinism). `window` is true when the sweep filled its SWEEP_TAKE bound
 * AND made progress — more due work may remain and the caller should re-tick
 * immediately.
 */
export async function sweepScheduledPublishes(
  now: number = Date.now(),
): Promise<{ published: number; jobs: number; failed: number; window: boolean }> {
  const due = await prisma.generationJob.findMany({
    where: {
      publishAt: { lte: new Date(now) },
      publishedAt: null,
      status: { in: TERMINAL_STATUSES },
    },
    orderBy: { publishAt: "asc" },
    take: SWEEP_TAKE,
  });
  let published = 0;
  let jobsDone = 0;
  let failed = 0;
  for (const job of due) {
    try {
      published += await publishJobBatch(job);
      jobsDone += 1;
    } catch (error) {
      // Isolate failures per job — one shop's broken session or DB row must
      // not block every other scheduled publish in the window.
      failed += 1;
      console.error(`[cellexia] scheduled publish failed for job ${job.id}`, error);
    }
  }
  // `window` demands MAJORITY progress, not just a full window: failed jobs
  // keep the oldest publishAt and re-seat at the head of every window, so a
  // failure-dominated full window re-ticking immediately would re-run its
  // failing publishes every 5 s for the whole backlog drain — such sweeps
  // take the failed-retry cadence instead (the healthy backlog then drains
  // one window per retry tick, which is the honest pace while writes fail).
  return {
    published,
    jobs: jobsDone,
    failed,
    window: due.length >= SWEEP_TAKE && jobsDone > failed,
  };
}

/**
 * Publishes one job's batch: atomically claims the job row AND flips the
 * batch's still-PENDING synthetic rows, then runs the moderation path's
 * exact side-effect set (aggregates + metafields + brand-page sync,
 * ask-cache invalidation). Returns how many reviews were flipped.
 */
async function publishJobBatch(job: {
  id: string;
  shop: string;
  productId: string;
  batchId: string;
}): Promise<number> {
  // Claim + flip in ONE transaction (see the module comment): the CAS
  // re-checks terminal status at flip time — a job re-queued by "Retry
  // remaining" after the sweep's snapshot fails the CAS and its rows are
  // never touched mid-generation — and the two writes cannot commit
  // separately, so a crash can never strand a flipped batch behind an
  // unclaimed job. The flip's triple guard (shop + batchId + isSynthetic)
  // mirrors the skeptic pass: never touch rows outside this batch.
  const { claimed, flipped } = await prisma.$transaction(async (tx) => {
    const claim = await tx.generationJob.updateMany({
      where: { id: job.id, publishedAt: null, status: { in: TERMINAL_STATUSES } },
      data: { publishedAt: new Date() },
    });
    if (claim.count === 0) return { claimed: false, flipped: 0 };
    const flip = await tx.review.updateMany({
      where: {
        shop: job.shop,
        syntheticBatchId: job.batchId,
        isSynthetic: true,
        status: "PENDING",
      },
      data: { status: "PUBLISHED" },
    });
    return { claimed: true, flipped: flip.count };
  });
  // No claim: the job left terminal state (retry) — its own kick publishes
  // later. Claimed but nothing flipped: the rows were already published by
  // hand through moderation (which ran its own sync) or the batch is empty —
  // either way there is nothing to sync for.
  if (!claimed || flipped === 0) return flipped;

  // 3) Post-publish sync — the same set updateReviewStatuses runs for a
  //    manual publish (v1.20.1 lesson: what one feature writes must match
  //    what the adjacent surfaces serve). Offline session, jobs.server
  //    pattern; a failure is logged on the job row for the merchant.
  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(job.shop);
    const { syncProductData } = await import("~/components/admin/moderation.server");
    await syncProductData(job.shop, job.productId, admin);
  } catch (error) {
    console.error(`[cellexia] job ${job.id}: post-publish product sync failed`, error);
    await appendJobError(
      job.id,
      "The reviews were auto-published, but the product rating sync failed — it will refresh on the next moderation action.",
    );
  }
  try {
    const { invalidateAskAnswers } = await import("./qna.server");
    await invalidateAskAnswers(job.shop, job.productId);
  } catch (error) {
    console.error(`[cellexia] job ${job.id}: post-publish ask-cache invalidation failed`, error);
  }
  return flipped;
}

/** Appends one warning to the job's errors[] list (capped, best-effort). */
async function appendJobError(jobId: string, message: string): Promise<void> {
  try {
    const row = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { errors: true },
    });
    if (!row) return;
    let errors: string[] = [];
    try {
      const parsed = JSON.parse(row.errors);
      if (Array.isArray(parsed)) {
        errors = parsed.filter((e): e is string => typeof e === "string");
      }
    } catch {
      errors = [];
    }
    if (errors.includes(message)) return;
    errors.push(message);
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { errors: JSON.stringify(errors.slice(0, MAX_JOB_ERRORS)) },
    });
  } catch (error) {
    console.error(`[cellexia] job ${jobId}: publish warning write failed`, error);
  }
}
