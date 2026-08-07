// SPEC-1.24 — skeptic pass against the REAL synthetic.server code.
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

fs.writeFileSync(path.join(HERE, "sk-db-stub.js"), `
const prisma = {
  review: {
    findMany: async (q) => {
      const w = q?.where ?? {};
      let rows = globalThis.__fx.rows.filter((r) =>
        r.shop === w.shop && r.isSynthetic === true &&
        r.syntheticBatchId === w.syntheticBatchId &&
        (w.qaChecked === undefined || r.qaChecked === w.qaChecked));
      rows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
      return (q?.take ? rows.slice(0, q.take) : rows).map((r) => ({ ...r }));
    },
    deleteMany: async (q) => {
      const w = q?.where ?? {};
      const victims = globalThis.__fx.rows.filter((r) =>
        w.id.in.includes(r.id) && r.shop === w.shop &&
        r.isSynthetic === true && r.syntheticBatchId === w.syntheticBatchId);
      globalThis.__fx.deleted.push(...victims.map((r) => r.id));
      globalThis.__fx.rows = globalThis.__fx.rows.filter((r) => !victims.includes(r));
      return { count: victims.length };
    },
    updateMany: async (q) => {
      const w = q?.where ?? {};
      let n = 0;
      for (const r of globalThis.__fx.rows) {
        if (w.id.in.includes(r.id) && r.shop === w.shop && r.isSynthetic === true) {
          Object.assign(r, q.data); n++;
        }
      }
      return { count: n };
    },
  },
  setting: { findUnique: async () => ({}), upsert: async () => ({}) },
  translationCache: { deleteMany: async (q) => {
    globalThis.__fx.trDeleted = (globalThis.__fx.trDeleted ?? []).concat(q?.where?.reviewId?.in ?? []);
    return { count: (q?.where?.reviewId?.in ?? []).length };
  } },
};
export default prisma;`);
fs.writeFileSync(path.join(HERE, "sk-entry.js"),
  `export { runSkepticPass, buildSkepticSystemPrompt, parseSyntheticConfig, buildSystemPrompt, writingStyleFor } from "${ROOT}/app/services/synthetic.server";`);
fs.writeFileSync(path.join(HERE, "shopify-stub.js"), "export const unauthenticated = { admin: async () => ({ admin: null }) };");
await esbuild.build({
  entryPoints: [path.join(HERE, "sk-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "sk.bundle.cjs"),
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "sk-db-stub.js") }));
    b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "shopify-stub.js") }));
    b.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  }}],
});
const svc = require(path.join(HERE, "sk.bundle.cjs"));

let fail = 0;
const t = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { fail++; console.log("   ", detail); } };
const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: `r${i}`, shop: "s", isSynthetic: true, syntheticBatchId: "b1", qaChecked: false,
  language: "en", rating: 5, title: `T${i}`, body: `Body ${i}`, createdAt: new Date(2026, 0, 1 + i),
}));
function fx(rows) { globalThis.__fx = { rows, deleted: [] }; }
const answer = (obj) => ({ ok: true, status: 200,
  json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 60 } }),
  text: async () => "" });

// T1: two convicted of eight
fx(mkRows(8));
globalThis.fetch = async () => answer({ remove: [2, 5], reason: "uniform rhythm" });
let r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 20);
t("T1a two removed", r.removed === 2 && globalThis.__fx.deleted.sort().join() === "r1,r4", JSON.stringify({ r, deleted: globalThis.__fx.deleted }));
t("T1b survivors marked checked", globalThis.__fx.rows.every((x) => x.qaChecked), JSON.stringify(globalThis.__fx.rows.map((x) => x.qaChecked)));
t("T1c counts + tokens", r.checked === 8 && r.inputTokens === 500 && r.outputTokens === 60 && r.unchecked === 0, JSON.stringify(r));

// T2: paranoid answer capped at 40%
fx(mkRows(10));
globalThis.fetch = async () => answer({ remove: [1,2,3,4,5,6,7,8,9,10], reason: "all AI" });
r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 20);
t("T2 cap holds: 4 of 10 max, worst-first", r.removed === 4 && globalThis.__fx.deleted.join() === "r0,r1,r2,r3", JSON.stringify({ removed: r.removed, deleted: globalThis.__fx.deleted }));

// T3: unparseable answer keeps everything
fx(mkRows(6));
globalThis.fetch = async () => answer(null) && null; // force garbage below
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "I think they all look fine to me!" }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 20 } }), text: async () => "" });
r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 20);
t("T3 unusable answer: nothing deleted, all kept + unchecked", r.removed === 0 && r.unchecked === 6 && globalThis.__fx.rows.length === 6 && globalThis.__fx.rows.every((x) => x.qaChecked), JSON.stringify(r));

// T4: batching honors X across groups
fx(mkRows(12));
let calls = 0;
globalThis.fetch = async () => { calls += 1; return answer({ remove: [1], reason: "tell" }); };
r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 5);
t("T4 groups of 5 → 3 calls, one removal each", calls === 3 && r.removed === 3 && r.checked === 12, JSON.stringify({ calls, r }));

// T5: auth failure bails with pass-through
fx(mkRows(7));
globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "auth" });
r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 20);
t("T5 auth failure: authFailed, all kept", r.authFailed === true && r.removed === 0 && globalThis.__fx.rows.length === 7, JSON.stringify(r));

// T6: cooperative stop
fx(mkRows(15));
let stops = 0;
globalThis.fetch = async () => answer({ remove: [], reason: "clean" });
r = await svc.runSkepticPass("s", "sk", "claude-sonnet-5", "b1", 5, () => { stops += 1; return stops > 1; });
t("T6 stop after the first group", r.checked === 5 && globalThis.__fx.rows.filter((x) => x.qaChecked).length === 5, JSON.stringify(r));

// T7: config defaults + clamps
const parsed = svc.parseSyntheticConfig({ productId: "123", productTitle: "X", count: 10, languages: ["en"], skepticBatchSize: 500 });
t("T7a skeptic on by default, size clamped to 60", parsed.config.skepticCheck === true && parsed.config.skepticBatchSize === 60, JSON.stringify({ c: parsed.config?.skepticCheck, s: parsed.config?.skepticBatchSize }));
const parsed2 = svc.parseSyntheticConfig({ productId: "123", productTitle: "X", count: 10, languages: ["en"], skepticCheck: false, skepticBatchSize: 2 });
t("T7b off honored, size floored to 5", parsed2.config.skepticCheck === false && parsed2.config.skepticBatchSize === 5, JSON.stringify({ c: parsed2.config?.skepticCheck, s: parsed2.config?.skepticBatchSize }));

// T8: prompts carry the new dial + skeptic contract
const gen = svc.buildSystemPrompt("Cellexia");
t("T8a titles join the dial, without verbatim example bait", /applies to the TITLE/.test(gen) && /never reuse an example verbatim/.test(gen) && !/"works great"/.test(gen));
const sk = svc.buildSkepticSystemPrompt();
t("T8b skeptic protects human mess", /signs of a REAL shopper/.test(sk) && /never grounds for removal/.test(sk));
t("T8c skeptic JSON contract", /"remove"/.test(sk) && /empty "remove" array is a perfectly good answer/.test(sk));

// T9 — the human-touch slider maps the mix as documented
{
  const dist = (level) => {
    const c = { clean: 0, minor_slips: 0, casual_sloppy: 0 };
    for (let i = 0; i < 10000; i++) c[svc.writingStyleFor((i + 0.5) / 10000, level)]++;
    return { clean: c.clean / 100, minor: c.minor_slips / 100, sloppy: c.casual_sloppy / 100 };
  };
  const d0 = dist(0), d50 = dist(50), d100 = dist(100);
  t("T9a level 0 is fully polished", d0.clean === 100 && d0.sloppy === 0, JSON.stringify(d0));
  t("T9b level 50 ≈ 50/30/20 (the v1.23 feel)",
    Math.abs(d50.clean - 50) < 1 && Math.abs(d50.minor - 30) < 1 && Math.abs(d50.sloppy - 20) < 1, JSON.stringify(d50));
  t("T9c level 100 is 0/60/40 — never all sloppy", d100.clean === 0 && Math.abs(d100.minor - 60) < 1, JSON.stringify(d100));
  const p = svc.parseSyntheticConfig({ productId: "1", productTitle: "X", count: 5, languages: ["en"], humanTouch: 250 });
  const p2 = svc.parseSyntheticConfig({ productId: "1", productTitle: "X", count: 5, languages: ["en"] });
  t("T9d clamped to 100, defaults to 50", p.config.humanTouch === 100 && p2.config.humanTouch === 50,
    JSON.stringify({ a: p.config?.humanTouch, b: p2.config?.humanTouch }));
}

console.log(fail === 0 ? "\nALL SKEPTIC CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
