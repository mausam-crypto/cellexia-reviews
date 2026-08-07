// SPEC-1.26 — multi-product launch assembly, against the REAL service code.
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..").split(path.sep).join("/");
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const fs = require("fs");
fs.writeFileSync(path.join(HERE, "ml-db-stub.js"),
  "const prisma = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => ({}) }) });\nexport default prisma;");
fs.writeFileSync(path.join(HERE, "ml-shopify-stub.js"),
  "export const unauthenticated = { admin: async () => ({ admin: null }) };");
fs.writeFileSync(path.join(HERE, "ml-entry.js"),
  `export { parseMultiLaunch, assembleLaunchConfig, MAX_MULTI_PRODUCTS } from "${ROOT}/app/services/synthetic.server";`);
await esbuild.build({
  entryPoints: [path.join(HERE, "ml-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "ml.bundle.cjs"),
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "ml-db-stub.js") }));
    b.onResolve({ filter: /^~\/shopify\.server$/ }, () => ({ path: path.join(HERE, "ml-shopify-stub.js") }));
    b.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  }}],
});
const svc = require(path.join(HERE, "ml.bundle.cjs"));
let fail = 0;
const t = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { fail++; console.log("   ", detail); } };

const SHARED = { languages: ["en", "fr"], humanTouch: 40, skepticCheck: true, skepticBatchSize: 20,
  structuredAttrs: true, status: "PUBLISHED", maxHelpfulVotes: 25 };
const CTX = (id, title) => ({ id, title, handle: null, description: "A cream.", productType: "Serum", tags: [], variants: ["30ml", "50ml"] });

// M1: shared + overrides precedence through the REAL parser
{
  const launch = svc.parseMultiLaunch({ shared: { ...SHARED, count: 99, verifiedPercent: 10 },
    products: [
      { productId: "111", count: 12, targetAverage: 4.2, verifiedPercent: 90, repliesPercent: 5, dateStart: "2026-01-01", dateEnd: "2026-06-01" },
      { productId: "222", count: 30 },
    ] });
  t("M1a parses", launch.error === null, JSON.stringify(launch));
  const a = svc.assembleLaunchConfig(launch.input, launch.input.rows[0], CTX("111", "Cream A"));
  const b = svc.assembleLaunchConfig(launch.input, launch.input.rows[1], CTX("222", "Cream B"));
  t("M1b per-product count wins over shared leakage", a.config.count === 12 && b.config.count === 30,
    JSON.stringify({ a: a.config?.count, b: b.config?.count }));
  t("M1c per-product verified% wins; unset row falls to parser default", a.config.verifiedPercent === 90 && b.config.verifiedPercent === 80,
    JSON.stringify({ a: a.config?.verifiedPercent, b: b.config?.verifiedPercent }));
  t("M1d shared settings reach both", a.config.humanTouch === 40 && b.config.humanTouch === 40 && b.config.languages.join() === "en,fr");
  t("M1e context wired in", a.config.productTitle === "Cream A" && a.config.productVariants.join() === "30ml,50ml");
  t("M1f overridden dates win; unset rows get the parser's default window",
    String(a.config.dateStart).startsWith("2026-01") && b.config.dateStart !== null &&
      String(b.config.dateStart) !== String(a.config.dateStart),
    JSON.stringify({ a: a.config?.dateStart, b: b.config?.dateStart }));
}

// M2: caps and hostile shapes
{
  const many = { shared: SHARED, products: Array.from({ length: 21 }, (_, i) => ({ productId: String(1000 + i), count: 5 })) };
  t("M2a 20-product cap", svc.parseMultiLaunch(many).error !== null, "");
  const dup = svc.parseMultiLaunch({ shared: SHARED, products: [{ productId: "5", count: 5 }, { productId: "5", count: 5 }] });
  t("M2b duplicate product named", /appears twice/.test(dup.error ?? ""), dup.error);
  const over = svc.parseMultiLaunch({ shared: SHARED, products: [{ productId: "5", count: 999999 }] });
  t("M2c over-limit count rejected, not clamped", /up to/.test(over.error ?? ""), over.error);
  const noid = svc.parseMultiLaunch({ shared: SHARED, products: [{ count: 5 }] });
  t("M2d missing product named by row", /Product 1/.test(noid.error ?? ""), noid.error);
  const smuggle = svc.parseMultiLaunch({ shared: { ...SHARED, productTitle: "EVIL", count: 7 }, products: [{ productId: "9", count: 3 }] });
  const cfg = svc.assembleLaunchConfig(smuggle.input, smuggle.input.rows[0], CTX("9", "Real"));
  t("M2e shared cannot smuggle product identity or per-product fields",
    cfg.config.productTitle === "Real" && cfg.config.count === 3, JSON.stringify({ t: cfg.config?.productTitle, c: cfg.config?.count }));
}

// M3: variant default derived server-side when the row could not decide
{
  const launch = svc.parseMultiLaunch({ shared: SHARED, products: [
    { productId: "31", count: 5 },                        // no assignVariants key
    { productId: "32", count: 5, assignVariants: false }, // explicit merchant "off"
  ] });
  const a = svc.assembleLaunchConfig(launch.input, launch.input.rows[0], CTX("31", "Multi"));
  const b = svc.assembleLaunchConfig(launch.input, launch.input.rows[1], CTX("32", "Multi2"));
  t("M3a omitted → defaults ON for a multi-variant product", a.config.assignVariants === true, JSON.stringify(a.config?.assignVariants));
  t("M3b explicit off is respected", b.config.assignVariants === false, JSON.stringify(b.config?.assignVariants));
  const single = svc.assembleLaunchConfig(launch.input, launch.input.rows[0],
    { ...CTX("31", "Solo"), variants: [] });
  t("M3c omitted → stays off for a variant-less product", single.config.assignVariants === false);
}

console.log(fail === 0 ? "\nALL MULTI-LAUNCH CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
