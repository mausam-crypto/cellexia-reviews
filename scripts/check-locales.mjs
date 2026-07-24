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
