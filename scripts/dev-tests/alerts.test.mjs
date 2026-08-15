/**
 * v1.34 (SPEC-1.34) — low-star review support alerts.
 *
 * Real-code checks (no DB, no SMTP server, no API key):
 *  A1  parseRecipientList / effectiveRecipients / sanitizeRecipients
 *  A2  sanitizeSmtpHost
 *  A3  resolveSmtpConfig (host/from fallbacks, security whitelist, port)
 *  A4  shouldAlert gate (toggle, source, synthetic, threshold clamp)
 *  A5  buildAlertEmail: HTML escaping, header-injection hardening, honesty
 *      lines for the three order-lookup outcomes, admin links, test banner
 *  A6  collectOrderContext against a fake admin.graphql (query preference,
 *      reviewed-product marker, id extraction, failure honesty)
 */
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes throughout: ROOT is embedded into generated entry files as
// a module specifier, where Windows backslashes would form invalid escapes.
const ROOT = path.resolve(HERE, "..", "..").split(path.sep).join("/");
const require = createRequire(path.join(ROOT, "package.json"));
const esbuild = require("esbuild");
const fs = require("fs");
fs.writeFileSync(path.join(HERE, "al-entry.js"),
  `export { parseRecipientList, effectiveRecipients, resolveSmtpConfig, shouldAlert, clampThreshold, buildAlertEmail, oneLine, collectOrderContext, maybeSendLowStarAlert } from "${ROOT}/app/services/alerts.server";
   export { sanitizeRecipients, sanitizeSmtpHost, sanitizeAlertFromEmail } from "${ROOT}/app/services/settings.server";
   export { calls as dbCalls } from "~/db.server";`);
// Recording db stub: getSettings sees an alerts-enabled row with NO SMTP
// host, and every prisma.setting.update (recordOutcome) is captured so the
// suite can assert what lastAlertError was actually written.
fs.writeFileSync(path.join(HERE, "al-db-stub.js"),
  `export const calls = [];
const row = { shop: "s.myshopify.com", lowStarAlerts: true, lowStarAlertMax: 2,
  alertRecipients: "t@x.co", notifyEmail: null, smtpHost: null, smtpPort: 587,
  smtpSecurity: "starttls", smtpUser: null, smtpPass: null, alertFromEmail: null,
  previewToken: "tok" };
const prisma = { setting: { upsert: async () => row, update: async (args) => { calls.push(args); return row; } } };
export default prisma;
`);
await esbuild.build({
  entryPoints: [path.join(HERE, "al-entry.js")], bundle: true, platform: "node", format: "cjs",
  outfile: path.join(HERE, "al.bundle.cjs"),
  external: ["nodemailer"],
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^~\/db\.server$/ }, () => ({ path: path.join(HERE, "al-db-stub.js") }));
    b.onResolve({ filter: /^~\// }, (a) => {
      const base = path.join(ROOT, "app", a.path.slice(2));
      return { path: fs.existsSync(base + ".ts") ? base + ".ts" : base + ".tsx" };
    });
  }}],
});
const svc = require(path.join(HERE, "al.bundle.cjs"));
let fail = 0;
const t = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { fail++; if (detail !== undefined) console.log("   ", detail); } };

/* ----------------------------- A1: recipients ---------------------------- */
t("A1 two addresses", JSON.stringify(svc.parseRecipientList("a@b.com, c@d.com")) === '["a@b.com","c@d.com"]');
t("A1 dedupe case-insensitive", svc.parseRecipientList("A@B.com a@b.com").length === 1);
t("A1 invalid dropped", JSON.stringify(svc.parseRecipientList("not-an-email, x@y.co")) === '["x@y.co"]');
t("A1 semicolons and newlines", svc.parseRecipientList("a@b.com;c@d.com\ne@f.com").length === 3);
t("A1 cap at 5", svc.parseRecipientList("a@1.co b@1.co c@1.co d@1.co e@1.co f@1.co g@1.co").length === 5);
t("A1 null/empty", svc.parseRecipientList(null).length === 0 && svc.parseRecipientList("").length === 0);
t("A1 effective explicit wins",
  JSON.stringify(svc.effectiveRecipients({ alertRecipients: "x@y.co", notifyEmail: "n@n.co" })) === '["x@y.co"]');
t("A1 effective falls back to notifyEmail",
  JSON.stringify(svc.effectiveRecipients({ alertRecipients: null, notifyEmail: "n@n.co" })) === '["n@n.co"]');
t("A1 effective both empty", svc.effectiveRecipients({ alertRecipients: null, notifyEmail: null }).length === 0);
t("A1 sanitizeRecipients canonical", svc.sanitizeRecipients("a@b.com;c@d.com junk") === "a@b.com, c@d.com");
t("A1 sanitizeRecipients all junk -> null", svc.sanitizeRecipients("junk, more junk") === null);

/* ------------------------------ A2: host --------------------------------- */
t("A2 plain host", svc.sanitizeSmtpHost("smtp.gmail.com") === "smtp.gmail.com");
t("A2 scheme+path stripped", svc.sanitizeSmtpHost("smtps://smtp.gmail.com/foo") === "smtp.gmail.com");
t("A2 lowercased", svc.sanitizeSmtpHost("SMTP.Gmail.COM") === "smtp.gmail.com");
t("A2 spaces rejected", svc.sanitizeSmtpHost("smtp host.com") === null);
t("A2 shell-ish rejected", svc.sanitizeSmtpHost("host;rm -rf") === null);
t("A2 overlong rejected", svc.sanitizeSmtpHost("a".repeat(254) + ".com") === null);
t("A2 ipv4 ok", svc.sanitizeSmtpHost("192.168.1.10") === "192.168.1.10");

/* ------------------------------ A3: config ------------------------------- */
const baseSmtp = { smtpHost: "smtp.x.com", smtpPort: 587, smtpSecurity: "starttls", smtpUser: "u@x.com", smtpPass: "p", alertFromEmail: null };
t("A3 no host", svc.resolveSmtpConfig({ ...baseSmtp, smtpHost: null }) === "no_host");
t("A3 from falls back to email-shaped user", svc.resolveSmtpConfig(baseSmtp).from === "u@x.com");
t("A3 explicit from wins",
  svc.resolveSmtpConfig({ ...baseSmtp, alertFromEmail: "f@x.com" }).from === "f@x.com");
t("A3 non-email user, no from", svc.resolveSmtpConfig({ ...baseSmtp, smtpUser: "DOMAIN\\user" }) === "no_from");
t("A3 unknown security -> starttls", svc.resolveSmtpConfig({ ...baseSmtp, smtpSecurity: "weird" }).security === "starttls");
t("A3 bad port -> 587", svc.resolveSmtpConfig({ ...baseSmtp, smtpPort: 0 }).port === 587);

/* ------------------------------- A4: gate -------------------------------- */
const on = { lowStarAlerts: true, lowStarAlertMax: 2 };
const sfront = { rating: 1, source: "storefront", isSynthetic: false };
t("A4 fires on 1-star", svc.shouldAlert(on, sfront) === true);
t("A4 fires on 2-star at max 2", svc.shouldAlert(on, { ...sfront, rating: 2 }) === true);
t("A4 silent on 3-star at max 2", svc.shouldAlert(on, { ...sfront, rating: 3 }) === false);
t("A4 3-star at max 3", svc.shouldAlert({ ...on, lowStarAlertMax: 3 }, { ...sfront, rating: 3 }) === true);
t("A4 toggle off", svc.shouldAlert({ ...on, lowStarAlerts: false }, sfront) === false);
t("A4 csv-import never alerts", svc.shouldAlert(on, { ...sfront, source: "csv-import" }) === false);
t("A4 bulk-add never alerts", svc.shouldAlert(on, { ...sfront, source: "bulk-add" }) === false);
t("A4 synthetic never alerts", svc.shouldAlert(on, { ...sfront, isSynthetic: true }) === false);
t("A4 threshold clamps 7 -> 3", svc.clampThreshold(7) === 3 && svc.shouldAlert({ ...on, lowStarAlertMax: 7 }, { ...sfront, rating: 3 }) === true);
t("A4 threshold clamps NaN -> 2", svc.clampThreshold(NaN) === 2);

/* ------------------------------ A5: email -------------------------------- */
const review = {
  id: "r1", productId: "555", productTitle: "Night Cream", productHandle: "night-cream",
  rating: 1, title: 'Broke <b>out</b> "badly"', body: '<script>alert(1)</script>\nSecond line',
  language: "fr", authorName: "Eve\r\nBcc: victim@x.com", authorEmail: "eve@x.com",
  customerId: "9001", variantTitle: "50ml", verified: true, status: "PENDING",
  ageRange: "25_34", skinConcerns: '["dryness"]', timeUsing: "w1_4", resultsSeen: "[]",
  createdAt: new Date("2026-08-15T10:00:00Z"),
};
const okCtx = {
  status: "ok",
  orders: [{
    id: "777", name: "#1042", createdAt: "2026-08-01T09:00:00Z", fulfillment: "FULFILLED",
    financial: "PAID", total: "89.00 EUR",
    items: [
      { title: "Night Cream", quantity: 1, variantTitle: "50ml", isReviewedProduct: true },
      { title: "Day <Serum>", quantity: 2, variantTitle: null, isReviewedProduct: false },
    ],
    containsReviewedProduct: true,
  }],
  customer: { id: "9001", displayName: "Eve Example", email: "eve@x.com", phone: "+33 6 00 00 00 00", ordersCount: "4" },
};
const mail = svc.buildAlertEmail({ shop: "cellexia-labs.myshopify.com", review, context: okCtx, mediaCount: 2, thresholdMax: 2 });
t("A5 subject has rating + product + author", /1-star review/.test(mail.subject) && mail.subject.includes("Night Cream"));
t("A5 subject header-injection stripped", !/[\r\n]/.test(mail.subject), JSON.stringify(mail.subject));
t("A5 html escapes script tag", !mail.html.includes("<script>") && mail.html.includes("&lt;script&gt;"));
t("A5 html escapes item title", !mail.html.includes("<Serum>") && mail.html.includes("Day &lt;Serum&gt;"));
t("A5 pending status line", mail.text.includes("NOT visible to shoppers yet"));
t("A5 order admin link", mail.text.includes("https://admin.shopify.com/store/cellexia-labs/orders/777"));
t("A5 customer admin link", mail.text.includes("https://admin.shopify.com/store/cellexia-labs/customers/9001"));
t("A5 reviewed-product marker", mail.text.includes("reviewed product"));
t("A5 structured attrs labeled", mail.text.includes("25–34") && mail.text.includes("Dryness") && mail.text.includes("1–4 weeks"));
t("A5 language labeled", mail.text.includes("French"));
t("A5 media count", mail.text.includes("2 attachments"));
t("A5 phone included", mail.text.includes("+33 6 00 00 00 00"));
t("A5 no test banner on real alert", !mail.html.includes("test alert"));

const failMail = svc.buildAlertEmail({ shop: "s.myshopify.com", review, context: { status: "failed", orders: [], customer: null }, mediaCount: 0, thresholdMax: 2 });
t("A5 failed lookup is honest", failMail.text.includes("FAILED") && !failMail.text.includes("No orders were found"));
const emptyMail = svc.buildAlertEmail({ shop: "s.myshopify.com", review, context: { status: "ok", orders: [], customer: null }, mediaCount: 0, thresholdMax: 2 });
t("A5 zero orders says none found", emptyMail.text.includes("No orders were found"));
const unavailMail = svc.buildAlertEmail({ shop: "s.myshopify.com", review, context: { status: "unavailable", orders: [], customer: null }, mediaCount: 0, thresholdMax: 2 });
t("A5 unavailable lookup named", unavailMail.text.includes("unavailable"));
const pubMail = svc.buildAlertEmail({ shop: "s.myshopify.com", review: { ...review, status: "PUBLISHED" }, context: okCtx, mediaCount: 0, thresholdMax: 2 });
t("A5 published status line", pubMail.text.includes("Published — visible to shoppers"));
const testMail = svc.buildAlertEmail({ shop: "s.myshopify.com", review, context: okCtx, mediaCount: 0, thresholdMax: 2, isTest: true });
t("A5 test banner present + [TEST] subject", testMail.subject.startsWith("[TEST]") && /test alert/i.test(testMail.html));
t("A5 oneLine collapses", svc.oneLine("a\r\n b\tc") === "a b c");

/* A5 regressions from the v1.34 adversarial review */
t("A5 financial status rendered (text+html)", mail.text.includes("PAID") && mail.html.includes("PAID"));
t("A5 test email never claims a Reply-To address is set",
  !/Reply-To is set to \S+@/.test(testMail.text) &&
  !testMail.html.includes("Reply-To is set to the reviewer's address") &&
  testMail.text.includes("In a real alert, Reply-To is set to the reviewer"));
t("A5 real email still names the Reply-To", mail.text.includes("Reply-To is set to eve@x.com"));
{
  // Phishing hardening: EMAIL_RE accepts URL-shaped addresses; they must
  // render as inert text, never as <a href> — only the app-built admin links
  // may be hyperlinks.
  const evil = svc.buildAlertEmail({
    shop: "s.myshopify.com",
    review: { ...review, authorEmail: "https://evil.example/pay#@x.com" },
    context: {
      ...okCtx,
      customer: { ...okCtx.customer, displayName: "https://evil2.example/support" },
    },
    mediaCount: 0,
    thresholdMax: 2,
  });
  t("A5 URL-shaped author email is not linkified", !evil.html.includes('href="https://evil.example'));
  t("A5 URL-shaped display name is not linkified", !evil.html.includes('href="https://evil2.example'));
  t("A5 admin links still linkified",
    evil.html.includes('href="https://admin.shopify.com/store/s/customers/9001"') &&
    evil.html.includes('href="https://admin.shopify.com/store/s/orders/777"'));
}

/* --------------------------- A6: order lookup ---------------------------- */
function fakeAdmin(handler) {
  const calls = [];
  return {
    calls,
    graphql: async (_q, opts) => {
      calls.push(opts.variables.query);
      const body = handler(opts.variables.query, calls.length);
      return { json: async () => body };
    },
  };
}
const ORDER_NODE = {
  id: "gid://shopify/Order/777", name: "#1042", createdAt: "2026-08-01T09:00:00Z",
  displayFulfillmentStatus: "FULFILLED", displayFinancialStatus: "PAID",
  totalPriceSet: { shopMoney: { amount: "89.00", currencyCode: "EUR" } },
  customer: { id: "gid://shopify/Customer/9001", displayName: "Eve", email: "eve@x.com", phone: null, numberOfOrders: "4" },
  lineItems: { nodes: [
    { title: "Night Cream", quantity: 1, variantTitle: "50ml", product: { id: "gid://shopify/Product/555" } },
    { title: "Other", quantity: 1, variantTitle: null, product: { id: "gid://shopify/Product/1" } },
  ] },
};
const rev = { productId: "555", authorEmail: "eve@x.com", customerId: "9001" };

{
  const admin = fakeAdmin(() => ({ data: { orders: { nodes: [ORDER_NODE] } } }));
  const ctx = await svc.collectOrderContext(admin, rev);
  t("A6 customer_id query preferred", admin.calls[0] === "customer_id:9001");
  t("A6 one call when it answers", admin.calls.length === 1);
  t("A6 numeric ids extracted", ctx.orders[0].id === "777" && ctx.customer.id === "9001");
  t("A6 reviewed product flagged", ctx.orders[0].containsReviewedProduct === true && ctx.orders[0].items[0].isReviewedProduct === true && ctx.orders[0].items[1].isReviewedProduct === false);
  t("A6 total joined", ctx.orders[0].total === "89.00 EUR");
}
{
  const admin = fakeAdmin((q) => q.startsWith("customer_id") ? { data: { orders: { nodes: [] } } } : { data: { orders: { nodes: [ORDER_NODE] } } });
  const ctx = await svc.collectOrderContext(admin, rev);
  t("A6 falls through to email query", admin.calls.length === 2 && admin.calls[1] === 'email:"eve@x.com"' && ctx.orders.length === 1);
}
{
  const admin = fakeAdmin(() => { throw new Error("boom"); });
  const ctx = await svc.collectOrderContext(admin, rev);
  t("A6 throw -> failed (honest)", ctx.status === "failed" && ctx.orders.length === 0);
}
{
  const admin = fakeAdmin(() => ({ errors: [{ message: "THROTTLED" }] }));
  const ctx = await svc.collectOrderContext(admin, rev);
  t("A6 graphql errors -> failed", ctx.status === "failed");
}
{
  const admin = fakeAdmin(() => ({ data: { orders: { nodes: [] } } }));
  const ctx = await svc.collectOrderContext(admin, rev);
  t("A6 zero everywhere -> ok/none", ctx.status === "ok" && ctx.orders.length === 0);
}
{
  const admin = fakeAdmin(() => ({ data: { orders: { nodes: [ORDER_NODE] } } }));
  const ctx = await svc.collectOrderContext(admin, { productId: "555", authorEmail: null, customerId: null });
  t("A6 no keys -> no calls", admin.calls.length === 0 && ctx.status === "ok");
}
{
  const ctx = await svc.collectOrderContext(null, rev);
  t("A6 null admin -> unavailable", ctx.status === "unavailable");
}
{
  const admin = fakeAdmin(() => ({ data: { orders: { nodes: [ORDER_NODE] } } }));
  await svc.collectOrderContext(admin, { productId: "555", authorEmail: 'e"v\\e @x.com', customerId: null });
  t("A6 email query sanitized", admin.calls.length === 1 && admin.calls[0] === 'email:"eve@x.com"', admin.calls[0]);
}

/* ------------------- A7: outcome recording (real entry) ------------------ */
// Drives the REAL maybeSendLowStarAlert against the recording db stub: the
// settings row has alerts ON but no SMTP host, so every send records
// "No SMTP host configured" — until the per-shop cap (30/h) trips, whose
// dropped record must name the cap verbatim and never claim an SMTP failure.
{
  const sfReview = {
    id: "r2", shop: "s.myshopify.com", productId: "555", productTitle: "X", productHandle: null,
    rating: 1, title: null, body: "bad", language: "en", authorName: "A", authorEmail: "a@b.co",
    customerId: null, country: null, variantTitle: null, verified: false, status: "PENDING",
    ageRange: null, skinConcerns: "[]", timeUsing: null, resultsSeen: "[]", helpfulCount: 0,
    reportCount: 0, reply: null, replyAt: null, ipHash: null, isSynthetic: false, qaChecked: false,
    source: "storefront", syntheticBatchId: null, syntheticGeneratedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  svc.dbCalls.length = 0;
  const origErr = console.error;
  console.error = () => {};
  for (let i = 0; i < 31; i++) await svc.maybeSendLowStarAlert("s.myshopify.com", sfReview, null);
  console.error = origErr;
  const errs = svc.dbCalls.map((c) => c.data && c.data.lastAlertError).filter((e) => typeof e === "string");
  t("A7 all 31 outcomes recorded", errs.length === 31, errs.length);
  t("A7 not_configured recorded honestly", errs[0] === "No SMTP host configured", errs[0]);
  const last = errs[errs.length - 1];
  t("A7 31st alert dropped by the cap, message names the cap",
    typeof last === "string" && last.startsWith("Hourly alert cap reached"), last);
  t("A7 dropped is never labeled an SMTP failure", typeof last === "string" && !last.includes("SMTP send failed"));
}

console.log(fail === 0 ? "\nALL ALERT CASES PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail ? 1 : 0);
