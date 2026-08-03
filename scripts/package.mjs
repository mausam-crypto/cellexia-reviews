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
      yield { abs, rel: relPath };
    }
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
if (fs.existsSync(OUT_FILE)) fs.rmSync(OUT_FILE);

const output = fs.createWriteStream(OUT_FILE);
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
  ["extensions/cellexia-reviews/assets/cellexia-reviews.js", 135168],
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

let fileCount = 0;
for (const file of walk(ROOT)) {
  archive.file(file.abs, { name: `${TOP_FOLDER}/${file.rel}` });
  fileCount += 1;
}

await archive.finalize();
await finished;

const bytes = fs.statSync(OUT_FILE).size;
const megabytes = (bytes / (1024 * 1024)).toFixed(2);
console.log(`Created ${OUT_FILE}`);
console.log(`  files: ${fileCount}`);
console.log(`  size:  ${megabytes} MB (${bytes.toLocaleString("en-US")} bytes)`);
