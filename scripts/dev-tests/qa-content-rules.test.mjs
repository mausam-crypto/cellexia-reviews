import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..").split(path.sep).join("/");
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const fs = require("fs");
fs.writeFileSync(path.join(HERE, "qa-entry.js"),
  `export { scrubEmojis, hasFragranceFreeClaim, STYLE_RULES } from "${ROOT}/app/services/synthetic-prompts.server";
   export { buildSystemPrompt } from "${ROOT}/app/services/synthetic.server";`);
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

console.log(fail === 0 ? "\nALL QA-GENERATOR CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
