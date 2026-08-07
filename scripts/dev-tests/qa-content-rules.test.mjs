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
fs.writeFileSync(path.join(HERE, "qa-entry.js"),
  `export { scrubEmojis, hasFragranceFreeClaim, STYLE_RULES } from "${ROOT}/app/services/synthetic-prompts.server";
   export { buildSystemPrompt, exactTimeUsing, buildUserContent } from "${ROOT}/app/services/synthetic.server";`);
fs.writeFileSync(path.join(HERE, "qa-db-stub.js"),
  "const prisma = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => ({}) }) });\nexport default prisma;");
fs.writeFileSync(path.join(HERE, "shopify-stub.js"), "export const unauthenticated = { admin: async () => ({ admin: null }) };");
await esbuild.build({
  entryPoints: [path.join(HERE, "qa-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "qa.bundle.cjs"),
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "qa-db-stub.js") }));
    b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "shopify-stub.js") }));
    b.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  }}],
});
const svc = require(path.join(HERE, "qa.bundle.cjs"));
let fail = 0;
const t = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { fail++; console.log("   ", detail); } };

// emoji scrub
t("emoji stripped", svc.scrubEmojis("love it 😍✨ so good 👍") === "love it so good", JSON.stringify(svc.scrubEmojis("love it 😍✨ so good 👍")));
t("kaomoji hearts stripped", !/[❤♥]/u.test(svc.scrubEmojis("great ❤️")), svc.scrubEmojis("great ❤️"));
t("ZWJ family stripped", svc.scrubEmojis("nice 👨‍👩‍👧 product") === "nice product", JSON.stringify(svc.scrubEmojis("nice 👨‍👩‍👧 product")));
t("plain text untouched", svc.scrubEmojis("Ma peau est plus ferme, 5 étoiles!") === "Ma peau est plus ferme, 5 étoiles!");
t("accents/CJK/arabic survive", svc.scrubEmojis("crème 日本語 العربية naïve") === "crème 日本語 العربية naïve", svc.scrubEmojis("crème 日本語 العربية naïve"));
t("punctuation gap closed", svc.scrubEmojis("amazing 🎉!") === "amazing!", JSON.stringify(svc.scrubEmojis("amazing 🎉!")));
t("clocks/keycaps/CJK-marks stripped", svc.scrubEmojis("fast ⏰ great ‼ deal 🈹 ok 1️⃣") === "fast great deal ok 1", JSON.stringify(svc.scrubEmojis("fast ⏰ great ‼ deal 🈹 ok 1️⃣")));
t("geometric emoji stripped", svc.scrubEmojis("size ▶ up") === "size up", JSON.stringify(svc.scrubEmojis("size ▶ up")));

// fragrance claims across locales
const CLAIMS = ["Love that it's fragrance-free", "totally perfume free!", "Enfin un soin sans parfum",
  "endlich parfümfrei", "es sin perfume", "profumo? senza profumo!", "helt parfumefri", "hajusteeton ihanuus",
  "produkt bezzapachowy", "خالٍ من العطر", "無香料で嬉しい", "unscented and gentle", "geurvrij en zacht",
  "fără parfum, perfect", "endelig parfymefri", "krem uten parfyme", "ilman hajusteita, ihana",
  "ohne Parfüm, endlich", "unparfümiert und mild", "oparfymerad kräm", "uparfumeret creme",
  "香料不使用で安心", "χωρίς αρώματα, τέλειο", "ΧΩΡΙΣ ΑΡΩΜΑ", "bezzapachowa formuła",
  "neparfumat, excelent", "illatanyagmentes krém", "خالي من العطر تماما", "no fragrance at all",
  "geurloos en zacht", "totalmente inodoro"];
for (const c of CLAIMS) t(`claim caught: ${c.slice(0,28)}`, svc.hasFragranceFreeClaim(c), c);
const OK = ["The scent is lovely and light", "le parfum est discret", "Der Duft ist angenehm",
  "smells like roses", "j'adore son parfum", "light fragrance that fades fast"];
for (const c of OK) t(`scent-experience allowed: ${c.slice(0,28)}`, !svc.hasFragranceFreeClaim(c), c);

// prompt carries the rules
const sys = svc.buildSystemPrompt("Cellexia");
t("prompt bans emojis", /Never use emojis/.test(sys));
t("prompt bans absence claims", /fragrance-free, unscented/.test(sys));
t("prompt has the writing dial", /casual_sloppy/.test(sys) && /imperfect capitalization/.test(sys));
t("old imperfect rule gone", !/When "imperfect" is true/.test(sys));

// usage durations: concrete, in-band, deterministic — never the range label
{
  const BANDS = {
    lt_1w: /^(2|3|4|5) days$|^about a week$/,
    w1_4: /^1 week$|^10 days$|^(2|3) weeks$|^almost a month$/,
    m1_3: /^1 month$|^6 weeks$|^2 months$|^10 weeks$|^almost 3 months$/,
    m3_6: /^(3|4|5) months$|^almost 6 months$/,
    gt_6m: /^(7|8|9) months$|^almost a year$|^over a year$/,
  };
  let allOk = true, spread = new Set();
  for (const [band, re] of Object.entries(BANDS)) {
    for (let i = 0; i < 50; i++) {
      const got = svc.exactTimeUsing(band, i);
      if (!re.test(got)) { allOk = false; console.log("   bad:", band, i, got); }
      if (band === "m1_3") spread.add(got);
    }
  }
  t("durations always concrete and inside the band", allOk);
  t("durations vary across a batch", spread.size >= 3, [...spread].join(", "));
  t("deterministic per index", svc.exactTimeUsing("m1_3", 7) === svc.exactTimeUsing("m1_3", 7));
  t("unknown band degrades to null", svc.exactTimeUsing("nope", 1) === null);

  const sys2 = svc.buildSystemPrompt("Cellexia");
  t("prompt bans range phrasing in reviews", /NEVER write it as a range/.test(sys2));
  // The spec JSON itself must not carry a range label any more.
  const content = svc.buildUserContent(
    { productTitle: "X", productType: null, productTags: [], productVariants: [], productDescription: "d" },
    [{ index: 3, language: "en", rating: 5, brief: "b", tone: "t", length: "short",
       verified: true, variantTitle: null, timeUsing: "m1_3", resultsSeen: [],
       wantsReply: false, writing: "clean", displayName: "A", country: null }],
  );
  t("spec JSON carries a concrete duration, not the range",
    !/1 to 3 months/.test(content) && /"time_using":"(1 month|6 weeks|2 months|10 weeks|almost 3 months)"/.test(content),
    content.slice(content.indexOf("time_using") - 10, content.indexOf("time_using") + 60));
}

console.log(fail === 0 ? "\nALL QA-GENERATOR CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
