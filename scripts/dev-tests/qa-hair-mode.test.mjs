/**
 * v1.29 (SPEC-1.29) — QA generator hair mode + merchant extra product info.
 *
 * Real-code checks (no DB, no API key):
 *  H1  parseSyntheticConfig: defaults, coercion, 2000-char cap
 *  H2  buildSystemPrompt: category swap, skincare wording gone in hair mode
 *  H3  buildUserContent: extra-info block, hair CATEGORY block, hair results phrasing
 *  H4  buildBatchPlan: hair flag is rng-DRAW-NEUTRAL (identical plan apart from
 *      the documented differences), skin concerns emptied, results hair-safe
 *  H5  hairBrief substitution per persona; hairBrief dash hygiene
 *  H6  parseMultiLaunch/assembleLaunchConfig: per-row keys, shared cannot smuggle
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
fs.writeFileSync(path.join(HERE, "hm-entry.js"),
  `export { parseSyntheticConfig, buildBatchPlan, buildSystemPrompt, buildUserContent, parseMultiLaunch, assembleLaunchConfig } from "${ROOT}/app/services/synthetic.server";
   export { PERSONA_BRIEFS } from "${ROOT}/app/services/synthetic-prompts.server";`);
fs.writeFileSync(path.join(HERE, "hm-db-stub.js"),
  "const prisma = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => ({}) }) });\nexport default prisma;");
fs.writeFileSync(path.join(HERE, "hm-shopify-stub.js"), "export const unauthenticated = { admin: async () => ({ admin: null }) };");
await esbuild.build({
  entryPoints: [path.join(HERE, "hm-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "hm.bundle.cjs"),
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "hm-db-stub.js") }));
    b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "hm-shopify-stub.js") }));
    b.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  }}],
});
const svc = require(path.join(HERE, "hm.bundle.cjs"));
let fail = 0;
const t = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { fail++; if (detail !== undefined) console.log("   ", detail); } };

const BASE_RAW = {
  productId: "123456",
  productTitle: "Deep Repair Hair Serum",
  productDescription: "A restorative serum for dry lengths.",
  count: 60,
  targetAverage: 4.5,
  verifiedPercent: 80,
  languages: ["en"],
  repliesPercent: 15,
  maxHelpfulVotes: 25,
  dateStart: "2025-05-01",
  dateEnd: "2026-05-01",
  structuredAttrs: true,
  humanTouch: 50,
};

// H1 — parse
{
  const { config } = svc.parseSyntheticConfig(BASE_RAW);
  t("H1a default hairProduct false", config.hairProduct === false);
  t("H1b default extraProductInfo empty", config.extraProductInfo === "");
  const on = svc.parseSyntheticConfig({ ...BASE_RAW, hairProduct: "true", extraProductInfo: "  Caffeine serum.  " });
  t("H1c string 'true' coerces", on.config.hairProduct === true);
  t("H1d extra info trimmed", on.config.extraProductInfo === "Caffeine serum.");
  const long = svc.parseSyntheticConfig({ ...BASE_RAW, extraProductInfo: "x".repeat(5000) });
  t("H1e extra info capped at 2000", long.config.extraProductInfo.length === 2000);
  const reparsed = svc.parseSyntheticConfig({ ...on.config });
  t("H1f idempotent re-parse (job runner round trip)", reparsed.config.hairProduct === true && reparsed.config.extraProductInfo === "Caffeine serum.");
}

// H2 — system prompt category
{
  const skin = svc.buildSystemPrompt("Cellexia");
  const hair = svc.buildSystemPrompt("Cellexia", true);
  t("H2a default names skincare", /anti-aging skincare storefront/.test(skin));
  t("H2b hair names hair care", /hair care storefront/.test(hair));
  t("H2c hair drops the skincare frame", !/skincare/.test(hair));
}

// H3 — user content blocks
{
  const { config } = svc.parseSyntheticConfig({ ...BASE_RAW, hairProduct: true, extraProductInfo: "Key actives: caffeine and biotin. Fullness after 6 to 8 weeks." });
  const specs = svc.buildBatchPlan(config, "hm-seed");
  const content = svc.buildUserContent(config, specs.slice(0, 8));
  t("H3a extra info block present", /Additional product info from the merchant/.test(content) && /caffeine and biotin/.test(content));
  t("H3b hair category block present", /CATEGORY: this is a HAIR product/.test(content));
  t("H3c category bans facial-skin talk", /Never describe effects on facial skin/.test(content));

  const plain = svc.parseSyntheticConfig(BASE_RAW).config;
  const plainContent = svc.buildUserContent(plain, svc.buildBatchPlan(plain, "hm-seed").slice(0, 8));
  t("H3d no extra block when empty", !/Additional product info/.test(plainContent));
  t("H3e no category block for skincare", !/CATEGORY: this is a HAIR product/.test(plainContent));

  // hair results phrasing never uses the skin wording
  t("H3f no skin results wording in hair prompt", !/firmer skin|reduced fine lines|less irritated skin|more even tone/.test(content));
}

// H4 — draw-neutral plan; attrs filtered
{
  const skin = svc.buildBatchPlan(svc.parseSyntheticConfig(BASE_RAW).config, "hm-seed");
  const hair = svc.buildBatchPlan(svc.parseSyntheticConfig({ ...BASE_RAW, hairProduct: true }).config, "hm-seed");
  t("H4a same plan length", skin.length === hair.length && skin.length === 60);
  let sameCore = true, concernsEmpty = true, resultsSafe = true, timeSame = true;
  const SAFE = new Set(["smoother", "hydration", "too_early"]);
  for (let i = 0; i < skin.length; i++) {
    const a = skin[i], b = hair[i];
    if (a.rating !== b.rating || a.language !== b.language || a.createdAt !== b.createdAt ||
        a.verified !== b.verified || a.helpfulCount !== b.helpfulCount ||
        a.personaKey !== b.personaKey || a.displayName !== b.displayName ||
        a.writing !== b.writing || a.ageRange !== b.ageRange) sameCore = false;
    if (a.timeUsing !== b.timeUsing) timeSame = false;
    if (b.skinConcerns.length !== 0) concernsEmpty = false;
    for (const k of b.resultsSeen) if (!SAFE.has(k)) resultsSafe = false;
    // hair results are the skin draw filtered, never resampled
    const filtered = a.resultsSeen.filter((k) => SAFE.has(k));
    if (JSON.stringify(filtered) !== JSON.stringify(b.resultsSeen)) resultsSafe = false;
  }
  t("H4b rng draw sequence identical (core fields match)", sameCore);
  t("H4c timeUsing identical", timeSame);
  t("H4d skin concerns emptied in hair mode", concernsEmpty);
  t("H4e results filtered to hair-safe subset of the same draw", resultsSafe);
}

// H5 — hairBrief substitution + hygiene
{
  const byKey = new Map(svc.PERSONA_BRIEFS.map((p) => [p.key, p]));
  const hair = svc.buildBatchPlan(svc.parseSyntheticConfig({ ...BASE_RAW, hairProduct: true }).config, "hm-seed");
  let subOk = true, sawHairVariant = false;
  for (const spec of hair) {
    const p = byKey.get(spec.personaKey);
    const expected = p.hairBrief ?? p.brief;
    if (spec.brief !== expected) subOk = false;
    if (p.hairBrief && spec.brief === p.hairBrief) sawHairVariant = true;
  }
  t("H5a hair specs use hairBrief when the persona has one", subOk);
  t("H5b at least one hair variant actually appears", sawHairVariant);
  const skin = svc.buildBatchPlan(svc.parseSyntheticConfig(BASE_RAW).config, "hm-seed");
  t("H5c skincare specs never use hairBrief", skin.every((s) => s.brief === byKey.get(s.personaKey).brief));
  const withVariants = svc.PERSONA_BRIEFS.filter((p) => p.hairBrief);
  t("H5d hair variants exist (>= 15 skin-locked briefs covered)", withVariants.length >= 15, withVariants.length);
  t("H5e hairBrief dash hygiene (no em/en dashes)", withVariants.every((p) => !/[—–]/.test(p.hairBrief)));
  t("H5f hairBrief never mentions skin", withVariants.every((p) => !/\bskin\b|skincare/i.test(p.hairBrief)));
}

// H6 — multi-launch plumbing
{
  const launch = svc.parseMultiLaunch({
    shared: { ...BASE_RAW, hairProduct: true, extraProductInfo: "smuggled brand text" },
    products: [
      { productId: "111", count: 10 },
      { productId: "222", count: 10, hairProduct: true, extraProductInfo: "Leave-in serum for thinning hair." },
    ],
  });
  t("H6a launch parses", launch.error === null, launch.error);
  const ctx = (id, title) => ({ id, title, handle: null, description: "", productType: null, tags: [], variants: [] });
  const c1 = svc.assembleLaunchConfig(launch.input, launch.input.rows[0], ctx("111", "Face Cream"));
  const c2 = svc.assembleLaunchConfig(launch.input, launch.input.rows[1], ctx("222", "Hair Serum"));
  t("H6b shared cannot smuggle the per-product keys", c1.config.hairProduct === false && c1.config.extraProductInfo === "");
  t("H6c row keys reach the row's config", c2.config.hairProduct === true && /thinning hair/.test(c2.config.extraProductInfo));
}

console.log("");
if (fail > 0) { console.log(`${fail} FAILURE(S)`); process.exit(1); }
console.log("ALL HAIR-MODE CASES PASS");
