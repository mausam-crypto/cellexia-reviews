// Server tests for SPEC-1.20 — against the REAL curation/pricing/batch code.
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes throughout: ROOT is embedded into generated entry
// files as a module specifier, where Windows backslashes would form
// invalid escapes. Node accepts forward slashes on every platform.
const ROOT = path.resolve(HERE, "..", "..").split(path.sep).join("/");
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const fs = require("fs");

fs.writeFileSync(
  path.join(HERE, "db-stub.js"),
  `function match(r, w) {
    if (!w) return true;
    if (w.status && r.status !== w.status) return false;
    if (w.isSynthetic !== undefined && r.isSynthetic !== w.isSynthetic) return false;
    if (w.productId && typeof w.productId === "string" && r.productId !== w.productId) return false;
    if (w.id && w.id.in && !w.id.in.includes(r.id)) return false;
    if (w.id && w.id.notIn && w.id.notIn.includes(r.id)) return false;
    if (w.rating && w.rating.lte !== undefined && !(r.rating <= w.rating.lte)) return false;
    return true;
  }
  const prisma = {
    setting: {
      findUnique: async () => globalThis.__fx.settingRow,
      upsert: async () => globalThis.__fx.settingRow,
      update: async (q) => { Object.assign(globalThis.__fx.settingRow, q.data); globalThis.__fx.settingWrites.push(q.data); return globalThis.__fx.settingRow; },
      // Mirrors Prisma: matches on the WHERE, and {increment} adds to the
      // stored value. recordSpend relies on count===0 to detect a month change.
      updateMany: async (q) => {
        const row = globalThis.__fx.settingRow;
        const where = q?.where ?? {};
        // Supports the shapes the real code uses: equality, {not}, {lt}, and
        // an OR of those (the batch submit lock's compare-and-set).
        const cond = (val, c) => {
          if (c === null) return val == null;
          if (c && typeof c === "object") {
            if ("not" in c) return val !== c.not;
            if ("lt" in c) return val != null && val < c.lt;
          }
          return val === c;
        };
        for (const [k, v] of Object.entries(where)) {
          if (k === "shop") continue;
          if (k === "OR") {
            if (!v.some((clause) => Object.entries(clause).every(([ck, cv]) => cond(row[ck], cv)))) {
              return { count: 0 };
            }
            continue;
          }
          if (!cond(row[k], v)) return { count: 0 };
        }
        for (const [k, v] of Object.entries(q?.data ?? {})) {
          if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
          else row[k] = v;
        }
        globalThis.__fx.settingWrites.push(q.data);
        return { count: 1 };
      },
      findMany: async () => [],
    },
    review: {
      findMany: async (q) => {
        let rows = globalThis.__fx.reviews.filter((r) => match(r, q?.where));
        if (q?.orderBy) rows = [...rows].sort((a,b)=> b.createdAt - a.createdAt);
        return (q?.take ? rows.slice(0, q.take) : rows).map((r) => ({ media: [], ...r }));
      },
      count: async (q) => globalThis.__fx.reviews.filter((r) => match(r, q?.where)).length,
      groupBy: async (q) => {
        const rows = globalThis.__fx.reviews.filter((r) => match(r, q?.where));
        return [...new Set(rows.map((r) => r.productId))].map((productId) => {
          const mine = rows.filter((r) => r.productId === productId);
          return {
            productId,
            _count: { _all: mine.length },
            _max: { createdAt: mine.reduce((m, r) => (m && m > r.createdAt ? m : r.createdAt), null) },
          };
        });
      },
      findFirst: async (q) => globalThis.__fx.reviews.find((r) => match(r, q?.where)) ?? null,
    },
    translationCache: { findMany: async (q) => globalThis.__fx.translations.filter((t) =>
      q.where.reviewId.in.includes(t.reviewId) &&
      (typeof q.where.target === "string" ? t.target === q.where.target : q.where.target.in.includes(t.target))) },
    aiCuration: {
      upsert: async (q) => { globalThis.__fx.curationsWritten.push(q); return q.create; },
      findUnique: async () => null,
      findMany: async () => globalThis.__fx.curationRows,
    },
    curationBatch: {
      create: async (q) => { const row = { id: "cb1", ...q.data }; globalThis.__fx.batches.push(row); return row; },
      findMany: async (q) => globalThis.__fx.batches.filter((b) =>
        (q?.where?.appliedAt === null ? b.appliedAt == null : true) &&
        (q?.where?.status?.in ? q.where.status.in.includes(b.status) : true)),
      findFirst: async (q) => globalThis.__fx.batches.find((b) =>
        (q?.where?.shop === undefined || b.shop === q.where.shop) &&
        (q?.where?.anthropicBatchId === undefined || b.anthropicBatchId === q.where.anthropicBatchId)) ?? null,
      findUnique: async (q) => globalThis.__fx.batches.find((b) => b.id === q?.where?.id) ?? null,
      update: async (q) => { const row = globalThis.__fx.batches.find((b) => b.id === q.where.id) ?? globalThis.__fx.batches[0]; Object.assign(row, q.data); return row; },
      updateMany: async (q) => {
        const w = q.where ?? {};
        // Mirrors the real claim predicate: id + appliedAt null + (claimedAt
        // null OR older than the TTL), so the stale-claim path is exercised.
        const orOk = (b) => !w.OR || w.OR.some((c) => {
          if ("claimedAt" in c && c.claimedAt === null) return b.claimedAt == null;
          if (c.claimedAt && c.claimedAt.lt) return b.claimedAt != null && b.claimedAt < c.claimedAt.lt;
          return false;
        });
        const rows = globalThis.__fx.batches.filter((b) =>
          (w.id === undefined || b.id === w.id) &&
          (w.appliedAt === null ? b.appliedAt == null : true) &&
          orOk(b));
        rows.forEach((b) => Object.assign(b, q.data));
        return { count: rows.length };
      },
      count: async (q) => {
        const w = q?.where ?? {};
        return globalThis.__fx.batches.filter((b) =>
          (!w.status?.in || w.status.in.includes(b.status)) &&
          (!w.submittedAt?.gt || (b.submittedAt ?? new Date()) > w.submittedAt.gt)).length;
      },
    },
    productDisplayConfig: { findUnique: async () => null },
  };
  export default prisma;`,
);
fs.writeFileSync(path.join(HERE, "translate-stub.js"),
  `export async function translateReviews(shop, ids, target) {
     globalThis.__fx.translateCalls.push({ ids: [...ids], target });
     return globalThis.__fx.translateImpl ? globalThis.__fx.translateImpl(ids, target) : {};
   }`);
fs.writeFileSync(path.join(HERE, "shopify-stub.js"),
  `export const unauthenticated = { admin: async () => ({ admin: globalThis.__fx.sweepAdmin }) };`);
fs.writeFileSync(path.join(HERE, "entry.js"),
  `export * as cur from "${ROOT}/app/services/curation.server";
   export * as price from "${ROOT}/app/services/pricing.server";
   export * as ai from "${ROOT}/app/services/ai.server";
   export * as batch from "${ROOT}/app/services/curation-batch.server";
   export { estimateCuration } from "${ROOT}/app/services/curation-estimate.server";`);

await esbuild.build({
  entryPoints: [path.join(HERE, "entry.js")],
  bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "v120.bundle.cjs"),
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "db-stub.js") }));
      b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "shopify-stub.js") }));
      b.onResolve({ filter: /translate\.server$/ }, () => ({ path: path.join(HERE, "translate-stub.js") }));
      b.onResolve({ filter: /^~\// }, (a) => {
        const base = path.join(ROOT, "app", a.path.slice(2));
        return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
      });
    },
  }],
});
const svc = require(path.join(HERE, "v120.bundle.cjs"));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

const mk = (i, over = {}) => ({
  id: `r${i}`, shop: "s", productId: "123", rating: 5,
  title: `T${i}`, body: `Body ${i} ` + "x".repeat(120),
  language: "en", verified: true, status: "PUBLISHED", isSynthetic: false,
  createdAt: new Date(2026, 0, 1 + (i % 300)), variantTitle: null,
  helpfulCount: 100 - (i % 100), media: [],
  ...over,
});
function fx(over = {}) {
  globalThis.__fx = {
    settingRow: {
      shop: "s", aiProvider: "anthropic", anthropicApiKey: "sk-test", aiModel: "claude-sonnet-5",
      curationInstructions: null, curationOverviewField: "accentuate.overview",
      curationSource: "as_seen", curationRefresh: "manual",
      curationBudgetUsd: null, curationSpendMonth: "", curationSpendUsd: 0,
    },
    reviews: [], translations: [], curationRows: [], curationsWritten: [],
    translateCalls: [], translateImpl: null, batches: [], settingWrites: [], sweepAdmin: null,
    ...over,
  };
}
const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "A rich cream.", metafield: { value: "Overview text." } } } }) }) };

// P1 — pricing table
{
  const { costUsd, ratesFor, formatUsd, BATCH_DISCOUNT } = svc.price;
  const intro = costUsd({ model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0, today: "2026-08-05" });
  const after = costUsd({ model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0, today: "2026-09-01" });
  check("P1a intro pricing applies before the cutoff", intro === 2, String(intro));
  check("P1b standard pricing after the cutoff", after === 3, String(after));
  check("P1c batch is exactly half", costUsd({ model: "claude-opus-5", inputTokens: 1_000_000, outputTokens: 0, batch: true }) === 2.5);
  check("P1d unknown model prices to null (never guessed)", costUsd({ model: "made-up", inputTokens: 1e6, outputTokens: 0 }) === null && ratesFor("made-up") === null);
  check("P1e output priced separately", costUsd({ model: "claude-opus-5", inputTokens: 0, outputTokens: 1_000_000 }) === 25);
  check("P1f formatUsd keeps small amounts readable", formatUsd(12.3456) === "$12.35" && formatUsd(0.0421).startsWith("$0.04"));
  check("P1g discount constant", BATCH_DISCOUNT === 0.5);
}

// P2 — every review reaches the agent (no 60 cap)
{
  fx({ reviews: Array.from({ length: 240 }, (_, i) => mk(i)) });
  const { candidates, trimmedFrom } = await svc.cur.buildCandidates("s", "123", "en", "as_seen");
  check("P2a all 240 reviews are candidates (60 cap gone)", candidates.length === 240, String(candidates.length));
  check("P2b nothing trimmed at this size", !trimmedFrom, String(trimmedFrom));
  check("P2c bodies keep up to 2000 chars", candidates[0].body.length > 100);
  // The curator's set must equal the product page's set. reviews.server.ts
  // serves `{shop, productId, status:"PUBLISHED"}` with no provenance filter,
  // so a published QA-generated review is shown to shoppers and must be
  // ordered too. Unpublished rows are excluded, whatever their provenance.
  fx({ reviews: [
    ...Array.from({ length: 10 }, (_, i) => mk(i)),
    mk(99, { isSynthetic: true }),
    mk(98, { isSynthetic: true, status: "PENDING" }),
    mk(97, { status: "PENDING" }),
  ] });
  const pub = await svc.cur.buildCandidates("s", "123", "en", "as_seen");
  check("P2d published QA-generated rows are ordered like any other",
    pub.candidates.length === 11 && pub.candidates.some((c) => c.id === "r99"),
    String(pub.candidates.length));
  check("P2e unpublished rows are excluded whatever their provenance",
    !pub.candidates.some((c) => c.id === "r98" || c.id === "r97"));
}

// P3 — token-budget degradation ladder
{
  // 4000 huge reviews: bodies alone blow past the 400k budget.
  const huge = Array.from({ length: 4000 }, (_, i) => mk(i, { body: "y".repeat(2000), rating: (i % 5) + 1 }));
  fx({ reviews: huge });
  const { candidates, trimmedFrom } = await svc.cur.buildCandidates("s", "123", "en", "as_seen");
  const tokens = candidates.reduce((n, c) => n + Math.ceil(JSON.stringify(c).length / 3.4), 0);
  check("P3a payload fits the token budget", tokens <= svc.cur.MAX_PAYLOAD_TOKENS, String(tokens));
  check("P3b trimming is reported", trimmedFrom === 4000, String(trimmedFrom));
  check("P3c bodies were shortened before dropping reviews", candidates[0].body.length <= 800, String(candidates[0].body.length));
  const bands = new Set(candidates.map((c) => c.rating));
  check("P3d coverage ordering keeps every rating band", bands.size === 5, JSON.stringify([...bands]));
}

// P4 — dry run never translates
{
  fx({
    reviews: Array.from({ length: 8 }, (_, i) => mk(i, { language: "en" })),
    settingRow: undefined,
  });
  globalThis.__fx.settingRow = { shop: "s", aiProvider: "anthropic", anthropicApiKey: "sk-test",
    aiModel: "claude-sonnet-5", curationOverviewField: "accentuate.overview", curationSource: "all_translated",
    curationInstructions: null, curationBudgetUsd: null, curationSpendMonth: "", curationSpendUsd: 0 };
  globalThis.__fx.translateImpl = () => { throw new Error("must not translate in a dry run"); };
  const dry = await svc.cur.buildCandidates("s", "123", "fr", "all_translated", { translate: false });
  check("P4a dry run performed zero translations", globalThis.__fx.translateCalls.length === 0);
  check("P4b dry run still counts what it would translate", dry.missingTranslations === 8, String(dry.missingTranslations));
  check("P4c untranslated reviews fall through marked-original", dry.candidates.every((c) => c.textNote === "en"));
}

// P5 — budget ceiling
{
  fx({ reviews: Array.from({ length: 6 }, (_, i) => mk(i)) });
  globalThis.__fx.settingRow.curationBudgetUsd = 1;
  globalThis.__fx.settingRow.curationSpendMonth = new Date().toISOString().slice(0, 7);
  globalThis.__fx.settingRow.curationSpendUsd = 0.9;
  const under = await svc.cur.checkBudget("s", 0.05);
  const over = await svc.cur.checkBudget("s", 0.5);
  check("P5a under ceiling passes", under.ok === true && under.ceiling === 1);
  check("P5b over ceiling refuses", over.ok === false, JSON.stringify(over));
  globalThis.__fx.settingRow.curationSpendMonth = "2020-01"; // stale month
  const reset = await svc.cur.checkBudget("s", 0.5);
  check("P5c a new month resets the counter", reset.ok === true && reset.spent === 0, JSON.stringify(reset));
  globalThis.__fx.settingRow.curationBudgetUsd = null;
  check("P5d no ceiling always passes", (await svc.cur.checkBudget("s", 9999)).ok === true);
  // recordSpend uses BILLED usage
  globalThis.__fx.settingRow.curationSpendUsd = 0;
  await svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false);
  check("P5e spend recorded from billed usage", globalThis.__fx.settingRow.curationSpendUsd > 0, String(globalThis.__fx.settingRow.curationSpendUsd));
  const beforeBatch = globalThis.__fx.settingRow.curationSpendUsd;
  await svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, true);
  const delta = globalThis.__fx.settingRow.curationSpendUsd - beforeBatch;
  check("P5f batch spend recorded at half", Math.abs(delta - beforeBatch / 2) < 1e-6, String(delta));
}

// P6 — estimate: measured, priced, spends nothing
{
  fx({ reviews: Array.from({ length: 12 }, (_, i) => mk(i)) });
  let countCalls = 0, messageCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("count_tokens")) {
      countCalls += 1;
      return { ok: true, status: 200, json: async () => ({ input_tokens: 4321 }), text: async () => "" };
    }
    messageCalls += 1;
    throw new Error("estimate must never call the Messages API");
  };
  const est = await svc.estimateCuration("s", admin);
  check("P6a one call per qualifying pair", est.calls >= 1, JSON.stringify({ calls: est.calls }));
  check("P6b input tokens are MEASURED", est.exactPairs === est.totalPairs && est.inputTokens === 4321 * est.calls, JSON.stringify({ e: est.exactPairs, t: est.totalPairs, tok: est.inputTokens }));
  check("P6c never called the Messages API", messageCalls === 0 && countCalls === est.calls);
  check("P6d priced, with batch exactly half of instant", est.priced && Math.abs(est.batchCostUsd - est.instantCostUsd / 2) < 1e-6,
    JSON.stringify({ i: est.instantCostUsd, b: est.batchCostUsd }));
  check("P6e output tokens use the documented per-call estimate", est.outputTokens === est.calls * 900, String(est.outputTokens));
  // unknown model → tokens but no price
  globalThis.__fx.settingRow.aiModel = "some-unreleased-model";
  const unpriced = await svc.estimateCuration("s", admin);
  check("P6f unknown model reports tokens without inventing a price",
    unpriced.priced === false && unpriced.instantCostUsd === null && unpriced.inputTokens > 0, JSON.stringify({ p: unpriced.priced, c: unpriced.instantCostUsd }));
}

// P7 — estimate degrades to extrapolation when counting fails
{
  fx({ reviews: Array.from({ length: 12 }, (_, i) => mk(i, { productId: String(100 + (i % 4)) })) });
  let n = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes("count_tokens")) throw new Error("no messages call");
    n += 1;
    if (n > 2) return { ok: false, status: 400, json: async () => ({}), text: async () => "nope" };
    return { ok: true, status: 200, json: async () => ({ input_tokens: 5000 }), text: async () => "" };
  };
  const est = await svc.estimateCuration("s", admin);
  check("P7a some pairs measured, rest extrapolated", est.exactPairs > 0 && est.exactPairs < est.totalPairs, JSON.stringify({ e: est.exactPairs, t: est.totalPairs }));
  check("P7b extrapolation is disclosed in notes", est.notes.some((x) => /estimated from the measured average/.test(x)), JSON.stringify(est.notes));
  check("P7c total still counts every call", est.inputTokens > 0);
}

// P8 — batch custom_id contract
{
  const { batchCustomId } = svc.batch;
  check("P8a plain id valid", batchCustomId("8654321098765", "en") === "c_8654321098765_en");
  check("P8b regional locale keeps its hyphen and stays valid", /^[a-zA-Z0-9_-]{1,64}$/.test(batchCustomId("123", "pt-PT")));
  check("P8c over-long id refused rather than truncated", batchCustomId("9".repeat(70), "en") === null);
  check("P8d hostile id refused", batchCustomId("12 3/../x", "en") === null);
}

// P9 — batch submit body shape + budget refusal
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  let body = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/batches")) {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ id: "msgbatch_01" }), text: async () => "" };
    }
    throw new Error("unexpected " + url);
  };
  const res = await svc.batch.submitCurationBatch("s", admin, [{ productId: "123", locale: "en" }]);
  check("P9a submit ok and batch row stored", res.status === "ok" && globalThis.__fx.batches.length === 1, JSON.stringify(res));
  check("P9b body is {requests:[{custom_id, params}]}", Array.isArray(body.requests) && body.requests[0].custom_id === "c_123_en");
  const p = body.requests[0].params;
  check("P9c params carry model/max_tokens/system/messages", Boolean(p.model && p.max_tokens && p.system && p.messages[0].role === "user"));
  check("P9d helpfulCount never in the payload", !p.messages[0].content.includes("helpfulCount"));
  globalThis.__fx.settingRow.curationBudgetUsd = 0.001;
  globalThis.__fx.settingRow.curationSpendMonth = new Date().toISOString().slice(0, 7);
  globalThis.__fx.settingRow.curationSpendUsd = 0.001;
  const refused = await svc.batch.submitCurationBatch("s", admin, [{ productId: "123", locale: "en" }], 5);
  check("P9e over-budget submit refused with both numbers", refused.status === "over_budget" && refused.ceiling === 0.001, JSON.stringify(refused));
}

// P10 — JSONL result parsing and application
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cb1", shop: "s", anthropicBatchId: "msgbatch_01", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 4, pairs: JSON.stringify({
      c_123_en: { productId: "123", locale: "en" },
      c_123_fr: { productId: "123", locale: "fr" },
      c_123_de: { productId: "123", locale: "de" },
      c_123_it: { productId: "123", locale: "it" },
    }), appliedAt: null, succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
  });
  const good = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "Because." });
  const lines = [
    JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: good }], usage: { input_tokens: 1000, output_tokens: 100 } } } }),
    JSON.stringify({ custom_id: "c_123_fr", result: { type: "errored", error: { type: "invalid_request" } } }),
    JSON.stringify({ custom_id: "c_123_de", result: { type: "expired" } }),
    "{ this is not json",
    JSON.stringify({ custom_id: "c_unknown", result: { type: "succeeded", message: { content: [{ type: "text", text: good }] } } }),
    "",
  ].join("\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_01")) return { ok: true, status: 200, json: async () => ({
      processing_status: "ended", results_url: "https://results.example/x.jsonl",
      request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 1 },
      ended_at: "2026-08-05T10:00:00Z",
    }), text: async () => "" };
    if (u.includes("results.example")) return { ok: true, status: 200, text: async () => lines, json: async () => ({}) };
    throw new Error("unexpected " + u);
  };
  const out = await svc.batch.pollCurationBatches("s", admin);
  const row = globalThis.__fx.batches[0];
  check("P10a batch applied once", out.applied === 1 && row.appliedAt instanceof Date);
  check("P10b only the succeeded line stored a curation", globalThis.__fx.curationsWritten.length === 1, String(globalThis.__fx.curationsWritten.length));
  check("P10c malformed + errored + expired + unknown id all counted as failures", row.errored === 4, String(row.errored));
  check("P10d usage summed from the result file", row.inputTokens === 1000 && row.outputTokens === 100, JSON.stringify({ i: row.inputTokens, o: row.outputTokens }));
  check("P10e batch cost recorded at the discounted rate", row.costUsd > 0 && row.costUsd < 0.01, String(row.costUsd));
  check("P10f a re-poll does not re-apply", (await svc.batch.pollCurationBatches("s", admin)).applied === 0);
}

// P11 — batch result goes through the SAME validation as instant
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cb2", shop: "s", anthropicBatchId: "msgbatch_02", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1,
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en" } }),
    appliedAt: null, succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
  });
  // Two invented ids + one real ⇒ below MIN_ORDER ⇒ must be rejected, nothing stored.
  const bad = JSON.stringify({ order: ["r0", "nope-1", "nope-2"], rationale: "x" });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_02")) return { ok: true, status: 200, json: async () => ({
      processing_status: "ended", results_url: "https://results.example/y.jsonl",
      request_counts: { succeeded: 1 }, ended_at: null }), text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: bad }] } } }), json: async () => ({}) };
  };
  await svc.batch.pollCurationBatches("s", admin);
  check("P11 fabricated ids rejected in batch exactly as in instant runs",
    globalThis.__fx.curationsWritten.length === 0, String(globalThis.__fx.curationsWritten.length));
}

// P12 — the spend counter: atomic accumulation, honest month rollover
{
  const month = new Date().toISOString().slice(0, 7);
  fx({ reviews: Array.from({ length: 4 }, (_, i) => mk(i)) });
  // Last month's total must NOT carry into this month's ceiling.
  globalThis.__fx.settingRow.curationSpendMonth = "2020-01";
  globalThis.__fx.settingRow.curationSpendUsd = 999;
  await svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false);
  const afterRollover = globalThis.__fx.settingRow;
  check("P12a a new month starts from zero, not last month's total",
    afterRollover.curationSpendMonth === month && afterRollover.curationSpendUsd === 2,
    JSON.stringify({ m: afterRollover.curationSpendMonth, v: afterRollover.curationSpendUsd }));

  // Concurrent runs must both land: a read-modify-write would lose one.
  await Promise.all([
    svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false),
    svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false),
  ]);
  check("P12b concurrent spend accumulates instead of overwriting",
    globalThis.__fx.settingRow.curationSpendUsd === 6,
    String(globalThis.__fx.settingRow.curationSpendUsd));

  // ...and the ceiling then reads the accumulated total.
  globalThis.__fx.settingRow.curationBudgetUsd = 6.5;
  const b = await svc.cur.checkBudget("s", 1);
  check("P12c the ceiling is judged against real accumulated spend",
    b.ok === false && b.spent === 6 && b.ceiling === 6.5, JSON.stringify(b));

  // An unpriced model records nothing rather than a wrong number.
  const before = globalThis.__fx.settingRow.curationSpendUsd;
  await svc.cur.recordSpend("s", "some-unknown-model", { inputTokens: 1_000_000, outputTokens: 0 }, false);
  check("P12d an unpriced model never invents a spend figure",
    globalThis.__fx.settingRow.curationSpendUsd === before, String(globalThis.__fx.settingRow.curationSpendUsd));
}

// P13 — the API key never leaves Anthropic, even if results_url redirects
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cb3", shop: "s", anthropicBatchId: "msgbatch_03", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1,
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en" } }),
    appliedAt: null, succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
  });
  const seen = [];
  const good = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "ok" });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push({ u, key: init?.headers?.["x-api-key"] ?? null });
    if (u.endsWith("msgbatch_03")) return { ok: true, status: 200, json: async () => ({
      processing_status: "ended",
      results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_03/results",
      request_counts: { succeeded: 1 }, ended_at: null }), text: async () => "" };
    // Anthropic redirects the results to object storage.
    if (u.includes("api.anthropic.com") && u.endsWith("/results")) {
      return { ok: false, status: 302, headers: { get: (h) => (h === "location" ? "https://storage.example/x.jsonl?sig=abc" : null) }, text: async () => "", json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: good }] }, } }),
      json: async () => ({}) };
  };
  await svc.batch.pollCurationBatches("s", admin);
  const offOrigin = seen.filter((s) => !s.u.includes("api.anthropic.com"));
  const onOrigin = seen.filter((s) => s.u.includes("api.anthropic.com"));
  check("P13a the redirect is followed and the results still apply",
    globalThis.__fx.curationsWritten.length === 1, String(globalThis.__fx.curationsWritten.length));
  check("P13b the key is sent to Anthropic", onOrigin.every((s) => s.key === "sk-test") && onOrigin.length >= 2,
    JSON.stringify(onOrigin.map((s) => s.key)));
  check("P13c the key is NEVER sent to the storage host",
    offOrigin.length === 1 && offOrigin.every((s) => s.key === null), JSON.stringify(offOrigin));
}

// P14 — two estimates running at once do not blank each other's payloads
{
  fx({ reviews: Array.from({ length: 6 }, (_, i) => mk(i)) });
  let counted = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("count_tokens")) {
      counted += 1;
      return { ok: true, status: 200, json: async () => ({ input_tokens: 4242 }) };
    }
    throw new Error(`estimate must not call ${url}`);
  };
  const [a, b] = await Promise.all([
    svc.estimateCuration("s", admin, ["123"]),
    svc.estimateCuration("s", admin, ["123"]),
  ]);
  check("P14a both concurrent estimates measured every pair",
    a.exactPairs === a.totalPairs && b.exactPairs === b.totalPairs && a.totalPairs > 0,
    JSON.stringify({ a: [a.exactPairs, a.totalPairs], b: [b.exactPairs, b.totalPairs] }));
  check("P14b neither fell back to an approximation",
    a.inputTokens === a.totalPairs * 4242 && b.inputTokens === b.totalPairs * 4242,
    JSON.stringify({ a: a.inputTokens, b: b.inputTokens }));
  check("P14c the preview never called the Messages API", counted > 0, String(counted));
}

// P15 — the batch reservation: the ceiling holds across back-to-back submits
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.settingRow.curationBudgetUsd = 10;
  globalThis.__fx.settingRow.curationSpendMonth = new Date().toISOString().slice(0, 7);
  globalThis.__fx.settingRow.curationSpendUsd = 0;
  let submits = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/batches")) {
      submits += 1;
      return { ok: true, status: 200, json: async () => ({ id: `msgbatch_r${submits}` }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  const pairs = [{ productId: "123", locale: "en" }];
  const first = await svc.batch.submitCurationBatch("s", admin, pairs, 6);
  check("P15a first $6 batch is accepted against a $10 limit", first.status === "ok", JSON.stringify(first));
  check("P15b the estimate is reserved immediately", globalThis.__fx.settingRow.curationSpendUsd === 6,
    String(globalThis.__fx.settingRow.curationSpendUsd));

  // Same shop, second submit: without a reservation this would also pass.
  globalThis.__fx.batches.length = 0; // clear the open-batch guard for this check
  const second = await svc.batch.submitCurationBatch("s", admin, pairs, 6);
  check("P15c a second $6 batch is refused — the reservation is visible to the check",
    second.status === "over_budget", JSON.stringify(second));

  // Cancelling gives the reservation back.
  globalThis.__fx.batches.push({
    id: "cbr", shop: "s", anthropicBatchId: "msgbatch_r1", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{}", appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 6,
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  await svc.batch.cancelCurationBatch("s", "msgbatch_r1");
  check("P15d cancelling releases the reservation", globalThis.__fx.settingRow.curationSpendUsd === 0,
    String(globalThis.__fx.settingRow.curationSpendUsd));
}

// P16 — the open-batch guard stops a double-click billing twice
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cbopen", shop: "s", anthropicBatchId: "msgbatch_open", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{}", appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0,
  });
  let posted = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/batches")) { posted += 1; return { ok: true, status: 200, json: async () => ({ id: "x" }) }; }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  const r = await svc.batch.submitCurationBatch("s", admin, [{ productId: "123", locale: "en" }], 1);
  check("P16 a second background run is refused while one is open",
    r.status === "already_running" && posted === 0, JSON.stringify({ r, posted }));
}

// P17 — script-aware token estimate: CJK is not counted as Latin prose
{
  const latin = "a".repeat(1000);
  const japanese = "レビュー".repeat(250); // 1000 chars
  const lat = svc.price.approxTokens(latin);
  const jpn = svc.price.approxTokens(japanese);
  check("P17a Latin text uses the ~3.4 chars/token ratio", lat === Math.ceil(1000 / 3.4), String(lat));
  check("P17b CJK counts far higher, so the ladder trims instead of overflowing",
    jpn === 1000 && jpn > lat * 3, JSON.stringify({ lat, jpn }));
  check("P17c mixed text is counted piecewise", svc.price.approxTokens("ab" + "レ") === Math.ceil(2 / 3.4 + 1));
}

// P18 — a trimmed curation is not born stale
{
  const many = Array.from({ length: 8 }, (_, i) => mk(i));
  fx({ reviews: many });
  globalThis.__fx.curationRows = [{
    shop: "s", productId: "123", locale: "en", orderedIds: JSON.stringify(["r0", "r1", "r2"]),
    rationale: "x", model: "claude-sonnet-5",
    // Read 5 of the 8 that were published: a trimmed run.
    reviewCount: 5, sourceCount: 8,
    updatedAt: new Date(Date.now() + 60_000), createdAt: new Date(),
  }];
  const rows = await svc.cur.curationStatus("s");
  check("P18a a trimmed run is up to date, not permanently stale", rows[0].stale === false, JSON.stringify(rows[0]));
  check("P18b the table can say how many of how many were read",
    rows[0].reviewCount === 5 && rows[0].readOf === 8, JSON.stringify(rows[0]));

  // Publishing another review still marks it stale.
  globalThis.__fx.reviews = Array.from({ length: 9 }, (_, i) => mk(i));
  const rows2 = await svc.cur.curationStatus("s");
  check("P18c a new review still marks it stale", rows2[0].stale === true, JSON.stringify(rows2[0]));

  // Pre-1.20 rows (sourceCount 0) fall back to reviewCount.
  globalThis.__fx.reviews = many;
  globalThis.__fx.curationRows[0].sourceCount = 0;
  globalThis.__fx.curationRows[0].reviewCount = 8;
  const rows3 = await svc.cur.curationStatus("s");
  check("P18d rows written before 1.20 still judge correctly",
    rows3[0].stale === false && rows3[0].readOf === null, JSON.stringify(rows3[0]));
}

// P19 — a batch result is stamped with the review count from SUBMIT time
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cbs", shop: "s", anthropicBatchId: "msgbatch_src", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1,
    // Submitted when only 8 reviews were published.
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en", sourceCount: 8 } }),
    appliedAt: null, succeeded: 0, errored: 0, expired: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0,
  });
  // Two more reviews arrive while the batch is with Anthropic.
  globalThis.__fx.reviews = Array.from({ length: 10 }, (_, i) => mk(i));
  const good = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "ok" });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_src")) return { ok: true, status: 200, json: async () => ({
      processing_status: "ended", results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_src/results",
      request_counts: { succeeded: 1 }, ended_at: null }), text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: good }] } } }),
      json: async () => ({}) };
  };
  await svc.batch.pollCurationBatches("s", admin);
  const written = globalThis.__fx.curationsWritten[0];
  check("P19a the row records what the agent actually saw, not today's count",
    written?.create?.sourceCount === 8, JSON.stringify(written?.create));
  check("P19b the model that produced it is stamped, not the current setting",
    written?.create?.model === "claude-sonnet-5", String(written?.create?.model));

  // ...so the row reads as stale and the next refresh picks up the new reviews.
  globalThis.__fx.curationRows = [{
    shop: "s", productId: "123", locale: "en", orderedIds: JSON.stringify(["r0","r1","r2"]),
    rationale: "ok", model: "claude-sonnet-5", reviewCount: 8, sourceCount: 8,
    updatedAt: new Date(Date.now() + 60_000), createdAt: new Date(),
  }];
  const rows = await svc.cur.curationStatus("s");
  check("P19c reviews that arrived during the batch still mark it stale",
    rows[0].stale === true, JSON.stringify(rows[0]));
}

// P20 — a process that dies mid-apply does not strand the results
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const good = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "ok" });
  const ended = (id) => ({ ok: true, status: 200, json: async () => ({
    processing_status: "ended",
    results_url: `https://api.anthropic.com/v1/messages/batches/${id}/results`,
    request_counts: { succeeded: 1 }, ended_at: null }), text: async () => "" });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_dead")) return ended("msgbatch_dead");
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: good }] } } }),
      json: async () => ({}) };
  };
  // A previous process claimed this 25 minutes ago and never finished.
  globalThis.__fx.batches.push({
    id: "cbdead", shop: "s", anthropicBatchId: "msgbatch_dead", status: "ended",
    model: "claude-sonnet-5", requestCount: 1,
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en", sourceCount: 8 } }),
    claimedAt: new Date(Date.now() - 25 * 60 * 1000), appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0,
  });
  const r = await svc.batch.pollCurationBatches("s", admin);
  check("P20a a stale claim is retaken and the results applied", r.applied === 1, JSON.stringify(r));
  check("P20b the curation is stored", globalThis.__fx.curationsWritten.length === 1,
    String(globalThis.__fx.curationsWritten.length));

  // A FRESH claim by another poll is respected — no double apply.
  globalThis.__fx.curationsWritten.length = 0;
  globalThis.__fx.batches.push({
    id: "cblive", shop: "s", anthropicBatchId: "msgbatch_live", status: "ended",
    model: "claude-sonnet-5", requestCount: 1,
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en", sourceCount: 8 } }),
    claimedAt: new Date(), appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0,
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_live")) return ended("msgbatch_live");
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded", message: { content: [{ type: "text", text: good }] } } }),
      json: async () => ({}) };
  };
  const r2 = await svc.batch.pollCurationBatches("s", admin);
  check("P20c a claim another poll is actively holding is left alone",
    r2.applied === 0 && globalThis.__fx.curationsWritten.length === 0,
    JSON.stringify({ r2, written: globalThis.__fx.curationsWritten.length }));
}

// P21 — an unreadable pairs record fails the batch instead of looping forever
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.settingRow.curationSpendMonth = new Date().toISOString().slice(0, 7);
  globalThis.__fx.settingRow.curationSpendUsd = 5;
  globalThis.__fx.batches.push({
    id: "cbbad", shop: "s", anthropicBatchId: "msgbatch_bad", status: "ended",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{not json",
    claimedAt: null, appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 5,
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    processing_status: "ended", results_url: "https://api.anthropic.com/x", request_counts: {}, ended_at: null }),
    text: async () => "" });
  await svc.batch.pollCurationBatches("s", admin);
  const row = globalThis.__fx.batches.find((b) => b.id === "cbbad");
  check("P21a the batch is failed rather than retried forever",
    row.status === "failed" && row.appliedAt != null, JSON.stringify({ s: row.status, a: row.appliedAt }));
  check("P21b its reservation is given back", globalThis.__fx.settingRow.curationSpendUsd === 0 && row.reservedUsd === 0,
    JSON.stringify({ spend: globalThis.__fx.settingRow.curationSpendUsd, res: row.reservedUsd }));
}

// P22 — a reservation is always credited to the month it was charged to
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const thisMonth = new Date().toISOString().slice(0, 7);
  // Last month's $6 reservation, released now, must NOT eat this month's $2.
  globalThis.__fx.settingRow.curationSpendMonth = thisMonth;
  globalThis.__fx.settingRow.curationSpendUsd = 2;
  globalThis.__fx.batches.push({
    id: "cbold", shop: "s", anthropicBatchId: "msgbatch_old", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{}", claimedAt: null, appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    reservedUsd: 6, reservedMonth: "2020-01",
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  await svc.batch.cancelCurationBatch("s", "msgbatch_old");
  check("P22a releasing last month's reservation leaves this month untouched",
    globalThis.__fx.settingRow.curationSpendUsd === 2,
    String(globalThis.__fx.settingRow.curationSpendUsd));

  // A reservation from THIS month is released normally.
  globalThis.__fx.batches.push({
    id: "cbnow", shop: "s", anthropicBatchId: "msgbatch_now", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{}", claimedAt: null, appliedAt: null,
    succeeded: 0, errored: 0, expired: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    reservedUsd: 2, reservedMonth: thisMonth,
  });
  await svc.batch.cancelCurationBatch("s", "msgbatch_now");
  check("P22b this month's reservation is released normally",
    globalThis.__fx.settingRow.curationSpendUsd === 0,
    String(globalThis.__fx.settingRow.curationSpendUsd));
}

// P23 — a batch the app can never reach again does not block the shop forever
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const old = new Date(Date.now() - 27 * 60 * 60 * 1000);
  globalThis.__fx.batches.push({
    id: "cbstuck", shop: "s", anthropicBatchId: "msgbatch_stuck", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1, pairs: "{}", claimedAt: null, appliedAt: null,
    submittedAt: old, succeeded: 0, errored: 0, expired: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0, reservedMonth: "",
  });
  check("P23a a 27-hour-old in_progress batch no longer counts as open",
    (await svc.batch.hasOpenBatch("s")) === false);

  globalThis.__fx.batches[0].submittedAt = new Date();
  check("P23b a batch submitted just now does count as open",
    (await svc.batch.hasOpenBatch("s")) === true);
}

// P24 — a month rollover under concurrency does not lose either amount
{
  fx({ reviews: [] });
  globalThis.__fx.settingRow.curationSpendMonth = "2020-01";
  globalThis.__fx.settingRow.curationSpendUsd = 500;
  // Both calls arrive with the stored month stale: one must roll it over and
  // the other must ADD to the fresh total, not overwrite it.
  await Promise.all([
    svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false),
    svc.cur.recordSpend("s", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }, false),
  ]);
  check("P24a both amounts survive the rollover, and last month's total does not",
    globalThis.__fx.settingRow.curationSpendUsd === 4 &&
      globalThis.__fx.settingRow.curationSpendMonth === new Date().toISOString().slice(0, 7),
    JSON.stringify({ v: globalThis.__fx.settingRow.curationSpendUsd, m: globalThis.__fx.settingRow.curationSpendMonth }));
}

// P25 — two submits racing: the lock lets exactly one through
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  let posted = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/batches")) {
      posted += 1;
      // Slow enough that the second click is inside the first one's window.
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ id: `msgbatch_race${posted}` }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  const pairs = [{ productId: "123", locale: "en" }];
  const [a, b] = await Promise.all([
    svc.batch.submitCurationBatch("s", admin, pairs, 1),
    svc.batch.submitCurationBatch("s", admin, pairs, 1),
  ]);
  const oks = [a, b].filter((r) => r.status === "ok").length;
  check("P25a exactly one of two simultaneous submits goes through",
    oks === 1 && posted === 1, JSON.stringify({ a: a.status, b: b.status, posted }));
  check("P25b the other is told a run is already going",
    [a, b].some((r) => r.status === "already_running"), JSON.stringify({ a: a.status, b: b.status }));
  check("P25c the lock is released afterwards",
    globalThis.__fx.settingRow.curationBatchLock == null,
    String(globalThis.__fx.settingRow.curationBatchLock));
}

// P26 — the merchant's bug: a store populated from the QA generator.
// Published QA-generated reviews ARE served on the product page
// (reviews.server.ts uses {shop, productId, status:"PUBLISHED"} with no
// provenance filter), so the curator has to order them like any other.
// v1.20.0 excluded them and the preview came back empty.
{
  const synthetic = Array.from({ length: 12 }, (_, i) => mk(i, { isSynthetic: true }));
  fx({ reviews: synthetic });
  globalThis.fetch = async (url) => {
    if (String(url).includes("count_tokens")) {
      return { ok: true, status: 200, json: async () => ({ input_tokens: 5000 }) };
    }
    throw new Error(`estimate must not call ${url}`);
  };
  const est = await svc.estimateCuration("s", admin);
  check("P26a a store of QA-generated reviews is curatable again",
    est.calls > 0 && est.products === 1, JSON.stringify({ calls: est.calls, products: est.products, notes: est.notes }));

  const { candidates } = await svc.cur.buildCandidates("s", "123", "en");
  check("P26b every published review reaches the agent, whatever its provenance",
    candidates.length === 12, String(candidates.length));

  const locales = await svc.cur.qualifyingLocales("s", "123", "as_seen");
  check("P26c the product qualifies", locales.includes("en"), JSON.stringify(locales));

  // ...and a mixed store curates the whole page, not just part of it.
  fx({ reviews: [...synthetic, ...Array.from({ length: 4 }, (_, i) => mk(100 + i))] });
  const mixed = await svc.cur.buildCandidates("s", "123", "en");
  check("P26d a mixed store curates every review the page shows",
    mixed.candidates.length === 16, String(mixed.candidates.length));
}

// P27 — an empty preview always explains itself instead of guessing
{
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ input_tokens: 1 }) });

  fx({ reviews: [] });
  const none = await svc.estimateCuration("s", admin);
  check("P27a no reviews at all is stated plainly",
    none.calls === 0 && none.notes.some((n) => /no reviews in this app/i.test(n)),
    JSON.stringify(none.notes));

  fx({ reviews: Array.from({ length: 5 }, (_, i) => mk(i, { status: "PENDING" })) });
  const unpublished = await svc.estimateCuration("s", admin);
  check("P27b reviews awaiting approval are named as the reason, with a count",
    unpublished.calls === 0 &&
      unpublished.notes.some((n) => /5 are waiting for approval/i.test(n)),
    JSON.stringify(unpublished.notes));

  fx({ reviews: Array.from({ length: 2 }, (_, i) => mk(i)) });
  const tooFew = await svc.estimateCuration("s", admin);
  check("P27c below the 3-review floor is named as the reason",
    tooFew.calls === 0 && tooFew.notes.some((n) => /fewer than 3 published reviews/i.test(n)),
    JSON.stringify(tooFew.notes));

  check("P27d an empty preview is never silent",
    none.notes.length > 0 && unpublished.notes.length > 0 && tooFew.notes.length > 0);
}

// P28 — a Shopify outage costs ONE call per product, not one per language
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.settingRow.curationSource = "all_translated"; // 17 locales qualify
  let adminCalls = 0;
  const flaky = { graphql: async () => { adminCalls += 1; throw new Error("shopify down"); } };
  globalThis.fetch = async (u) => {
    if (String(u).includes("count_tokens")) return { ok: true, status: 200, json: async () => ({ input_tokens: 10 }) };
    throw new Error("must not call the Messages API");
  };
  const est = await svc.estimateCuration("s", flaky);
  check("P28a one failed Shopify call per product, not one per language",
    adminCalls === 1, `${adminCalls} calls`);
  check("P28b nothing is priced when the product could not be read", est.calls === 0, String(est.calls));
  check("P28c the merchant is told Shopify did not answer, not that the product is gone",
    est.notes.some((n) => /Shopify did not answer/.test(n)) &&
    !est.notes.some((n) => /no longer exist/.test(n)), JSON.stringify(est.notes));

  // A product that Shopify confirms is gone reads differently.
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const gone = { graphql: async () => ({ json: async () => ({ data: { product: null } }) }) };
  const est2 = await svc.estimateCuration("s", gone);
  check("P28d a deleted product says so instead",
    est2.calls === 0 && est2.notes.some((n) => /no longer exist/.test(n)) &&
    !est2.notes.some((n) => /Shopify did not answer/.test(n)), JSON.stringify(est2.notes));
}

// P29 — the 90%-failure bug: thinking must be OFF on curation calls
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const bodies = [];
  const good = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "ok" });
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({
      content: [{ type: "text", text: good }], stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 } }), text: async () => "" };
  };
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "d", metafield: null } } }) }) };
  const r = await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("P29a the run succeeds", r.status === "ok", JSON.stringify(r));
  check("P29b Sonnet 5 is told NOT to think — thinking is billed against max_tokens",
    bodies[0]?.thinking?.type === "disabled", JSON.stringify(bodies[0]?.thinking));
  check("P29c max_tokens has room for a rationale in any of the 17 languages",
    bodies[0]?.max_tokens >= 4000, String(bodies[0]?.max_tokens));

  // Haiku 4.5 has no default thinking — the parameter must NOT be sent.
  globalThis.__fx.settingRow.aiModel = "claude-haiku-4-5";
  bodies.length = 0;
  await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("P29d Haiku is not sent a thinking parameter it may not accept",
    bodies.length > 0 && !("thinking" in bodies[0]), JSON.stringify(Object.keys(bodies[0] ?? {})));

  // The batch path sends the IDENTICAL params.
  globalThis.__fx.settingRow.aiModel = "claude-sonnet-5";
  const built = await svc.cur.buildCurationRequest("s", admin, "123", "en");
  const params = svc.cur.anthropicMessageParams(built.request);
  check("P29e batch params carry the same thinking override",
    params.thinking?.type === "disabled" && params.max_tokens === built.request.maxTokens,
    JSON.stringify({ t: params.thinking, m: params.max_tokens }));
}

// P30 — a truncated answer is diagnosed, not shrugged at
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "d", metafield: null } } }) }) };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    content: [{ type: "text", text: '{"order": ["r0", "r1"' }], stop_reason: "max_tokens",
    usage: { input_tokens: 100, output_tokens: 4000 } }), text: async () => "" });
  const r = await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("P30a truncation reports ai_truncated, and the billed tokens still count",
    r.status === "ai_truncated", JSON.stringify(r));
  check("P30b the truncated call's spend was still recorded",
    globalThis.__fx.settingRow.curationSpendUsd > 0, String(globalThis.__fx.settingRow.curationSpendUsd));

  // A hard 400 (payload too big, malformed) is deterministic — its own status.
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({}),
    text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}' });
  const r400 = await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("P30c a 400 reports ai_rejected", r400.status === "ai_rejected", JSON.stringify(r400));

  // A refused API key names itself.
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "auth" });
  const r401 = await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("P30d a refused key reports ai_auth", r401.status === "ai_auth", JSON.stringify(r401));
}

// P31 — the payload budget respects the model's real context window
{
  check("P31a Sonnet keeps the 400k budget", svc.cur.payloadBudgetFor("claude-sonnet-5") === 400_000,
    String(svc.cur.payloadBudgetFor("claude-sonnet-5")));
  check("P31b Haiku is budgeted inside its 200k window",
    svc.cur.payloadBudgetFor("claude-haiku-4-5") === 150_000,
    String(svc.cur.payloadBudgetFor("claude-haiku-4-5")));
  check("P31c an unknown model gets the SAFE small budget",
    svc.cur.payloadBudgetFor("some-future-model") === 150_000,
    String(svc.cur.payloadBudgetFor("some-future-model")));

  // ...and buildCandidates actually enforces it: a review set that fits 400k
  // but not 150k is trimmed for Haiku instead of sent and rejected.
  const huge = Array.from({ length: 400 }, (_, i) =>
    mk(i, { body: "Detailed review text. ".repeat(90) })); // ~2000 chars each
  fx({ reviews: huge });
  globalThis.__fx.settingRow.aiModel = "claude-haiku-4-5";
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "d", metafield: null } } }) }) };
  const built = await svc.cur.buildCurationRequest("s", admin, "123", "en");
  const size = svc.price.approxTokens(built.request.system + built.request.userContent);
  check("P31d a 400-review payload is trimmed to fit Haiku's window",
    built.status === "ok" && size < 150_000,
    JSON.stringify({ status: built.status, size, count: built.request?.candidates?.length }));
}

// P29 — extractJson survives what models actually emit; truncation still fails
{
  const GOOD = { order: ["r0", "r1", "r2"], rationale: "ok" };
  const J = JSON.stringify(GOOD);
  const cases = [
    ["trailing prose with a brace", J + "\nNote: keep {order} short.", true],
    ["two JSON objects", J + "\n" + JSON.stringify({ order: ["x"], rationale: "dup" }), true],
    ["raw newlines inside the rationale",
      '{ "order": ["r0","r1","r2"], "rationale": "line one\nline two" }', true],
    ["truncated mid-array must STILL fail", '{ "order": ["r0","r1",', false],
    ["truncated mid-string must STILL fail", '{ "order": ["r0"], "rationale": "cut', false],
  ];
  for (const [name, input, wantParse] of cases) {
    const got = svc.ai ? svc.ai.extractJson(input) : null;
    const ok = wantParse ? got !== null && Array.isArray(got.order) : got === null;
    check(`P29 ${name}`, ok, JSON.stringify(got)?.slice(0, 80));
  }
}

// P30 — a truncated BATCH answer reports truncation, never "could not be read"
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  globalThis.__fx.batches.push({
    id: "cbt", shop: "s", anthropicBatchId: "msgbatch_tr", status: "in_progress",
    model: "claude-sonnet-5", requestCount: 1,
    pairs: JSON.stringify({ c_123_en: { productId: "123", locale: "en", sourceCount: 8, reviewCount: 8 } }),
    claimedAt: null, appliedAt: null, succeeded: 0, errored: 0, expired: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, reservedUsd: 0, reservedMonth: "",
  });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("msgbatch_tr")) return { ok: true, status: 200, json: async () => ({
      processing_status: "ended",
      results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_tr/results",
      request_counts: { succeeded: 1 }, ended_at: null }), text: async () => "" };
    return { ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ custom_id: "c_123_en", result: { type: "succeeded",
        message: { content: [{ type: "text", text: '{ "order": ["r0","r1",' }],
          stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 4000 } } } }),
      json: async () => ({}) };
  };
  await svc.batch.pollCurationBatches("s");
  const f = svc.cur.recentCurationFailures("s");
  check("P30 batch truncation is filed as ai_truncated",
    f.some((x) => x.status === "ai_truncated"), JSON.stringify(f.map((x) => x.status)));
  check("P30b nothing was stored from the truncated answer",
    globalThis.__fx.curationsWritten.length === 0, String(globalThis.__fx.curationsWritten.length));
}

// P31 — an unreadable answer keeps its head as evidence
{
  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const req = { system: "s", userContent: "u", model: "claude-sonnet-5", maxTokens: 4000,
    targetLocale: "en", candidates: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}` })),
    trimmedFrom: null };
  const r = await svc.cur.applyCurationResponse("s", "123", req, "I refuse to answer in JSON today.");
  check("P31 unreadable answers carry a bounded snippet",
    r.status === "ai_unparseable" && r.detail === "I refuse to answer in JSON today.",
    JSON.stringify(r));
}

// P32 — parser and salvage cover the shapes that were failing in production
{
  const J = JSON.stringify({ order: ["r0", "r1", "r2"], rationale: "ok" });
  const preamble = "First I weigh the doubts {results, texture} against the reviews.\n" + J;
  const got = svc.ai.extractJson(preamble);
  check("P32a a brace in a prose preamble no longer poisons the parse",
    got !== null && Array.isArray(got.order), JSON.stringify(got)?.slice(0, 80));

  fx({ reviews: Array.from({ length: 8 }, (_, i) => mk(i)) });
  const req = { system: "s", userContent: "u", model: "claude-sonnet-5", maxTokens: 8000,
    targetLocale: "en", candidates: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}` })),
    trimmedFrom: null };
  // The classic killer: an unescaped quote inside the rationale.
  const broken = '{ "order": ["r0","r1","r2","r3"], "rationale": "the reviewer said "amazing" twice" }';
  const r = await svc.cur.applyCurationResponse("s", "123", req, broken);
  check("P32b a broken rationale no longer sinks the order",
    r.status === "ok" && r.ordered === 4, JSON.stringify(r));
  const stored = globalThis.__fx.curationsWritten[0];
  check("P32c the salvaged curation stores the order with an empty rationale",
    stored && JSON.parse(stored.create.orderedIds).length === 4 && stored.create.rationale === "",
    JSON.stringify(stored?.create)?.slice(0, 120));

  // A truncated order array must never salvage.
  globalThis.__fx.curationsWritten.length = 0;
  const cut = '{ "order": ["r0","r1",';
  const r2 = await svc.cur.applyCurationResponse("s", "123", req, cut);
  check("P32d a truncated order still fails, with evidence attached",
    r2.status === "ai_unparseable" && typeof r2.detail === "string",
    JSON.stringify(r2));
}

console.log(failures === 0 ? "\nALL SCENARIOS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
