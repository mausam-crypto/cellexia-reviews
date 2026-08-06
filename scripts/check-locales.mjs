#!/usr/bin/env node
/**
 * check-locales.mjs — CI guard for the theme-extension locale files.
 *
 * For every extension under extensions/<name>/locales it verifies, against the
 * en.default master files (en.default.json / en.default.schema.json):
 *
 *   - every file parses as JSON and only contains objects + non-empty strings
 *   - key-set equality with the matching master file
 *     (plural nodes — objects whose keys are CLDR plural categories with an
 *     "other" form — may adapt their category set per language, e.g. pl/ro/ar
 *     add "few"/"many", but must keep "other")
 *   - `[[var]]` and `{{ var }}` placeholders are preserved verbatim
 *
 * Exits 1 with a readable diff report on any problem. No dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSIONS_DIR = path.join(ROOT, "extensions");
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

/** @param {unknown} value */
function isPluralNode(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((k) => PLURAL_CATEGORIES.has(k)) &&
    keys.includes("other") &&
    keys.every((k) => typeof (/** @type {Record<string, unknown>} */ (value)[k]) === "string")
  );
}

/**
 * Flattens a locale tree into a Map of dotted key →
 * { kind: "string", value } | { kind: "plural", forms }.
 * Structural problems are pushed onto `errors`.
 */
function flatten(value, prefix, out, errors) {
  if (typeof value === "string") {
    out.set(prefix, { kind: "string", value });
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      `invalid value at "${prefix || "(root)"}": expected string or object, got ` +
        (value === null ? "null" : Array.isArray(value) ? "array" : typeof value),
    );
    return;
  }
  if (isPluralNode(value)) {
    out.set(prefix, { kind: "plural", forms: { ...value } });
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    errors.push(`empty object at "${prefix || "(root)"}"`);
    return;
  }
  for (const key of keys) {
    flatten(value[key], prefix ? `${prefix}.${key}` : key, out, errors);
  }
}

/** Extracts normalized placeholder tokens: "[[name]]" and "{{name}}". */
function extractPlaceholders(str) {
  const found = new Set();
  for (const match of str.matchAll(/\[\[\s*([\w.-]+)\s*\]\]/g)) found.add(`[[${match[1]}]]`);
  for (const match of str.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(`{{${match[1]}}}`);
  return found;
}

function setDiff(a, b) {
  return [...a].filter((item) => !b.has(item));
}

function checkEmptyValues(flat, errors) {
  for (const [key, entry] of flat) {
    if (entry.kind === "string") {
      if (entry.value.trim() === "") errors.push(`empty value at "${key}"`);
    } else {
      for (const [category, form] of Object.entries(entry.forms)) {
        if (String(form).trim() === "") errors.push(`empty value at "${key}.${category}"`);
      }
    }
  }
}

/** Compares a translated flat map against the master flat map. */
function compareWithMaster(masterFlat, targetFlat, errors) {
  for (const [key, masterEntry] of masterFlat) {
    const targetEntry = targetFlat.get(key);
    if (!targetEntry) {
      const nested = [...targetFlat.keys()].some((k) => k.startsWith(`${key}.`));
      errors.push(
        nested
          ? `key "${key}" must be a ${masterEntry.kind === "plural" ? "plural object (one/few/many/other…)" : "string"}, ` +
            "but the file nests different sub-keys under it"
          : `missing key: "${key}"`,
      );
      continue;
    }
    if (masterEntry.kind !== targetEntry.kind) {
      errors.push(
        `kind mismatch at "${key}": master is ${masterEntry.kind}, file has ${targetEntry.kind}` +
          (masterEntry.kind === "plural"
            ? " (keep the plural object — every language needs at least an \"other\" form)"
            : ""),
      );
      continue;
    }
    if (masterEntry.kind === "string") {
      const expected = extractPlaceholders(masterEntry.value);
      const actual = extractPlaceholders(targetEntry.value);
      const lost = setDiff(expected, actual);
      const invented = setDiff(actual, expected);
      if (lost.length > 0)
        errors.push(`lost placeholder(s) at "${key}": ${lost.join(", ")}`);
      if (invented.length > 0)
        errors.push(`unexpected placeholder(s) at "${key}": ${invented.join(", ")}`);
    } else {
      // Plural: the union of placeholders across forms must match the master
      // union, and no form may invent placeholders the master never uses.
      const masterUnion = new Set();
      for (const form of Object.values(masterEntry.forms)) {
        for (const token of extractPlaceholders(form)) masterUnion.add(token);
      }
      const targetUnion = new Set();
      for (const [category, form] of Object.entries(targetEntry.forms)) {
        const formTokens = extractPlaceholders(form);
        for (const token of formTokens) targetUnion.add(token);
        const invented = setDiff(formTokens, masterUnion);
        if (invented.length > 0)
          errors.push(`unexpected placeholder(s) at "${key}.${category}": ${invented.join(", ")}`);
      }
      const lost = setDiff(masterUnion, targetUnion);
      if (lost.length > 0)
        errors.push(`lost placeholder(s) at "${key}" (missing from every plural form): ${lost.join(", ")}`);
    }
  }
  for (const key of targetFlat.keys()) {
    if (!masterFlat.has(key)) {
      const nestedInMaster = [...masterFlat.keys()].some((k) => k.startsWith(`${key}.`));
      if (!nestedInMaster) errors.push(`extra key not in en.default: "${key}"`);
    }
  }
}

function loadJson(filePath, errors) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    errors.push(`cannot read file: ${error.message}`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`invalid JSON: ${error.message}`);
    return null;
  }
}

function loadFlat(filePath, errors) {
  const data = loadJson(filePath, errors);
  if (data === null) return null;
  const flat = new Map();
  flatten(data, "", flat, errors);
  checkEmptyValues(flat, errors);
  return flat;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const fileErrors = new Map(); // rel path -> string[]
let filesChecked = 0;

function errorsFor(relPath) {
  if (!fileErrors.has(relPath)) fileErrors.set(relPath, []);
  return fileErrors.get(relPath);
}

if (!fs.existsSync(EXTENSIONS_DIR)) {
  console.error(`No extensions directory found at ${EXTENSIONS_DIR}.`);
  process.exit(1);
}

const extensionDirs = fs
  .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory());

for (const extension of extensionDirs) {
  const localesDir = path.join(EXTENSIONS_DIR, extension.name, "locales");
  if (!fs.existsSync(localesDir)) continue;

  const relDir = path.relative(ROOT, localesDir);
  const files = fs
    .readdirSync(localesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  if (files.length === 0) continue;

  const masters = {
    schema: "en.default.schema.json",
    content: "en.default.json",
  };
  const masterFlat = { schema: null, content: null };

  // Load + self-check masters first.
  for (const [kind, name] of Object.entries(masters)) {
    if (!files.includes(name)) continue;
    const relPath = `${relDir}/${name}`;
    filesChecked += 1;
    masterFlat[kind] = loadFlat(path.join(localesDir, name), errorsFor(relPath));
  }

  for (const file of files) {
    if (file === masters.schema || file === masters.content) continue;
    const kind = file.endsWith(".schema.json") ? "schema" : "content";
    const relPath = `${relDir}/${file}`;
    const errors = errorsFor(relPath);
    filesChecked += 1;

    if (!files.includes(masters[kind])) {
      errors.push(`master file ${masters[kind]} is missing — cannot compare`);
      continue;
    }
    const targetFlat = loadFlat(path.join(localesDir, file), errors);
    if (targetFlat === null || masterFlat[kind] === null) continue;
    compareWithMaster(masterFlat[kind], targetFlat, errors);
  }
}

if (filesChecked === 0) {
  console.error("No locale files found under extensions/*/locales — nothing to check.");
  process.exit(1);
}

const failing = [...fileErrors.entries()].filter(([, errors]) => errors.length > 0);

for (const [relPath, errors] of [...fileErrors.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  if (errors.length === 0) {
    console.log(`  OK    ${relPath}`);
  } else {
    console.log(`  FAIL  ${relPath}`);
    for (const error of errors) console.log(`          - ${error}`);
  }
}

console.log("");
if (failing.length > 0) {
  const problemCount = failing.reduce((sum, [, errors]) => sum + errors.length, 0);
  console.error(
    `Locale check failed: ${problemCount} problem(s) in ${failing.length} of ${filesChecked} file(s).`,
  );
  process.exit(1);
}
console.log(`Locale check passed: ${filesChecked} file(s) OK.`);

/* ---------------------------------------------------------------------------
 * cx-i18n.liquid sync guard (added after SPEC-1.12): every literal
 * `t("group.key")` the widget JS consumes must be emitted by the storefront
 * dictionary snippet — locale files alone don't reach the browser. The demo
 * page hand-writes its own dictionary, so a missing snippet entry is
 * invisible in demo verification; this check makes it a build failure.
 * ------------------------------------------------------------------------- */
{
  const jsPath = path.join(
    EXTENSIONS_DIR,
    "cellexia-reviews",
    "assets",
    "cellexia-reviews.js",
  );
  const snippetPath = path.join(
    EXTENSIONS_DIR,
    "cellexia-reviews",
    "snippets",
    "cx-i18n.liquid",
  );
  const js = fs.readFileSync(jsPath, "utf8");
  const snippet = fs.readFileSync(snippetPath, "utf8");

  // Literal dotted keys passed to any t()-style helper: t("widget.x"),
  // I.t("a11y.y", …). Bare keys (tw/ot group shorthands) resolve through
  // group prefixes covered by the snippet's per-group loops — not checked.
  const consumed = new Set();
  for (const m of js.matchAll(/\bt\(\s*"([a-z0-9_]+\.[a-z0-9_.]+)"/g)) {
    consumed.add(m[1]);
  }
  // Group-prefix helpers (tq → "qna." + key, etc.): resolve their literal
  // keys too, so a group helper cannot hide a missing snippet entry.
  // tw was missing from this list, and that blind spot let a widget string
  // ship in the locale FILES but not in the SNIPPET that actually delivers
  // strings to the storefront (v1.21's sort_relevant, caught by hand).
  const HELPER_GROUPS = { tq: "qna", tw: "widget" };
  for (const [helper, group] of Object.entries(HELPER_GROUPS)) {
    for (const m of js.matchAll(new RegExp(`\\b${helper}\\(\\s*"([a-z0-9_]+)"`, "g"))) {
      consumed.add(`${group}.${m[1]}`);
    }
  }
  // Keys the snippet emits: "group.key": lines plus loop-emitted plural
  // groups listed in cx_i18n_plural_keys.
  const emitted = new Set();
  for (const m of snippet.matchAll(/"([a-z0-9_]+\.[a-z0-9_.]+)"\s*:/g)) {
    emitted.add(m[1]);
  }
  const pluralList = snippet.match(/cx_i18n_plural_keys = '([^']+)'/);
  if (pluralList) for (const k of pluralList[1].split("|")) emitted.add(k.trim());
  // Loop-emitted groups (e.g. `for` loops over attrs/report reasons) declare
  // their prefix in a `cx_i18n_groups`-style list or emit "<group>.<key>"
  // pairs dynamically; treat any group with at least one emitted key + a
  // {%- for -%} construct mentioning it as covered for bare-suffix misses.
  const missing = [...consumed].filter((key) => {
    if (emitted.has(key)) return false;
    // plural keys resolve as key.one/key.other lookups
    if (emitted.has(key + ".other") || [...emitted].some((e) => e.startsWith(key + "."))) return false;
    // dynamic per-option groups (age./skin./time./results./report_dialog.)
    // are emitted by loops the static scan can't see — skip whole groups
    // that the snippet demonstrably iterates.
    const group = key.split(".")[0];
    if (new RegExp(`['"|]${group}\\.`).test(snippet) === false && snippet.includes(`'${group}'`)) return false;
    return true;
  });
  if (missing.length > 0) {
    console.error("");
    console.error("cx-i18n.liquid sync check failed — keys consumed by cellexia-reviews.js");
    console.error("but never emitted by snippets/cx-i18n.liquid (shoppers would see raw keys):");
    for (const k of missing.sort()) console.error(`  - ${k}`);
    process.exit(1);
  }
  console.log(`cx-i18n sync check passed: ${consumed.size} JS-consumed key(s) covered.`);
}

/* ---------------------------------------------------------------------------
 * HTML-entity guard (added with v1.15): locale strings must contain REAL
 * characters, never HTML entities — the widget renders via textContent, so
 * "&#39;" would display literally to shoppers. (The runtime also decodes
 * defensively for strings tainted upstream, e.g. Translate & Adapt
 * overrides; this guard keeps OUR files clean at the source.)
 * ------------------------------------------------------------------------- */
{
  const ENTITY_RE = /&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});/;
  const offenders = [];
  const scan = (value, filePath, keyPath) => {
    if (typeof value === "string") {
      const m = value.match(ENTITY_RE);
      if (m) offenders.push(`${filePath} → ${keyPath}: contains "${m[0]}"`);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, filePath, `${keyPath}.${k}`);
    }
  };
  for (const extension of fs.readdirSync(EXTENSIONS_DIR)) {
    const localesDir = path.join(EXTENSIONS_DIR, extension, "locales");
    if (!fs.existsSync(localesDir)) continue;
    for (const file of fs.readdirSync(localesDir)) {
      if (!file.endsWith(".json")) continue;
      const rel = path.join("extensions", extension, "locales", file);
      try {
        scan(JSON.parse(fs.readFileSync(path.join(localesDir, file), "utf8")), rel, "");
      } catch {
        /* parse errors already reported above */
      }
    }
  }
  if (offenders.length > 0) {
    console.error("");
    console.error("HTML-entity check failed — locale strings must use real characters:");
    for (const line of offenders.slice(0, 20)) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log("HTML-entity check passed: no entities in locale strings.");
}

/* ------------------------------------------------------------------------- *
 * Schema `t:` key guard (v1.19.2 — deploy audit).
 *
 * A block's {% schema %} may reference labels as "t:cellexia.x.y". Shopify
 * resolves those against the extension's *.schema.json locale files, and a
 * key that exists in NONE of them renders as the RAW KEY in the merchant's
 * theme editor. Cross-locale parity (checked above) cannot catch it: if the
 * key is missing everywhere, every file agrees. That is exactly how the app
 * embed's "Show the review Q&A box" toggle shipped unlabeled for two
 * releases. This closes the gap.
 * ------------------------------------------------------------------------- */
{
  const offenders = [];
  for (const entry of extensionDirs) {
    const extension = entry.name;
    const blocksDir = path.join(EXTENSIONS_DIR, extension, "blocks");
    const localesDir = path.join(EXTENSIONS_DIR, extension, "locales");
    if (!fs.existsSync(blocksDir) || !fs.existsSync(localesDir)) continue;

    const schemaLocales = new Map();
    for (const file of fs.readdirSync(localesDir).filter((f) => f.endsWith(".schema.json"))) {
      try {
        const flat = {};
        const walk = (node, prefix) => {
          for (const [key, value] of Object.entries(node)) {
            if (value && typeof value === "object") walk(value, `${prefix}${key}.`);
            else flat[`${prefix}${key}`] = value;
          }
        };
        walk(JSON.parse(fs.readFileSync(path.join(localesDir, file), "utf8")), "");
        schemaLocales.set(file, flat);
      } catch {
        /* parse errors already reported above */
      }
    }

    for (const file of fs.readdirSync(blocksDir).filter((f) => f.endsWith(".liquid"))) {
      const source = fs.readFileSync(path.join(blocksDir, file), "utf8");
      const schemaBlock = /\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/.exec(source);
      if (!schemaBlock) continue;
      for (const match of schemaBlock[1].matchAll(/"t:([^"]+)"/g)) {
        const key = match[1];
        const missing = [...schemaLocales.entries()]
          .filter(([, flat]) => !(key in flat))
          .map(([name]) => name.replace(".schema.json", ""));
        if (missing.length > 0) {
          offenders.push(
            `blocks/${file}: "t:${key}" missing in ${missing.length}/${schemaLocales.size} schema locales (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`,
          );
        }
      }
    }
  }
  if (offenders.length > 0) {
    console.error("");
    console.error("Schema t: key check failed — the theme editor would show raw keys:");
    for (const line of offenders.slice(0, 20)) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log("Schema t: key check passed: every block setting label resolves.");
}
