// Server tests for SPEC-1.27 — textual diversity in the "Overall reviews"
// ranking, against the REAL brand.server.ts (db stubbed, dev-tests README
// conventions). Restores the lost brand-page suite in the process.
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
  path.join(HERE, "bd-translate-stub.js"),
  `export async function translateReviews() { return {}; }`,
);
fs.writeFileSync(
  path.join(HERE, "bd-shopify-stub.js"),
  `export const unauthenticated = { admin: async () => ({ admin: null }) };`,
);
fs.writeFileSync(
  path.join(HERE, "bd-db-stub.js"),
  `const matches = (r, where) => {
    if (!where) return true;
    if (where.shop != null && r.shop !== where.shop) return false;
    if (where.status != null && r.status !== where.status) return false;
    if (where.rating != null) {
      if (typeof where.rating === "number") { if (r.rating !== where.rating) return false; }
      else if (where.rating.gte != null && r.rating < where.rating.gte) return false;
    }
    if (where.id != null) {
      if (where.id.in && !where.id.in.includes(r.id)) return false;
      if (where.id.notIn && where.id.notIn.includes(r.id)) return false;
    }
    if (where.productId != null) {
      if (typeof where.productId === "string") { if (r.productId !== where.productId) return false; }
      else if (where.productId.in && !where.productId.in.includes(r.productId)) return false;
    }
    if (where.productHandle != null) {
      if (typeof where.productHandle === "string") { if (r.productHandle !== where.productHandle) return false; }
      else if (where.productHandle.not === null && r.productHandle == null) return false;
    }
    if (where.productTitle != null && where.productTitle.not === null && r.productTitle == null) return false;
    if (where.skinConcerns?.contains && !r.skinConcerns.includes(where.skinConcerns.contains)) return false;
    if (where.isSynthetic === false && r.isSynthetic) return false;
    if (where.verified === true && !r.verified) return false;
    return true;
  };
  const withCount = (r) => ({ ...r, media: r.media ?? [], _count: { media: (r.media ?? []).length } });
  const prisma = {
    setting: {
      upsert: async () => globalThis.__fx.settingRow,
      update: async () => globalThis.__fx.settingRow,
      findUnique: async () => globalThis.__fx.settingRow,
      findMany: async () => [],
    },
    review: {
      findMany: async (q) => {
        let rows = globalThis.__fx.reviews.filter((r) => matches(r, q?.where));
        if (q?.distinct?.includes("productId")) {
          const seen = new Set();
          rows = rows.filter((r) => (seen.has(r.productId) ? false : (seen.add(r.productId), true)));
        }
        return rows.map(withCount);
      },
      groupBy: async (q) => {
        const rows = globalThis.__fx.reviews.filter((r) => matches(r, q?.where));
        const key = q.by[0];
        const map = new Map();
        for (const r of rows) map.set(r[key], (map.get(r[key]) ?? 0) + 1);
        return [...map.entries()].map(([k, n]) => ({ [key]: k, _count: { _all: n } }));
      },
      count: async (q) => globalThis.__fx.reviews.filter((r) => matches(r, q?.where)).length,
    },
    reviewMedia: { findMany: async () => [] },
    translationCache: { findMany: async () => [] },
    productDisplayConfig: { findUnique: async () => null },
    aiCuration: { findUnique: async () => null, findMany: async () => [] },
  };
  export default prisma;`,
);
fs.writeFileSync(
  path.join(HERE, "bd-entry.js"),
  `export { pickTopBrandReviews, listBrandReviews } from "${ROOT}/app/services/brand.server";`,
);
const stubPlugin = {
  name: "stubs",
  setup(build) {
    build.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "bd-db-stub.js") }));
    build.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "bd-shopify-stub.js") }));
    build.onResolve({ filter: /translate\.server$/ }, () => ({ path: path.join(HERE, "bd-translate-stub.js") }));
    build.onResolve({ filter: /^~\// }, (a) => ({ path: path.join(ROOT, "app", a.path.slice(2) + ".ts") }));
  },
};
await esbuild.build({
  entryPoints: [path.join(HERE, "bd-entry.js")],
  bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "bd.bundle.cjs"), plugins: [stubPlugin],
});
const svc = require(path.join(HERE, "bd.bundle.cjs"));

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

let seq = 0;
function review(over = {}) {
  seq += 1;
  return {
    id: `r${String(seq).padStart(2, "0")}`,
    shop: "s", productId: "p1", productTitle: "Night Cream", productHandle: "night-cream",
    rating: 5, title: "A solid product", body: "", language: "en", authorName: "Ann",
    authorEmail: null, customerId: null, country: null, variantTitle: null,
    verified: true, status: "PUBLISHED", ageRange: null, skinConcerns: "[]",
    timeUsing: null, resultsSeen: "[]", helpfulCount: 0, reportCount: 0,
    reply: null, replyAt: null, ipHash: null, isSynthetic: false, qaChecked: false,
    source: null, syntheticBatchId: null, syntheticGeneratedAt: null,
    createdAt: new Date(Date.now() - seq * 3_600_000), updatedAt: new Date(), media: [],
    ...over,
  };
}

function fx(reviews, overallWidget = "{}") {
  globalThis.__fx = {
    settingRow: { shop: "s", previewToken: "t", overallWidget, translationDisplay: "original", showTranslate: true, translationProvider: "anthropic" },
    reviews,
  };
}

const CLONE_BODY_A =
  "I have been using this every night for six weeks and the fine lines around my eyes have visibly softened. The texture is rich without feeling greasy and a little goes a long way.";
const CLONE_BODY_B =
  "I have been using this every morning for eight weeks and the fine lines around my eyes have visibly softened. The texture is rich without feeling greasy and a little goes a long way.";
const DISTINCT_BODIES = [
  "Bought this for my mother after her dermatologist recommended retinol alternatives. She says her skin feels firmer and the redness on her cheeks has calmed down considerably.",
  "Shipping was fast and the packaging is gorgeous. More importantly the serum absorbs in seconds and layers well under sunscreen without pilling or leaving any sticky residue.",
  "After years of trying different brands I finally found something that does not irritate my sensitive skin. No breakouts, no stinging, just a healthy glow after a month of use.",
  "The pump dispenses exactly the right amount and one jar lasted me almost three months. My pores look smaller and my makeup goes on much smoother than before.",
  "I was skeptical about the price but the results speak for themselves. Dark spots from old acne scars have faded noticeably since I added this to my evening routine.",
];
const DISTINCT_TITLES = [
  "Worth every penny",
  "Gorgeous packaging, fast shipping",
  "Finally no irritation",
  "One jar lasts months",
  "Dark spots fading",
];

const CLONE2_BODY =
  "My husband keeps stealing this from my shelf. We both noticed our foreheads look less shiny by midday and neither of us has had a single clogged pore since we started.";
const CLONE3_BODY =
  "Customer service replaced my damaged jar within two days without any fuss. The product itself smells faintly of roses and leaves a soft matte finish I really like.";

/** Three same-headline clones (each with its OWN body) on three DIFFERENT
 * products + five distinct reviews — only the headlines repeat. */
function sameyTitleFixture() {
  seq = 0;
  const clones = [
    review({ id: "c1", productId: "p1", productHandle: "night-cream", title: "Love this cream", body: CLONE_BODY_A, helpfulCount: 40 }),
    review({ id: "c2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", title: "Love this cream!", body: CLONE2_BODY, helpfulCount: 39 }),
    review({ id: "c3", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", title: "love this cream", body: CLONE3_BODY, helpfulCount: 38 }),
  ];
  const distinct = DISTINCT_BODIES.map((body, i) =>
    review({
      id: `d${i + 1}`, productId: `p${i + 4}`, productHandle: `product-${i + 4}`,
      productTitle: `Product ${i + 4}`, title: DISTINCT_TITLES[i], body, helpfulCount: 30 - i,
    }),
  );
  return [...clones, ...distinct];
}

// ---------------------------------------------------------------------------
// 1. Same normalized headline on different products → exactly one featured,
//    slots still fill (never fewer cards than before).
// ---------------------------------------------------------------------------
{
  fx(sameyTitleFixture());
  const top = await svc.pickTopBrandReviews("s", 6);
  const ids = top.map((r) => r.id);
  check("samey headlines: one clone featured", ids.filter((id) => id.startsWith("c")).length === 1, ids.join(","));
  check("samey headlines: top clone wins", ids[0] === "c1", ids.join(","));
  check("samey headlines: all 6 slots filled", ids.length === 6, String(ids.length));
  check("samey headlines: distinct reviews backfill", ["d1", "d2", "d3", "d4", "d5"].every((id) => ids.includes(id)), ids.join(","));
}

// ---------------------------------------------------------------------------
// 2. Near-duplicate BODIES (same template, words swapped) on different
//    products → the twin is demoted on the API list, never removed.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "a1", productId: "p1", title: "Six weeks in", body: CLONE_BODY_A, helpfulCount: 40 }),
    review({ id: "a2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", title: "Two months of use", body: CLONE_BODY_B, helpfulCount: 39 }),
    review({ id: "d1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", title: DISTINCT_TITLES[0], body: DISTINCT_BODIES[0], helpfulCount: 30 }),
    review({ id: "d2", productId: "p4", productHandle: "toner", productTitle: "Toner", title: DISTINCT_TITLES[1], body: DISTINCT_BODIES[1], helpfulCount: 29 }),
  ]);
  const page1 = await svc.listBrandReviews("s", { page: 1, perPage: 3 });
  const page2 = await svc.listBrandReviews("s", { page: 2, perPage: 3 });
  const ids1 = page1.reviews.map((r) => r.id);
  const ids2 = page2.reviews.map((r) => r.id);
  check("near-dup bodies: twin demoted off page 1", ids1.join(",") === "a1,d1,d2", ids1.join(","));
  check("near-dup bodies: twin appears on page 2", ids2.join(",") === "a2", ids2.join(","));
  check("near-dup bodies: total untouched", page1.total === 4 && page1.total_pages === 2, JSON.stringify({ total: page1.total, pages: page1.total_pages }));
  const all = [...ids1, ...ids2];
  check("near-dup bodies: no id lost or duplicated", new Set(all).size === 4, all.join(","));
}

// ---------------------------------------------------------------------------
// 3. Never-shrink: an all-samey shop still fills as many slots as SPEC-1.9
//    alone would (top-up from skipped candidates).
// ---------------------------------------------------------------------------
{
  seq = 0;
  const clones = Array.from({ length: 5 }, (_, i) =>
    review({
      id: `s${i + 1}`, productId: `p${i + 1}`, productHandle: `product-${i + 1}`,
      productTitle: `Product ${i + 1}`, title: "Love this cream", body: CLONE_BODY_A, helpfulCount: 40 - i,
    }),
  );
  fx(clones);
  const top = await svc.pickTopBrandReviews("s", 6);
  check("never-shrink: all 5 samey reviews still featured", top.length === 5, String(top.length));
  check("never-shrink: score order kept in top-up", top.map((r) => r.id).join(",") === "s1,s2,s3,s4,s5", top.map((r) => r.id).join(","));
}

// ---------------------------------------------------------------------------
// 4. Picked mode: hand-picks stay verbatim, seed the sieve (backfill never
//    echoes them), and keep the first slots on the unfiltered API page 1.
// ---------------------------------------------------------------------------
{
  fx(sameyTitleFixture(), JSON.stringify({ mode: "picked", pickedIds: ["c2"] }));
  const top = await svc.pickTopBrandReviews("s", 6);
  const ids = top.map((r) => r.id);
  check("picked: hand-pick first, verbatim", ids[0] === "c2", ids.join(","));
  check("picked: backfill skips the pick's clones", !ids.includes("c1") && !ids.includes("c3"), ids.join(","));
  check("picked: slots still fill", ids.length === 6, String(ids.length));

  const page1 = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  const listIds = page1.reviews.map((r) => r.id);
  check("picked list: pick keeps slot 1, clones demoted to the tail", listIds.join(",") === "c2,d1,d2,d3,d4,d5,c1,c3", listIds.join(","));
  check("picked list: nothing removed", page1.total === 8, String(page1.total));
}

// ---------------------------------------------------------------------------
// 5. The 2-per-product cap survives both the sieve and the top-up path.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx(DISTINCT_BODIES.slice(0, 4).map((body, i) =>
    review({ id: `x${i + 1}`, productId: "p9", productHandle: "hero", productTitle: "Hero", title: DISTINCT_TITLES[i], body, helpfulCount: 40 - i }),
  ));
  check("product cap: distinct texts, same product → 2", (await svc.pickTopBrandReviews("s", 6)).length === 2);

  seq = 0;
  fx(Array.from({ length: 5 }, (_, i) =>
    review({ id: `y${i + 1}`, productId: "p9", productHandle: "hero", productTitle: "Hero", title: "Love this cream", body: CLONE_BODY_A, helpfulCount: 40 - i }),
  ));
  const capped = await svc.pickTopBrandReviews("s", 6);
  check("product cap: samey texts, same product → still 2 via top-up", capped.length === 2, String(capped.length));
}

// ---------------------------------------------------------------------------
// 6. A textually diverse dataset ranks in the exact SPEC-1.9 score order —
//    the sieve is a no-op.
// ---------------------------------------------------------------------------
{
  seq = 0;
  const diverse = DISTINCT_BODIES.map((body, i) =>
    review({
      id: `d${i + 1}`, productId: `p${i + 1}`, productHandle: `product-${i + 1}`,
      productTitle: `Product ${i + 1}`, title: DISTINCT_TITLES[i], body, helpfulCount: 50 - i,
    }),
  );
  fx(diverse);
  const top = await svc.pickTopBrandReviews("s", 5);
  check("diverse data: pure score order (sieve no-op)", top.map((r) => r.id).join(",") === "d1,d2,d3,d4,d5", top.map((r) => r.id).join(","));
  const list = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  check("diverse data: list order unchanged too", list.reviews.map((r) => r.id).join(",") === "d1,d2,d3,d4,d5");
  const again = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  check("determinism: same call, same order", again.reviews.map((r) => r.id).join(",") === list.reviews.map((r) => r.id).join(","));
}

// ---------------------------------------------------------------------------
// 7. The rating relax to >= 3 still fires, and the sieve applies over the
//    relaxed pool.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "f1", productId: "p1", rating: 4, title: DISTINCT_TITLES[0], body: DISTINCT_BODIES[0], helpfulCount: 40 }),
    review({ id: "f2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", rating: 4, title: DISTINCT_TITLES[1], body: DISTINCT_BODIES[1], helpfulCount: 39 }),
    review({ id: "g1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", rating: 3, title: DISTINCT_TITLES[2], body: DISTINCT_BODIES[2], helpfulCount: 20 }),
    // g2's title must be DISSIMILAR to f1's ("Worth every penny" vs "Worth
    // every cent" has title containment 0.69 — the title rule would fire
    // first and the label below would lie): the body rule must be the decider.
    review({ id: "g2", productId: "p4", productHandle: "toner", productTitle: "Toner", rating: 3, title: "Cheap and effective", body: DISTINCT_BODIES[0], helpfulCount: 19 }),
    review({ id: "g3", productId: "p5", productHandle: "mask", productTitle: "Mask", rating: 3, title: DISTINCT_TITLES[4], body: DISTINCT_BODIES[4], helpfulCount: 18 }),
  ]);
  const top = await svc.pickTopBrandReviews("s", 4);
  const ids = top.map((r) => r.id);
  check("relax: >=3 pool fills the slots", ids.length === 4, String(ids.length));
  check("relax: sieve applies to relaxed pool (g2 echoes f1's body)", !ids.includes("g2"), ids.join(","));
  check("relax: expected selection", ids.join(",") === "f1,f2,g1,g3", ids.join(","));
}

// ---------------------------------------------------------------------------
// 8. Unsegmented script (ja): identical bodies deduped, distinct bodies kept.
// ---------------------------------------------------------------------------
{
  const JA_BODY_A =
    "このクリームを毎晩使い始めてから六週間になりますが、目元の小じわが目に見えて柔らかくなりました。テクスチャーは濃厚なのにべたつかず、少量でよく伸びます。";
  const JA_BODY_B =
    "敏感肌でも刺激を感じることなく使えるのが嬉しいです。朝のメイク前に塗ってもよれず、一ヶ月で頬の赤みが落ち着いて肌全体が明るくなった気がします。";
  seq = 0;
  fx([
    review({ id: "j1", productId: "p1", language: "ja", title: "最高のクリーム", body: JA_BODY_A, helpfulCount: 40 }),
    review({ id: "j2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", language: "ja", title: "しっとり潤う", body: JA_BODY_A, helpfulCount: 39 }),
    review({ id: "j3", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", language: "ja", title: "敏感肌でも安心", body: JA_BODY_B, helpfulCount: 30 }),
  ]);
  const list = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  const ids = list.reviews.map((r) => r.id);
  check("ja: identical body demoted, distinct kept", ids.join(",") === "j1,j3,j2", ids.join(","));
}

// ---------------------------------------------------------------------------
// 9. Stars filter: the sieve applies within the filtered set; stats stay the
//    unfiltered aggregate.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "a1", productId: "p1", rating: 5, title: "Six weeks in", body: CLONE_BODY_A, helpfulCount: 40 }),
    review({ id: "a2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", rating: 5, title: "Two months of use", body: CLONE_BODY_B, helpfulCount: 39 }),
    review({ id: "d1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", rating: 5, title: DISTINCT_TITLES[0], body: DISTINCT_BODIES[0], helpfulCount: 30 }),
    review({ id: "d2", productId: "p4", productHandle: "toner", productTitle: "Toner", rating: 4, title: DISTINCT_TITLES[1], body: DISTINCT_BODIES[1], helpfulCount: 29 }),
  ]);
  const list = await svc.listBrandReviews("s", { page: 1, perPage: 12, stars: 5 });
  const ids = list.reviews.map((r) => r.id);
  check("stars filter: 5-star twin demoted within the filter", ids.join(",") === "a1,d1,a2", ids.join(","));
  check("stars filter: stats stay unfiltered", list.stats.count === 4, String(list.stats.count));
}

// ---------------------------------------------------------------------------
// 10. Demote-never-remove at scale: 30 clones paginate without loss.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx(Array.from({ length: 30 }, (_, i) =>
    review({
      id: `c${String(i).padStart(2, "0")}`, productId: `p${i}`, productHandle: `product-${i}`,
      productTitle: `Product ${i}`, title: "Love this cream", body: CLONE_BODY_A, helpfulCount: 100 - i,
    }),
  ));
  const pages = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await svc.listBrandReviews("s", { page, perPage: 12 });
    pages.push(...res.reviews.map((r) => r.id));
  }
  check("30 clones: every review still reachable", new Set(pages).size === 30, String(new Set(pages).size));
  check("30 clones: best clone still leads", pages[0] === "c00", pages[0]);
}

// ---------------------------------------------------------------------------
// 11. Featured path, body rule as the DECIDER: near-duplicate bodies under
//     dissimilar titles → one featured; the twin returns only via the
//     never-shrink top-up, at the back of the list.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "a1", productId: "p1", title: "Six weeks in", body: CLONE_BODY_A, helpfulCount: 40 }),
    review({ id: "a2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", title: "Two months of use", body: CLONE_BODY_B, helpfulCount: 39 }),
    review({ id: "d1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", title: DISTINCT_TITLES[0], body: DISTINCT_BODIES[0], helpfulCount: 30 }),
    review({ id: "d2", productId: "p4", productHandle: "toner", productTitle: "Toner", title: DISTINCT_TITLES[1], body: DISTINCT_BODIES[1], helpfulCount: 29 }),
  ]);
  const top3 = await svc.pickTopBrandReviews("s", 3);
  check("featured body rule: twin not among 3 featured", top3.map((r) => r.id).join(",") === "a1,d1,d2", top3.map((r) => r.id).join(","));
  const top4 = await svc.pickTopBrandReviews("s", 4);
  check("featured body rule: top-up appends twin last, never 2nd", top4.map((r) => r.id).join(",") === "a1,d1,d2,a2", top4.map((r) => r.id).join(","));
}

// ---------------------------------------------------------------------------
// 12. 24-slot prefix boundary: >24 distinct reviews + one near-dup ranked
//     13th → the per_page=24 first page is fully distinct and the dup lands
//     at position 25, immediately after the prefix.
// ---------------------------------------------------------------------------
{
  const WORDS = [
    "marigold", "porcelain", "juniper", "alabaster", "thunder", "velvet", "copper",
    "meadow", "lantern", "biscuit", "harbor", "willow", "saffron", "pebble", "cinnamon",
    "orchid", "tundra", "quartz", "bramble", "nectar", "fjord", "ember", "lagoon",
    "truffle", "zephyr", "obsidian",
  ];
  seq = 0;
  const distinct = WORDS.map((word, i) =>
    review({
      id: `w${String(i + 1).padStart(2, "0")}`, productId: `p${i + 1}`,
      productHandle: `product-${i + 1}`, productTitle: `Product ${i + 1}`,
      title: word, body: `${word} `.repeat(20).trim(), helpfulCount: 200 - 2 * (i + 1),
    }),
  );
  const dup = review({
    id: "dup", productId: "p99", productHandle: "product-99", productTitle: "Product 99",
    title: "keepsake", body: `${WORDS[0]} `.repeat(20).trim(), helpfulCount: 175, // ranks 13th
  });
  fx([...distinct, dup]);
  const page1 = await svc.listBrandReviews("s", { page: 1, perPage: 24 });
  const ids1 = page1.reviews.map((r) => r.id);
  check("prefix boundary: page 1 holds 24 distinct reviews", ids1.length === 24 && !ids1.includes("dup"), ids1.join(","));
  check("prefix boundary: prefix keeps score order", ids1.join(",") === distinct.slice(0, 24).map((r) => r.id).join(","), ids1.join(","));
  const page2 = await svc.listBrandReviews("s", { page: 2, perPage: 24 });
  const ids2 = page2.reviews.map((r) => r.id);
  check("prefix boundary: dup demoted to position 25 exactly", ids2.join(",") === "dup,w25,w26", ids2.join(","));
  check("prefix boundary: total untouched", page1.total === 27, String(page1.total));
}

// ---------------------------------------------------------------------------
// 13. Short-text guards: null titles never collide via the empty key;
//     sub-4-trigram titles skip the ratio test; exact rule still applies.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "n1", productId: "p1", title: null, body: DISTINCT_BODIES[0], helpfulCount: 40 }),
    review({ id: "n2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", title: null, body: DISTINCT_BODIES[1], helpfulCount: 39 }),
    review({ id: "t1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", title: "Ok!", body: DISTINCT_BODIES[2], helpfulCount: 30 }),
    review({ id: "t2", productId: "p4", productHandle: "toner", productTitle: "Toner", title: "No", body: DISTINCT_BODIES[3], helpfulCount: 29 }),
    review({ id: "t3", productId: "p5", productHandle: "mask", productTitle: "Mask", title: "ok", body: DISTINCT_BODIES[4], helpfulCount: 28 }),
  ]);
  const list = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  const ids = list.reviews.map((r) => r.id);
  check("short text: null titles never collide (empty key guarded)", ids[0] === "n1" && ids[1] === "n2", ids.join(","));
  check("short text: 'Ok!' vs 'No' both admitted (ratio test gated)", ids.indexOf("t2") === 3, ids.join(","));
  check("short text: 'Ok!' vs 'ok' deduped by the exact rule", ids.join(",") === "n1,n2,t1,t2,t3" && ids.indexOf("t3") === 4, ids.join(","));
}

// ---------------------------------------------------------------------------
// 14. Picked-echo top-up order: non-echo skipped candidates fill first; the
//     echo of a hand-picked card appears only when nothing else remains.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "A", productId: "p1", title: "Love this cream", body: CLONE_BODY_A, helpfulCount: 60 }),
    review({ id: "B", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", title: "Love this cream!", body: CLONE_BODY_B, helpfulCount: 50 }),
    review({ id: "D1", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", title: DISTINCT_TITLES[0], body: DISTINCT_BODIES[0], helpfulCount: 40 }),
    review({ id: "D2", productId: "p4", productHandle: "toner", productTitle: "Toner", title: "Cheap and effective", body: DISTINCT_BODIES[0], helpfulCount: 39 }),
  ], JSON.stringify({ mode: "picked", pickedIds: ["A"] }));
  const top3 = await svc.pickTopBrandReviews("s", 3);
  check("picked echo: with slots to spare, echo stays out", top3.map((r) => r.id).join(",") === "A,D1,D2", top3.map((r) => r.id).join(","));
  const top4 = await svc.pickTopBrandReviews("s", 4);
  check("picked echo: echo admitted only as the last resort", top4.map((r) => r.id).join(",") === "A,D1,D2,B", top4.map((r) => r.id).join(","));
}

// ---------------------------------------------------------------------------
// 15. Mark handling: ja voiced/unvoiced kana stay distinct; Arabic pointed
//     and unpointed spellings of the same headline dedupe.
// ---------------------------------------------------------------------------
{
  seq = 0;
  fx([
    review({ id: "v1", productId: "p1", language: "ja", title: "そうだ", body: DISTINCT_BODIES[0], helpfulCount: 40 }),
    review({ id: "v2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", language: "ja", title: "そうた", body: DISTINCT_BODIES[1], helpfulCount: 39 }),
  ]);
  const ja = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  check("ja voicing: だ/た titles are different words, both kept", ja.reviews.map((r) => r.id).join(",") === "v1,v2", ja.reviews.map((r) => r.id).join(","));

  seq = 0;
  fx([
    review({ id: "m1", productId: "p1", language: "ar", title: "منتج ممتاز", body: DISTINCT_BODIES[0], helpfulCount: 40 }),
    review({ id: "m2", productId: "p2", productHandle: "day-cream", productTitle: "Day Cream", language: "ar", title: "مُنْتَج مُمْتَاز", body: DISTINCT_BODIES[1], helpfulCount: 39 }),
    review({ id: "m3", productId: "p3", productHandle: "eye-cream", productTitle: "Eye Cream", language: "ar", title: "جودة رائعة", body: DISTINCT_BODIES[2], helpfulCount: 30 }),
  ]);
  const ar = await svc.listBrandReviews("s", { page: 1, perPage: 12 });
  check("ar folding: pointed twin demoted, different headline kept", ar.reviews.map((r) => r.id).join(",") === "m1,m3,m2", ar.reviews.map((r) => r.id).join(","));
}

console.log(failures === 0 ? "ALL BRAND-DIVERSITY TESTS PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
