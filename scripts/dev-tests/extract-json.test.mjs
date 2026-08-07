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
fs.writeFileSync(path.join(HERE, "empty-stub.js"),
  "export default new Proxy({}, { get: () => async () => ({}) });\n" +
  ["SHOP_LOCALES","DESIGN_THEMES","RANKING_STRATEGIES","TRANSLATION_DISPLAYS","AGE_RANGES","TIME_USING","SKIN_CONCERNS","RESULTS_SEEN"]
    .map((n) => "export const " + n + " = [];").join("\n"));
fs.writeFileSync(path.join(HERE, "ej-entry.js"),
  `export { extractJson } from "${ROOT}/app/services/ai.server";`);
await esbuild.build({
  entryPoints: [path.join(HERE, "ej-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "ej.bundle.cjs"),
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\// }, () => ({ path: path.join(HERE, "empty-stub.js") }));
  }}],
});
const { extractJson } = require(path.join(HERE, "ej.bundle.cjs"));

const GOOD = { order: ["a","b","c"], rationale: "ok" };
const J = JSON.stringify(GOOD);
let fail = 0;
const t = (name, input, want) => {
  const got = extractJson(input);
  const ok = want === null ? got === null : JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; console.log("   got:", JSON.stringify(got)?.slice(0,120)); }
};

// must still work (historical behaviour)
t("plain object", J, GOOD);
t("fenced", "```json\n" + J + "\n```", GOOD);
t("leading prose", "Here is the order:\n" + J, GOOD);
t("trailing prose no brace", J + "\nHope this helps!", GOOD);
// previously FAILED, must now pass
t("trailing prose WITH brace", J + '\nNote: keep {order} short.', GOOD);
t("two JSON objects", J + "\n" + JSON.stringify({order:["x"],rationale:"dup"}), GOOD);
const rawNl = '{ "order": ["a","b","c"], "rationale": "line one\nline two\nline three" }';
t("raw newlines in rationale", rawNl, { order:["a","b","c"], rationale:"line one\nline two\nline three" });
const rawTab = '{ "order": ["a"], "rationale": "col1\tcol2" }';
t("raw tab in rationale", rawTab, { order:["a"], rationale:"col1\tcol2" });
t("unclosed fence + prose-brace tail", "```json\n" + J + "\nNote: {tip}", GOOD);
// must STILL fail (truncation must never half-apply)
t("truncated mid-array", '{ "order": ["a","b",', null);
t("truncated mid-string", '{ "order": ["a"], "rationale": "cut off he', null);
t("empty", "", null);
t("no json at all", "I cannot help with that.", null);

console.log(fail === 0 ? "\nALL EXTRACTJSON CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
