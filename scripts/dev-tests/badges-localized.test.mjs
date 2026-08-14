// Server tests for SPEC-1.31 §3/§4 — translated-handle badge resolution
// against the REAL badges.server.ts (db + fetch stubbed, dev-tests README
// conventions). Module-level caches persist across scenarios in this one
// process: every scenario runs under its OWN shop domain so nothing bleeds,
// and S3/S4/S5 exploit the persistence deliberately (cache scenarios).
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
  path.join(HERE, "bl-translate-stub.js"),
  `export async function translateReviews() { return {}; }`,
);
fs.writeFileSync(
  path.join(HERE, "bl-shopify-stub.js"),
  `export const unauthenticated = { admin: async () => ({ admin: null }) };`,
);
fs.writeFileSync(
  path.join(HERE, "bl-db-stub.js"),
  `const matches = (r, where) => {
    if (!where) return true;
    if (where.shop != null && r.shop !== where.shop) return false;
    if (where.status != null && r.status !== where.status) return false;
    if (where.productId != null && r.productId !== String(where.productId)) return false;
    if (where.productHandle?.in && !where.productHandle.in.includes(r.productHandle)) return false;
    return true;
  };
  const prisma = {
    review: {
      // Two groupBy shapes reach this stub: resolution step (a) groups by
      // [productHandle, productId]; computeProductStats groups by [rating].
      groupBy: async (q) => {
        const rows = globalThis.__fx.reviews.filter((r) => matches(r, q?.where));
        if (q.by.includes("productHandle")) {
          const map = new Map();
          for (const r of rows) {
            const k = r.productHandle + "::" + r.productId;
            map.set(k, (map.get(k) ?? 0) + 1);
          }
          return [...map.entries()].map(([k, n]) => {
            const [productHandle, productId] = k.split("::");
            return { productHandle, productId, _count: { _all: n } };
          });
        }
        const byRating = new Map();
        for (const r of rows) byRating.set(r.rating, (byRating.get(r.rating) ?? 0) + 1);
        return [...byRating.entries()].map(([rating, n]) => ({ rating, _count: { _all: n } }));
      },
      // The v1.8 backfill write — recorded so scenarios can assert step (c)
      // NEVER backfills Review.productHandle.
      updateMany: async (q) => { globalThis.__fx.updateManyCalls.push(q); return { count: 0 }; },
    },
    setting: { findUnique: async () => null, findMany: async () => [] },
  };
  export default prisma;`,
);
fs.writeFileSync(
  path.join(HERE, "bl-entry.js"),
  `export { badgeStatsByHandles, normalizeBadgeRoot } from "${ROOT}/app/services/badges.server";
   export { RATE_LIMITS } from "${ROOT}/app/services/ratelimit.server";`,
);
const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "bl-db-stub.js") }));
    build.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "bl-shopify-stub.js") }));
    build.onResolve({ filter: /translate\.server$/ }, () => ({ path: path.join(HERE, "bl-translate-stub.js") }));
    // .ts with a .tsx fallback (moderation.server is a .tsx — reached since
    // v1.30 via reviews.server → publish-scheduler.server).
    build.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  },
};
await esbuild.build({
  entryPoints: [path.join(HERE, "bl-entry.js")],
  bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "bl.bundle.cjs"), plugins: [stubPlugin],
});
const svc = require(path.join(HERE, "bl.bundle.cjs"));

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

function fx(over = {}) {
  globalThis.__fx = { reviews: [], updateManyCalls: [], ...over };
}
const review = (shop, productHandle, productId, rating) => ({
  shop, productHandle, productId: String(productId), rating, status: "PUBLISHED",
});

// Global fetch stub: counts calls, tracks max in-flight (each call parks on
// a setImmediate so a whole chunk overlaps), and delegates to the scenario's
// impl. Anything the scenario did not expect throws → surfaces as a FAIL.
const net = { calls: [], inits: [], inFlight: 0, maxInFlight: 0, impl: null };
globalThis.fetch = async (url, init) => {
  net.calls.push(String(url));
  net.inits.push(init ?? {});
  net.inFlight += 1;
  net.maxInFlight = Math.max(net.maxInFlight, net.inFlight);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    if (!net.impl) throw new Error("unexpected fetch: " + url);
    return await net.impl(String(url), init ?? {});
  } finally {
    net.inFlight -= 1;
  }
};
const resetNet = (impl) => {
  net.calls = []; net.inits = []; net.inFlight = 0; net.maxInFlight = 0; net.impl = impl;
};
const jsonOk = (id) => ({ status: 200, json: async () => ({ id, title: "Stubbed product" }) });
const notFound = () => ({ status: 404, json: async () => { throw new Error("no body"); } });

// Admin stub whose handle search finds nothing (a translated handle never
// matches the Admin query — that is §0.1) but counts graphql calls, so
// scenarios can prove step (b) ran before / instead of step (c).
const mkAdmin = () => {
  const calls = [];
  return { calls, graphql: async (q) => { calls.push(q); return { json: async () => ({ data: {} }) }; } };
};

// S1 — translated handles + valid root resolve via the storefront; the badge
// is keyed by the REQUESTED handle and the canonical path is untouched.
// 8 handles also prove the ≤6-in-flight chunking (SPEC-1.31 §3).
{
  const shop = "s1.myshopify.com";
  fx({ reviews: Array.from({ length: 8 }, (_, i) => review(shop, `c${i + 1}`, 100 + i + 1, 5)) });
  resetNet((url) => {
    const m = url.match(/^https:\/\/s1\.myshopify\.com\/fr\/products\/t([1-8])\.js$/);
    if (!m) throw new Error("unexpected URL " + url);
    return jsonOk(100 + Number(m[1]));
  });
  const admin = mkAdmin();
  const handles = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
  const badges = await svc.badgeStatsByHandles(shop, admin, handles, "/fr/");
  check("S1a all 8 badges keyed by the requested translated handle",
    handles.every((h) => badges[h]?.average === 5 && badges[h]?.count === 1),
    JSON.stringify(badges));
  check("S1b one storefront fetch per unresolved handle", net.calls.length === 8, String(net.calls.length));
  check("S1c at most 6 fetches in flight (chunked)", net.maxInFlight === 6, String(net.maxInFlight));
  check("S1d admin lookup ran once first and found nothing", admin.calls.length === 1, String(admin.calls.length));
  check("S1e step (c) never backfills Review.productHandle",
    globalThis.__fx.updateManyCalls.length === 0, String(globalThis.__fx.updateManyCalls.length));
  check("S1f every fetch carries an abort signal and MANUAL redirect mode",
    net.inits.every((i) => i.signal instanceof AbortSignal && i.redirect === "manual"));
}

// S2 — mixed batch: canonical (DB row), translated (storefront), unknown
// (storefront 404) → exactly the first two answer; the canonical handle
// never hits the storefront.
{
  const shop = "s2.myshopify.com";
  fx({ reviews: [
    review(shop, "night-cream", 201, 5),
    review(shop, "night-cream", 201, 4),
    review(shop, "night-repair", 202, 5),
  ] });
  resetNet((url) => {
    if (url === "https://s2.myshopify.com/fr/products/creme-de-nuit.js") return jsonOk(202);
    if (url === "https://s2.myshopify.com/fr/products/creme-inconnue.js") return notFound();
    throw new Error("unexpected URL " + url);
  });
  const admin = mkAdmin();
  const badges = await svc.badgeStatsByHandles(
    shop, admin, ["night-cream", "creme-de-nuit", "creme-inconnue"], "/fr/");
  check("S2a exactly the resolvable two handles answer",
    Object.keys(badges).sort().join(",") === "creme-de-nuit,night-cream", JSON.stringify(badges));
  check("S2b canonical stats come from the DB row", badges["night-cream"]?.average === 4.5 && badges["night-cream"]?.count === 2,
    JSON.stringify(badges["night-cream"]));
  check("S2c translated handle resolves to the OTHER product's stats",
    badges["creme-de-nuit"]?.average === 5 && badges["creme-de-nuit"]?.count === 1,
    JSON.stringify(badges["creme-de-nuit"]));
  check("S2d only the two DB-unresolved handles hit the storefront", net.calls.length === 2, net.calls.join(" "));
}

// S3 — positive cache: the second identical call performs ZERO storefront
// fetches (root-scoped handleCache entry persists across calls by design).
{
  const shop = "s3.myshopify.com";
  fx({ reviews: [review(shop, "hidden-canonical", 301, 5)] });
  resetNet((url) => {
    if (url === "https://s3.myshopify.com/fr/products/creme-cachee.js") return jsonOk(301);
    throw new Error("unexpected URL " + url);
  });
  const first = await svc.badgeStatsByHandles(shop, null, ["creme-cachee"], "/fr/");
  const afterFirst = net.calls.length;
  const second = await svc.badgeStatsByHandles(shop, null, ["creme-cachee"], "/fr/");
  check("S3a first call fetches once and answers", afterFirst === 1 && first["creme-cachee"]?.count === 1,
    `${afterFirst} ${JSON.stringify(first)}`);
  check("S3b second identical call: zero storefront fetches, same badge",
    net.calls.length === 1 && second["creme-cachee"]?.average === 5, `${net.calls.length} ${JSON.stringify(second)}`);
}

// S4 — negative cache: a 404 handle re-requested within the 10 min TTL is
// still omitted, with zero new fetches.
{
  const shop = "s4.myshopify.com";
  fx();
  resetNet((url) => {
    if (url === "https://s4.myshopify.com/fr/products/fantome.js") return notFound();
    throw new Error("unexpected URL " + url);
  });
  const first = await svc.badgeStatsByHandles(shop, null, ["fantome"], "/fr/");
  const afterFirst = net.calls.length;
  const second = await svc.badgeStatsByHandles(shop, null, ["fantome"], "/fr/");
  check("S4a 404 → omitted after one fetch", afterFirst === 1 && Object.keys(first).length === 0,
    `${afterFirst} ${JSON.stringify(first)}`);
  check("S4b re-request within TTL: zero new fetches, still omitted",
    net.calls.length === 1 && Object.keys(second).length === 0, `${net.calls.length} ${JSON.stringify(second)}`);
}

// S5 — root-scope isolation: the SAME slug under /fr/ and /de/ maps to two
// different products; neither call may reuse the other's cache entry.
{
  const shop = "s5.myshopify.com";
  fx({ reviews: [
    review(shop, "fr-canonical", 501, 5),
    review(shop, "de-canonical", 502, 3),
    review(shop, "de-canonical", 502, 3),
  ] });
  resetNet((url) => {
    if (url === "https://s5.myshopify.com/fr/products/crema.js") return jsonOk(501);
    if (url === "https://s5.myshopify.com/de/products/crema.js") return jsonOk(502);
    throw new Error("unexpected URL " + url);
  });
  const fr = await svc.badgeStatsByHandles(shop, null, ["crema"], "/fr/");
  const afterFr = net.calls.length;
  const de = await svc.badgeStatsByHandles(shop, null, ["crema"], "/de/");
  const afterDe = net.calls.length;
  const frAgain = await svc.badgeStatsByHandles(shop, null, ["crema"], "/fr/");
  check("S5a /fr/ resolves its own product", fr["crema"]?.average === 5 && fr["crema"]?.count === 1 && afterFr === 1,
    `${afterFr} ${JSON.stringify(fr)}`);
  check("S5b /de/ fetches FRESH (no bleed from the /fr/ entry)",
    de["crema"]?.average === 3 && de["crema"]?.count === 2 && afterDe === 2, `${afterDe} ${JSON.stringify(de)}`);
  check("S5c repeat /fr/ call hits the root-scoped cache, zero fetches",
    frAgain["crema"]?.average === 5 && net.calls.length === 2, `${net.calls.length} ${JSON.stringify(frAgain)}`);
}

// S6 — Admin client null + translated handle: the storefront path still
// resolves (the offline admin client being unavailable must not kill badges
// on localized pages).
{
  const shop = "s6.myshopify.com";
  fx({ reviews: [review(shop, "hair-serum", 601, 4)] });
  resetNet((url) => {
    if (url === "https://s6.myshopify.com/pt-br/products/serum-capilar.js") return jsonOk(601);
    throw new Error("unexpected URL " + url);
  });
  const badges = await svc.badgeStatsByHandles(shop, null, ["serum-capilar"], "/pt-br/");
  check("S6a storefront path resolves without an admin client",
    badges["serum-capilar"]?.average === 4 && badges["serum-capilar"]?.count === 1, JSON.stringify(badges));
  check("S6b exactly one fetch, under the /pt-br/ root",
    net.calls.length === 1 && net.calls[0] === "https://s6.myshopify.com/pt-br/products/serum-capilar.js",
    net.calls.join(" "));
}

// S7 — abort/timeout and a non-JSON body both degrade to omission; the
// function must not throw (it only throws on DB errors).
{
  const shop = "s7.myshopify.com";
  fx();
  resetNet((url) => {
    if (url.endsWith("/abort-moi.js")) {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    if (url.endsWith("/pas-json.js")) {
      return { status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    }
    throw new Error("unexpected URL " + url);
  });
  let badges = null;
  let threw = null;
  try {
    badges = await svc.badgeStatsByHandles(shop, null, ["abort-moi", "pas-json"], "/fr/");
  } catch (error) {
    threw = error;
  }
  check("S7a abort + non-JSON: no throw, both handles omitted",
    threw === null && badges !== null && Object.keys(badges).length === 0,
    threw ? String(threw) : JSON.stringify(badges));
  check("S7b both lookups were attempted once", net.calls.length === 2, net.calls.join(" "));
}

// S8 — the exported route normalizer (SPEC-1.31 §2): trim, strip slashes,
// lowercase; only a bare locale segment survives.
{
  const good = [
    ["fr", "/fr/"], ["/fr/", "/fr/"], ["pt-br", "/pt-br/"],
    [" de ", "/de/"], ["FR", "/fr/"], ["deu", "/deu/"],
  ];
  const bad = ["FR/..", "evil.com", "fr%2Fx", "french", "fr-toolong", "f", "", "  ", "/", null];
  check("S8a valid roots normalize to the /fr/ shape",
    good.every(([raw, want]) => svc.normalizeBadgeRoot(raw) === want),
    JSON.stringify(good.map(([raw]) => svc.normalizeBadgeRoot(raw))));
  check("S8b junk, traversal and encoded slashes all → null",
    bad.every((raw) => svc.normalizeBadgeRoot(raw) === null),
    JSON.stringify(bad.map((raw) => svc.normalizeBadgeRoot(raw))));
}

// S9 — manual redirect policy (review hardening): Shopify's myshopify→
// primary-domain hop (same https path) is followed; anything else — IP
// literal, changed path, http, or a hop chain past the cap — is rejected
// and the handle degrades to omission.
{
  const shop = "s9.myshopify.com";
  fx({ reviews: [review(shop, "s9-canonical", 901, 5)] });
  const redirect = (loc) => ({
    status: 301,
    headers: { get: (k) => (k.toLowerCase() === "location" ? loc : null) },
    json: async () => { throw new Error("redirect has no body"); },
  });
  resetNet((url) => {
    if (url === "https://s9.myshopify.com/fr/products/legit.js")
      return redirect("https://shop.example.com/fr/products/legit.js");
    if (url === "https://shop.example.com/fr/products/legit.js") return jsonOk(901);
    if (url === "https://s9.myshopify.com/fr/products/vers-ip.js")
      return redirect("https://169.254.169.254/fr/products/vers-ip.js");
    if (url === "https://s9.myshopify.com/fr/products/autre-chemin.js")
      return redirect("https://shop.example.com/latest/meta-data");
    if (url === "https://s9.myshopify.com/fr/products/vers-http.js")
      return redirect("http://shop.example.com/fr/products/vers-http.js");
    if (url.endsWith("/boucle.js")) return redirect(url); // self-loop, every hop
    throw new Error("unexpected URL " + url);
  });
  const badges = await svc.badgeStatsByHandles(
    shop, null, ["legit", "vers-ip", "autre-chemin", "vers-http", "boucle"], "/fr/");
  check("S9a same-path https primary-domain hop is followed and resolves",
    badges["legit"]?.average === 5 && badges["legit"]?.count === 1, JSON.stringify(badges));
  check("S9b IP-literal, changed-path and http redirects are all rejected",
    !("vers-ip" in badges) && !("autre-chemin" in badges) && !("vers-http" in badges),
    JSON.stringify(badges));
  check("S9c rejected redirects stop at the first hop (no fetch to the bad target)",
    !net.calls.some((u) => u.includes("169.254") || u.includes("meta-data") || u.startsWith("http://")),
    net.calls.join(" "));
  check("S9d a redirect loop gives up after the hop cap (1 + 2 follows)",
    net.calls.filter((u) => u.endsWith("/boucle.js")).length === 3, net.calls.join(" "));
}

// S10 — per-request FRESH-lookup cap (review hardening): 20 unknown handles
// → exactly 16 storefront fetches; the re-request fetches only the 4-handle
// tail (the 16 are negative-cached).
{
  const shop = "s10.myshopify.com";
  fx();
  resetNet((url) => {
    if (/^https:\/\/s10\.myshopify\.com\/fr\/products\/u([0-9]|1[0-9])\.js$/.test(url)) return notFound();
    throw new Error("unexpected URL " + url);
  });
  const handles = Array.from({ length: 20 }, (_, i) => `u${i}`);
  const first = await svc.badgeStatsByHandles(shop, null, handles, "/fr/");
  const afterFirst = net.calls.length;
  const second = await svc.badgeStatsByHandles(shop, null, handles, "/fr/");
  check("S10a first call caps fresh storefront lookups at 16",
    afterFirst === 16 && Object.keys(first).length === 0, String(afterFirst));
  check("S10b second call fetches ONLY the uncapped 4-handle tail",
    net.calls.length === 20 && Object.keys(second).length === 0, String(net.calls.length));
}

// S11 — process-wide in-flight ceiling (review hardening): three concurrent
// 6-handle requests against a parked storefront → at most 12 fetches in
// flight; the saturated request's handles are SKIPPED and NOT negative-
// cached (they fetch normally on a later call), while fetched misses ARE.
{
  const shop = "s11.myshopify.com";
  fx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resetNet(async () => { await gate; return notFound(); });
  const mk = (prefix) => Array.from({ length: 6 }, (_, i) => `${prefix}${i}`);
  const pAll = Promise.all([
    svc.badgeStatsByHandles(shop, null, mk("aa-"), "/fr/"),
    svc.badgeStatsByHandles(shop, null, mk("bb-"), "/fr/"),
    svc.badgeStatsByHandles(shop, null, mk("cc-"), "/fr/"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let all three reach step (c)
  const parked = net.calls.length;
  const parkedMax = net.maxInFlight;
  release();
  await pAll;
  check("S11a the global ceiling holds: exactly 12 fetches in flight, 6 skipped",
    parked === 12 && parkedMax === 12, `calls=${parked} max=${parkedMax}`);
  resetNet(() => notFound());
  await svc.badgeStatsByHandles(shop, null, mk("cc-"), "/fr/");
  const ccRefetch = net.calls.length;
  await svc.badgeStatsByHandles(shop, null, mk("aa-"), "/fr/");
  check("S11b skipped handles were NOT negative-cached (they fetch later) while fetched misses were",
    ccRefetch === 6 && net.calls.length === 6, `cc=${ccRefetch} total=${net.calls.length}`);
}

// S12 — the badges rate bucket must stay sized for its SHARED-key reality
// (SPEC-1.31 §5): getClientIp's last-hop value collapses to proxy-egress IPs
// behind CDN+Shopify+host, so a "per-visitor" sub-1200 cap silently starves
// real shoppers at peak. Pin the floor so a refactor cannot quietly regress.
{
  check("S12a badges rate bucket ≥ 2400/h (shared proxy-egress buckets)",
    svc.RATE_LIMITS.badges.max >= 2400 && svc.RATE_LIMITS.badges.windowMs === 3600000,
    JSON.stringify(svc.RATE_LIMITS.badges));
}

console.log(failures === 0 ? `\nALL ${checks} PASS` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
