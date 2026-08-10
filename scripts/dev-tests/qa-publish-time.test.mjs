/**
 * v1.30 (SPEC-1.30) — QA generator scheduled auto-publish ("publish time").
 *
 * Real-code checks (no DB, no API key):
 *  P1  parseSyntheticConfig publishAt contract: Z required, normalization,
 *      forced PENDING, hard error on malformed/out-of-bounds, past accepted,
 *      absent/empty ignored, idempotent re-parse (job-runner round trip)
 *  P2  multi-launch: publishAt rides `shared` untouched; rows cannot smuggle
 *      their own; assembled configs are PENDING with the shared instant
 *  P3  sweepScheduledPublishes against a scripted in-memory prisma:
 *      due-query shape, claim+flip atomic in ONE transaction (claim gates
 *      the flip), triple-guarded review flip, CAS-loss never touches
 *      reviews, zero-flip claims without sync, sync failure appends a job
 *      warning but still counts the publish, per-job failure isolation,
 *      window flag demands progress (a full window of failures must NOT
 *      request an immediate re-tick)
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes throughout: ROOT is embedded into generated entry files as
// a module specifier, where Windows backslashes would form invalid escapes.
const ROOT = path.resolve(HERE, "..", "..").split(path.sep).join("/");
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const fs = require("fs");

fs.writeFileSync(
  path.join(HERE, "pt-entry.js"),
  `export { parseSyntheticConfig, parseMultiLaunch, assembleLaunchConfig } from "${ROOT}/app/services/synthetic.server";
   export { sweepScheduledPublishes } from "${ROOT}/app/services/publish-scheduler.server";`,
);
// Scriptable stubs: each test swaps the globalThis hooks, so one bundle
// serves every scenario.
fs.writeFileSync(
  path.join(HERE, "pt-db-stub.js"),
  "const prisma = new Proxy({}, { get: (t, prop) => globalThis.__ptPrisma?.[prop] });\nexport default prisma;",
);
fs.writeFileSync(
  path.join(HERE, "pt-shopify-stub.js"),
  "export const unauthenticated = { admin: async (shop) => globalThis.__ptAdmin(shop) };",
);
fs.writeFileSync(
  path.join(HERE, "pt-moderation-stub.js"),
  "export async function syncProductData(shop, productId, admin) { return globalThis.__ptSync(shop, productId, admin); }",
);
fs.writeFileSync(
  path.join(HERE, "pt-qna-stub.js"),
  "export async function invalidateAskAnswers(shop, productId) { return globalThis.__ptInvalidate(shop, productId); }",
);
await esbuild.build({
  entryPoints: [path.join(HERE, "pt-entry.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(HERE, "pt.bundle.cjs"),
  plugins: [
    {
      name: "stubs",
      setup(b) {
        // Specific filters BEFORE the generic ~/ resolver (v1.18 lesson).
        b.onResolve({ filter: /^~\/db\.server$/ }, () => ({
          path: path.join(HERE, "pt-db-stub.js"),
        }));
        b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({
          path: path.join(HERE, "pt-shopify-stub.js"),
        }));
        b.onResolve({ filter: /moderation\.server$/ }, () => ({
          path: path.join(HERE, "pt-moderation-stub.js"),
        }));
        // publish-scheduler imports qna RELATIVELY ("./qna.server").
        b.onResolve({ filter: /qna\.server$/ }, () => ({
          path: path.join(HERE, "pt-qna-stub.js"),
        }));
        b.onResolve({ filter: /^~\// }, (a) => {
          const base = path.join(ROOT, "app", a.path.slice(2));
          return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
        });
      },
    },
  ],
});
const svc = require(path.join(HERE, "pt.bundle.cjs"));
let fail = 0;
const t = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    fail++;
    if (detail !== undefined) console.log("   ", detail);
  }
};

const BASE_RAW = {
  productId: "123456",
  productTitle: "Firming Night Cream",
  productDescription: "A rich night cream.",
  count: 40,
  targetAverage: 4.5,
  verifiedPercent: 80,
  languages: ["en", "fr"],
  repliesPercent: 15,
  maxHelpfulVotes: 25,
  dateStart: "2025-05-01",
  dateEnd: "2026-05-01",
  structuredAttrs: true,
  humanTouch: 50,
  status: "PUBLISHED",
};

/* ---- P1: parse contract -------------------------------------------------- */
{
  const full = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2026-08-12T06:00:00.000Z" });
  t("P1a valid Z instant accepted", full.config !== null, full.error);
  t("P1b normalized verbatim", full.config?.publishAt === "2026-08-12T06:00:00.000Z");
  t("P1c status FORCED to PENDING over raw PUBLISHED", full.config?.status === "PENDING");

  const short = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2026-08-12T06:00Z" });
  t(
    "P1d short form normalizes to full ISO",
    short.config?.publishAt === "2026-08-12T06:00:00.000Z",
    short.error ?? short.config?.publishAt,
  );

  const noZone = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2026-08-12T06:00:00" });
  t("P1e zone-less string is a HARD error", noZone.config === null && /publish time/i.test(noZone.error ?? ""));
  const offset = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2026-08-12T06:00:00+02:00" });
  t("P1f offset form rejected (UTC only)", offset.config === null);
  const junk = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "next tuesday" });
  t("P1g garbage is a HARD error", junk.config === null);
  const impossible = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2026-13-45T06:00:00.000Z" });
  t("P1h impossible date rejected", impossible.config === null);
  const early = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "1999-01-01T06:00:00.000Z" });
  const late = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2150-01-01T06:00:00.000Z" });
  // Upper bound is EXCLUSIVE — the same contract as the admin form's client
  // mirror, so no instant passes one check and fails the other.
  const boundary = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2100-01-01T00:00:00.000Z" });
  t(
    "P1i static bounds enforced (upper bound exclusive, client-mirror aligned)",
    early.config === null && late.config === null && boundary.config === null,
  );

  const past = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "2025-01-01T06:00:00.000Z" });
  t("P1j PAST instant accepted (retry case)", past.config?.publishAt === "2025-01-01T06:00:00.000Z");

  const absent = svc.parseSyntheticConfig({ ...BASE_RAW });
  t("P1k absent → no publishAt, status honored", absent.config?.publishAt === undefined && absent.config?.status === "PUBLISHED");
  const empty = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: "" });
  const nul = svc.parseSyntheticConfig({ ...BASE_RAW, publishAt: null });
  t("P1l empty/null treated as absent", empty.config?.publishAt === undefined && nul.config?.publishAt === undefined);

  const reparsed = svc.parseSyntheticConfig({ ...full.config });
  t(
    "P1m idempotent re-parse (job-runner round trip)",
    JSON.stringify(reparsed.config) === JSON.stringify(full.config),
  );
}

/* ---- P2: multi-launch ---------------------------------------------------- */
{
  const launch = svc.parseMultiLaunch({
    shared: { ...BASE_RAW, productId: undefined, publishAt: "2026-09-01T06:00:00.000Z" },
    products: [
      { productId: "111", count: 10, publishAt: "2026-01-01T00:00:00.000Z" },
      { productId: "222", count: 5 },
    ],
  });
  t("P2a launch parses", launch.input !== null, launch.error);
  t("P2b publishAt rides shared", launch.input?.shared.publishAt === "2026-09-01T06:00:00.000Z");
  t(
    "P2c a row cannot smuggle its own publishAt",
    launch.input?.rows.every((r) => !("publishAt" in r.overrides)),
  );
  const ctx = {
    id: "111",
    title: "Serum",
    handle: "serum",
    description: "d",
    productType: null,
    tags: [],
    variants: [],
  };
  const assembled = svc.assembleLaunchConfig(launch.input, launch.input.rows[0], ctx);
  t("P2d assembled config carries the SHARED instant", assembled.config?.publishAt === "2026-09-01T06:00:00.000Z");
  t("P2e assembled config is PENDING", assembled.config?.status === "PENDING");
}

/* ---- P3: sweep against a scripted prisma --------------------------------- */

function job(id, over = {}) {
  return {
    id,
    shop: "test-shop.myshopify.com",
    productId: "777",
    batchId: `batch-${id}`,
    status: "COMPLETED",
    publishAt: new Date("2026-08-10T06:00:00.000Z"),
    publishedAt: null,
    errors: "[]",
    ...over,
  };
}

/**
 * Scripted prisma + side-effect hooks. `script.flip(job)` returns the flip
 * count (or throws); `script.claim` the CAS count. Every call is logged.
 * The transaction callback receives a DISTINCT facade whose log entries
 * carry a "tx." tag — so a regression that calls the OUTER client inside
 * the $transaction callback (the SQLite auto-commit-outside-the-tx pitfall)
 * produces untagged entries and fails the assertions, instead of passing
 * unnoticed because both clients logged identically.
 */
function arm(script) {
  const log = [];
  const jobRows = new Map((script.due ?? []).map((j) => [j.id, j]));
  const makeFacade = (tag) => ({
    generationJob: {
      findMany: async (args) => {
        log.push([`${tag}job.findMany`, args]);
        return script.due ?? [];
      },
      updateMany: async (args) => {
        log.push([`${tag}job.updateMany`, args]);
        return { count: script.claim ?? 1 };
      },
      findFirst: async (args) => {
        log.push([`${tag}job.findFirst`, args]);
        return null;
      },
      count: async (args) => {
        log.push([`${tag}job.count`, args]);
        return 0;
      },
      findUnique: async (args) => {
        log.push([`${tag}job.findUnique`, args]);
        return jobRows.get(args.where.id) ?? null;
      },
      update: async (args) => {
        log.push([`${tag}job.update`, args]);
        return {};
      },
    },
    review: {
      updateMany: async (args) => {
        log.push([`${tag}review.updateMany`, args]);
        const id = args.where.syntheticBatchId?.replace("batch-", "");
        return { count: script.flip ? script.flip(id) : 3 };
      },
    },
  });
  const txFacade = makeFacade("tx.");
  globalThis.__ptPrisma = {
    ...makeFacade(""),
    $transaction: async (fn) => {
      log.push(["tx.begin"]);
      try {
        return await fn(txFacade);
      } finally {
        log.push(["tx.end"]);
      }
    },
  };
  globalThis.__ptAdmin = async () => {
    log.push(["admin"]);
    if (script.adminThrow) throw new Error("no offline session");
    return { admin: {} };
  };
  globalThis.__ptSync = async (shop, productId) => {
    log.push(["sync", shop, productId]);
    if (script.syncThrow) throw new Error("metafields down");
  };
  globalThis.__ptInvalidate = async (shop, productId) => {
    log.push(["invalidate", shop, productId]);
  };
  return log;
}

const NOW = Date.parse("2026-08-10T07:00:00.000Z");

// P3a — happy path: query shape, triple guard, claim, side-effects.
{
  const log = arm({ due: [job("j1")] });
  const res = await svc.sweepScheduledPublishes(NOW);
  const findArgs = log.find(([k]) => k === "job.findMany")?.[1];
  t(
    "P3a1 due query: lte-now + unpublished + terminal-only, bounded + oldest-first",
    findArgs?.where?.publishAt?.lte?.getTime() === NOW &&
      findArgs?.where?.publishedAt === null &&
      JSON.stringify(findArgs?.where?.status?.in?.slice().sort()) ===
        JSON.stringify(["CANCELLED", "COMPLETED", "FAILED"]) &&
      findArgs?.take === 100 &&
      findArgs?.orderBy?.publishAt === "asc",
    JSON.stringify(findArgs),
  );
  const flip = log.find(([k]) => k === "tx.review.updateMany")?.[1];
  t(
    "P3a2 review flip (inside the tx) triple-guarded to the batch's PENDING synthetic rows",
    flip?.where?.shop === "test-shop.myshopify.com" &&
      flip?.where?.syntheticBatchId === "batch-j1" &&
      flip?.where?.isSynthetic === true &&
      flip?.where?.status === "PENDING" &&
      flip?.data?.status === "PUBLISHED",
    JSON.stringify(flip),
  );
  const claim = log.find(([k]) => k === "tx.job.updateMany")?.[1];
  t(
    "P3a3 claim (inside the tx) is a CAS on publishedAt+terminal",
    claim?.where?.id === "j1" &&
      claim?.where?.publishedAt === null &&
      Array.isArray(claim?.where?.status?.in) &&
      claim?.data?.publishedAt instanceof Date,
    JSON.stringify(claim),
  );
  t("P3a4 sync + ask-invalidation ran for the product", log.some(([k, , p]) => k === "sync" && p === "777") && log.some(([k]) => k === "invalidate"));
  t("P3a5 result counts", res.published === 3 && res.jobs === 1 && res.failed === 0, JSON.stringify(res));
}

// P3b — ATOMICITY: claim gates the flip, BOTH run inside one transaction
// USING THE TX CLIENT (a crash can never leave the reviews flipped but the
// job unclaimed). The untagged-write check is the mutant-killer: code that
// reaches for the outer prisma client inside the callback would auto-commit
// outside the transaction and MUST fail here.
{
  const log = arm({ due: [job("j1")] });
  await svc.sweepScheduledPublishes(NOW);
  const txBegin = log.findIndex(([k]) => k === "tx.begin");
  const txEnd = log.findIndex(([k]) => k === "tx.end");
  const claimIdx = log.findIndex(([k]) => k === "tx.job.updateMany");
  const flipIdx = log.findIndex(([k]) => k === "tx.review.updateMany");
  t(
    "P3b claim-then-flip, both inside ONE transaction, via the tx client",
    txBegin !== -1 && claimIdx > txBegin && flipIdx > claimIdx && txEnd > flipIdx,
    JSON.stringify(log.map(([k]) => k)),
  );
  t(
    "P3b2 no outer-client writes anywhere in the publish (mutant guard)",
    !log.some(([k]) => k === "review.updateMany" || k === "job.updateMany"),
    JSON.stringify(log.map(([k]) => k)),
  );
}

// P3c — CAS loss (retry re-queued the job): the reviews are NEVER touched
// (the un-skeptic-checked retry rows must not publish mid-generation), and
// no side-effects run.
{
  const log = arm({ due: [job("j1")], claim: 0 });
  await svc.sweepScheduledPublishes(NOW);
  t(
    "P3c CAS loss never flips reviews, skips sync + invalidation",
    !log.some(([k]) => k.endsWith("review.updateMany")) &&
      !log.some(([k]) => k === "sync") &&
      !log.some(([k]) => k === "invalidate"),
  );
}

// P3d — nothing left to flip (manual early publish): claim, but no sync.
{
  const log = arm({ due: [job("j1")], flip: () => 0 });
  const res = await svc.sweepScheduledPublishes(NOW);
  t(
    "P3d zero-flip still claims, skips sync",
    log.some(([k]) => k === "tx.job.updateMany") &&
      !log.some(([k]) => k === "sync") &&
      res.published === 0 &&
      res.jobs === 1,
  );
}

// P3e — sync failure: warning appended to the job row, publish still counts,
// ask-invalidation still runs.
{
  const log = arm({ due: [job("j1")], syncThrow: true });
  const res = await svc.sweepScheduledPublishes(NOW);
  const warn = log.find(([k]) => k === "job.update")?.[1];
  t(
    "P3e1 sync failure appends the job warning",
    typeof warn?.data?.errors === "string" && /auto-published/.test(warn.data.errors),
    JSON.stringify(warn),
  );
  t("P3e2 publish still counted + ask cache still invalidated", res.published === 3 && res.jobs === 1 && log.some(([k]) => k === "invalidate"));
}

// P3f — per-job failure isolation: job 1 explodes, job 2 still publishes.
{
  const log = arm({
    due: [job("j1"), job("j2", { productId: "888" })],
    flip: (id) => {
      if (id === "j1") throw new Error("db down");
      return 5;
    },
  });
  const res = await svc.sweepScheduledPublishes(NOW);
  t(
    "P3f one bad job never blocks the rest",
    res.failed === 1 && res.jobs === 1 && res.published === 5 && log.some(([k, , p]) => k === "sync" && p === "888"),
    JSON.stringify(res),
  );
}

// P3g — the window flag demands MAJORITY progress: a full window (100 due)
// of pure failures must NOT request an immediate re-tick (it would hot-loop
// 100 failing publishes every 5 s), a failure-DOMINATED mixed window must
// not either (failed jobs re-seat at the head of every window), while a
// healthy full window must.
{
  const dueAll = Array.from({ length: 100 }, (_, i) => job(`f${i}`));
  const quiet = console.error; // expected failure lines — keep output readable
  console.error = () => {};
  arm({ due: dueAll, flip: () => { throw new Error("write refused"); } });
  const broke = await svc.sweepScheduledPublishes(NOW);
  arm({
    due: dueAll,
    flip: (id) => {
      if (Number(id.slice(1)) < 60) throw new Error("write refused");
      return 3;
    },
  });
  const mixed = await svc.sweepScheduledPublishes(NOW);
  console.error = quiet;
  arm({ due: dueAll });
  const fine = await svc.sweepScheduledPublishes(NOW);
  t(
    "P3g failure-dominated windows back off; healthy full windows re-tick",
    broke.window === false &&
      broke.failed === 100 &&
      mixed.window === false &&
      mixed.failed === 60 &&
      mixed.jobs === 40 &&
      fine.window === true &&
      fine.jobs === 100,
    JSON.stringify({
      broke: { w: broke.window, f: broke.failed },
      mixed: { w: mixed.window, f: mixed.failed, j: mixed.jobs },
      fine: { w: fine.window, j: fine.jobs },
    }),
  );
}

console.log(fail === 0 ? "\nAll publish-time checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
