/**
 * Cellexia Reviews — global generation activity bar (SPEC-1.7 §5) plus the
 * shared client-side job-status utilities used by both this bar and the
 * "Generation jobs" card on the QA data page:
 *
 *   - `useActiveJobsPoll()` — polls the authenticated resource route
 *     `/app/jobs/status` (which returns `activeJobSummary` and kicks the
 *     runner) every 3 s while ≥ 1 job is active and every 30 s otherwise,
 *     pausing entirely while `document.hidden`.
 *   - `normalizeJobList` / `JobView` — tolerant parsing of the serialized
 *     JobDTO shape (SPEC-1.7 §1/§3) coming from either the resource route or
 *     a Remix loader.
 *   - Duration / cost / count formatters shared by the estimate banner, the
 *     jobs table and this bar ("about 4 minutes", "$0.35", "12,400").
 *
 * The bar itself is mounted once in app.tsx below the NavMenu, so progress is
 * visible from every admin page. It renders only while at least one job is
 * QUEUED/RUNNING, aggregates progress across jobs (naming the product when
 * there is exactly one), links to the QA data page, and is dismissible for
 * the rest of the browser session (sessionStorage — never persisted).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@remix-run/react";
import { Banner, Box, Text } from "@shopify/polaris";

/* ------------------------------------------------------------------------- *
 * Job view model (client-side mirror of the SPEC-1.7 JobDTO)
 * ------------------------------------------------------------------------- */

/** Statuses that count as "active" for polling cadence and the bar. */
export const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"] as const;

export function isActiveJobStatus(status: string): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

/**
 * Normalized, client-safe view of a generation job. Field names follow the
 * GenerationJob schema / JobDTO in SPEC-1.7 §1/§3; every value is defaulted
 * so a partial payload can never crash the UI.
 */
export interface JobView {
  id: string;
  status: string;
  productId: string;
  productTitle: string | null;
  batchId: string;
  target: number;
  created: number;
  failed: number;
  /** v1.24: reviews removed by the skeptical double-check (absent on old rows). */
  removedByCheck?: number;
  /** v1.24: non-fatal per-run warnings (first one is shown on the row). */
  errors?: string[];
  chunksTotal: number;
  chunksDone: number;
  costUsd: number;
  /** Live ETA (seconds) recomputed server-side for RUNNING jobs. */
  etaSeconds: number | null;
  error: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asIsoString(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

export function normalizeJob(raw: unknown): JobView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  return {
    id: v.id,
    status: typeof v.status === "string" && v.status ? v.status : "QUEUED",
    productId: typeof v.productId === "string" ? v.productId : "",
    productTitle:
      typeof v.productTitle === "string" && v.productTitle ? v.productTitle : null,
    batchId: typeof v.batchId === "string" ? v.batchId : "",
    target: Math.max(0, Math.round(asNumber(v.target))),
    created: Math.max(0, Math.round(asNumber(v.created))),
    failed: Math.max(0, Math.round(asNumber(v.failed))),
    removedByCheck: Math.max(0, Math.round(asNumber(v.removedByCheck))),
    errors: Array.isArray(v.errors)
      ? v.errors.filter((e): e is string => typeof e === "string").slice(0, 5)
      : [],
    chunksTotal: Math.max(0, Math.round(asNumber(v.chunksTotal))),
    chunksDone: Math.max(0, Math.round(asNumber(v.chunksDone))),
    costUsd: Math.max(0, asNumber(v.costUsd)),
    etaSeconds:
      typeof v.etaSeconds === "number" && Number.isFinite(v.etaSeconds) && v.etaSeconds >= 0
        ? v.etaSeconds
        : null,
    error: typeof v.error === "string" && v.error ? v.error : null,
    cancelRequested: v.cancelRequested === true,
    startedAt: asIsoString(v.startedAt),
    finishedAt: asIsoString(v.finishedAt),
    createdAt: asIsoString(v.createdAt),
  };
}

export function normalizeJobList(raw: unknown): JobView[] {
  if (!Array.isArray(raw)) return [];
  const jobs: JobView[] = [];
  for (const item of raw) {
    const job = normalizeJob(item);
    if (job) jobs.push(job);
  }
  return jobs;
}

/* ------------------------------------------------------------------------- *
 * Shared formatters
 * ------------------------------------------------------------------------- */

/** "45 seconds" / "4 minutes" / "1 hour 20 minutes" (no qualifier). */
export function humanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  const hours = `${h} hour${h === 1 ? "" : "s"}`;
  return rm === 0 ? hours : `${hours} ${rm} minute${rm === 1 ? "" : "s"}`;
}

/**
 * "about 4 minutes", with the low–high range appended when the two differ by
 * more than 25% ("about 4 minutes – 7 minutes") per SPEC-1.7 §4.
 */
export function formatEta(seconds: number, secondsHigh?: number | null): string {
  const low = Math.max(0, seconds);
  if (
    typeof secondsHigh === "number" &&
    Number.isFinite(secondsHigh) &&
    secondsHigh > low * 1.25
  ) {
    return `about ${humanDuration(low)} – ${humanDuration(secondsHigh)}`;
  }
  return `about ${humanDuration(low)}`;
}

/** "$0.35"; four decimals below one cent ("$0.0042") per SPEC-1.7 §4. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Thousands-separated integer ("12,400"). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US");
}

/* ------------------------------------------------------------------------- *
 * Polling hook
 * ------------------------------------------------------------------------- */

export interface ActiveJobsSummary {
  active: number;
  jobs: JobView[];
}

const STATUS_ROUTE = "/app/jobs/status";
const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

/**
 * Polls `/app/jobs/status` with an adaptive cadence: 3 s while any job is
 * active, 30 s otherwise, and fully paused while the document is hidden
 * (resuming with an immediate poll on visibility). App Bridge v4 attaches the
 * session token to same-origin fetches, so the authenticated resource route
 * works with a plain `fetch`. Transient failures are ignored — the last good
 * summary stays on screen and the next tick retries.
 *
 * `refresh()` forces an immediate poll (used right after enqueueing a job).
 */
export function useActiveJobsPoll(): {
  summary: ActiveJobsSummary | null;
  refresh: () => void;
} {
  const [summary, setSummary] = useState<ActiveJobsSummary | null>(null);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let lastActive = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (disposed || document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), ms);
    };

    const run = async (): Promise<void> => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      let next: ActiveJobsSummary | null = null;
      try {
        const response = await fetch(STATUS_ROUTE, {
          headers: { Accept: "application/json" },
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (typeof body === "object" && body !== null) {
            const record = body as Record<string, unknown>;
            next = {
              active: Math.max(0, Math.round(asNumber(record.active))),
              jobs: normalizeJobList(record.jobs),
            };
          }
        }
      } catch {
        // Transient network/auth hiccup — keep the last summary and retry.
      }
      inFlight = false;
      if (disposed) return;
      if (next) {
        lastActive = next.active;
        setSummary(next);
      }
      schedule(lastActive > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    tickRef.current = () => {
      if (timer) clearTimeout(timer);
      void run();
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else {
        void run();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const refresh = useCallback(() => tickRef.current(), []);
  return { summary, refresh };
}

/* ------------------------------------------------------------------------- *
 * The bar
 * ------------------------------------------------------------------------- */

const DISMISS_KEY = "cellexia.generationActivityBar.dismissed";

export function GenerationActivityBar() {
  const navigate = useNavigate();
  const { summary } = useActiveJobsPoll();
  const [dismissed, setDismissed] = useState(false);

  // sessionStorage is read in an effect so SSR/hydration never touch it.
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
    } catch {
      // Storage unavailable (e.g. blocked third-party context) — never dismissible-persistent.
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Best effort — the in-memory flag still hides it for this mount.
    }
  }, []);

  if (dismissed || !summary || summary.active === 0) return null;

  const activeJobs = summary.jobs.filter((job) => isActiveJobStatus(job.status));
  const jobs = activeJobs.length > 0 ? activeJobs : summary.jobs;
  if (jobs.length === 0) return null;

  const created = jobs.reduce((acc, job) => acc + job.created, 0);
  const target = jobs.reduce((acc, job) => acc + job.target, 0);
  // With chunk-parallel jobs the wall-clock time left is the slowest job's ETA.
  let eta: number | null = null;
  for (const job of jobs) {
    if (job.etaSeconds !== null && (eta === null || job.etaSeconds > eta)) {
      eta = job.etaSeconds;
    }
  }

  const single = jobs.length === 1 ? jobs[0] : null;
  // v1.24: all chunks done but the job still RUNNING means the skeptical
  // double-check is reading the batch — say so instead of a frozen
  // "Generating N of N" that quietly counts DOWN as removals land.
  const checking =
    jobs.length > 0 &&
    jobs.every(
      (job) => job.status === "RUNNING" && job.chunksTotal > 0 && job.chunksDone >= job.chunksTotal,
    );
  const parts: string[] = [];
  parts.push(
    checking
      ? single && single.productTitle
        ? `Double-checking reviews for “${single.productTitle}”…`
        : "Double-checking the generated reviews…"
      : single && single.productTitle
        ? `Generating reviews for “${single.productTitle}” — ${formatCount(created)} of ${formatCount(target)}`
        : `Generating reviews — ${formatCount(created)} of ${formatCount(target)}`,
  );
  if (jobs.length > 1) parts.push(`${jobs.length} jobs`);
  if (eta !== null && eta > 0) parts.push(`${formatEta(eta)} left`);

  return (
    <Box paddingInline="400" paddingBlockStart="400">
      <Banner
        tone="info"
        title={parts.join(" · ")}
        onDismiss={dismiss}
        action={{ content: "View QA data", onAction: () => navigate("/app/qa-generator") }}
      >
        <Text as="p" variant="bodySm" tone="subdued">
          Generation runs in the background — you can keep working or close this tab.
        </Text>
      </Banner>
    </Box>
  );
}
