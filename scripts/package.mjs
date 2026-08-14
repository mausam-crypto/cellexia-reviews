#!/usr/bin/env node
/**
 * package.mjs — builds the distributable ZIP for handover.
 *
 * Produces dist/cellexia-reviews-v<version>.zip containing the whole repo
 * under a top-level `cellexia-reviews/` folder, excluding node_modules, dist,
 * build, env files (except .env.example), SQLite databases, .shopify, .git,
 * .DS_Store and dev caches. Prints the zip path, size and file count.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let archiver;
try {
  ({ default: archiver } = await import("archiver"));
} catch {
  console.error("The 'archiver' package is required. Run `npm install` first.");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const TOP_FOLDER = "cellexia-reviews";
const OUT_DIR = path.join(ROOT, "dist");
const OUT_FILE = path.join(OUT_DIR, `cellexia-reviews-v${version}.zip`);

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".shopify",
  ".cache",
  ".vite",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".idea",
  ".vscode",
  ".claude",
  // SPEC-1.6 §7 verification harness (demo/_verify): a CDP-driven test rig and
  // its raw results.json. Repo-only, like SPEC*.md below — never handed to the
  // installing developer.
  "_verify",
]);

/** @param {string} name */
function isExcludedFile(name) {
  if (name === ".DS_Store") return true;
  if (name === ".env.example") return false; // ships with the template
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.includes(".sqlite")) return true; // dev.sqlite, dev.sqlite-journal…
  if (name.endsWith(".log")) return true;
  // Internal build specifications — repo-only design contracts, not part of
  // the release handed to the installing developer (docs/ is the handover set).
  if (/^SPEC(-[\d.]+)?\.md$/.test(name)) return true;
  return false;
}

/** Yields { abs, rel } for every file to include. */
function* walk(dir, rel = "") {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      yield* walk(abs, relPath);
    } else if (entry.isFile()) {
      if (isExcludedFile(entry.name)) continue;
      // scripts/dev-tests generates bundles and stubs beside itself on every
      // run — only the suites and their README belong in a release.
      if (
        relPath.startsWith("scripts/dev-tests/") &&
        !/\.test\.mjs$/.test(entry.name) &&
        entry.name !== "README.md"
      ) {
        continue;
      }
      yield { abs, rel: relPath };
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// Build into a temp file and rename only on success: the previous release
// ZIPs in dist/ are the only record of what shipped (the adversarial reviews
// diff against them), and a gate failing must not have destroyed one first.
const TMP_FILE = `${OUT_FILE}.building`;
if (fs.existsSync(TMP_FILE)) fs.rmSync(TMP_FILE);

const output = fs.createWriteStream(TMP_FILE);
const archive = archiver("zip", { zlib: { level: 9 } });

const finished = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
  archive.on("warning", (error) => {
    if (error.code !== "ENOENT") reject(error);
  });
});

archive.pipe(output);

// Release gate: the storefront asset budgets (SPEC-1.10 §9). Shopify serves
// these gzipped, but the unminified caps keep growth deliberate — a failure
// here means trim comments/code before shipping, not raise the number casually.
// v1.12: caps raised deliberately (112→120 KiB JS, 55→60 KiB CSS) for the
// Amazon-exact PDP badge + ratings popover (SPEC-1.12 §7). v1.14: JS 120→124
// KiB for market-scoped go-live + the preview Stamped-hide (SPEC-1.14). The
// gate remains the guard against ACCIDENTAL growth — raise only with a
// CHANGELOG note.
// v1.16: JS 128→132 KiB + CSS 60→64 KiB for the review Q&A box and the
// Amazon summary polish (recorded in CHANGELOG).
const ASSET_BUDGETS = [
  // Raised 132k→137k for v1.22's card badge position feature (price finder +
  // position resolution); 137k→139k for v1.27.1's overall-block localization
  // (locale product map + /products/x.js title fallback + SSR date re-render);
  // 139k→141k for v1.28's cart badge toggle + above-quantity placement;
  // 141k→145k for v1.31's localized card badges (locale-root detection +
  // carousel-clone re-queue) and its fetch-layer hardening (retry ladder,
  // 403 body check, boot-guard move) (all recorded in CHANGELOG). Raise
  // this ONLY for a deliberate feature, never to absorb drift — that is
  // the whole point of the gate.
  ["extensions/cellexia-reviews/assets/cellexia-reviews.js", 148480],
  ["extensions/cellexia-reviews/assets/cellexia-reviews.css", 65536],
  // v1.19 (SPEC-1.19 §9): the brand reviews page's own standalone assets.
  ["extensions/cellexia-reviews/assets/cellexia-reviews-page.js", 49152],
  ["extensions/cellexia-reviews/assets/cellexia-reviews-page.css", 24576],
];
for (const [rel, cap] of ASSET_BUDGETS) {
  const size = fs.statSync(path.join(ROOT, rel)).size;
  if (size > cap) {
    console.error(`BUDGET EXCEEDED: ${rel} is ${size.toLocaleString("en-US")} bytes (cap ${cap.toLocaleString("en-US")})`);
    process.exit(1);
  }
}

// v1.19.1 — SHOPIFY PLATFORM LIMITS for theme app extensions. These are not
// our budgets: exceeding any of them makes `shopify app deploy` REJECT the
// extension, so they are hard release gates.
//   - each locale file        <= 15 KB   (raised from 7 KB by Shopify)
//   - all locale data summed  <= 256 KB
//   - all Liquid summed       <= 100 KB
//   - whole extension         <= 10 MB
// https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
const EXT_DIR = path.join(ROOT, "extensions/cellexia-reviews");
const KIB = 1024;
const platformFailures = [];

const localeFiles = fs
  .readdirSync(path.join(EXT_DIR, "locales"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ rel: `locales/${f}`, size: fs.statSync(path.join(EXT_DIR, "locales", f)).size }));
for (const { rel, size } of localeFiles) {
  if (size > 15 * KIB) {
    platformFailures.push(`${rel} is ${size.toLocaleString("en-US")} bytes (Shopify caps each locale file at 15 KB)`);
  }
}
const localeTotal = localeFiles.reduce((sum, f) => sum + f.size, 0);
if (localeTotal > 256 * KIB) {
  platformFailures.push(
    `locale data totals ${localeTotal.toLocaleString("en-US")} bytes (Shopify caps the total at 256 KB)`,
  );
}

let liquidTotal = 0;
for (const dir of ["blocks", "snippets"]) {
  const abs = path.join(EXT_DIR, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of fs.readdirSync(abs)) {
    if (f.endsWith(".liquid")) liquidTotal += fs.statSync(path.join(abs, f)).size;
  }
}
if (liquidTotal > 100 * KIB) {
  platformFailures.push(
    `Liquid totals ${liquidTotal.toLocaleString("en-US")} bytes (Shopify caps the total at 100 KB)`,
  );
}

if (platformFailures.length > 0) {
  console.error("SHOPIFY EXTENSION LIMIT EXCEEDED — the app would fail to deploy:");
  for (const line of platformFailures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(
  `  extension limits OK: largest locale ${Math.max(...localeFiles.map((f) => f.size)).toLocaleString("en-US")} B / 15 KB · ` +
    `locales total ${(localeTotal / KIB).toFixed(1)} KB / 256 KB · Liquid ${(liquidTotal / KIB).toFixed(1)} KB / 100 KB`,
);

/**
 * The AI Curator decides the ORDER shoppers see, so the set of reviews it
 * reads has to be the set the product page serves. In 1.20.0 a well-meant
 * `isSynthetic: false` was added to the curation queries only; on a store
 * populated from the QA generator that emptied the curator completely, and
 * the cost preview reported "nothing to curate" for products full of reviews.
 * It shipped because nothing compared the two queries.
 *
 * This gate does. It is a source check — no database, no Prisma client.
 * Default-DENY: every file under app/ is scanned, and any review query that
 * filters on a provenance column fails the build unless the file is on the
 * allowlist below with a stated reason. Whitespace is normalized first, so a
 * where-clause wrapped across lines by a formatter cannot slip through — the
 * first version of this gate only matched single-line clauses, which would
 * have missed the very regression it exists to prevent.
 */
const PROVENANCE_COLUMNS = ["isSynthetic", "syntheticBatchId"];
/** Files allowed to filter reviews by provenance, and why. */
const PROVENANCE_ALLOWED = new Map([
  ["app/services/brand.server.ts", "the public brand page must not cite QA-generated reviews"],
  ["app/services/brand-page.server.ts", "same: public claims about real customers"],
  ["app/services/qna.server.ts", "brand-level answers are public claims too"],
  ["app/services/synthetic.server.ts", "manages the QA rows themselves"],
  ["app/services/jobs.server.ts", "manages QA generation batches"],
  ["app/services/import.server.ts", "sets the column on import/export"],
  ["app/services/reviews.server.ts", "writes the column; admin listing filters by it"],
  ["app/routes/app.reviews.tsx", "admin listing shows and filters the Synthetic badge"],
  ["app/routes/app.qa-generator.tsx", "the QA generator's own screen"],
  ["app/routes/app._index.tsx", "dashboard warning counts published QA rows"],
]);

function reviewQueryRegions(text) {
  // Comments out, whitespace collapsed: the check must not depend on layout.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const flat = code.replace(/\s+/g, " ");
  const regions = [];
  const re = /prisma\.review\.(findMany|count|groupBy|aggregate)\(/g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    // Take a generous window; the where-clause always sits near the front.
    regions.push(flat.slice(m.index, m.index + 600));
  }
  return regions;
}

const parityFailures = [];
for (const file of walk(ROOT)) {
  if (!/^app\/.*\.(ts|tsx)$/.test(file.rel)) continue;
  const text = fs.readFileSync(file.abs, "utf8");
  if (!PROVENANCE_COLUMNS.some((c) => text.includes(c))) continue;
  const allowedFor = PROVENANCE_ALLOWED.get(file.rel);
  for (const region of reviewQueryRegions(text)) {
    for (const column of PROVENANCE_COLUMNS) {
      if (!new RegExp(`${column}\\s*:`).test(region)) continue;
      if (allowedFor) continue;
      parityFailures.push(
        `${file.rel} has a review query filtering on ${column}, but it is not on the ` +
          `provenance allowlist in scripts/package.mjs. The curator and the product page ` +
          `must read the same reviews — see reviews.server.ts listReviews.`,
      );
    }
  }
}
// An allowlist entry naming a file that no longer exists is a silent hole.
for (const rel of PROVENANCE_ALLOWED.keys()) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    parityFailures.push(
      `scripts/package.mjs allowlists ${rel}, which no longer exists — remove the entry.`,
    );
  }
}
if (parityFailures.length > 0) {
  console.error("CURATION/STOREFRONT REVIEW-SET MISMATCH — the curated order would be wrong:");
  for (const line of parityFailures) console.error(`  - ${line}`);
  console.error("  If a new exclusion is deliberate, add the file to PROVENANCE_ALLOWED with a reason.");
  process.exit(1);
}
console.log(
  `  curation reads the same review set the product page serves ` +
    `(${PROVENANCE_ALLOWED.size} file(s) allowlisted)`,
);

// The dev-test suites ship as PORTABLE tools. A contributor's absolute home
// path or the Unix-only `new URL(...).pathname` idiom (malformed drive paths
// on Windows) must never reach a release again — both did once, and the
// merchant's developer had to patch the ZIP by hand.
const portabilityFailures = [];
for (const rel of fs.readdirSync(path.join(ROOT, "scripts/dev-tests"))) {
  if (!rel.endsWith(".test.mjs")) continue;
  const text = fs.readFileSync(path.join(ROOT, "scripts/dev-tests", rel), "utf8");
  if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text)) {
    portabilityFailures.push(`scripts/dev-tests/${rel} hardcodes an absolute home directory`);
  }
  if (text.includes("import.meta.url).pathname")) {
    portabilityFailures.push(
      `scripts/dev-tests/${rel} uses URL(...).pathname — use fileURLToPath (Windows)`,
    );
  }
}
if (portabilityFailures.length > 0) {
  console.error("DEV-TEST PORTABILITY FAILURE:");
  for (const line of portabilityFailures) console.error(`  - ${line}`);
  process.exit(1);
}

let fileCount = 0;
for (const file of walk(ROOT)) {
  archive.file(file.abs, { name: `${TOP_FOLDER}/${file.rel}` });
  fileCount += 1;
}

await archive.finalize();
await finished;
// Every gate has passed and the archive is fully flushed — NOW claim the name.
if (fs.existsSync(OUT_FILE)) fs.rmSync(OUT_FILE);
fs.renameSync(TMP_FILE, OUT_FILE);

const bytes = fs.statSync(OUT_FILE).size;
const megabytes = (bytes / (1024 * 1024)).toFixed(2);
console.log(`Created ${OUT_FILE}`);
console.log(`  files: ${fileCount}`);
console.log(`  size:  ${megabytes} MB (${bytes.toLocaleString("en-US")} bytes)`);
