// Server tests for SPEC-1.17 — against the REAL curation/ranking services.
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
  path.join(HERE, "translate-stub.js"),
  `export async function translateReviews(shop, ids, target) {
    globalThis.__fx.translateCalls.push({ ids: [...ids], target });
    const impl = globalThis.__fx.translateImpl;
    return impl ? impl(ids, target) : {};
  }`,
);
fs.writeFileSync(
  path.join(HERE, "shopify-stub.js"),
  `export const unauthenticated = { admin: async () => ({ admin: globalThis.__fx.sweepAdmin }) };`,
);
fs.writeFileSync(
  path.join(HERE, "db-stub.js"),
  `const prisma = {
    setting: {
      upsert: async (q) => { globalThis.__fx.settingWrites.push(q); return { ...globalThis.__fx.settingRow, ...(q?.update ?? {}) }; },
      findUnique: async () => globalThis.__fx.settingRow,
      update: async (q) => { globalThis.__fx.settingWrites.push(q); return { ...globalThis.__fx.settingRow, ...(q?.data ?? {}) }; },
      findMany: async () => [],
    },
    review: {
      findMany: async (q) => {
        const all = globalThis.__fx.reviews;
        if (q?.where?.id?.in) return all.filter((r) => q.where.id.in.includes(r.id));
        if (q?.where?.id?.notIn) return all.filter((r) => !q.where.id.notIn.includes(r.id)).slice(0, q?.take ?? 999);
        if (q?.where?.AND) {
          const notIn = q.where.AND.find((c) => c.id?.notIn)?.id?.notIn ?? [];
          return all.filter((r) => !notIn.includes(r.id)).slice(q?.skip ?? 0, (q?.skip ?? 0) + (q?.take ?? 999));
        }
        return all.slice(0, q?.take ?? 999);
      },
      groupBy: async () => [{
        productId: "123",
        _count: { _all: globalThis.__fx.reviews.length },
        _max: { createdAt: globalThis.__fx.reviews.reduce((m, r) => (m && m > r.createdAt ? m : r.createdAt), null) },
      }],
      count: async () => globalThis.__fx.reviews.length,
    },
    translationCache: { findMany: async (q) => {
      const targetOk = (t) => typeof q.where.target === "string" ? t.target === q.where.target : q.where.target.in.includes(t.target);
      return globalThis.__fx.translations.filter((t) => q.where.reviewId.in.includes(t.reviewId) && targetOk(t));
    } },
    productDisplayConfig: { findUnique: async () => globalThis.__fx.displayConfig },
    aiCuration: {
      upsert: async (q) => { globalThis.__fx.curationsWritten.push(q); return q.create; },
      findUnique: async (q) => globalThis.__fx.curationRows.find((r) => r.locale === q.where.shop_productId_locale.locale) ?? null,
      findMany: async () => globalThis.__fx.curationRows,
    },
  };
  export default prisma;`,
);
fs.writeFileSync(
  path.join(HERE, "entry.js"),
  `export * as cur from "${ROOT}/app/services/curation.server";
   export { CURATION_PROMPTS, curationPromptFor } from "${ROOT}/app/services/curation-prompts.server";
   export { fetchRankedPage } from "${ROOT}/app/services/ranking.server";
   export { updateSettings } from "${ROOT}/app/services/settings.server";
   export { sweepShopCurations } from "${ROOT}/app/services/curation-scheduler.server";`,
);
const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "db-stub.js") }));
    build.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "shopify-stub.js") }));
    build.onResolve({ filter: /translate\.server$/ }, () => ({ path: path.join(HERE, "translate-stub.js") }));
    build.onResolve({ filter: /^~\// }, (a) => ({ path: path.join(ROOT, "app", a.path.slice(2) + ".ts") }));
  },
};
await esbuild.build({
  entryPoints: [path.join(HERE, "entry.js")],
  bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "cur.bundle.cjs"), plugins: [stubPlugin],
});
const svc = require(path.join(HERE, "cur.bundle.cjs"));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

const REVIEWS = Array.from({ length: 8 }, (_, i) => ({
  id: `r${i + 1}`,
  rating: i % 2 === 0 ? 5 : 4,
  title: `Title ${i + 1}`,
  body: `Body of review number ${i + 1} with plenty of real detail about texture and results.`,
  language: i < 5 ? "en" : "fr",
  verified: i % 2 === 0,
  createdAt: new Date(2026, 0, i + 1),
  variantTitle: null,
  helpfulCount: 100 - i,
  media: [],
}));

function fx(over = {}) {
  globalThis.__fx = {
    settingRow: {
      shop: "s", aiProvider: "anthropic", anthropicApiKey: "sk-test",
      aiModel: "claude-sonnet-5", previewToken: "t", curationInstructions: "Focus on sensitive skin.",
      curationOverviewField: "accentuate.overview", showSummary: true, showTranslate: true,
      translationProvider: "anthropic", translationDisplay: "original", showQna: false,
    },
    reviews: REVIEWS, translations: [], displayConfig: null,
    curationsWritten: [], curationRows: [],
    translateCalls: [], translateImpl: null, sweepAdmin: null, settingWrites: [],
    ...over,
  };
}

// S1: all 17 prompts exist, carry the JSON contract, and are natively written
{
  const P = svc.CURATION_PROMPTS;
  const locales = ["en","fr","de","da","sv","fi","nl","it","es","ar","pl","pt-PT","ja","nb","ro","hu","el"];
  check("S1a all 17 locales present", locales.every((l) => typeof P[l] === "string" && P[l].length > 400));
  check("S1b contract keys everywhere", locales.every((l) => P[l].includes('"order"') && P[l].includes('"rationale"')));
  check("S1c fr is French (no English method text)", /sceptique/.test(P.fr) && !/skeptical eye/.test(P.fr));
  check("S1d ja is Japanese", /レビュー/.test(P.ja) && !/skeptical/.test(P.ja));
  check("S1e ar is Arabic", /التقييمات/.test(P.ar));
  check("S1f de is German", /skeptisch/i.test(P.de) && /Rezension/.test(P.de));
  check("S1g no em/en dashes inside any prompt", locales.every((l) => !/[—–]/.test(P[l])));
  check("S1h vote-count exclusion stated in en+fr", /helpful-vote/.test(P.en) && /votes utiles/.test(P.fr));
}

// S2: metafieldToText handles Accentuate shapes
{
  const m = svc.cur.metafieldToText;
  check("S2a plain string", m("Just text") === "Just text");
  check("S2b html stripped", m("<p>Rich <b>text</b></p>") === "Rich text");
  check("S2c quill ops", m('{"ops":[{"insert":"Line one "},{"insert":"and two"}]}') === "Line one and two");
  check("S2d nested value arrays", m('[{"value":"A"},{"value":"B"}]') === "A B");
  check("S2e junk → empty-ish", m(42) === "");
}

// S3: candidate assembly — native / translated / marked original + counts
{
  // r1..r5 are en (foreign for fr); r6..r8 are native fr. Translate r2→fr.
  fx({ translations: [{ reviewId: "r2", target: "fr", title: "Titre 2", body: "Corps traduit deux." }] });
  const { candidates, localTexts } = await svc.cur.buildCandidates("s", "123", "fr");
  const r2 = candidates.find((c) => c.id === "r2");
  const r1 = candidates.find((c) => c.id === "r1");
  const r6 = candidates.find((c) => c.id === "r6");
  check("S3a translated candidate uses cached translation", r2.textNote === "translated" && r2.body === "Corps traduit deux.");
  check("S3b untranslated foreign marked with language", r1.textNote === "en");
  check("S3c native fr stays native; localTexts = 3 native + 1 translated", r6.textNote === "native" && localTexts === 4, String(localTexts));
}

// S4: curateProductLocale — payload has no helpfulCount, order validated, stored
{
  fx();
  let payload = null;
  globalThis.fetch = async (url, init) => {
    payload = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({
          order: ["r3", "r1", "bogus", "r5", "r3"],
          rationale: "Prospects doubt absorption; these reviews answer it credibly.",
        }) }],
        stop_reason: "end_turn",
      }),
      text: async () => "",
    };
  };
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "A rich cream.", metafield: { value: "Deep overview text." } } } }) }) };
  const r = await svc.cur.curateProductLocale("s", admin, "123", "en");
  check("S4a ok with 3 valid ids (bogus + dupe dropped)", r.status === "ok" && r.ordered === 3, JSON.stringify(r));
  check("S4b helpfulCount absent from payload", !payload.messages[0].content.includes("helpfulCount"));
  check("S4c merchant guidance included", payload.messages[0].content.includes("Focus on sensitive skin."));
  check("S4d overview text included", payload.messages[0].content.includes("Deep overview text."));
  check("S4e system prompt is the English agent", /skeptical/.test(payload.system));
  const written = globalThis.__fx.curationsWritten[0];
  check("S4f stored order excludes bogus + dupes", written.create.orderedIds === JSON.stringify(["r3", "r1", "r5"]));
}

// S5: too few valid ids ⇒ failed, nothing stored
{
  fx();
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ type: "text", text: JSON.stringify({ order: ["r1", "bogus"], rationale: "x" }) }], stop_reason: "end_turn" }),
    text: async () => "",
  });
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "Cream", description: "d", metafield: null } } }) }) };
  const r = await svc.cur.curateProductLocale("s", admin, "123", "en");
  // v1.20.2: the status names WHICH failure, so the admin label can give the
  // right advice instead of "try again in a minute" for everything.
  check("S5 <3 surviving ids → ai_bad_ids, not stored", r.status === "ai_bad_ids" && globalThis.__fx.curationsWritten.length === 0, JSON.stringify(r));
}

// S6: fetchRankedPage — pins → curated → amazon_top remainder; locale fallback
{
  fx({
    curationRows: [
      { locale: "fr", orderedIds: JSON.stringify(["r4", "r2", "r6"]), rationale: "", reviewCount: 8 },
      { locale: "en", orderedIds: JSON.stringify(["r5", "r3", "r1"]), rationale: "", reviewCount: 8 },
    ],
  });
  const display = { strategy: "ai_curated", boosts: {}, pinnedIds: ["r8"] };
  const page = await svc.fetchRankedPage("s", "123", display, 1, 6, { shop: "s" }, "fr");
  check("S6a pins first, then fr curation, then rest", JSON.stringify(page.ids.slice(0, 4)) === JSON.stringify(["r8", "r4", "r2", "r6"]), JSON.stringify(page.ids));
  const pageEn = await svc.fetchRankedPage("s", "123", display, 1, 6, { shop: "s" }, "el");
  check("S6b unknown locale falls back to en curation", JSON.stringify(pageEn.ids.slice(0, 4)) === JSON.stringify(["r8", "r5", "r3", "r1"]), JSON.stringify(pageEn.ids));
  fx({ curationRows: [] });
  const none = await svc.fetchRankedPage("s", "123", { strategy: "ai_curated", boosts: {}, pinnedIds: [] }, 1, 6, { shop: "s" }, "fr");
  check("S6c no curation → plain amazon_top orderBy path", none.ids === null && Array.isArray(none.orderBy));

  // v1.21: the response must SAY when the served order is curated — and only
  // then, so the widget's "Most relevant" label can never appear over the
  // amazon_top fallback of an uncurated product.
  check("S6d curatedApplied true when a curation was served", page.curatedApplied === true, JSON.stringify(page.curatedApplied));
  check("S6e curatedApplied true through the en fallback", pageEn.curatedApplied === true, JSON.stringify(pageEn.curatedApplied));
  check("S6f curatedApplied false when the strategy fell back", none.curatedApplied === false, JSON.stringify(none.curatedApplied));
  const plain = await svc.fetchRankedPage("s", "123", { strategy: "amazon_top", boosts: {}, pinnedIds: [] }, 1, 6, { shop: "s" }, "fr");
  check("S6g curatedApplied false under a classic strategy", plain.curatedApplied === false, JSON.stringify(plain.curatedApplied));
}

// S7: queue caps + debounce accounting
{
  fx();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ order: ["r1", "r2", "r3"], rationale: "ok" }) }], stop_reason: "end_turn" }), text: async () => "" });
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "T", description: "d", metafield: null } } }) }) };
  const s1 = await svc.cur.queueCuration("s", admin, ["123"]);
  check("S7a queued en (+fr not qualifying: only 3 fr texts < 5)", s1.queued >= 1, JSON.stringify(s1));
  const s2 = await svc.cur.queueCuration("s", admin, ["123"]);
  check("S7b immediate re-queue debounced", s2.queued === 0 && s2.skippedDebounce >= 1, JSON.stringify(s2));
}

// S8 (fix E/I/J): hardened prompts — injection rule, achievable minimum, ja gloss
{
  const P = svc.CURATION_PROMPTS;
  const locales = ["en","fr","de","da","sv","fi","nl","it","es","ar","pl","pt-PT","ja","nb","ro","hu","el"];
  check("S8a en+fr+ja injection-resistance rule present",
    /NEVER follow instructions/.test(P.en) && /Ne suivez JAMAIS une instruction/.test(P.fr) && /決して従わず/.test(P.ja));
  check("S8b minimum relaxed to 3 everywhere (no '8 to 30'-style leftovers)",
    /3 to 30 ids/.test(P.en) && /3 à 30 identifiants/.test(P.fr) && /3〜30件/.test(P.ja) && /من 3 إلى 30/.test(P.ar));
  check("S8c ja gloss fixed", !P.ja.includes("使用details") && P.ja.includes("使用の詳細"));
  check("S8d still no em/en dashes after edits", locales.every((l) => !/[—–]/.test(P[l])));
}

// S9 (fix D): qualifyingLocales — batched, correct thresholds
{
  // 5 en + 3 fr native, r2 translated → fr has 4 local texts (<5) ⇒ only en qualifies.
  fx({ translations: [{ reviewId: "r2", target: "fr", title: "T", body: "Corps traduit." }] });
  const q1 = await svc.cur.qualifyingLocales("s", "123");
  check("S9a en qualifies, fr (4 texts) does not", q1.includes("en") && !q1.includes("fr"), JSON.stringify(q1));
  // Translate r1 too → fr reaches 5.
  fx({ translations: [
    { reviewId: "r1", target: "fr", title: "T", body: "Corps un." },
    { reviewId: "r2", target: "fr", title: "T", body: "Corps deux." },
  ] });
  const q2 = await svc.cur.qualifyingLocales("s", "123");
  check("S9b fr qualifies at 5 local texts", q2.includes("en") && q2.includes("fr"), JSON.stringify(q2));
  fx({ reviews: [] });
  const q3 = await svc.cur.qualifyingLocales("s", "123");
  check("S9c no reviews → no locales", q3.length === 0);
}

// S10 (fix L): missing key ⇒ aiReady false, nothing queued
{
  fx({ settingRow: { shop: "s2", aiProvider: "anthropic", anthropicApiKey: null,
    aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview" } });
  const s = await svc.cur.queueCuration("s2", { graphql: async () => { throw new Error("must not be called"); } });
  check("S10 no key → aiReady:false, queued 0", s.aiReady === false && s.queued === 0, JSON.stringify(s));
}

// S11 (fix F + regression R4): staleness = count-under-cap OR newer review than the run
{
  const many = Array.from({ length: 80 }, (_, i) => ({ ...REVIEWS[0], id: `m${i}` }));
  fx({ reviews: many, curationRows: [
    { productId: "123", locale: "en", orderedIds: JSON.stringify(["m1","m2","m3"]), rationale: "", model: "claude-sonnet-5", updatedAt: new Date(), reviewCount: 60 },
    { productId: "123", locale: "fr", orderedIds: JSON.stringify(["m1","m2","m3"]), rationale: "", model: "claude-sonnet-5", updatedAt: new Date(), reviewCount: 55 },
    { productId: "123", locale: "de", orderedIds: JSON.stringify(["m1","m2","m3"]), rationale: "", model: "claude-sonnet-5", updatedAt: new Date(2025, 5, 1), reviewCount: 60 },
  ] });
  const rows = await svc.cur.curationStatus("s");
  const en = rows.find((r) => r.locale === "en");
  const fr = rows.find((r) => r.locale === "fr");
  const de = rows.find((r) => r.locale === "de");
  // v1.20: the 60-candidate cap is gone, so the published count compares
  // directly — 80 published against a curation that saw 60 IS stale now.
  check("S11a 80 published vs 60 curated → stale (no cap to clamp to)", en.stale === true, JSON.stringify(en));
  check("S11b curated at 55 of 80 → stale", fr.stale === true, JSON.stringify(fr));
  check("S11c count matches cap but a review is NEWER than the run → stale", de.stale === true, JSON.stringify(de));
}

// S12 (regression R2): < MIN_ORDER reviews ⇒ no qualifying locales, nothing queued
{
  fx({ reviews: REVIEWS.slice(0, 2) });
  const q = await svc.cur.qualifyingLocales("s", "123");
  check("S12a 2 reviews → no locale qualifies (not even en)", q.length === 0, JSON.stringify(q));
  const s = await svc.cur.queueCuration("s", { graphql: async () => { throw new Error("must not be called"); } }, ["123"]);
  check("S12b bulk curate skips it entirely (no cap burn, no failure)", s.queued === 0 && s.aiReady === true, JSON.stringify(s));
}

// S13 (regressions R1+R3): failed run → retryable immediately + failure cleared on success
{
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return fn();
  };
  fx({ settingRow: { shop: "s4", aiProvider: "anthropic", anthropicApiKey: "sk-test",
    aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview" } });
  const admin = { graphql: async () => ({ json: async () => ({ data: { product: { title: "T", description: "d", metafield: null } } }) }) };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "not json at all" }], stop_reason: "end_turn" }), text: async () => "" });
  const q1 = await svc.cur.queueCuration("s4", admin, ["123"]);
  check("S13a failing run queued", q1.queued === 1, JSON.stringify(q1));
  const failed = await until(() => svc.cur.recentCurationFailures("s4").length > 0);
  check("S13b failure recorded and visible", failed, JSON.stringify(svc.cur.recentCurationFailures("s4")));
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ order: ["r1", "r2", "r3"], rationale: "ok now" }) }], stop_reason: "end_turn" }), text: async () => "" });
  const q2 = await svc.cur.queueCuration("s4", admin, ["123"]);
  check("S13c immediate retry after failure NOT debounced", q2.queued === 1, JSON.stringify(q2));
  const cleared = await until(() => svc.cur.recentCurationFailures("s4").length === 0);
  check("S13d success clears the recorded failure", cleared, JSON.stringify(svc.cur.recentCurationFailures("s4")));
  const q3 = await svc.cur.queueCuration("s4", admin, ["123"]);
  check("S13e re-queue after SUCCESS is debounced", q3.queued === 0 && q3.skippedDebounce === 1, JSON.stringify(q3));
}

// ---- SPEC-1.18 scenarios ----

// S14: all_translated candidate assembly — missing translations filled, fallback preserved
{
  // fr locale: r1..r5 are en (foreign), r6..r8 native fr. r2 already cached.
  fx({
    translations: [{ reviewId: "r2", target: "fr", title: "Titre 2", body: "Corps traduit deux." }],
    translateImpl: (ids, target) => {
      const out = {};
      for (const id of ids) {
        if (id === "r5") continue; // provider "fails" r5 → must fall back to marked-original
        out[id] = { title: `TR ${id}`, body: `Corps ${id} en ${target}.`, reply: null };
      }
      return out;
    },
  });
  const { candidates, localTexts } = await svc.cur.buildCandidates("s", "123", "fr", "all_translated");
  const calls = globalThis.__fx.translateCalls;
  check("S14a translate called only for MISSING foreign ids, target fr",
    calls.length === 1 && calls[0].target === "fr" &&
    JSON.stringify([...calls[0].ids].sort()) === JSON.stringify(["r1", "r3", "r4", "r5"]),
    JSON.stringify(calls));
  const r1 = candidates.find((c) => c.id === "r1");
  const r2 = candidates.find((c) => c.id === "r2");
  const r5 = candidates.find((c) => c.id === "r5");
  const r6 = candidates.find((c) => c.id === "r6");
  check("S14b newly translated candidate carries the translation", r1.textNote === "translated" && r1.body === "Corps r1 en fr.");
  check("S14c cached translation untouched (no re-billing)", r2.textNote === "translated" && r2.body === "Corps traduit deux.");
  check("S14d untranslatable review falls back to marked-original", r5.textNote === "en");
  check("S14e native stays native; localTexts counts native+translated", r6.textNote === "native" && localTexts === 7, String(localTexts));
  // as_seen must never call the translator
  fx();
  await svc.cur.buildCandidates("s", "123", "fr", "as_seen");
  check("S14f as_seen never calls translateReviews", globalThis.__fx.translateCalls.length === 0);
}

// S15: qualification matrix per mode
{
  fx();
  const asSeen = await svc.cur.qualifyingLocales("s", "123", "as_seen");
  const allTr = await svc.cur.qualifyingLocales("s", "123", "all_translated");
  check("S15a as_seen: en only (fr lacks 5 local texts)", asSeen.length === 1 && asSeen[0] === "en", JSON.stringify(asSeen));
  check("S15b all_translated: every storefront locale qualifies", allTr.length === 17 && allTr.includes("ja") && allTr.includes("ar"), String(allTr.length));
  fx({ reviews: REVIEWS.slice(0, 2) });
  const tiny = await svc.cur.qualifyingLocales("s", "123", "all_translated");
  check("S15c <3 reviews → nothing qualifies in either mode", tiny.length === 0);
}

// S16: settings whitelist sanitization
{
  fx();
  await svc.updateSettings("s", { curationSource: "all_translated", curationRefresh: "daily" });
  await svc.updateSettings("s", { curationSource: "garbage", curationRefresh: "hourly" });
  const writes = globalThis.__fx.settingWrites
    .map((w) => w?.update ?? w?.data ?? {})
    .filter((d) => "curationSource" in d || "curationRefresh" in d);
  check("S16a valid values persisted", writes.some((d) => d.curationSource === "all_translated" && d.curationRefresh === "daily"), JSON.stringify(writes));
  check("S16b invalid values dropped (never written)", !writes.some((d) => d.curationSource === "garbage" || d.curationRefresh === "hourly"), JSON.stringify(writes));
}

// S17: auto-refresh sweep — due = stale AND older than the window, pair-precise
{
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return fn();
  };
  const now = Date.now();
  const H = 60 * 60 * 1000;
  fx({
    settingRow: { shop: "s6", aiProvider: "anthropic", anthropicApiKey: "sk-test",
      aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview",
      curationSource: "as_seen", curationRefresh: "daily" },
    curationRows: [
      // stale (count 5 ≠ 8) and 25h old → DUE
      { productId: "123", locale: "en", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 5 },
      // stale but only 1h old → NOT due (window not elapsed)
      { productId: "123", locale: "fr", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 1 * H), reviewCount: 5 },
      // fresh (count matches, no newer reviews) though 25h old → NOT due
      { productId: "123", locale: "de", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 8 },
    ],
    sweepAdmin: { graphql: async () => ({ json: async () => ({ data: { product: { title: "T", description: "d", metafield: null } } }) }) },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ order: ["r1", "r2", "r3"], rationale: "refreshed" }) }], stop_reason: "end_turn" }), text: async () => "" });
  const r = await svc.sweepShopCurations("s6", now);
  check("S17a exactly the stale+old pair queued", r.queued === 1, JSON.stringify(r));
  const ran = await until(() => globalThis.__fx.curationsWritten.length > 0);
  check("S17b the queued run executed for (123, en) only",
    ran && globalThis.__fx.curationsWritten.length === 1 &&
    globalThis.__fx.curationsWritten[0].create.locale === "en",
    JSON.stringify(globalThis.__fx.curationsWritten.map((w) => w.create?.locale)));
  // manual shop: never swept
  globalThis.__fx.settingRow = { ...globalThis.__fx.settingRow, shop: "s7", curationRefresh: "manual" };
  const rManual = await svc.sweepShopCurations("s7", now);
  check("S17c manual shops untouched", rManual.queued === 0);
  // weekly window: 2 days old stale row is not due, 8 days is
  globalThis.__fx.settingRow = { ...globalThis.__fx.settingRow, shop: "s8", curationRefresh: "weekly" };
  globalThis.__fx.curationRows = [
    { productId: "123", locale: "en", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 2 * 24 * H), reviewCount: 5 },
  ];
  const rWeek2d = await svc.sweepShopCurations("s8", now);
  globalThis.__fx.curationRows[0].updatedAt = new Date(now - 8 * 24 * H);
  const rWeek8d = await svc.sweepShopCurations("s8", now);
  check("S17d weekly window respected (2d: no, 8d: yes)", rWeek2d.queued === 0 && rWeek8d.queued === 1, JSON.stringify([rWeek2d, rWeek8d]));
  // no key: skipped
  globalThis.__fx.settingRow = { ...globalThis.__fx.settingRow, shop: "s9", curationRefresh: "daily", anthropicApiKey: null };
  const rNoKey = await svc.sweepShopCurations("s9", now);
  check("S17e no key → sweep skips shop", rNoKey.queued === 0);
}

// S18 (review fixes): attempt-aware window + qualification re-check + no blind model calls
{
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
    return fn();
  };
  const now = Date.now();
  const H = 60 * 60 * 1000;
  // S18a: a pair attempted by the previous sweep (S17 ran (123,en) for shop s6)
  // must NOT be due again within the window even though updatedAt is old.
  globalThis.__fx.settingRow = { shop: "s6", aiProvider: "anthropic", anthropicApiKey: "sk-test",
    aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview",
    curationSource: "as_seen", curationRefresh: "daily" };
  globalThis.__fx.reviews = REVIEWS;
  globalThis.__fx.curationRows = [
    { productId: "123", locale: "en", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 5 },
  ];
  globalThis.__fx.curationsWritten = [];
  const again = await svc.sweepShopCurations("s6", now);
  check("S18a re-sweep within the window after an ATTEMPT queues nothing", again.queued === 0, JSON.stringify(again));

  // S18b: product dropped to 2 reviews — stale rows exist but sweep must skip (no cap burn).
  fx({
    settingRow: { shop: "s10", aiProvider: "anthropic", anthropicApiKey: "sk-test",
      aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview",
      curationSource: "as_seen", curationRefresh: "daily" },
    reviews: REVIEWS.slice(0, 2),
    curationRows: [
      { productId: "123", locale: "en", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 5 },
    ],
    sweepAdmin: { graphql: async () => { throw new Error("must not be reached"); } },
  });
  const tiny = await svc.sweepShopCurations("s10", now);
  check("S18b sweep skips products under 3 reviews entirely", tiny.queued === 0, JSON.stringify(tiny));

  // S18c: as_seen — stale fr row whose locale no longer qualifies (4 local texts) is skipped, en still runs.
  fx({
    settingRow: { shop: "s11", aiProvider: "anthropic", anthropicApiKey: "sk-test",
      aiModel: "claude-sonnet-5", curationInstructions: null, curationOverviewField: "accentuate.overview",
      curationSource: "as_seen", curationRefresh: "daily" },
    translations: [{ reviewId: "r2", target: "fr", title: "T", body: "Corps." }], // fr = 3 native + 1 translated = 4 < 5
    curationRows: [
      { productId: "123", locale: "en", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 5 },
      { productId: "123", locale: "fr", orderedIds: JSON.stringify(["r1","r2","r3"]), rationale: "", model: "m", updatedAt: new Date(now - 25 * H), reviewCount: 5 },
    ],
    sweepAdmin: { graphql: async () => ({ json: async () => ({ data: { product: { title: "T", description: "d", metafield: null } } }) }) },
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ order: ["r1", "r2", "r3"], rationale: "ok" }) }], stop_reason: "end_turn" }), text: async () => "" });
  const requal = await svc.sweepShopCurations("s11", now);
  check("S18c disqualified locale skipped, qualifying one queued", requal.queued === 1, JSON.stringify(requal));
  const wrote = await until(() => globalThis.__fx.curationsWritten.length > 0);
  check("S18d the queued run is the en pair", wrote && globalThis.__fx.curationsWritten.every((w) => w.create.locale === "en"),
    JSON.stringify(globalThis.__fx.curationsWritten.map((w) => w.create?.locale)));

  // S18e: a Shopify FAILURE and a DELETED product are different things, and
  // both must stop the run before a single model call is billed. Conflating
  // them (v1.20.0 and earlier) told merchants their products were deleted
  // when the API had merely hiccuped.
  fx();
  let modelCalled = false;
  globalThis.fetch = async () => { modelCalled = true; throw new Error("model must not be called"); };
  const deadAdmin = { graphql: async () => { throw new Error("api gone"); } };
  const rDead = await svc.cur.curateProductLocale("s", deadAdmin, "123", "en");
  check("S18e a Shopify error reports shopify_error, and no model call is made",
    rDead.status === "shopify_error" && !modelCalled, JSON.stringify(rDead));

  // The call SUCCEEDS and the product is genuinely gone.
  const goneAdmin = { graphql: async () => ({ json: async () => ({ data: { product: null } }) }) };
  const rGone = await svc.cur.curateProductLocale("s", goneAdmin, "123", "en");
  check("S18e2 a deleted product still reports no_product",
    rGone.status === "no_product" && !modelCalled, JSON.stringify(rGone));

  // An auth failure is REPORTED, never rethrown. shopify-app-remix wraps every
  // HTTP failure — 429 and 5xx included — as a thrown Response, so rethrowing
  // would let one transient throttle abort a whole catalogue run.
  const authAdmin = { graphql: async () => { throw new Response("reauth", { status: 401 }); } };
  let threw = null;
  let rAuth = null;
  try {
    rAuth = await svc.cur.curateProductLocale("s", authAdmin, "123", "en");
  } catch (e) {
    threw = e;
  }
  check("S18e3 a 401 is reported as shopify_auth and never thrown",
    threw === null && rAuth?.status === "shopify_auth", JSON.stringify({ threw: String(threw), rAuth }));

  // A throttle must NOT abort the run the way an auth failure would read.
  const throttled = { graphql: async () => { throw new Response("slow down", { status: 429 }); } };
  const rThrottle = await svc.cur.curateProductLocale("s", throttled, "123", "en");
  check("S18e3b a 429 degrades to shopify_error, so one throttle cannot kill a whole run",
    rThrottle.status === "shopify_error", JSON.stringify(rThrottle));

  // HTTP 200 carrying a GraphQL errors array is how the Admin API reports
  // THROTTLED and ACCESS_DENIED — not a deleted product.
  const gqlErr = { graphql: async () => ({ json: async () => ({ data: { product: null }, errors: [{ message: "Throttled" }] }) }) };
  const rGql = await svc.cur.curateProductLocale("s", gqlErr, "123", "en");
  check("S18e3c a GraphQL errors array is a Shopify problem, not a missing product",
    rGql.status === "shopify_error", JSON.stringify(rGql));

  // ...and when it happens in the DETACHED background pump, where nothing can
  // act on it, it is at least recorded as a Shopify problem rather than as a
  // failed AI call — otherwise the merchant is sent to check their API key.
  fx();
  globalThis.__fx.reviews = REVIEWS;
  const authFail = { graphql: async () => { throw new Response("reauth", { status: 401 }); } };
  // A shop key this file has not queued before, so the 10-minute debounce
  // cannot swallow the run.
  await svc.cur.queueCuration("s-reauth", authFail, ["123"]);
  const recorded = await until(() => svc.cur.recentCurationFailures("s-reauth").length > 0);
  const rows = svc.cur.recentCurationFailures("s-reauth");
  check("S18e4 a background re-auth failure is filed as an access problem",
    recorded && rows.some((r) => r.status === "shopify_auth"),
    JSON.stringify(rows.map((r) => r.status)));

  // S18f: all_translated with < 3 reviews never bills translations.
  fx({ reviews: REVIEWS.slice(0, 2), translateImpl: () => { throw new Error("must not translate"); } });
  const few = await svc.cur.buildCandidates("s", "123", "fr", "all_translated");
  check("S18f translate-all skips translation under MIN_ORDER", few.candidates.length === 2 && globalThis.__fx.translateCalls.length === 0);
}

console.log(failures === 0 ? "\nALL SCENARIOS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
