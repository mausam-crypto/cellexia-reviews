// Server tests for SPEC-1.32 §2/§3 — the Badge doctor step logic and the
// badgeStatsByHandles trace hook, against the REAL badge-doctor.server.ts +
// badges.server.ts (db + fetch stubbed, dev-tests README conventions).
// Module-level caches persist across scenarios in this one process: every
// scenario runs under its OWN shop domain so nothing bleeds, and D2 exploits
// the persistence deliberately (cache/negative-cache trace paths).
// Stub files use bd2-* names — the bd-* names belong to brand-diversity.
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
  path.join(HERE, "bd2-translate-stub.js"),
  `export async function translateReviews() { return {}; }`,
);
fs.writeFileSync(
  path.join(HERE, "bd2-shopify-stub.js"),
  `export const unauthenticated = { admin: async () => ({ admin: null }) };`,
);
fs.writeFileSync(
  path.join(HERE, "bd2-db-stub.js"),
  `const matches = (r, where) => {
    if (!where) return true;
    if (where.shop != null && r.shop !== where.shop) return false;
    if (where.status != null && r.status !== where.status) return false;
    if (where.productId != null) {
      if (typeof where.productId === "object") {
        if (where.productId.in && !where.productId.in.map(String).includes(r.productId)) return false;
      } else if (r.productId !== String(where.productId)) return false;
    }
    if (where.productHandle?.in && !where.productHandle.in.includes(r.productHandle)) return false;
    return true;
  };
  const prisma = {
    review: {
      // Generic groupBy: badge resolution groups by [productHandle, productId],
      // computeProductStats by [rating], the doctor's step 2 by
      // [productId, productHandle, status] and step 1 by [productId].
      groupBy: async (q) => {
        const rows = globalThis.__fx.reviews.filter((r) => matches(r, q?.where));
        const map = new Map();
        for (const r of rows) {
          const key = q.by.map((f) => JSON.stringify(r[f] ?? null)).join("|");
          const cur = map.get(key);
          if (cur) cur._count._all += 1;
          else {
            const o = { _count: { _all: 1 } };
            for (const f of q.by) o[f] = r[f] ?? null;
            map.set(key, o);
          }
        }
        return [...map.values()];
      },
      findMany: async (q) => {
        let rows = globalThis.__fx.reviews.filter((r) => matches(r, q?.where));
        if (q?.orderBy?.createdAt === "desc") {
          rows = [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        }
        if (q?.distinct) {
          const seen = new Set();
          rows = rows.filter((r) => {
            const k = q.distinct.map((f) => r[f]).join("|");
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        if (q?.select) {
          rows = rows.map((r) => {
            const o = {};
            for (const k of Object.keys(q.select)) if (q.select[k]) o[k] = r[k] ?? null;
            return o;
          });
        }
        return rows;
      },
      findFirst: async (q) => (await prisma.review.findMany(q))[0] ?? null,
      // The v1.8 backfill write — recorded so scenarios can prove nothing
      // beyond the known step (b) backfill happens.
      updateMany: async (q) => { globalThis.__fx.updateManyCalls.push(q); return { count: 0 }; },
    },
    setting: {
      upsert: async () => globalThis.__fx.setting,
      update: async () => globalThis.__fx.setting,
      findUnique: async () => globalThis.__fx.setting ?? null,
      findMany: async () => [],
    },
  };
  export default prisma;`,
);
fs.writeFileSync(
  path.join(HERE, "bd2-entry.js"),
  `export { badgeStatsByHandles, normalizeBadgeRoot } from "${ROOT}/app/services/badges.server";
   export {
     apiDryRunWithTrace,
     badgePreviewStep,
     reviewDataStep,
     liveGatingStep,
     rateLimitStep,
     deployedExtensionCheck,
   } from "${ROOT}/app/services/badge-doctor.server";
   export { RATE_LIMITS } from "${ROOT}/app/services/ratelimit.server";`,
);
const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "bd2-db-stub.js") }));
    build.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "bd2-shopify-stub.js") }));
    build.onResolve({ filter: /translate\.server$/ }, () => ({ path: path.join(HERE, "bd2-translate-stub.js") }));
    // .ts with a .tsx fallback (moderation.server is a .tsx — reached since
    // v1.30 via reviews.server → publish-scheduler.server).
    build.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  },
};
await esbuild.build({
  entryPoints: [path.join(HERE, "bd2-entry.js")],
  bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "bd2.bundle.cjs"), plugins: [stubPlugin],
});
const svc = require(path.join(HERE, "bd2.bundle.cjs"));

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

function fx(over = {}) {
  globalThis.__fx = {
    reviews: [],
    updateManyCalls: [],
    setting: { isLive: true, liveScope: "all", liveMarkets: "[]", previewToken: "tok" },
    ...over,
  };
}
const review = (shop, productHandle, productId, rating, status = "PUBLISHED") => ({
  shop, productHandle, productId: String(productId), rating, status,
});

// Global fetch stub (badges-localized pattern): counts calls, delegates to
// the scenario's impl; anything unexpected throws → surfaces as a FAIL.
const net = { calls: [], inFlight: 0, maxInFlight: 0, impl: null };
globalThis.fetch = async (url, init) => {
  net.calls.push(String(url));
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
  net.calls = []; net.inFlight = 0; net.maxInFlight = 0; net.impl = impl;
};
const jsonOk = (id) => ({ status: 200, json: async () => ({ id, title: "Stubbed product" }) });
const notFound = () => ({ status: 404, json: async () => { throw new Error("no body"); } });
const pageOk = (body, url) => ({
  status: 200, url, text: async () => body, json: async () => JSON.parse(body),
});

// Admin stub: parses resolveProducts' aliased handle-search query and answers
// from a handle→{id,title} map, counting graphql calls.
const mkAdmin = (products = {}) => {
  const calls = [];
  return {
    calls,
    graphql: async (q) => {
      calls.push(q);
      const data = {};
      const re = /(h\d+): products\(first: 1, query: "handle:\\"([^"\\]+)\\""\)/g;
      let m;
      while ((m = re.exec(q))) {
        const hit = products[m[2]];
        data[m[1]] = {
          nodes: hit
            ? [{ id: `gid://shopify/Product/${hit.id}`, title: hit.title ?? "P", handle: m[2] }]
            : [],
        };
      }
      return { json: async () => ({ data }) };
    },
  };
};

const pathOf = (dryRun, handle) => {
  const entry = dryRun.handles.find((h) => h.handle === handle);
  return entry ? entry.path.join(">") : "(missing)";
};

// D1 — apiDryRunWithTrace over a mixed batch under /fr/: one handle per
// resolution branch — DB row, Admin API, storefront JSON, unresolved — plus
// an invalid token. Trace labels + badges + the exact response JSON.
{
  const shop = "d1.myshopify.com";
  fx({ reviews: [
    review(shop, "db-hit", 101, 5),
    review(shop, null, 102, 4),
    review(shop, "sf-canonical", 103, 5),
    review(shop, "sf-canonical", 103, 4),
  ] });
  resetNet((url) => {
    if (url === "https://d1.myshopify.com/fr/products/sf-hit.js") return jsonOk(103);
    if (url === "https://d1.myshopify.com/fr/products/ghost.js") return notFound();
    throw new Error("unexpected URL " + url);
  });
  const admin = mkAdmin({ "admin-hit": { id: 102, title: "Admin product" } });
  const dryRun = await svc.apiDryRunWithTrace(
    shop, admin, "db-hit, sf-hit admin-hit\nghost, Bad_Handle!", "fr");
  check("D1a DB-row handle traces review-rows",
    pathOf(dryRun, "db-hit") === "review-rows", pathOf(dryRun, "db-hit"));
  check("D1b Admin-resolved handle traces admin-api",
    pathOf(dryRun, "admin-hit") === "admin-api", pathOf(dryRun, "admin-hit"));
  check("D1c storefront-resolved handle traces storefront-json",
    pathOf(dryRun, "sf-hit") === "storefront-json", pathOf(dryRun, "sf-hit"));
  check("D1d unknown handle traces unresolved",
    pathOf(dryRun, "ghost") === "unresolved", pathOf(dryRun, "ghost"));
  check("D1e invalid token flagged, never sent through resolution",
    dryRun.handles.find((h) => h.handle === "bad_handle!")?.invalid === true &&
      pathOf(dryRun, "bad_handle!") === "",
    JSON.stringify(dryRun.handles.find((h) => h.handle === "bad_handle!")));
  const body = JSON.parse(dryRun.responseJson);
  check("D1f exact response JSON carries the three resolvable badges",
    Object.keys(body.badges).sort().join(",") === "admin-hit,db-hit,sf-hit" &&
      body.badges["db-hit"].average === 5 && body.badges["admin-hit"].count === 1 &&
      body.badges["sf-hit"].average === 4.5 && body.badges["sf-hit"].count === 2,
    dryRun.responseJson);
  check("D1g only the two DB/Admin-unresolved handles hit the storefront",
    net.calls.length === 2, net.calls.join(" "));
  check("D1h root normalized and partial answers rate a WARN",
    dryRun.root === "/fr/" && dryRun.result.status === "warn",
    `${dryRun.root} ${dryRun.result.status}`);
}

// D2 — the SAME shop again: positive hits trace "cache", the 404 handle
// traces "negative-cache" then "unresolved", zero storefront fetches.
{
  const shop = "d1.myshopify.com";
  fx({ reviews: [
    review(shop, "db-hit", 101, 5),
    review(shop, null, 102, 4),
    review(shop, "sf-canonical", 103, 5),
    review(shop, "sf-canonical", 103, 4),
  ] });
  resetNet(() => { throw new Error("no fetch expected"); });
  const dryRun = await svc.apiDryRunWithTrace(
    shop, mkAdmin(), "db-hit, sf-hit, admin-hit, ghost", "fr");
  check("D2a all three resolved handles trace cache",
    pathOf(dryRun, "db-hit") === "cache" && pathOf(dryRun, "admin-hit") === "cache" &&
      pathOf(dryRun, "sf-hit") === "cache",
    dryRun.handles.map((h) => `${h.handle}:${h.path}`).join(" "));
  check("D2b negative-cached handle traces negative-cache then unresolved",
    pathOf(dryRun, "ghost") === "negative-cache>unresolved", pathOf(dryRun, "ghost"));
  check("D2c zero storefront fetches on the cached run", net.calls.length === 0,
    net.calls.join(" "));
}

// D3 — per-request fresh cap: 18 unknown handles under /fr/ → 16 fetch (and
// end unresolved), the 2-handle tail traces storefront-skipped.
{
  const shop = "d3.myshopify.com";
  fx();
  resetNet(() => notFound());
  const paths = new Map();
  const handles = Array.from({ length: 18 }, (_, i) => `u${i}`);
  await svc.badgeStatsByHandles(shop, null, handles, "/fr/", (h, s) => {
    paths.set(h, [...(paths.get(h) ?? []), s]);
  });
  check("D3a exactly 16 fresh storefront lookups ran", net.calls.length === 16,
    String(net.calls.length));
  check("D3b fetched misses trace plain unresolved",
    handles.slice(0, 16).every((h) => (paths.get(h) ?? []).join(">") === "unresolved"),
    JSON.stringify([...paths]));
  check("D3c the capped tail traces storefront-skipped then unresolved",
    handles.slice(16).every((h) => (paths.get(h) ?? []).join(">") === "storefront-skipped>unresolved"),
    JSON.stringify(handles.slice(16).map((h) => paths.get(h))));
}

// D4 — process-wide in-flight ceiling: three concurrent 6-handle requests
// against a parked storefront — the saturated third request's handles trace
// storefront-skipped (S11's setup, now observed through the hook).
{
  const shop = "d4.myshopify.com";
  fx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resetNet(async () => { await gate; return notFound(); });
  const mk = (prefix) => Array.from({ length: 6 }, (_, i) => `${prefix}${i}`);
  const trace = (map) => (h, s) => { map.set(h, [...(map.get(h) ?? []), s]); };
  const [pa, pb, pc] = [new Map(), new Map(), new Map()];
  const pAll = Promise.all([
    svc.badgeStatsByHandles(shop, null, mk("aa-"), "/fr/", trace(pa)),
    svc.badgeStatsByHandles(shop, null, mk("bb-"), "/fr/", trace(pb)),
    svc.badgeStatsByHandles(shop, null, mk("cc-"), "/fr/", trace(pc)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let all three reach step (c)
  const parked = net.calls.length;
  release();
  await pAll;
  check("D4a the global ceiling still holds with tracing on (12 fetches)",
    parked === 12 && net.maxInFlight === 12, `calls=${parked} max=${net.maxInFlight}`);
  check("D4b ceiling-skipped handles trace storefront-skipped then unresolved",
    mk("cc-").every((h) => (pc.get(h) ?? []).join(">") === "storefront-skipped>unresolved"),
    JSON.stringify([...pc]));
  check("D4c fetched requests trace plain unresolved",
    [...mk("aa-").map((h) => pa.get(h)), ...mk("bb-").map((h) => pb.get(h))]
      .every((p) => (p ?? []).join(">") === "unresolved"),
    JSON.stringify([[...pa], [...pb]]));
}

// D5 — reviewDataStep: aggregates per product (published/total/average via
// computeProductStats, observed handles incl. translated aliases) and FLAGS
// the reviews-but-zero-published case as the step's FAIL.
{
  const shop = "d5.myshopify.com";
  fx({ reviews: [
    review(shop, "night-cream", 201, 5),
    review(shop, "night-cream", 201, 4),
    review(shop, "creme-de-nuit", 201, 5),
    review(shop, "hidden", 202, 3, "PENDING"),
  ] });
  const { result, rows } = await svc.reviewDataStep(shop);
  const p201 = rows.find((r) => r.productId === "201");
  const p202 = rows.find((r) => r.productId === "202");
  check("D5a per-product aggregation: counts, computeProductStats average, handles",
    p201 && p201.totalCount === 3 && p201.publishedCount === 3 && p201.average === 4.7 &&
      p201.handles.join(",") === "creme-de-nuit,night-cream" && p201.zeroPublished === false,
    JSON.stringify(p201));
  check("D5b zero-published product flagged on its row",
    p202 && p202.totalCount === 1 && p202.publishedCount === 0 && p202.zeroPublished === true,
    JSON.stringify(p202));
  check("D5c the step verdict is FAIL naming the zero-published case",
    result.status === "fail" && result.detail.includes("PUBLISHED"),
    JSON.stringify(result));
  check("D5d rows sorted most-published first", rows[0]?.productId === "201",
    JSON.stringify(rows.map((r) => r.productId)));
}

// D6 — badgePreviewStep: real data from the TOP-reviewed product; canned
// sample (WARN) when the shop has no published reviews.
{
  const shop = "d6.myshopify.com";
  fx({ reviews: [
    review(shop, "top-cream", 301, 5),
    review(shop, "top-cream", 301, 4),
    review(shop, "other", 302, 3),
  ] });
  const { result, preview } = await svc.badgePreviewStep(shop);
  check("D6a top-reviewed product picked with computeProductStats numbers",
    result.status === "pass" && preview.productId === "301" &&
      preview.average === 4.5 && preview.count === 2 && preview.sample === false,
    JSON.stringify(preview));
  fx();
  const empty = await svc.badgePreviewStep("d6-empty.myshopify.com");
  check("D6b no published reviews → WARN with sample numbers",
    empty.result.status === "warn" && empty.preview.sample === true &&
      empty.preview.average === 4.8 && empty.preview.count === 132,
    JSON.stringify(empty.preview));
}

// D7 — liveGatingStep: PASS when live (markets listed under scoped rollout),
// WARN with the Dashboard "Go live" remedy when not.
{
  fx({ setting: { isLive: true, liveScope: "all", liveMarkets: "[]", previewToken: "t" } });
  const live = await svc.liveGatingStep("d7.myshopify.com");
  fx({ setting: { isLive: true, liveScope: "markets", liveMarkets: '["fr","de"]', previewToken: "t" } });
  const scoped = await svc.liveGatingStep("d7.myshopify.com");
  fx({ setting: { isLive: false, liveScope: "all", liveMarkets: "[]", previewToken: "t" } });
  const offline = await svc.liveGatingStep("d7.myshopify.com");
  check("D7a live in all markets → PASS",
    live.result.status === "pass" && live.gating.isLive === true &&
      live.gating.liveScope === "all",
    JSON.stringify(live));
  check("D7b market-scoped live lists the markets",
    scoped.result.status === "pass" && scoped.gating.liveMarkets.join(",") === "fr,de" &&
      scoped.result.detail.includes("fr, de"),
    JSON.stringify(scoped));
  check("D7c not live → WARN naming the 403-by-design and the Go live toggle",
    offline.result.status === "warn" && offline.result.detail.includes("403") &&
      (offline.result.remedy ?? "").includes("Go live"),
    JSON.stringify(offline.result));
}

// D8 — rateLimitStep: numbers come from RATE_LIMITS (never hardcoded), the
// env var is reported name-only (its VALUE never echoed), unset → WARN.
{
  const saved = process.env.CELLEXIA_CLIENT_IP_HEADER;
  process.env.CELLEXIA_CLIENT_IP_HEADER = "true-client-ip";
  const withHeader = svc.rateLimitStep();
  delete process.env.CELLEXIA_CLIENT_IP_HEADER;
  const without = svc.rateLimitStep();
  if (saved !== undefined) process.env.CELLEXIA_CLIENT_IP_HEADER = saved;
  check("D8a bucket rendered from RATE_LIMITS and ≥ the §4b floor",
    withHeader.limits.max === svc.RATE_LIMITS.badges.max &&
      withHeader.limits.windowMs === svc.RATE_LIMITS.badges.windowMs &&
      withHeader.limits.max >= 2400 &&
      withHeader.result.detail.includes(String(svc.RATE_LIMITS.badges.max)),
    JSON.stringify(withHeader.limits));
  check("D8b header set → PASS, and the VALUE is never echoed",
    withHeader.result.status === "pass" && withHeader.limits.ipHeaderSet === true &&
      !JSON.stringify(withHeader).includes("true-client-ip"),
    JSON.stringify(withHeader.result));
  check("D8c header unset → WARN, name-only mention",
    without.result.status === "warn" && without.limits.ipHeaderSet === false &&
      without.result.detail.includes("CELLEXIA_CLIENT_IP_HEADER"),
    JSON.stringify(without.result));
}

// D9 — deployedExtensionCheck verdicts from stubbed storefront HTML
// (SPEC-1.32 §3): marker → PASS; no marker → FAIL redeploy; no config →
// FAIL embed-disabled; fetch error → FAIL network; password page → FAIL.
// Never throws.
const embedHtml = (markerJs) => `<html><head>
<script src="https://cdn.shopify.com/extensions/0f0e0d0c-1234-5678-9abc-def012345678/cellexia-reviews-29/assets/cellexia-reviews.js" defer></script>
<script type="application/json" id="cx-embed-config">
{"pageType":"home","proxy":"/apps/cellexia-reviews/api","settings":{"enable_product_widget":true,"placement_selector":"","enable_badges":true,"badge_style":"stars_count","badge_selector":"","show_pdp_title_badge":true,"pdp_badge_position":"under_title","card_badge_position":"inherit","cart_badges":null,"pdp_badge_selector":""},"skin":"amazon","live":true,"market":"","product":null}
</script></head><body>${markerJs ? "" : ""}</body></html>`;
const ASSET_URL =
  "https://cdn.shopify.com/extensions/0f0e0d0c-1234-5678-9abc-def012345678/cellexia-reviews-29/assets/cellexia-reviews.js";
{
  fx();
  // (a) config present + score marker in the served JS → PASS.
  resetNet((url) => {
    // v1.32 review hardening: step 6 fetches the myshopify origin with ?_fd=0
    // (skip the primary-domain redirect and its CDN bot wall) — stubs match it.
    if (url === "https://d9a.myshopify.com/?_fd=0") return pageOk(embedHtml(true), "https://d9a.myshopify.com/");
    if (url === ASSET_URL) return pageOk('var sc = el("span", "cx-badge-inline__score", x);', ASSET_URL);
    throw new Error("unexpected URL " + url);
  });
  const pass = await svc.deployedExtensionCheck("d9a.myshopify.com");
  check("D9a marker present → PASS naming the numeric rating and the build",
    pass.result.status === "pass" && pass.result.detail.includes("numeric rating") &&
      pass.build === "cellexia-reviews-29" && net.calls.length === 2,
    JSON.stringify(pass.result));
  check("D9b the served badge settings are reported",
    pass.config?.enableBadges === true && pass.config?.badgeStyle === "stars_count" &&
      pass.config?.cardBadgePosition === "inherit",
    JSON.stringify(pass.config));

  // (b) config present + NO marker → FAIL with the redeploy message.
  resetNet((url) => {
    if (url === "https://d9b.myshopify.com/?_fd=0") return pageOk(embedHtml(false), "https://d9b.myshopify.com/");
    if (url === ASSET_URL) return pageOk("var oldBuild = true; // stars + count only", ASSET_URL);
    throw new Error("unexpected URL " + url);
  });
  const stale = await svc.deployedExtensionCheck("d9b.myshopify.com");
  check("D9c no marker → FAIL: predates v1.32, remedy npm run deploy",
    stale.result.status === "fail" && stale.result.detail.includes("predates v1.32") &&
      (stale.result.remedy ?? "").includes("npm run deploy"),
    JSON.stringify(stale.result));

  // (c) no #cx-embed-config → FAIL embed-disabled; the CDN is never fetched.
  resetNet((url) => {
    if (url === "https://d9c.myshopify.com/?_fd=0") return pageOk("<html><body>theme without the app embed</body></html>", "https://d9c.myshopify.com/");
    throw new Error("unexpected URL " + url);
  });
  const noConfig = await svc.deployedExtensionCheck("d9c.myshopify.com");
  check("D9d no config → FAIL naming the app embed, one fetch only",
    noConfig.result.status === "fail" && noConfig.result.detail.includes("app embed") &&
      net.calls.length === 1,
    JSON.stringify(noConfig.result));

  // (d) network error → FAIL, never a throw.
  resetNet(() => { throw new Error("ECONNREFUSED"); });
  let threw = null;
  let down = null;
  try {
    down = await svc.deployedExtensionCheck("d9d.myshopify.com");
  } catch (error) {
    threw = error;
  }
  check("D9e network error → actionable FAIL, no throw",
    threw === null && down?.result.status === "fail" &&
      down.result.detail.includes("Could not reach"),
    threw ? String(threw) : JSON.stringify(down?.result));

  // (e) password-protected storefront → FAIL naming the password page.
  resetNet((url) => {
    if (url === "https://d9e.myshopify.com/?_fd=0") return pageOk("<html>pw</html>", "https://d9e.myshopify.com/password");
    throw new Error("unexpected URL " + url);
  });
  const pw = await svc.deployedExtensionCheck("d9e.myshopify.com");
  check("D9f password page → FAIL naming the password protection",
    pw.result.status === "fail" && pw.result.detail.toLowerCase().includes("password"),
    JSON.stringify(pw.result));
}

// D10 — v1.32 review hardening on step 6: a 403 (CDN bot challenge aimed at
// server-side fetches) names the real cause instead of "check reachability";
// badge_style "stars_only" downgrades the marker PASS to a WARN naming the
// setting that hides the number.
{
  fx();
  resetNet((url) => {
    if (url === "https://d10a.myshopify.com/?_fd=0")
      return { status: 403, url: "https://d10a.myshopify.com/", text: async () => "<html>challenge</html>" };
    throw new Error("unexpected URL " + url);
  });
  const challenged = await svc.deployedExtensionCheck("d10a.myshopify.com");
  check("D10a HTTP 403 → FAIL naming bot protection, not generic reachability",
    challenged.result.status === "fail" && challenged.result.detail.includes("bot-protection") &&
      (challenged.result.remedy ?? "").includes("allowlist"),
    JSON.stringify(challenged.result));

  const starsOnlyHtml = embedHtml(true).replace('"badge_style":"stars_count"', '"badge_style":"stars_only"');
  resetNet((url) => {
    if (url === "https://d10b.myshopify.com/?_fd=0") return pageOk(starsOnlyHtml, "https://d10b.myshopify.com/");
    if (url === ASSET_URL) return pageOk('var sc = el("span", "cx-badge-inline__score", x);', ASSET_URL);
    throw new Error("unexpected URL " + url);
  });
  const starsOnly = await svc.deployedExtensionCheck("d10b.myshopify.com");
  check("D10b marker present but stars_only style → WARN naming the setting",
    starsOnly.result.status === "warn" && starsOnly.result.detail.includes("Stars only") &&
      (starsOnly.result.remedy ?? "").includes("Stars + review count"),
    JSON.stringify(starsOnly.result));
}

console.log(failures === 0 ? `\nALL ${checks} PASS` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
