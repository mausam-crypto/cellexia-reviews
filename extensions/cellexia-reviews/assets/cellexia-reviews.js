/* Cellexia Reviews storefront widget — vanilla ES2019, no dependencies.
* Contract: SPEC §6/§8/§9/§15, SPEC-1.2 (gating), SPEC-1.5/1.5.1 (embed,
* badges), SPEC-1.6 (proxy discovery, failure UX), SPEC-1.8 (comment-strip,
* translated mode), SPEC-1.10 §5 (preview bootstrap, PDP badge, overall).
* No innerHTML with user content — DOM built via createElement/textContent only. */
(() => {
"use strict";
/* ===== shared helpers (v1.5: also used by the badge module) ===== */
var SVG_NS = "http://www.w3.org/2000/svg";
function el(tag, cls, text) {
 var e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined && text !== null) e.textContent = text;
 return e;
}
function sa(e, n, v) { e.setAttribute(n, v); }
function ap(p, c) { p.appendChild(c); return c; }
function on(e, n, f, o) { e.addEventListener(n, f, o); }
function ns(tag) { return document.createElementNS(SVG_NS, tag); }
function tx(s) { return document.createTextNode(s); }
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function st(e, s) { for (var k in s) e.style[k] = s[k]; }
function al(e, v) { sa(e, "aria-label", v); }
function btn(cls, text, onClick) {
 var b = el("button", cls, text);
 b.type = "button";
 if (onClick) on(b, "click", onClick);
 return b;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function hideVisually(e) {
 st(e, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" });
}
function debounce(fn, ms) {
 var timer = null;
 return (...args) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; fn.apply(null, args); }, ms);
 };
}
var STAR_PATH = "M10 1.4l2.62 5.35 5.88.83-4.26 4.13 1.02 5.85L10 14.8l-5.26 2.76 1.02-5.85L1.5 7.58l5.88-.83L10 1.4z";
var starUid = 0;
function starSvg(frac, size) {
 var s = ns("svg");
 sa(s, "viewBox", "0 0 20 20");
 sa(s, "aria-hidden", "true");
 sa(s, "width", String(size)); sa(s, "height", String(size));
 sa(s, "class", "cx-star");
 var p = ns("path");
 sa(p, "d", STAR_PATH);
 sa(p, "stroke", "#FF6200");
 sa(p, "stroke-width", "1");
 sa(p, "stroke-linejoin", "round");
 if (frac >= 0.95) {
  sa(p, "fill", "#FF6200");
 } else if (frac <= 0.05) {
  sa(p, "fill", "#FFFFFF");
 } else {
  var id = "cxg" + (++starUid);
  var defs = ns("defs");
  var g = ns("linearGradient");
  sa(g, "id", id);
  sa(g, "x1", "0"); sa(g, "x2", "1");
  sa(g, "y1", "0"); sa(g, "y2", "0");
  var pct = Math.round(frac * 100) + "%";
  var s1 = ns("stop");
  sa(s1, "offset", pct); sa(s1, "stop-color", "#FF6200");
  var s2 = ns("stop");
  sa(s2, "offset", pct); sa(s2, "stop-color", "#FFFFFF");
  ap(g, s1); ap(g, s2); ap(defs, g);
  ap(s, defs);
  sa(p, "fill", "url(#" + id + ")");
 }
 ap(s, p);
 return s;
}
function starRowCore(rating, size, label) {
 var wrap = el("span", "cx-stars");
 sa(wrap, "role", "img");
 al(wrap, label);
 for (var i = 0; i < 5; i++) {
  ap(wrap, starSvg(Math.max(0, Math.min(1, rating - i)), size || 16));
 }
 return wrap;
}
/* storage */
function lsGet(key) {
 try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, val) {
 try { window.localStorage.setItem(key, val); } catch (e) { /* private mode */ }
}
function ssGet(key) {
 try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
}
function ssSet(key, val) {
 try { window.sessionStorage.setItem(key, val); } catch (e) {}
}
function ssDel(key) {
 try { window.sessionStorage.removeItem(key); } catch (e) {}
}
/* Reads `?cx_preview=` + persists it for the session — only when NOT live (or
   design mode): a live store cannot verify it (§9). See getPreviewToken(). */
function urlPreviewToken() {
 try { return new URLSearchParams(window.location.search).get("cx_preview") || null; } catch (e) { return null; }
}
function discoverPreviewToken() {
 var urlToken = urlPreviewToken();
 if (urlToken) {
  ssSet("cx_preview_token", urlToken);
  return urlToken;
 }
 return ssGet("cx_preview_token");
}
/* v1.6 §3 — design-mode-only editor token (RC-A). Liquid emits it only in
   design mode; we re-check, and never persist it. */
function editorToken(root, cfgE) {
 if (!inDesignMode()) return null;
 var v = null;
 try { v = root && root.getAttribute ? root.getAttribute("data-cx-editor-token") : null; } catch (e) {}
 if (typeof v === "string" && v.trim()) return v.trim();
 v = cfgE && cfgE.editorToken;
 return typeof v === "string" && v.trim() ? v.trim() : null;
}
/* ===== v1.10 (SPEC-1.10 §5A) shared preview bootstrap: ONE accessor serves
   widget + badges + overall; start() captures ?cx_preview on EVERY page.
   v1.6.1 nuance kept: live store ⇒ URL-only, never persisted. */
var pageLiveCache;
function pageIsLive() {
 if (pageLiveCache !== undefined) return pageLiveCache;
 var c = readEmbedConfig(), roots, i;
 if (c && typeof c.live === "boolean") return (pageLiveCache = c.live);
 try { roots = document.querySelectorAll("[data-cx-live]"); } catch (e) { roots = []; }
 for (i = 0; i < roots.length; i++) {
  if (roots[i].getAttribute("data-cx-live") === "false") return (pageLiveCache = false);
 }
 return (pageLiveCache = true);
}
function getPreviewToken(root, cfgE) {
 if (pageIsLive() && !inDesignMode()) return urlPreviewToken();
 return discoverPreviewToken() || editorToken(root, cfgE);
}
// Capture once + ribbon on ANY tokenized not-live page (widget root or not).
function previewBootstrap() {
 try {
  var live = pageIsLive(), design = inDesignMode(), u = urlPreviewToken();
  if (u && (!live || design)) ssSet("cx_preview_token", u);
  if (!live && !design && (u || ssGet("cx_preview_token"))) {
   var r = anyRoot() || qsSafe(".cx-overall");
   renderPreviewBar(makeI18n((r && r.getAttribute("data-locale")) || document.documentElement.lang || "en").t);
  }
 } catch (e) {}
}

/* ===== v1.6 §2 — app-proxy path rescue: if cx-proxy.liquid's value is wrong
   (404/410 or non-JSON), ONE sweep per page-load over the candidate subpaths,
   cache the winner, retry once; the memoised promise is shared with badges. */
var PROXY_CANDIDATES = ["cellexia-reviews", "cellexia", "reviews", "cellexia-review"];
var PROXY_BASE_RE = /^\/apps\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}\/api$/;
var resolvedProxyBase = null;  // sweep winner, or the sessionStorage cache
var proxySweep = null;         // memoised: at most one sweep per page-load
var proxyTried = [];           // bases proven broken (shown in the merchant notice)
function noteTried(base) { if (base && proxyTried.indexOf(base) < 0) proxyTried.push(base); }
// A base proven working this session beats a data-proxy we proved broken.
function seedProxyBase() {
 if (!resolvedProxyBase) {
  var c = (ssGet("cx_proxy_base") || "").replace(/\s+/g, "").replace(/\/+$/, "");
  if (PROXY_BASE_RE.test(c)) resolvedProxyBase = c;
 }
 return resolvedProxyBase;
}
// Hit = 200 + JSON naming this app; 404 HTML, other apps, 4 s timeout: miss (§2).
function probeProxyBase(base) {
 if (!window.fetch) return Promise.resolve(false);
 var ctrl = null, opts = { credentials: "same-origin" };
 try { ctrl = new AbortController(); opts.signal = ctrl.signal; } catch (e) {}
 var timer = ctrl ? window.setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 4000) : null;
 var stop = (v) => { if (timer) clearTimeout(timer); return v; };
 return window.fetch(base + "/ping", opts).then((r) => {
  stop();
  return r.ok ? r.json().then((b) => { return !!(b && b.app === "cellexia-reviews"); }, () => false) : false;
 }, () => stop(false));
}
function runProxyDiscovery(failedBase) {
 noteTried(failedBase);
 if (proxySweep) return proxySweep;
 var list = [];
 PROXY_CANDIDATES.forEach((c) => {
  var b = "/apps/" + c + "/api";
  if (b !== failedBase && list.indexOf(b) < 0) list.push(b);
 });
 var idx = 0;
 function step() {
  if (idx >= list.length) return Promise.resolve(null);
  var base = list[idx++];
  return probeProxyBase(base).then((ok) => {
   if (ok) return base;
   noteTried(base);
   return step();
  });
 }
 proxySweep = step().then((found) => {
  if (found) { resolvedProxyBase = found; ssSet("cx_proxy_base", found); }
  return found;
 }, () => null);
 return proxySweep;
}
function badPathError(status) {
 var e = new Error("cx_bad_path_" + status);
 e.cxBadPath = true;
 return e;
}
/* v1.8 (SPEC-1.8 §5, layer 2) — Shopify comment-wraps app-snippet renders,
   poisoning Liquid-carried proxy values. Liquid strips at the source; here:
   drop comments + whitespace, accept only "/apps/<subpath>/api", else "" so
   the caller falls back to the default base + §2 discovery sweep. */
function cleanProxyValue(v) {
 if (typeof v !== "string" || !v) return "";
 var s = v.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, "").replace(/\/+$/, "");
 return PROXY_BASE_RE.test(s) ? s : "";
}
/* i18n: flat dict from #cx-i18n + Intl formatters for one locale. */
function makeI18n(locale) {
 var STRINGS = {};
 (function loadDict() {
  var tag = document.getElementById("cx-i18n");
  if (!tag) return;
  var parsed;
  try { parsed = JSON.parse(tag.textContent); } catch (e) { return; }
  // v1.15: decode HTML entities (Translate & Adapt overrides smuggle them
  // in; textContent would show "&#39;" literally). SINGLE pass so decoded
  // output is never rescanned ("&#38;amp;" stays the literal "&amp;",
  // review fix). Named table = the typographic set translation tools emit;
  // unknown entities pass through untouched.
  var ENTS = { quot: '"', apos: "'", nbsp: "\u00A0", lt: "<", gt: ">", amp: "&",
   rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
   hellip: "\u2026", ndash: "\u2013", mdash: "\u2014", middot: "\u00B7",
   laquo: "\u00AB", raquo: "\u00BB", deg: "\u00B0", euro: "\u20AC",
   eacute: "\u00E9", egrave: "\u00E8", ecirc: "\u00EA", euml: "\u00EB",
   agrave: "\u00E0", acirc: "\u00E2", ccedil: "\u00E7", icirc: "\u00EE",
   iuml: "\u00EF", ocirc: "\u00F4", ugrave: "\u00F9", ucirc: "\u00FB",
   uuml: "\u00FC", ouml: "\u00F6", auml: "\u00E4", aring: "\u00E5",
   aelig: "\u00E6", oslash: "\u00F8", szlig: "\u00DF", ntilde: "\u00F1" };
  function deent(s) {
   if (s.indexOf("&") === -1) return s;
   return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,10}));/gi, function (m, d, h, nm) {
    try {
     if (d) return String.fromCodePoint(+d);
     if (h) return String.fromCodePoint(parseInt(h, 16));
     var v = ENTS[nm.toLowerCase()];
     return v === undefined ? m : v;
    } catch (e) { return m; }
   });
  }

  (function flatten(obj, prefix) {
   for (var k in obj) {
    if (!own(obj, k)) continue;
    var v = obj[k];
    var p = prefix ? prefix + "." + k : k;
    if (v !== null && typeof v === "object") flatten(v, p);
    else STRINGS[p] = deent(String(v));
   }
  })(parsed, "");
 })();
 function str(key) {
  if (STRINGS[key] !== undefined) return STRINGS[key];
  if (STRINGS["cellexia." + key] !== undefined) return STRINGS["cellexia." + key];
  return null;
 }
 var NF, NF1, DF, PR;
 try { NF = new Intl.NumberFormat(locale); } catch (e) { NF = new Intl.NumberFormat("en"); }
 try { NF1 = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }); } catch (e) { NF1 = NF; }
 try { DF = new Intl.DateTimeFormat(locale, { dateStyle: "long" }); } catch (e) { DF = new Intl.DateTimeFormat("en", { dateStyle: "long" }); }
 try { PR = new Intl.PluralRules(locale); } catch (e) { PR = new Intl.PluralRules("en"); }
 function fmtNum(n) { return NF.format(n); }
 function fmtDate(iso) {
  var d = new Date(iso);
  return isNaN(d.getTime()) ? "" : DF.format(d);
 }
 // [[var]] substitution — also used by the notice fallbacks (v1.6.1 §B).
 function fill(s, vars) {
  vars = vars || {};
  return String(s).replace(/\[\[(\w+)\]\]/g, (m, name) => {
   if (!(name in vars)) return m;
   var v = vars[name];
   return typeof v === "number" ? fmtNum(v) : String(v);
  });
 }
 function t(key, vars) {
  vars = vars || {};
  var s = null;
  if (typeof vars.count === "number") {
   var cat = PR.select(vars.count);
   s = str(key + "." + cat);
   if (s === null && cat !== "other") s = str(key + ".other");
   if (s === null) s = str(key + ".one");
  }
  if (s === null) s = str(key);
  if (s === null) return key;
  return fill(s, vars);
 }
 return { t: t, str: str, fill: fill, fmtNum: fmtNum, fmtDate: fmtDate, NF1: NF1 };
}
/* v1.2 preview ribbon (mounted at most once). */
var previewBar = null;
function renderPreviewBar(t) {
 if (previewBar) return;
 previewBar = el("div", "cx-preview-bar");
 sa(previewBar, "role", "status");
 ap(previewBar, el("strong", "cx-preview-bar__badge", t("preview.badge")));
 ap(previewBar, el("span", "cx-preview-bar__note", t("preview.note")));
 ap(previewBar, btn("cx-preview-bar__exit", t("preview.exit"), () => {
  ssDel("cx_preview_token");
  removeStampedHide(); // v1.14 §5: leaving preview restores Stamped instantly
  // Strip ?cx_preview before reloading or the reload re-enters preview.
  try {
   var u = new URL(window.location.href);
   if (u.searchParams.has("cx_preview")) {
    u.searchParams.delete("cx_preview");
    window.history.replaceState(null, "", u.toString());
   }
  } catch (e) { /* old browsers: at worst one extra preview view */ }
  window.location.reload();
 }));
 ap(document.body, previewBar);
}
function removePreviewBar() {
 if (previewBar && previewBar.parentNode) previewBar.parentNode.removeChild(previewBar);
 previewBar = null;
}

/* §4/§6: fallback for a #cx-i18n dictionary predating this release.
   MERCHANT-ONLY, so it can never reach a shopper. */
var NOTICE_FALLBACK = {
 expired_title: "Preview session expired",
 expired_body: "Reopen “Preview on your store” from the app’s Dashboard to continue previewing.",
 unconfigured_title: "Storefront connection not configured",
 unconfigured_body: "Open the app in your Shopify admin → Dashboard → “Test storefront connection”.",
 empty_merchant: "No reviews yet — import your reviews or generate test data in the app.",
 // v1.6.1 §B — reviews DO exist, they are just unapproved.
 empty_pending: "No published reviews yet — [[count]] awaiting approval in the app.",
 // v1.10 §5C — merchant preview of the Overall block before any data sync.
 overall_pending: "Overall reviews will appear here once review data is synced. Open the app's Display order page and press Refresh homepage data."
};

/* v1.10 §5D — stale token on a badge-only page: tell the merchant once.
   Merchant-only by construction (called only when a token was sent). */
var pageNotice = false;
function showExpiredPageNotice(I) {
 if (pageNotice) return;
 pageNotice = true;
 try {
  if (document.querySelector(".cx-notice--merchant")) return; // a surface already told them
  var wrap = el("div", "cx cx-page-notice");
  var box = ap(wrap, el("div", "cx-notice cx-notice--merchant"));
  sa(box, "role", "status");
  ap(box, el("strong", "cx-notice__title", I.str("notice.expired_title") || NOTICE_FALLBACK.expired_title));
  ap(box, el("p", "cx-notice__body", I.str("notice.expired_body") || NOTICE_FALLBACK.expired_body));
  var m = qsSafe("main") || qsSafe("#MainContent") || document.body;
  m.insertBefore(wrap, m.firstChild);
 } catch (e) {}
}

function boot(root) {
if (!root) return;
if (root.getAttribute("data-cx-hydrated") === "true") return;
sa(root, "data-cx-hydrated", "true");

/* ---- config ---- */
function attr(name, dflt) {
 var v = root.getAttribute("data-" + name);
 return v === null || v === "" ? dflt : v;
}
function flag(name, dflt) {
 var v = root.getAttribute("data-" + name);
 if (v === null || v === "") return dflt;
 return v === "true" || v === "1";
}
var cfg = {
 productId: attr("product-id", ""),
 productHandle: attr("product-handle", ""), // v1.5: sent with review POSTs
 locale: attr("locale", "en"),
 // cx-proxy.liquid single-sources this from cellexia.proxy_path (§2).
 // v1.8 §5: comment-strip + validate; invalid ⇒ default base + discovery.
 proxy: cleanProxyValue(attr("proxy", "")) || "/apps/cellexia-reviews/api",
 perPage: parseInt(attr("per-page", "10"), 10) || 10,
 defaultLocale: attr("shop-default-locale", "en"),
 showSummary: flag("show-summary", true),
 showMediaStrip: flag("show-media-strip", true),
 showForm: flag("show-form", true),
 showTranslate: flag("show-translate", true),
 demo: attr("demo", "false") === "true",
 brand: attr("brand", "Cellexia"),
 market: attr("market", ""), // v1.14 §6: Liquid-emitted market handle
 // v1.16 §3: Q&A — server ride-along turns showQna on; the block attr can
 // veto per-surface.
 showQna: false,
 showQnaBlock: flag("show-qna", true),
 // v1.8 §4: "original" (default) | "translated". Set only by the server
 // settings ride-along — demo mode never carries it, so demo is unchanged.
 translationDisplay: "original"
};

/* ---- v1.2 live/preview gating + v1.6 token resolution (§3) ---- */
// data-cx-live absent ⇒ live; not live: only a token un-hides the root.
var isLive = attr("cx-live", "true") !== "false";
var designMode = inDesignMode();
var isEmbed = root.getAttribute("data-cx-embed") === "true";
// RC-A: editor authenticates via token. v1.6.1 §B: LIVE stores carry a
// URL-only token (never persisted; server validates before returning meta).
var previewToken = getPreviewToken(root, readEmbedConfig()); // v1.10 §5A shared accessor, same rules
// §4 failure UX gate. Token holders are merchants on LIVE stores too (same
// rule as the ribbon; notices carry no shop data — DATA stays server-gated).
var isMerchantContext = designMode || !!previewToken;
if (!isLive) {
 if (previewToken || designMode) {
  root.hidden = false; // preview / editor visible; failures handled per §4
 } else {
  if (isEmbed) root.hidden = true; // re-hide the relocated embed shell
  return; // block root stays hidden: zero fetches, zero pixels
 }
}
seedProxyBase();
function currentBase() { return resolvedProxyBase || cfg.proxy; }
var MEDIA_LIMITS = {
 images: 5, videos: 1, imgMb: 8, vidMb: 80,
 imgTypes: ["image/jpeg", "image/png", "image/webp", "image/heic"],
 imgExt: /\.(jpe?g|png|webp|heic)$/i,
 vidTypes: ["video/mp4", "video/quicktime", "video/webm"],
 vidExt: /\.(mp4|mov|webm)$/i
};
var AGE_RANGES = ["under_25", "25_34", "35_44", "45_54", "55_64", "65_plus"];
var SKIN_CONCERNS = ["fine_lines", "dark_spots", "dryness", "dullness", "firmness", "texture", "sensitivity", "redness", "pores", "dark_circles"];
var TIME_USING = ["lt_1w", "w1_4", "m1_3", "m3_6", "gt_6m"];
var RESULTS_SEEN = ["smoother", "fewer_lines", "firmer", "radiance", "even_tone", "hydration", "calmer", "too_early"];
var REPORT_REASONS = ["off_topic", "inappropriate", "spam", "privacy", "other"];

/* ---- i18n (shared factory) ---- */
var I18N = makeI18n(cfg.locale);
var t = I18N.t, str = I18N.str, fill = I18N.fill, fmtNum = I18N.fmtNum, fmtDate = I18N.fmtDate, NF1 = I18N.NF1;
var tw = (k, v) => t("widget." + k, v);
var tf = (k, v) => t("form." + k, v);
var trs = (k, v) => t("review." + k, v);
function langName(code) {
 try {
  var n = new Intl.DisplayNames([cfg.locale], { type: "language" }).of(code);
  return n || code;
 } catch (e) { return code; }
}
function regionName(code) {
 try {
  var n = new Intl.DisplayNames([cfg.locale], { type: "region" }).of(code);
  return n || code;
 } catch (e) { return code; }
}

/* ---- DOM helpers (shared ones at IIFE scope) ---- */
function svgIcon(pathD, viewBox, cls, filled) {
 var s = ns("svg");
 sa(s, "viewBox", viewBox || "0 0 20 20");
 sa(s, "aria-hidden", "true");
 sa(s, "focusable", "false");
 sa(s, "width", "16"); sa(s, "height", "16");
 if (cls) sa(s, "class", cls);
 var p = ns("path");
 sa(p, "d", pathD);
 sa(p, "fill", filled === false ? "none" : "currentColor");
 if (filled === false) { sa(p, "stroke", "currentColor"); sa(p, "stroke-width", "1.5"); }
 ap(s, p);
 return s;
}
var ICON_SEARCH = "M8.5 3a5.5 5.5 0 0 1 4.38 8.82l3.65 3.65-1.06 1.06-3.65-3.65A5.5 5.5 0 1 1 8.5 3zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";
var ICON_ARROW_UP = "M5 15 15 5m0 0H7m8 0v8";
// v1.16 §3: Q&A icons — neutral sparkle + submit arrow (never Amazon's marks).
var ICON_SPARK = "M10 2l1.8 4.7L17 8.5l-4.6 1.9L10 15l-1.8-4.6L3.6 8.5l5.2-1.8L10 2zm6 9l.9 2.3 2.1.9-2.1.9L16 17l-.9-1.9-2.1-.9 2.1-.9L16 11z";
var ICON_ARROW_RIGHT = "M4 10h11m0 0l-4-4m4 4l-4 4";
function starRow(rating, size) {
 return starRowCore(rating, size, t("a11y.stars_label", { rating: NF1.format(rating) }));
}
function highlightInto(parent, text, terms, markTag) {
 if (!text) return;
 if (!terms || !terms.length) { ap(parent, tx(text)); return; }
 var lower = text.toLowerCase();
 var i = 0;
 while (i < text.length) {
  var best = -1, len = 0;
  for (var j = 0; j < terms.length; j++) {
   var term = String(terms[j]).toLowerCase();
   if (!term) continue;
   var idx = lower.indexOf(term, i);
   if (idx >= 0 && (best < 0 || idx < best || (idx === best && term.length > len))) {
    best = idx; len = term.length;
   }
  }
  if (best < 0) { ap(parent, tx(text.slice(i))); break; }
  if (best > i) ap(parent, tx(text.slice(i, best)));
  var m = el(markTag || "mark");
  m.textContent = text.slice(best, best + len);
  ap(parent, m);
  i = best + len;
 }
}

/* ---- storage (shared helpers at IIFE scope) ---- */
function visitorToken() {
 var tok = lsGet("cx_visitor_token");
 if (tok) return tok;
 if (window.crypto && typeof window.crypto.randomUUID === "function") {
  tok = window.crypto.randomUUID();
 } else {
  tok = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
   var r = Math.random() * 16 | 0;
   return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
 }
 lsSet("cx_visitor_token", tok);
 return tok;
}
var helpfulSet = (() => {
 var raw = lsGet("cx_helpful");
 var set = {};
 if (raw) {
  try { JSON.parse(raw).forEach((id) => { set[id] = true; }); } catch (e) {}
 }
 return set;
})();
function markHelpful(id) {
 helpfulSet[id] = true;
 lsSet("cx_helpful", JSON.stringify(Object.keys(helpfulSet)));
}
var trCache = {};      // reviewId -> {title, body, reply} for cfg.locale
var reportedSet = {};  // reviewId -> true (session only)
/* v1.8 §4 translated display mode: review.translated {title,body,reply,from}
   renders BY DEFAULT with a See original ⇄ See translation toggle; reviews
   without the payload keep the classic Translate button — never an error. */
var showOriginalIds = {}; // reviewId -> true while "See original" is chosen
function autoTranslation(r) {
 if (cfg.translationDisplay !== "translated") return null;
 var v = r && r.translated;
 if (!v || typeof v !== "object" || typeof v.body !== "string" || !v.body) return null;
 return v;
}

/* ---- API layer (with demo adapter) ---- */
function qs(params) {
 var parts = [];
 for (var k in params) {
  if (!own(params, k)) continue;
  var v = params[k];
  if (v === undefined || v === null || v === "" || v === false || v === 0) continue;
  parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v === true ? 1 : v)));
 }
 return parts.length ? "?" + parts.join("&") : "";
}
// v1.2: 403 not_live without a valid token → hide the widget quietly.
function httpError(status, body) {
 var err = new Error("http_" + status);
 if (status === 403 && body && body.errors && body.errors._ === "not_live") err.cxNotLive = true;
 return err;
}
function withPreview(body) {
 if (previewToken) body.preview_token = previewToken;
 return body;
}
/* §2/§4 — one classified transport: 404/410 or non-JSON <500 ⇒ cxBadPath;
   403 not_live ⇒ cxNotLive; else plain (network/5xx). POSTs still RESOLVE
   on ordinary 4xx (422, 429) — the form shows those inline. */
function sendOnce(url, init) {
 return window.fetch(url, init).then((r) => {
  if (r.status === 404 || r.status === 410) throw badPathError(r.status);
  return r.text().then((text) => {
   var body = null;
   if (!text) throw r.ok ? badPathError(r.status) : httpError(r.status, null);
   try {
    body = JSON.parse(text);
   } catch (e) {
    // HTML from Shopify or another app ⇒ wrong path; a real 5xx stays a 5xx.
    throw r.status >= 500 ? httpError(r.status, null) : badPathError(r.status);
   }
   if (r.ok) return body;
   var err = httpError(r.status, body);
   if (err.cxNotLive || !init.method) throw err; // GETs reject, POSTs resolve
   return body;
  });
 });
}
// One shared discovery sweep, then exactly one retry — never a loop.
function proxySend(buildUrl, init) {
 var base = currentBase();
 return sendOnce(buildUrl(base), init).catch((err) => {
  if (!err || !err.cxBadPath) throw err;
  return runProxyDiscovery(base).then((found) => {
   if (!found || found === base) throw err;
   return sendOnce(buildUrl(found), init);
  });
 }).catch((err) => {
  if (err && err.cxNotLive) handleNotLive();
  throw err;
 });
}
function getJSON(path, params) {
 return proxySend((base) => { return base + path + qs(params); }, { credentials: "same-origin" });
}
function postJSON(path, body) {
 var payload = JSON.stringify(withPreview(body));
 return proxySend((base) => { return base + path; }, {
  method: "POST", credentials: "same-origin",
  headers: { "Content-Type": "application/json" }, body: payload
 });
}
function demoData() { return window.CellexiaDemoData || {}; }
function demoDelay(value) { return Promise.resolve(value); }
function reviewMatches(r, state, topics) {
 if (state.stars && r.rating !== state.stars) return false;
 if (state.verified && !r.verified) return false;
 if (state.withMedia && !(r.media && r.media.length)) return false;
 if (state.ageRange && r.ageRange !== state.ageRange) return false;
 if (state.timeUsing && r.timeUsing !== state.timeUsing) return false;
 if (state.skinConcern && (r.skinConcerns || []).indexOf(state.skinConcern) < 0) return false;
 if (state.resultsSeen && (r.resultsSeen || []).indexOf(state.resultsSeen) < 0) return false;
 if (state.q) {
  var q = state.q.toLowerCase();
  var hay = ((r.title || "") + " " + (r.body || "")).toLowerCase();
  if (hay.indexOf(q) < 0) return false;
 }
 if (state.topic) {
  var topic = null;
  for (var i = 0; i < topics.length; i++) if (topics[i].key === state.topic) topic = topics[i];
  if (topic && topic.reviewIds && topic.reviewIds.length) {
   if (topic.reviewIds.indexOf(r.id) < 0) return false;
  } else if (topic && topic.terms && topic.terms.length) {
   var body = ((r.title || "") + " " + (r.body || "")).toLowerCase();
   var hit = false;
   for (var j = 0; j < topic.terms.length; j++) {
    if (body.indexOf(String(topic.terms[j]).toLowerCase()) >= 0) { hit = true; break; }
   }
   if (!hit) return false;
  }
 }
 return true;
}
function demoList(state) {
 var d = demoData();
 var topics = (d.summary && d.summary.topics) || [];
 var all = (d.reviews || []).filter((r) => { return reviewMatches(r, state, topics); });
 all.sort((a, b) => {
  if (state.sort === "recent") return new Date(b.createdAt) - new Date(a.createdAt);
  if ((b.helpfulCount || 0) !== (a.helpfulCount || 0)) return (b.helpfulCount || 0) - (a.helpfulCount || 0);
  if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
  return new Date(b.createdAt) - new Date(a.createdAt);
 });
 var per = state.perPage;
 var total = all.length;
 var pages = Math.max(1, Math.ceil(total / per));
 var page = Math.min(state.page, pages);
 return demoDelay({
  product: d.product,
  summary: d.summary || null,
  reviews: all.slice((page - 1) * per, page * per),
  media_gallery: page === 1 ? (d.media_gallery || []).slice(0, 12) : [],
  page: page, per_page: per, total: total, total_pages: pages
 });
}
function apiList(state) {
 if (cfg.demo) return demoList(state);
 return getJSON("/reviews", {
  product_id: cfg.productId,
  page: state.page,
  per_page: state.perPage,
  sort: state.sort,
  stars: state.stars,
  verified: state.verified,
  with_media: state.withMedia,
  age_range: state.ageRange,
  time_using: state.timeUsing,
  skin_concern: state.skinConcern,
  results_seen: state.resultsSeen,
  topic: state.topic,
  q: state.q,
  market: cfg.market, // v1.14 §6: observed-market source (recorded token-gated)
  locale: cfg.locale,
  preview_token: previewToken
 });
}
function apiVote(reviewId) {
 if (cfg.demo) {
  var d = demoData();
  var n = 1;
  (d.reviews || []).forEach((r) => {
   if (r.id === reviewId) { r.helpfulCount = (r.helpfulCount || 0) + 1; n = r.helpfulCount; }
  });
  return demoDelay({ ok: true, helpfulCount: n });
 }
 return postJSON("/reviews/" + encodeURIComponent(reviewId) + "/vote", { token: visitorToken() });
}
function apiReport(reviewId, reason) {
 if (cfg.demo) return demoDelay({ ok: true });
 return postJSON("/reviews/" + encodeURIComponent(reviewId) + "/report", {
  token: visitorToken(), reason: reason
 });
}
function demoTranslation(id, target) {
 var tr = demoData().translations || {};
 if (tr[id] && tr[id][target]) return tr[id][target];
 if (tr[target] && tr[target][id]) return tr[target][id];
 return null;
}
function apiTranslate(ids, target) {
 if (cfg.demo) {
  var out = {};
  ids.forEach((id) => {
   var v = demoTranslation(id, target);
   if (v) out[id] = v;
  });
  return demoDelay({ ok: true, translations: out });
 }
 return postJSON("/translate", { ids: ids, target: target });
}
function apiSummary(locale) {
 if (cfg.demo) return demoDelay({ summary: demoData().summary || null });
 return getJSON("/summary", { product_id: cfg.productId, locale: locale, preview_token: previewToken });
}
function apiSubmit(formData) {
 if (cfg.demo) {
  return demoDelay({ ok: true, status: "PENDING" });
 }
 if (previewToken) formData.append("preview_token", previewToken);
 // Multipart, same transport (re-sending FormData is safe: a 404 never reached us).
 return proxySend((base) => { return base + "/reviews"; },
  { method: "POST", credentials: "same-origin", body: formData });
}

/* ---- state & containers ---- */
var state = {
 page: 1, perPage: cfg.perPage, sort: "top",
 stars: 0, verified: false, withMedia: false,
 ageRange: "", skinConcern: "", timeUsing: "", resultsSeen: "",
 topic: "", q: ""
};
var data = {
 product: null, summary: null, reviews: [], gallery: [],
 total: 0, totalPages: 0, loading: false, error: false,
 errorKind: "", // v1.6 §4: "not_live" | "bad_path" | "network"
 pendingCount: 0 // v1.6.1 §B: merchant-only, from res.meta.pendingCount
};
var activeTerms = [];        // highlight terms of the active topic
var translatedIds = {};      // reviewId -> true when showing translation
var allTranslated = false;
var firstLoadDone = false;
// SPEC-1.12 §2: the PDP badge popover's star rows drive the widget filter.
on(root, "cellexia:set-stars", (ev) => {
 var n = ev && ev.detail ? Number(ev.detail.stars) : 0;
 if (n >= 1 && n <= 5 && n !== state.stars) { state.stars = n; reload(); }
});
var SECTION_FALLBACKS = { // legacy container-name lookups
 "media-strip": ".cx-strip",
 "active-filters": ".cx-pills",
 "pagination": ".cx-load-more"
};
function section(name) {
 var found = root.querySelector('[data-cx="' + name + '"]') ||
  root.querySelector("#cx-" + name) ||
  root.querySelector(".cx-" + name) ||
  (SECTION_FALLBACKS[name] ? root.querySelector(SECTION_FALLBACKS[name]) : null);
 if (found) return found;
 var made = el("div", "cx-" + name);
 sa(made, "data-cx", name);
 ap(root, made);
 return made;
}
var secHeader = section("header");
var secSummary = section("summary");
var secQna = section("qna"); // v1.16 §3 (auto-created; sits after summary)
var secMedia = section("media-strip");
var secControls = section("controls");
var secList = section("list");
var secFilters = section("active-filters");
var secPagination = section("pagination");
var secWrite = section("write");
// v1.5: embed shells hydrate flat — wrap in the block's cx-layout (reviews.liquid).
if (isEmbed && !root.querySelector(".cx-layout")) {
 var lay = ap(root, el("div", "cx-layout"));
 var rail = ap(lay, el("div", "cx-layout__rail"));
 var mainCol = ap(lay, el("div", "cx-layout__main"));
 [secHeader, secSummary, secQna, secWrite].forEach((s) => { ap(rail, s); });
 [secMedia, secControls, secFilters, secList, secPagination].forEach((s) => { ap(mainCol, s); });
}
if (secFilters.parentNode && secList.parentNode) { // pills sit above the list
 secList.parentNode.insertBefore(secFilters, secList);
}
// v1.16 §3: the Q&A box sits directly under the summary — unless the theme
// block omitted the summary container entirely (show_summary unchecked), in
// which case section() appended a stray summary div at the ROOT END and
// anchoring there would sink the box to the bottom (review fix): detect the
// misorder and anchor under the header instead.
(function placeQna() {
 var anchor = secSummary;
 try {
  if (secList && secSummary.compareDocumentPosition(secList) & 2) anchor = secHeader;
 } catch (e) {}
 if (anchor.parentNode) anchor.parentNode.insertBefore(secQna, anchor.nextSibling);
})();
// Snapshot reviews.liquid's SSR cards so a failed load restores them.
var ssrCards = Array.prototype.filter.call(secList.children, (n) => {
 return n.nodeType === 1 && n.hasAttribute("data-cx-ssr");
});
function restoreSsrCards() {
 if (!ssrCards.length) return false;
 for (var si = 0; si < ssrCards.length; si++) ap(secList, ssrCards[si]);
 return true;
}
var liveRegion = el("div", "cx-live");
sa(liveRegion, "aria-live", "polite");
hideVisually(liveRegion);
ap(root, liveRegion);
function announce(msg) { liveRegion.textContent = msg; }
var cardRefs = {}; // reviewId -> card element (for topic "Read more" + rerenders)

/* ---- dialog infrastructure ---- */
var currentDialogClose = null; // v1.2: lets handleNotLive() shut an open dialog
var reducedMotion = false;
try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
function focusables(node) {
 return Array.prototype.filter.call(
  node.querySelectorAll("a[href],button,input,select,textarea,[tabindex]"),
  (e) => { return !e.disabled && e.tabIndex !== -1 && e.offsetParent !== null; }
 );
}
function openDialog(className, build) {
 var prevFocus = document.activeElement;
 var mobile = window.innerWidth < 768;
 var overlay = el("div", "cx-overlay");
 st(overlay, { position: "fixed", inset: "0", background: "rgba(15,17,17,0.45)", zIndex: "2147480000", // --cx-z
  display: "flex", alignItems: mobile ? "flex-end" : "center", justifyContent: "center" });
 var dialog = el("div", "cx-dialog " + (className || "") + (mobile ? " cx-sheet" : ""));
 sa(dialog, "role", "dialog");
 sa(dialog, "aria-modal", "true");
 // Skins: top-layer surfaces copy the root's CURRENT skin attr when opened.
 var skin = root.getAttribute("data-cx-skin");
 if (skin) { sa(overlay, "data-cx-skin", skin); sa(dialog, "data-cx-skin", skin); }
 st(dialog, { background: "#FFFFFF", maxHeight: "88vh", overflowY: "auto",
  width: mobile ? "100%" : "calc(100% - 32px)", maxWidth: mobile ? "none" : "560px" });
 ap(overlay, dialog);
 var prevOverflow = document.body.style.overflow;
 document.body.style.overflow = "hidden";
 function close() {
  if (currentDialogClose === close) currentDialogClose = null;
  document.removeEventListener("keydown", onKey, true);
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  document.body.style.overflow = prevOverflow;
  if (prevFocus && prevFocus.focus) prevFocus.focus();
 }
 function onKey(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
  if (ev.key !== "Tab") return;
  var f = focusables(dialog);
  if (!f.length) return;
  var first = f[0], last = f[f.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
 }
 on(overlay, "click", (ev) => { if (ev.target === overlay) close(); });
 on(document, "keydown", onKey, true);
 build(dialog, close);
 currentDialogClose = close;
 ap(document.body, overlay);
 var f = focusables(dialog);
 if (f.length) f[0].focus();
 return { close: close, dialog: dialog };
}
function dialogCloseButton(close) {
 var b = btn("cx-dialog__close", "✕", close);
 al(b, t("a11y.close_dialog"));
 return b;
}
function dlgHead(dialog, close, title) {
 var head = ap(dialog, el("div", "cx-dialog__head"));
 ap(head, el("h2", "cx-dialog__title", title));
 ap(head, dialogCloseButton(close));
}

/* ---- v1.6 merchant notices (SPEC-1.6 §4) ---- */
// Absolute rule: null unless isMerchantContext — a shopper never sees one.
function tn(key, vars) {
 var s = str("notice." + key);
 if (s === null) s = NOTICE_FALLBACK[key];
 if (s === undefined || s === null) return "";
 return vars ? fill(s, vars) : s;
}
function buildNotice(title, body, detail, onRetry) {
 var box = el("div", "cx-notice cx-notice--merchant");
 sa(box, "role", "status");
 if (title) ap(box, el("strong", "cx-notice__title", title));
 if (body) ap(box, el("p", "cx-notice__body", body));
 if (detail) ap(box, el("p", "cx-notice__detail", detail)); // the paths tried
 if (onRetry) ap(box, btn("cx-btn cx-btn--sm cx-notice__action", tw("retry"), onRetry));
 return box;
}
function merchantNotice(kind) {
 if (!isMerchantContext) return null;
 if (kind === "not_live") return buildNotice(tn("expired_title"), tn("expired_body"));
 if (kind === "bad_path") {
  return buildNotice(tn("unconfigured_title"), tn("unconfigured_body"),
   (proxyTried.length ? proxyTried : [currentBase()]).join("  ·  "));
 }
 return buildNotice(str("notice.error_title") || tw("error_loading"),
  str("notice.error_body"), null, () => { reload(); });
}

/* ---- v1.2/v1.6 not-live handling ---- */
// 403 not_live — shopper: hide quietly; merchant: inline notice, SSR'd
// reviews kept underneath (§4 — RC-A).
var notLiveHandled = false;
function handleNotLive() {
 if (!notLiveHandled) { // one-time teardown; the render below always re-runs so
  notLiveHandled = true; // a later filter change cannot strand a "Loading…" list
  if (currentDialogClose) currentDialogClose();
  removePreviewBar();
  removeStampedHide(); // v1.14 §5: rejected token must not keep Stamped hidden
 }
 if (!isMerchantContext) { root.hidden = true; return; }
 root.hidden = false;
 data.error = true;
 data.errorKind = "not_live";
 renderList(); // → the expired-preview notice, with SSR cards kept below it
 clear(secPagination);
}

/* ---- rating header ---- */
var howOpen = false;
function renderHeader() {
 clear(secHeader);
 var p = data.product;
 ap(secHeader, el("h2", "cx-h2", attr("heading", null) || tw("title")));
 if (!p) return;
 var avg = Number(p.average) || 0;
 var row = el("div", "cx-header__score");
 ap(row, starRow(avg, 18));
 ap(row, el("span", "cx-avg-text", tw("rating_out_of", { rating: NF1.format(avg) })));
 ap(secHeader, row);
 ap(secHeader, el("div", "cx-header__count", tw("global_ratings", { count: Number(p.count) || 0 })));
 var dist = el("div", "cx-dist");
 sa(dist, "role", "group");
 for (var s = 5; s >= 1; s--) {
  ((starsVal) => {
   var d = (p.distribution && p.distribution[String(starsVal)]) || { count: 0, percent: 0 };
   var b = btn("cx-dist__row" + (state.stars === starsVal ? " is-active" : ""), null, () => {
    state.stars = state.stars === starsVal ? 0 : starsVal;
    reload();
   });
   al(b, t("a11y.filter_row", { stars: starsVal }));
   sa(b, "aria-pressed", state.stars === starsVal ? "true" : "false");
   ap(b, el("span", "cx-dist__label", tw("star_row", { count: starsVal })));
   var bar = el("span", "cx-dist__bar");
   var fill = el("span", "cx-dist__fill");
   fill.style.width = Math.max(0, Math.min(100, Number(d.percent) || 0)) + "%";
   ap(bar, fill);
   ap(b, bar);
   ap(b, el("span", "cx-dist__percent", tw("percent", { percent: Number(d.percent) || 0 })));
   ap(dist, b);
  })(s);
 }
 ap(secHeader, dist);
 var howWrap = el("div", "cx-how");
 var howBody = el("div", "cx-how__panel", tw("how_body"));
 howBody.id = "cx-how-body";
 howBody.hidden = !howOpen;
 var howBtn = btn("cx-link cx-how__toggle", tw("how_link"), () => {
  howOpen = !howOpen;
  howBody.hidden = !howOpen;
  sa(howBtn, "aria-expanded", howOpen ? "true" : "false");
 });
 sa(howBtn, "aria-expanded", howOpen ? "true" : "false");
 sa(howBtn, "aria-controls", "cx-how-body");
 ap(howWrap, howBtn);
 ap(howWrap, howBody);
 ap(secHeader, howWrap);
}

/* ---- "Customers say" summary + topic chips ---- */
function renderSummary() {
 clear(secSummary);
 var show = !!(cfg.showSummary && data.summary && data.summary.text);
 secSummary.hidden = !show;
 if (!show) return;
 var sm = data.summary;
 ap(secSummary, el("h3", "cx-summary__title", tw("summary_title")));
 ap(secSummary, el("p", "cx-summary__text", sm.text));
 ap(secSummary, el("p", "cx-summary__disclaimer", tw("summary_disclaimer")));
 var topics = sm.topics || [];
 if (!topics.length) return;
 ap(secSummary, el("div", "cx-chips__title", tw("chips_title")));
 var rowEl = el("div", "cx-chips");
 sa(rowEl, "role", "group");
 al(rowEl, tw("chips_title"));
 topics.forEach((topic) => {
  var positive = topic.sentiment === "positive"; // pipe separators drawn by CSS
  var chip = btn("cx-chip" + (positive ? "" : " cx-chip--neg") +
   (state.topic === topic.key ? " is-active" : ""), null, () => {
   toggleTopic(topic, chip);
  });
  sa(chip, "aria-pressed", state.topic === topic.key ? "true" : "false");
  if (positive) {
   var arrow = svgIcon(ICON_ARROW_UP, "0 0 20 20", "cx-chip__icon", false);
   ap(chip, arrow);
  } else {
   var tilde = el("span", "cx-chip__icon", "~");
   sa(tilde, "aria-hidden", "true");
   ap(chip, tilde);
  }
  ap(chip, el("span", "cx-chip__label", topic.label));
  ap(chip, el("span", "cx-chip__count", " (" + fmtNum(Number(topic.count) || 0) + ")"));
  ap(rowEl, chip);
 });
 ap(secSummary, rowEl);
 if (state.topic) {
  var active = null;
  topics.forEach((tp) => { if (tp.key === state.topic) active = tp; });
  if (active) ap(secSummary, buildTopicPanel(active));
 }
}
/* ---- v1.16 §3 review Q&A ("Looking for specific info?") ---- */
var tq = (k, v) => t("qna." + k, v);
var qnaState = { q: "", loading: false, answer: null, error: false, asked: "" };
function renderQna() {
 // Review fix: async re-renders (localization, reloads) must not eat the
 // shopper's typing — preserve value + focus + caret across the rebuild.
 var prevInput = secQna.querySelector(".cx-qna__input");
 var hadFocus = prevInput && document.activeElement === prevInput;
 if (prevInput) qnaState.q = prevInput.value;
 clear(secQna);
 var show = !!(cfg.showQnaBlock && (cfg.showQna || (cfg.demo && demoData().qna)));
 secQna.hidden = !show;
 if (!show) return;
 var head = ap(secQna, el("div", "cx-qna__head"));
 ap(head, svgIcon(ICON_SPARK, "0 0 20 20", "cx-qna__spark", true));
 ap(head, el("h3", "cx-qna__title", tq("title")));

 var row = ap(secQna, el("form", "cx-qna__row"));
 var input = el("input", "cx-qna__input");
 sa(input, "type", "text");
 sa(input, "maxlength", "200");
 sa(input, "placeholder", tq("placeholder"));
 al(input, tq("placeholder"));
 input.value = qnaState.q;
 ap(row, input);
 var sub = el("button", "cx-qna__submit");
 sa(sub, "type", "submit");
 al(sub, tq("ask"));
 sub.disabled = !qnaState.q.trim();
 ap(sub, svgIcon(ICON_ARROW_RIGHT, "0 0 20 20", "cx-qna__arrow", false));
 ap(row, sub);
 on(input, "input", () => { qnaState.q = input.value; sub.disabled = !input.value.trim(); });
 on(row, "submit", (ev) => { ev.preventDefault(); askQuestion(input.value); });
 if (hadFocus) {
  try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
 }

 var qs = (data.summary && data.summary.questions) || [];
 if (qs.length) {
  var pills = ap(secQna, el("div", "cx-qna__pills"));
  qs.forEach((q) => {
   if (typeof q !== "string" || !q) return;
   ap(pills, btn("cx-qna__pill", q, () => { qnaState.q = q; askQuestion(q); }));
  });
 }

 if (qnaState.loading) {
  var ld = ap(secQna, el("p", "cx-qna__loading"));
  sa(ld, "role", "status");
  ap(ld, el("span", "cx-spinner cx-qna__spinner"));
  ap(ld, tx(" " + tq("loading")));
 } else if (qnaState.error) {
  var er = ap(secQna, el("p", "cx-qna__error", tq("error")));
  sa(er, "role", "status");
 } else if (qnaState.answer) {
  var pan = ap(secQna, el("div", "cx-qna__answer"));
  sa(pan, "role", "region");
  al(pan, tq("title"));
  var top = ap(pan, el("div", "cx-qna__answerhead"));
  ap(top, el("strong", "cx-qna__q", qnaState.asked));
  var cl = btn("cx-qna__close", "✕", () => { qnaState.answer = null; renderQna(); });
  al(cl, tq("close"));
  ap(top, cl);
  ap(pan, el("p", "cx-qna__a", String(qnaState.answer.answer || "")));
  var quotes = qnaState.answer.quotes || [];
  for (var qi = 0; qi < quotes.length && qi < 3; qi++) {
   var qt = quotes[qi] || {};
   if (!qt.excerpt) continue;
   var li = ap(pan, el("div", "cx-qna__quote"));
   ap(li, el("p", "cx-quote-text", "“" + qt.excerpt + "”"));
   var att = ap(li, el("p", "cx-qna__attr"));
   var rr = Number(qt.rating) || 0;
   if (rr > 0) ap(att, starRowCore(rr, 12, t("a11y.stars_label", { rating: NF1.format(rr) })));
   if (qt.author) ap(att, el("span", "cx-qna__author", String(qt.author)));
  }
  ap(pan, el("p", "cx-summary__disclaimer cx-qna__disc", tq("disclaimer")));
 }
}
function askQuestion(qtext) {
 var q = String(qtext || "").trim();
 if (q.length < 3 || qnaState.loading) return;
 qnaState.loading = true;
 qnaState.error = false;
 qnaState.answer = null;
 qnaState.asked = q;
 qnaState.q = q;
 renderQna();
 if (cfg.demo) {
  var d = demoData().qna || null;
  qnaState.loading = false;
  qnaState.answer = d;
  qnaState.error = !d;
  renderQna();
  return;
 }
 postJSON("/ask", { product_id: cfg.productId, question: q, locale: cfg.locale }).then((res) => {
  qnaState.loading = false;
  if (res && typeof res.answer === "string" && res.answer) qnaState.answer = res;
  else qnaState.error = true;
  renderQna();
 }, () => {
  qnaState.loading = false;
  qnaState.error = true;
  renderQna();
 });
}

function toggleTopic(topic) {
 if (state.topic === topic.key) {
  state.topic = "";
  activeTerms = [];
 } else {
  state.topic = topic.key;
  activeTerms = (topic.terms || []).slice();
 }
 reload();
}
function topicExcerpts(topic) {
 var out = [];
 var terms = (topic.terms || []).map((x) => { return String(x).toLowerCase(); }).filter(Boolean);
 if (!terms.length) return out;
 for (var i = 0; i < data.reviews.length && out.length < 4; i++) {
  var r = data.reviews[i];
  var body = r.body || "";
  var lower = body.toLowerCase();
  var best = -1, len = 0;
  for (var j = 0; j < terms.length; j++) {
   var idx = lower.indexOf(terms[j]);
   if (idx >= 0 && (best < 0 || idx < best)) { best = idx; len = terms[j].length; }
  }
  if (best < 0) continue;
  var start = Math.max(0, best - 70);
  var end = Math.min(body.length, best + len + 90);
  out.push({
   review: r,
   prefix: (start > 0 ? "…" : "") + body.slice(start, best),
   match: body.slice(best, best + len),
   suffix: body.slice(best + len, end) + (end < body.length ? "…" : "")
  });
 }
 return out;
}
function buildTopicPanel(topic) {
 var panel = el("div", "cx-chip-panel");
 sa(panel, "role", "region");
 al(panel, topic.label);
 var head = el("div", "cx-chip-panel__head");
 ap(head, el("strong", "cx-chip-panel__title",
  tw("chip_mentions", { count: Number(topic.count) || 0, topic: topic.label })));
 var closeB = btn("cx-chip-panel__close", "✕", () => {
  state.topic = "";
  activeTerms = [];
  reload();
 });
 al(closeB, tw("close"));
 ap(head, closeB);
 ap(panel, head);
 var countsRow = el("div", "cx-chip-panel__counts");
 ap(countsRow, el("span", "cx-chip-panel__pos", tw("chip_positive", { count: Number(topic.pos) || 0 })));
 ap(countsRow, tx(" "));
 ap(countsRow, el("span", "cx-chip-panel__neg", tw("chip_negative", { count: Number(topic.neg) || 0 })));
 ap(panel, countsRow);
 if (topic.blurb) ap(panel, el("p", "cx-chip-panel__blurb", topic.blurb));
 var excerpts = topicExcerpts(topic);
 if (excerpts.length) {
  var list = el("ul", "cx-chip-panel__quotes");
  excerpts.forEach((ex) => {
   var li = el("li", "cx-chip-panel__quote");
   var q = el("span", "cx-quote-text");
   ap(q, tx("“" + ex.prefix));
   var b = el("b");
   b.textContent = ex.match;
   ap(q, b);
   ap(q, tx(ex.suffix + "”"));
   ap(li, q);
   ap(li, tx(" "));
   ap(li, btn("cx-link cx-quote-more", trs("read_more"), () => {
    var card = cardRefs[ex.review.id];
    if (card) {
     card.scrollIntoView(reducedMotion ? {} : { behavior: "smooth", block: "center" });
     card.focus({ preventScroll: true });
    }
   }));
   ap(list, li);
  });
  ap(panel, list);
 }
 return panel;
}

/* ---- media strip + lightbox ---- */
function mediaThumb(item, cls, label, onClick) {
 var b = btn(cls, null, onClick);
 al(b, label);
 var img = el("img");
 img.loading = "lazy";
 img.alt = "";
 img.src = item.thumbUrl || item.url || "";
 ap(b, img);
 if (item.type === "VIDEO") {
  var overlay = el("span", "cx-play"); // ▶ drawn by CSS (.cx-play::before)
  sa(overlay, "aria-hidden", "true");
  ap(b, overlay);
  var sr = el("span", null, trs("video_badge"));
  hideVisually(sr);
  ap(b, sr);
 }
 return b;
}
function renderMediaStrip() {
 clear(secMedia);
 var show = !!(cfg.showMediaStrip && data.gallery.length);
 secMedia.hidden = !show; // the SSR .cx-strip section ships hidden until filled
 if (!show) return;
 ap(secMedia, el("h3", "cx-strip__title", tw("media_strip_title")));
 var scroller = el("div", "cx-strip__list");
 sa(scroller, "role", "group");
 al(scroller, t("a11y.open_gallery"));
 data.gallery.forEach((item, i) => {
  ap(scroller, mediaThumb(item, "cx-strip__item", t("a11y.open_media", { name: item.authorName || "" }), () => {
   openLightbox(data.gallery, i);
  }));
 });
 ap(secMedia, scroller);
}
function findReview(id) {
 for (var i = 0; i < data.reviews.length; i++) if (data.reviews[i].id === id) return data.reviews[i];
 if (cfg.demo) {
  var all = demoData().reviews || [];
  for (var j = 0; j < all.length; j++) if (all[j].id === id) return all[j];
 }
 return null;
}
function openLightbox(items, startIndex) {
 var index = startIndex;
 openDialog("cx-lightbox", (dialog, close) => {
  dlgHead(dialog, close, tw("gallery_title"));
  var stage = el("div", "cx-lightbox__media");
  var meta = el("div", "cx-lightbox__info");
  ap(dialog, stage);
  ap(dialog, meta);
  var prevB = btn("cx-lightbox__prev", "‹", () => { index = (index - 1 + items.length) % items.length; show(); });
  al(prevB, t("a11y.prev"));
  var nextB = btn("cx-lightbox__next", "›", () => { index = (index + 1) % items.length; show(); });
  al(nextB, t("a11y.next"));
  if (items.length > 1) { ap(dialog, prevB); ap(dialog, nextB); }
  function show() {
   clear(stage); clear(meta);
   var item = items[index];
   if (item.type === "VIDEO") {
    var vid = document.createElement("video");
    vid.controls = true;
    vid.src = item.url || "";
    vid.style.maxWidth = "100%";
    ap(stage, vid);
   } else {
    var img = el("img");
    img.src = item.url || item.thumbUrl || "";
    img.alt = trs("media_alt", { name: item.authorName || "" });
    img.style.maxWidth = "100%";
    ap(stage, img);
   }
   var r = item.reviewId ? findReview(item.reviewId) : null;
   var name = item.authorName || (r && r.authorName) || "";
   if (name) ap(meta, el("div", "cx-lightbox__author", tw("gallery_by", { name: name })));
   var rating = item.rating || (r && r.rating);
   if (rating) ap(meta, starRow(rating, 14));
   if (r && r.body) {
    var excerpt = r.body.length > 180 ? r.body.slice(0, 180) + "…" : r.body;
    ap(meta, el("p", "cx-lightbox__excerpt", excerpt));
   }
  }
  show();
 });
}

/* ---- controls: search, sort, filter ---- */
var searchInput = null;
function renderControls() {
 clear(secControls);
 var searchWrap = el("div", "cx-search");
 var icon = svgIcon(ICON_SEARCH, "0 0 20 20", "cx-search__icon", true);
 ap(searchWrap, icon);
 searchInput = el("input", "cx-search__input");
 searchInput.type = "search";
 searchInput.placeholder = tw("search_placeholder");
 al(searchInput, tw("search_label"));
 searchInput.value = state.q;
 on(searchInput, "input", debounce(() => {
  state.q = searchInput.value.trim();
  reload({ keepFocus: searchInput });
 }, 300));
 ap(searchWrap, searchInput);
 ap(secControls, searchWrap);
 var sortWrap = el("div", "cx-sort");
 var sortId = "cx-sort-select";
 var sortLabel = el("label", "cx-sort__label", tw("sort_label"));
 sa(sortLabel, "for", sortId);
 ap(sortWrap, sortLabel);
 var select = el("select", "cx-sort__select");
 select.id = sortId;
 // v1.21: a curated order does not follow helpful votes, so it must not be
 // labeled "Top reviews" (which shoppers audit against vote counts).
 var topLabel = cfg.curatedOrder ? tw("sort_relevant") : tw("sort_top");
 [["top", topLabel], ["recent", tw("sort_recent")]].forEach((opt) => {
  var o = el("option", null, opt[1]);
  o.value = opt[0];
  if (state.sort === opt[0]) o.selected = true;
  ap(select, o);
 });
 on(select, "change", () => { state.sort = select.value; reload(); });
 ap(sortWrap, select);
 ap(secControls, sortWrap);
 var filterBtn = btn("cx-btn cx-filter-btn", tw("filter_button"), () => {
  openFilterPanel(filterBtn);
 });
 sa(filterBtn, "aria-haspopup", "dialog");
 ap(secControls, filterBtn);
 // v1.8: "Translate all" is redundant in translated mode (SPEC-1.8 §4).
 if (cfg.showTranslate && cfg.translationDisplay !== "translated" && hasForeignReviews()) {
  var trLink = btn("cx-link cx-translate-all",
   allTranslated ? tw("show_original_all") : tw("translate_all"),
   () => { toggleTranslateAll(trLink); });
  ap(secControls, el("div", "cx-translate-row")).appendChild(trLink);
 }
}
function hasForeignReviews() {
 return data.reviews.some((r) => { return r.language && r.language !== cfg.locale; });
}
function countLoaded(pred) {
 var n = 0;
 data.reviews.forEach((r) => { if (pred(r)) n++; });
 return n;
}
function optionLabelWithCount(label, count) {
 return count > 0 ? label + " (" + fmtNum(count) + ")" : label;
}
function radioGroup(panelState, legendText, field, options, labelFor, countFor) {
 var fs = el("fieldset", "cx-filter-group");
 ap(fs, el("legend", "cx-filter-legend", legendText));
 var groupName = "cxf-" + field;
 function addOption(value, labelText) {
  var lab = el("label", "cx-filter-option");
  var input = el("input");
  input.type = "radio";
  input.name = groupName;
  input.checked = panelState[field] === value;
  on(input, "change", () => { panelState[field] = value; });
  ap(lab, input);
  ap(lab, el("span", null, labelText));
  ap(fs, lab);
 }
 addOption("", tw("filter_all_stars"));
 options.forEach((key) => {
  var count = countFor ? countFor(key) : 0;
  addOption(key, optionLabelWithCount(labelFor(key), count));
 });
 return fs;
}
function checkboxRow(panelState, field, labelText) {
 var lab = el("label", "cx-filter-option cx-filter-check");
 var input = el("input");
 input.type = "checkbox";
 input.checked = !!panelState[field];
 on(input, "change", () => { panelState[field] = input.checked; });
 ap(lab, input);
 ap(lab, el("span", null, labelText));
 return lab;
}
function openFilterPanel() {
 var ps = {
  stars: state.stars, verified: state.verified, withMedia: state.withMedia,
  ageRange: state.ageRange, skinConcern: state.skinConcern,
  timeUsing: state.timeUsing, resultsSeen: state.resultsSeen
 };
 openDialog("cx-filter-panel", (dialog, close) => {
  dlgHead(dialog, close, tw("filter_title"));
  var starsFs = el("fieldset", "cx-filter-group");
  ap(starsFs, el("legend", "cx-filter-legend", tw("filter_stars")));
  function starOption(value, labelNode) {
   var lab = el("label", "cx-filter-option");
   var input = el("input");
   input.type = "radio";
   input.name = "cxf-stars";
   input.checked = ps.stars === value;
   on(input, "change", () => { ps.stars = value; });
   ap(lab, input);
   ap(lab, labelNode);
   ap(starsFs, lab);
  }
  starOption(0, el("span", null, tw("filter_all_stars")));
  for (var s = 5; s >= 1; s--) {
   ((val) => {
    var span = el("span", "cx-filter-star-label");
    ap(span, starRow(val, 13));
    ap(span, el("span", null, " " + tw("star_row", { count: val })));
    starOption(val, span);
   })(s);
  }
  ap(dialog, starsFs);
  ap(dialog, checkboxRow(ps, "verified", tw("filter_verified")));
  ap(dialog, checkboxRow(ps, "withMedia", tw("filter_media")));
  ap(dialog, radioGroup(ps, t("attrs.age_label"), "ageRange", AGE_RANGES,
   (k) => { return t("age." + k); },
   (k) => { return countLoaded((r) => { return r.ageRange === k; }); }));
  ap(dialog, radioGroup(ps, t("attrs.skin_label"), "skinConcern", SKIN_CONCERNS,
   (k) => { return t("skin." + k); },
   (k) => { return countLoaded((r) => { return (r.skinConcerns || []).indexOf(k) >= 0; }); }));
  ap(dialog, radioGroup(ps, t("attrs.time_label"), "timeUsing", TIME_USING,
   (k) => { return t("time." + k); },
   (k) => { return countLoaded((r) => { return r.timeUsing === k; }); }));
  ap(dialog, radioGroup(ps, t("attrs.results_label"), "resultsSeen", RESULTS_SEEN,
   (k) => { return t("results." + k); },
   (k) => { return countLoaded((r) => { return (r.resultsSeen || []).indexOf(k) >= 0; }); }));
  var actions = el("div", "cx-dialog__footer");
  ap(actions, btn("cx-btn cx-btn-clear", tw("clear_filters"), () => {
   ps.stars = 0; ps.verified = false; ps.withMedia = false;
   ps.ageRange = ""; ps.skinConcern = ""; ps.timeUsing = ""; ps.resultsSeen = "";
   commit(); close();
  }));
  ap(actions, btn("cx-btn cx-btn--primary", tw("apply_filters"), () => {
   commit(); close();
  }));
  ap(dialog, actions);
  function commit() {
   state.stars = ps.stars; state.verified = ps.verified; state.withMedia = ps.withMedia;
   state.ageRange = ps.ageRange; state.skinConcern = ps.skinConcern;
   state.timeUsing = ps.timeUsing; state.resultsSeen = ps.resultsSeen;
   reload();
  }
 });
}

/* ---- active filter pills ---- */
function renderActiveFilters() {
 clear(secFilters);
 var pills = [];
 function pill(label, remove) { pills.push({ label: label, remove: remove }); }
 if (state.stars) pill(tw("star_row", { count: state.stars }), () => { state.stars = 0; });
 if (state.verified) pill(tw("filter_verified"), () => { state.verified = false; });
 if (state.withMedia) pill(tw("filter_media"), () => { state.withMedia = false; });
 if (state.ageRange) pill(t("age." + state.ageRange), () => { state.ageRange = ""; });
 if (state.skinConcern) pill(t("skin." + state.skinConcern), () => { state.skinConcern = ""; });
 if (state.timeUsing) pill(t("time." + state.timeUsing), () => { state.timeUsing = ""; });
 if (state.resultsSeen) pill(t("results." + state.resultsSeen), () => { state.resultsSeen = ""; });
 if (state.topic) {
  var label = state.topic;
  ((data.summary && data.summary.topics) || []).forEach((tp) => {
   if (tp.key === state.topic) label = tp.label;
  });
  pill(label, () => { state.topic = ""; activeTerms = []; });
 }
 if (state.q) pill("“" + state.q + "”", () => {
  state.q = "";
  if (searchInput) searchInput.value = "";
 });
 secFilters.hidden = !pills.length;
 if (!pills.length) return;
 var wrap = el("div", "cx-active-filters");
 sa(wrap, "role", "group");
 al(wrap, tw("active_filters"));
 pills.forEach((item) => {
  var b = btn("cx-pill", null, () => { item.remove(); reload(); });
  al(b, tw("remove_filter", { name: item.label }));
  ap(b, el("span", "cx-pill__label", item.label));
  var x = el("span", "cx-pill__remove", "✕");
  sa(x, "aria-hidden", "true");
  ap(b, x);
  ap(wrap, b);
 });
 ap(wrap, btn("cx-link cx-clear-filters", tw("clear_filters"), () => {
  state.stars = 0; state.verified = false; state.withMedia = false;
  state.ageRange = ""; state.skinConcern = ""; state.timeUsing = ""; state.resultsSeen = "";
  state.topic = ""; state.q = ""; activeTerms = [];
  if (searchInput) searchInput.value = "";
  reload();
 }));
 ap(secFilters, wrap);
}
function anyFilterActive() {
 return !!(state.stars || state.verified || state.withMedia || state.ageRange ||
  state.skinConcern || state.timeUsing || state.resultsSeen || state.topic || state.q);
}

/* ---- review cards ---- */
function attributeLine(r) {
 var parts = [];
 if (r.ageRange) parts.push(t("attrs.age_label") + ": " + t("age." + r.ageRange));
 if (r.skinConcerns && r.skinConcerns.length) {
  parts.push(t("attrs.skin_label") + ": " + r.skinConcerns.map((k) => { return t("skin." + k); }).join(", "));
 }
 if (r.timeUsing) parts.push(t("attrs.time_label") + ": " + t("time." + r.timeUsing));
 if (r.resultsSeen && r.resultsSeen.length) {
  parts.push(t("attrs.results_label") + ": " + r.resultsSeen.map((k) => { return t("results." + k); }).join(", "));
 }
 if (!parts.length) return null;
 var line = el("div", "cx-attrs cx-muted");
 parts.forEach((p, i) => {
  if (i > 0) {
   var sep = el("span", "cx-attr-sep", " · ");
   sa(sep, "aria-hidden", "true");
   ap(line, sep);
  }
  ap(line, el("span", "cx-attr", p));
 });
 return line;
}
function clampedBody(container, text, terms) {
 var body = el("div", "cx-card__body");
 st(body, { display: "-webkit-box", webkitLineClamp: "6", webkitBoxOrient: "vertical", overflow: "hidden" });
 highlightInto(body, text, terms, "mark");
 ap(container, body);
 var toggle = btn("cx-link cx-read-more", trs("read_more"), () => {
  var expanded = body.style.webkitLineClamp === "unset";
  body.style.webkitLineClamp = expanded ? "6" : "unset";
  toggle.textContent = expanded ? trs("read_more") : trs("show_less");
  sa(toggle, "aria-expanded", expanded ? "false" : "true");
 });
 sa(toggle, "aria-expanded", "false");
 toggle.hidden = true;
 ap(container, toggle);
 window.requestAnimationFrame(() => {
  if (body.scrollHeight > body.clientHeight + 2) toggle.hidden = false;
 });
}
function renderCard(r) {
 var card = el("article", "cx-card");
 sa(card, "data-review-id", r.id);
 card.tabIndex = -1;
 cardRefs[r.id] = card;
 // v1.8: translated mode shows the server translation until "See original".
 var auto = autoTranslation(r);
 var tr = auto && !showOriginalIds[r.id] ? auto : (translatedIds[r.id] ? trCache[r.id] : null);
 var title = tr && tr.title ? tr.title : r.title;
 var body = tr && tr.body ? tr.body : r.body;
 var reply = tr && tr.reply ? tr.reply : r.reply;
 var head = el("div", "cx-card__head");
 var avatar = el("span", "cx-avatar", (r.authorName || "?").charAt(0).toUpperCase());
 sa(avatar, "aria-hidden", "true");
 ap(head, avatar);
 ap(head, el("span", "cx-card__author", r.authorName || ""));
 ap(card, head);
 var ratingRow = el("div", "cx-card__titleline");
 ap(ratingRow, starRow(r.rating, 16));
 if (title) ap(ratingRow, el("strong", "cx-card__title", title));
 ap(card, ratingRow);
 var dateText = r.country
  ? trs("reviewed_in_on", { country: regionName(r.country), date: fmtDate(r.createdAt) })
  : trs("reviewed_on", { date: fmtDate(r.createdAt) });
 ap(card, el("div", "cx-card__meta", dateText));
 if (r.variantTitle || r.verified) {
  var metaRow = el("div", "cx-card__variant");
  if (r.variantTitle) ap(metaRow, el("span", null, trs("size", { value: r.variantTitle })));
  if (r.verified) ap(metaRow, el("span", "cx-badge-verified", trs("verified")));
  ap(card, metaRow);
 }
 var bodyWrap = el("div", "cx-body-wrap");
 clampedBody(bodyWrap, body || "", state.topic ? activeTerms : null);
 ap(card, bodyWrap);
 var attrs = attributeLine(r);
 if (attrs) ap(card, attrs);
 if (r.media && r.media.length) {
  var mediaRow = el("div", "cx-card__media");
  var items = r.media.map((m) => {
   return { type: m.type, url: m.url, thumbUrl: m.thumbUrl, authorName: r.authorName, rating: r.rating, reviewId: r.id };
  });
  items.forEach((item, i) => {
   ap(mediaRow, mediaThumb(item, "cx-card__thumb", t("a11y.open_media", { name: r.authorName || "" }), () => {
    openLightbox(items, i);
   }));
  });
  ap(card, mediaRow);
 }
 if (cfg.showTranslate && r.language && r.language !== cfg.locale) {
  ap(card, translationControls(r, card));
 }
 if (r.helpfulCount > 0) {
  ap(card, el("div", "cx-card__helpful", trs("helpful_count", { count: r.helpfulCount })));
 }
 var actions = el("div", "cx-card__actions");
 if (helpfulSet[r.id]) {
  ap(actions, el("span", "cx-thanks", trs("helpful_thanks")));
 } else {
  var helpfulBtn = btn("cx-btn cx-btn-helpful", trs("helpful"), () => {
   helpfulBtn.disabled = true;
   apiVote(r.id).then((res) => {
    if (res && res.ok) {
     markHelpful(r.id);
     r.helpfulCount = res.helpfulCount != null ? res.helpfulCount : (r.helpfulCount || 0) + 1;
     rerenderCard(r);
    } else {
     helpfulBtn.disabled = false;
    }
   }).catch(() => { helpfulBtn.disabled = false; });
  });
  ap(actions, helpfulBtn);
 }
 if (reportedSet[r.id]) {
  ap(actions, el("span", "cx-muted cx-reported", trs("reported")));
 } else {
  ap(actions, btn("cx-link cx-card__report", trs("report"), () => {
   openReportDialog(r);
  }));
 }
 ap(card, actions);
 if (reply) {
  var replyBlock = el("div", "cx-reply");
  ap(replyBlock, el("strong", "cx-reply__title", trs("reply_from", { brand: cfg.brand })));
  if (r.replyAt) ap(replyBlock, el("span", "cx-reply__date", " — " + fmtDate(r.replyAt)));
  ap(replyBlock, el("p", "cx-reply__text", reply));
  ap(card, replyBlock);
 }
 return card;
}
function rerenderCard(r) {
 var old = cardRefs[r.id];
 if (!old || !old.parentNode) return;
 var fresh = renderCard(r);
 old.parentNode.replaceChild(fresh, old);
}

/* ---- translation ---- */
function fetchTranslations(ids) {
 var missing = ids.filter((id) => { return !trCache[id]; });
 if (!missing.length) return Promise.resolve();
 var chunks = [];
 for (var i = 0; i < missing.length; i += 20) chunks.push(missing.slice(i, i + 20));
 return Promise.all(chunks.map((chunk) => {
  return apiTranslate(chunk, cfg.locale).then((res) => {
   if (res && res.ok && res.translations) {
    for (var id in res.translations) {
     if (own(res.translations, id)) {
      trCache[id] = res.translations[id];
     }
    }
   }
  });
 }));
}
function translationControls(r, card) {
 var wrap = el("div", "cx-translate");
 // v1.8 §4 translated mode; reviews WITHOUT a server translation fall
 // through to the classic controls below.
 var auto = autoTranslation(r);
 if (auto) {
  if (showOriginalIds[r.id]) {
   ap(wrap, btn("cx-link", trs("see_translation"), () => {
    delete showOriginalIds[r.id];
    rerenderCard(r);
   }));
  } else {
   ap(wrap, el("span", "cx-muted cx-translated-note",
    trs("translated_from", { language: langName(auto.from || r.language) })));
   ap(wrap, tx(" "));
   ap(wrap, btn("cx-link", trs("see_original"), () => {
    showOriginalIds[r.id] = true;
    rerenderCard(r);
   }));
  }
  return wrap;
 }
 if (translatedIds[r.id]) {
  ap(wrap, el("span", "cx-muted cx-translated-note",
   trs("translated_from", { language: langName(r.language) })));
  ap(wrap, tx(" "));
  ap(wrap, btn("cx-link", trs("see_original"), () => {
   delete translatedIds[r.id];
   rerenderCard(r);
  }));
 } else {
  var link = btn("cx-link", trs("translate"), () => {
   link.disabled = true;
   link.textContent = trs("translating");
   fetchTranslations([r.id]).then(() => {
    if (trCache[r.id]) translatedIds[r.id] = true;
    rerenderCard(r);
   }).catch(() => {
    link.disabled = false;
    link.textContent = trs("translate");
   });
  });
  ap(wrap, link);
 }
 return wrap;
}
function toggleTranslateAll(link) {
 var foreign = data.reviews.filter((r) => { return r.language && r.language !== cfg.locale; });
 if (allTranslated) {
  allTranslated = false;
  foreign.forEach((r) => {
   if (translatedIds[r.id]) { delete translatedIds[r.id]; rerenderCard(r); }
  });
  link.textContent = tw("translate_all");
  return;
 }
 link.disabled = true;
 link.textContent = trs("translating");
 fetchTranslations(foreign.map((r) => { return r.id; })).then(() => {
  allTranslated = true;
  foreign.forEach((r) => {
   if (trCache[r.id]) { translatedIds[r.id] = true; rerenderCard(r); }
  });
  link.disabled = false;
  link.textContent = tw("show_original_all");
 }).catch(() => {
  link.disabled = false;
  link.textContent = tw("translate_all");
 });
}

/* ---- report dialog ---- */
function openReportDialog(r) {
 openDialog("cx-report-dialog", (dialog, close) => {
  dlgHead(dialog, close, t("report_dialog.title"));
  var fs = el("fieldset", "cx-filter-group");
  ap(fs, el("legend", "cx-filter-legend", t("report_dialog.reason_label")));
  var selected = REPORT_REASONS[0];
  REPORT_REASONS.forEach((reason, i) => {
   var lab = el("label", "cx-filter-option");
   var input = el("input");
   input.type = "radio";
   input.name = "cx-report-reason";
   input.checked = i === 0;
   on(input, "change", () => { selected = reason; });
   ap(lab, input);
   ap(lab, el("span", null, t("report_dialog." + reason)));
   ap(fs, lab);
  });
  ap(dialog, fs);
  var errEl = el("div", "cx-form__error");
  errEl.hidden = true;
  ap(dialog, errEl);
  var actions = el("div", "cx-dialog__footer");
  ap(actions, btn("cx-btn", t("report_dialog.cancel"), close));
  var submitB = btn("cx-btn cx-btn--primary", t("report_dialog.submit"), () => {
   submitB.disabled = true;
   apiReport(r.id, selected).then((res) => {
    if (res && res.ok) {
     reportedSet[r.id] = true;
     rerenderCard(r);
     close();
    } else {
     submitB.disabled = false;
     errEl.textContent = tf("error_generic");
     errEl.hidden = false;
    }
   }).catch(() => {
    submitB.disabled = false;
    errEl.textContent = tf("error_generic");
    errEl.hidden = false;
   });
  });
  ap(actions, submitB);
  ap(dialog, actions);
 });
}

/* ---- list + pagination ---- */
function renderList() {
 clear(secList);
 cardRefs = {};
 if (data.error) {
  // §4: merchant gets the truth; shopper gets SSR content or nothing at all.
  var notice = merchantNotice(data.errorKind);
  if (notice) ap(secList, notice);
  restoreSsrCards();
  return;
 }
 if (data.loading && !data.reviews.length) {
  ap(secList, el("p", "cx-muted cx-loading", tw("loading")));
  return;
 }
 if (!data.reviews.length) {
  ap(secList, el("p", "cx-muted cx-empty",
   anyFilterActive() ? tw("no_results") : tw("no_reviews")));
  // RC-B: zero reviews is not a failure. v1.6.1 §B: a non-zero pendingCount
  // is server-proven merchant-ness; a shopper reaches neither branch.
  var pending = data.pendingCount > 0;
  if ((isMerchantContext || pending) && !anyFilterActive()) {
   ap(secList, pending
    ? buildNotice(null, tn("empty_pending", { count: data.pendingCount }))
    : buildNotice(null, tn("empty_merchant")));
  }
  return;
 }
 ap(secList, el("div", "cx-count", tw("showing_count", {
  from: fmtNum(1),
  to: fmtNum(data.reviews.length),
  total: fmtNum(data.total)
 })));
 var list = el("div", "cx-review-list");
 data.reviews.forEach((r) => { ap(list, renderCard(r)); });
 ap(secList, list);
}
// §4 row 4: a failure AFTER content is on screen keeps it + inline retry —
// same for both audiences (a retry link is not an error box).
function renderInlineRetry(wasAppend) {
 detach(secList.querySelector(".cx-retry-inline"));
 var wrap = el("div", "cx-retry-inline");
 sa(wrap, "role", "status");
 ap(wrap, btn("cx-link", tw("retry"), () => {
  detach(wrap);
  if (wasAppend) state.page += 1; // the catch decremented it
  loadPage(wasAppend);
 }));
 ap(secList, wrap);
}
function renderPagination() {
 clear(secPagination);
 if (data.error || !data.reviews.length) return;
 if (state.page >= data.totalPages) return;
 var more = btn("cx-btn cx-load-more", tw("load_more"), () => {
  more.disabled = true;
  more.textContent = tw("loading");
  state.page += 1;
  loadPage(true).then(() => {
   announce(t("a11y.page_loaded"));
  });
 });
 ap(secPagination, more);
}

/* ---- write a review ---- */
function renderWriteButton() {
 clear(secWrite);
 secWrite.hidden = !cfg.showForm; // .cx-write has a divider border even when empty
 if (!cfg.showForm) return;
 ap(secWrite, btn("cx-btn cx-write-btn", tw("write_review"), openReviewForm));
}
function optionPillGroup(legendText, hint, options, labelFor, multi, selection) {
 var fs = el("fieldset", "cx-option-group");
 var legend = el("legend", "cx-option-legend", legendText + " " + tf("optional"));
 ap(fs, legend);
 if (hint) ap(fs, el("div", "cx-form__hint", hint));
 var rowEl = el("div", "cx-option-pills");
 options.forEach((key) => {
  var pillBtn = btn("cx-option-pill", labelFor(key), () => {
   if (multi) {
    var idx = selection.values.indexOf(key);
    if (idx >= 0) selection.values.splice(idx, 1);
    else selection.values.push(key);
    sa(pillBtn, "aria-pressed", selection.values.indexOf(key) >= 0 ? "true" : "false");
    pillBtn.classList.toggle("is-selected", selection.values.indexOf(key) >= 0);
   } else {
    selection.value = selection.value === key ? "" : key;
    Array.prototype.forEach.call(rowEl.children, (c) => {
     sa(c, "aria-pressed", "false");
     c.classList.remove("is-selected");
    });
    if (selection.value === key) {
     sa(pillBtn, "aria-pressed", "true");
     pillBtn.classList.add("is-selected");
    }
   }
  });
  sa(pillBtn, "aria-pressed", "false");
  ap(rowEl, pillBtn);
 });
 ap(fs, rowEl);
 return fs;
}
function fieldRow(labelText, inputEl, note, errEl) {
 var wrap = el("div", "cx-field");
 var lab = el("label", "cx-field-label", labelText);
 var id = "cx-fld-" + Math.random().toString(36).slice(2, 8);
 inputEl.id = id;
 sa(lab, "for", id);
 ap(wrap, lab);
 ap(wrap, inputEl);
 if (note) ap(wrap, el("div", "cx-form__hint", note));
 if (errEl) ap(wrap, errEl);
 return wrap;
}
function errBox() {
 var e = el("div", "cx-form__error");
 e.hidden = true;
 sa(e, "role", "alert");
 return e;
}
function setErr(e, msg) { e.textContent = msg || ""; e.hidden = !msg; }
function validMediaFile(file, isVideo) {
 if (isVideo) {
  var okType = MEDIA_LIMITS.vidTypes.indexOf(file.type) >= 0 || MEDIA_LIMITS.vidExt.test(file.name);
  if (!okType) return "type";
  if (file.size > MEDIA_LIMITS.vidMb * 1024 * 1024) return "size";
 } else {
  var okImg = MEDIA_LIMITS.imgTypes.indexOf(file.type) >= 0 || MEDIA_LIMITS.imgExt.test(file.name);
  if (!okImg) return "type";
  if (file.size > MEDIA_LIMITS.imgMb * 1024 * 1024) return "size";
 }
 return null;
}
function isVideoFile(file) {
 return file.type.indexOf("video/") === 0 || MEDIA_LIMITS.vidExt.test(file.name);
}
function openReviewForm() {
 var tStart = Date.now();
 var picked = []; // {file, url, isVideo}
 var rating = 0;
 openDialog("cx-form-dialog", (dialog, close) => {
  dlgHead(dialog, close, tf("title"));
  var form = el("form", "cx-form");
  form.noValidate = true;
  ap(dialog, form);
  var ratingErr = errBox();
  var starsFs = el("fieldset", "cx-field cx-rating-field");
  ap(starsFs, el("legend", "cx-field-label", tf("rating_label")));
  var starsWrap = el("div", "cx-star-select");
  sa(starsWrap, "role", "radiogroup");
  al(starsWrap, t("a11y.rating_input"));
  var starBtns = [];
  function paintStars(upTo) {
   starBtns.forEach((sb, i) => {
    clear(sb);
    ap(sb, starSvg(i < upTo ? 1 : 0, 32));
   });
  }
  for (var i = 1; i <= 5; i++) {
   ((val) => {
    var sb = btn("cx-rating-star", null, () => {
     rating = val;
     paintStars(rating);
     starBtns.forEach((x, j) => { sa(x, "aria-checked", j + 1 === val ? "true" : "false"); });
     setErr(ratingErr, "");
    });
    sa(sb, "role", "radio");
    sa(sb, "aria-checked", "false");
    al(sb, tf("rating_value", { count: val }));
    st(sb, { minWidth: "44px", minHeight: "44px" });
    on(sb, "mouseenter", () => { paintStars(val); });
    on(sb, "mouseleave", () => { paintStars(rating); });
    on(sb, "focus", () => { paintStars(val); });
    on(sb, "blur", () => { paintStars(rating); });
    starBtns.push(sb);
    ap(starsWrap, sb);
   })(i);
  }
  paintStars(0);
  ap(starsFs, starsWrap);
  ap(starsFs, ratingErr);
  ap(form, starsFs);
  var titleInput = el("input", "cx-input");
  titleInput.type = "text"; titleInput.maxLength = 150;
  titleInput.placeholder = tf("title_placeholder");
  ap(form, fieldRow(tf("title_label") + " " + tf("optional"), titleInput));
  var bodyErr = errBox();
  var bodyInput = el("textarea", "cx-input cx-textarea");
  bodyInput.maxLength = 5000; bodyInput.rows = 5;
  bodyInput.placeholder = tf("body_placeholder");
  ap(form, fieldRow(tf("body_label"), bodyInput, null, bodyErr));
  var nameErr = errBox();
  var nameInput = el("input", "cx-input");
  nameInput.type = "text"; nameInput.maxLength = 80;
  nameInput.placeholder = tf("name_placeholder");
  nameInput.autocomplete = "name";
  ap(form, fieldRow(tf("name_label"), nameInput, null, nameErr));
  var emailErr = errBox();
  var emailInput = el("input", "cx-input");
  emailInput.type = "email";
  emailInput.autocomplete = "email";
  ap(form, fieldRow(tf("email_label"), emailInput, tf("email_note"), emailErr));
  var ageSel = { value: "" };
  var skinSel = { values: [] };
  var timeSel = { value: "" };
  var resultsSel = { values: [] };
  ap(form, optionPillGroup(tf("age_label"), null, AGE_RANGES,
   (k) => { return t("age." + k); }, false, ageSel));
  ap(form, optionPillGroup(tf("skin_label"), tf("multi_hint"), SKIN_CONCERNS,
   (k) => { return t("skin." + k); }, true, skinSel));
  ap(form, optionPillGroup(tf("time_label"), null, TIME_USING,
   (k) => { return t("time." + k); }, false, timeSel));
  ap(form, optionPillGroup(tf("results_label"), tf("multi_hint"), RESULTS_SEEN,
   (k) => { return t("results." + k); }, true, resultsSel));
  var mediaErr = errBox();
  var mediaField = el("div", "cx-field cx-media-field");
  ap(mediaField, el("div", "cx-form__label", tf("media_label") + " " + tf("optional")));
  ap(mediaField, el("div", "cx-form__hint", tf("media_hint", {
   images: MEDIA_LIMITS.images, videos: MEDIA_LIMITS.videos,
   img_mb: MEDIA_LIMITS.imgMb, vid_mb: MEDIA_LIMITS.vidMb
  })));
  var thumbsRow = el("div", "cx-media-picker");
  var fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = MEDIA_LIMITS.imgTypes.concat(MEDIA_LIMITS.vidTypes).join(",") + ",.heic,.mov";
  hideVisually(fileInput);
  al(fileInput, tf("media_label"));
  var addBtn = btn("cx-media-add", tf("media_add"), () => { fileInput.click(); });
  function renderThumbs() {
   clear(thumbsRow);
   picked.forEach((item, idx) => {
    var cell = el("span", "cx-media-thumb");
    if (item.isVideo) {
     var vb = el("span", "cx-media-videobadge", trs("video_badge"));
     ap(cell, vb);
    } else {
     var img = el("img", "cx-media-preview");
     img.alt = "";
     img.src = item.url;
     ap(cell, img);
    }
    var rm = btn("cx-media-thumb__remove", "✕", () => {
     if (item.url) URL.revokeObjectURL(item.url);
     picked.splice(idx, 1);
     renderThumbs();
    });
    al(rm, tf("media_remove"));
    ap(cell, rm);
    ap(thumbsRow, cell);
   });
  }
  on(fileInput, "change", () => {
   setErr(mediaErr, "");
   var files = Array.prototype.slice.call(fileInput.files || []);
   for (var fi = 0; fi < files.length; fi++) {
    var file = files[fi];
    var isVid = isVideoFile(file);
    var imgCount = picked.filter((x) => { return !x.isVideo; }).length;
    var vidCount = picked.filter((x) => { return x.isVideo; }).length;
    if ((isVid && vidCount >= MEDIA_LIMITS.videos) || (!isVid && imgCount >= MEDIA_LIMITS.images)) {
     setErr(mediaErr, tf("error_media_count"));
     continue;
    }
    var problem = validMediaFile(file, isVid);
    if (problem === "type") { setErr(mediaErr, tf("error_media_type")); continue; }
    if (problem === "size") { setErr(mediaErr, tf("error_media_size")); continue; }
    picked.push({ file: file, url: isVid ? "" : URL.createObjectURL(file), isVideo: isVid });
   }
   fileInput.value = "";
   renderThumbs();
  });
  ap(mediaField, addBtn);
  ap(mediaField, fileInput);
  ap(mediaField, thumbsRow);
  ap(mediaField, mediaErr);
  ap(form, mediaField);
  var honeypot = el("input");
  honeypot.type = "text";
  honeypot.name = "website";
  honeypot.tabIndex = -1;
  honeypot.autocomplete = "off";
  sa(honeypot, "aria-hidden", "true");
  st(honeypot, { position: "absolute", left: "-9999px", height: "1px" });
  ap(form, honeypot);
  var formErr = errBox();
  ap(form, formErr);
  var actions = el("div", "cx-dialog__footer");
  ap(actions, btn("cx-btn", tf("cancel"), close));
  var submitB = el("button", "cx-btn cx-btn--primary cx-submit");
  submitB.type = "submit";
  submitB.textContent = tf("submit");
  ap(actions, submitB);
  ap(form, actions);
  on(form, "submit", (ev) => {
   ev.preventDefault();
   var ok = true;
   setErr(formErr, "");
   if (!rating) { setErr(ratingErr, tf("error_rating")); ok = false; }
   if (!bodyInput.value.trim()) { setErr(bodyErr, tf("error_body")); ok = false; } else setErr(bodyErr, "");
   if (!nameInput.value.trim()) { setErr(nameErr, tf("error_name")); ok = false; } else setErr(nameErr, "");
   var email = emailInput.value.trim();
   if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { setErr(emailErr, tf("error_email")); ok = false; } else setErr(emailErr, "");
   if (!ok) return;
   var fd = new FormData();
   fd.append("product_id", cfg.productId);
   if (cfg.productHandle) fd.append("product_handle", cfg.productHandle); // v1.5
   fd.append("rating", String(rating));
   if (titleInput.value.trim()) fd.append("title", titleInput.value.trim());
   fd.append("body", bodyInput.value.trim());
   fd.append("author_name", nameInput.value.trim());
   fd.append("author_email", email);
   fd.append("language", cfg.locale);
   if (ageSel.value) fd.append("age_range", ageSel.value);
   if (skinSel.values.length) fd.append("skin_concerns", JSON.stringify(skinSel.values));
   if (timeSel.value) fd.append("time_using", timeSel.value);
   if (resultsSel.values.length) fd.append("results_seen", JSON.stringify(resultsSel.values));
   fd.append("website", honeypot.value);
   fd.append("t_start", String(tStart));
   picked.forEach((item) => { fd.append("media[]", item.file, item.file.name); });
   submitB.disabled = true;
   submitB.textContent = tf("submitting");
   apiSubmit(fd).then((res) => {
    if (res && res.ok) {
     picked.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
     showSuccess(dialog, close, res.status === "PUBLISHED");
     if (res.status === "PUBLISHED") reload();
    } else {
     submitB.disabled = false;
     submitB.textContent = tf("submit");
     var errors = (res && res.errors) || {};
     if (errors._ === "rate_limited") { setErr(formErr, tf("error_rate_limited")); return; }
     var shown = false;
     var map = { rating: ratingErr, body: bodyErr, author_name: nameErr, author_email: emailErr, email: emailErr };
     for (var field in errors) {
      if (!own(errors, field)) continue;
      var target = map[field];
      var msg = str("form.error_" + field) !== null ? tf("error_" + field) : tf("error_generic");
      if (target) { setErr(target, msg); shown = true; }
     }
     if (!shown) setErr(formErr, tf("error_generic"));
    }
   }).catch(() => {
    submitB.disabled = false;
    submitB.textContent = tf("submit");
    setErr(formErr, tf("error_generic"));
   });
  });
 });
}
function showSuccess(dialog, close, published) {
 clear(dialog);
 dlgHead(dialog, close, tf("success_title"));
 ap(dialog, el("p", "cx-success-text",
  published ? tf("success_published") : tf("success_pending")));
 var actions = el("div", "cx-dialog__footer");
 ap(actions, btn("cx-btn cx-btn--primary", tw("close"), close));
 ap(dialog, actions);
 var f = focusables(dialog);
 if (f.length) f[0].focus();
}

/* ---- load orchestration ---- */
var loadSeq = 0;
var summaryLocalized = false;
function renderAll() {
 var prevSearch = searchInput;
 var searchFocused = prevSearch && document.activeElement === prevSearch;
 var liveVal = prevSearch ? prevSearch.value : state.q;
 renderHeader();
 renderSummary();
 renderQna(); // v1.16 §3
 renderMediaStrip();
 renderControls();
 renderActiveFilters();
 renderList();
 renderPagination();
 renderWriteButton();
 if (prevSearch && searchInput) {
  searchInput.value = liveVal;
  if (searchFocused) {
   searchInput.focus();
   try { searchInput.setSelectionRange(liveVal.length, liveVal.length); } catch (e) { /* type=search quirks */ }
  }
 }
 if (!firstLoadDone) {
  firstLoadDone = true;
  if (previewToken) fireTokenOk(); // v1.14 §5: server accepted this tab's token
  root.dispatchEvent(new CustomEvent("cellexia:loaded", {
   bubbles: true,
   detail: { // v1.5.1: PDP badge fallback data (+distribution, SPEC-1.12 §5)
    productId: cfg.productId, total: data.total,
    average: data.product ? Number(data.product.average) || 0 : 0,
    count: data.product ? Number(data.product.count) || 0 : 0,
    distribution: data.product ? data.product.distribution || null : null
   }
  }));
 } else {
  announce(t("a11y.list_updated"));
 }
}
// Admin settings ride along on the list response (settings obj / snake_case).
function applySkin(value) {
 // Guard unknown values back to "amazon", like the Liquid case/when.
 var skin = value === "cellexia" || value === "luxe" ? value : "amazon";
 sa(root, "data-cx-skin", skin);
 // Sync any open top-layer surface (openDialog copies only at open time).
 var surfaces = document.querySelectorAll(".cx-overlay, .cx-dialog");
 for (var i = 0; i < surfaces.length; i++) sa(surfaces[i], "data-cx-skin", skin);
}
function applyServerSettings(res) {
 if (!res) return;
 var s = res.settings || {};
 var showTr = own(s, "showTranslate") ? s.showTranslate :
  (own(res, "show_translate") ? res.show_translate : undefined);
 if (showTr !== undefined && showTr !== null) {
  cfg.showTranslate = showTr === true || showTr === "true" || showTr === 1;
 }
 if (own(s, "showQna")) cfg.showQna = s.showQna === true; // v1.16 §3
 // v1.21: only on unfiltered top responses; absent → keep the last known.
 if (own(s, "curatedOrder")) cfg.curatedOrder = s.curatedOrder === true;
 var brand = own(s, "brandDisplayName") ? s.brandDisplayName :
  (own(res, "brand_display_name") ? res.brand_display_name : undefined);
 if (typeof brand === "string" && brand) cfg.brand = brand;
 var theme = own(s, "designTheme") ? s.designTheme :
  (own(res, "design_theme") ? res.design_theme : undefined);
 if (typeof theme === "string" && theme) applySkin(theme);
 // v1.8 §4: only the two known values apply; older servers keep "original".
 var td = own(s, "translationDisplay") ? s.translationDisplay :
  (own(res, "translation_display") ? res.translation_display : undefined);
 if (td === "translated" || td === "original") cfg.translationDisplay = td;
}
/* v1.6.1 §B — `meta.pendingCount` is MERCHANT-ONLY server proof; read only if
   we sent a token, so a leaked payload never enters page state or the DOM. */
function readPendingCount(res) {
 if (!previewToken) return 0;
 var m = res && res.meta;
 if (!m || typeof m !== "object") return 0;
 var n = Number(m.pendingCount);
 return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function loadPage(append) {
 data.loading = true;
 data.error = false;
 if (!append && !data.reviews.length) renderList(); // "Loading reviews…" placeholder
 var token = ++loadSeq;
 return apiList(state).then((res) => {
  if (token !== loadSeq) return;
  data.loading = false;
  applyServerSettings(res);
  if (res.product) data.product = res.product;
  if (res.summary) data.summary = res.summary;
  data.total = Number(res.total) || 0;
  data.totalPages = Number(res.total_pages) || 0;
  data.pendingCount = readPendingCount(res);
  if (res.per_page) state.perPage = Number(res.per_page) || state.perPage;
  var incoming = res.reviews || [];
  data.reviews = append ? data.reviews.concat(incoming) : incoming.slice();
  if (res.media_gallery && res.media_gallery.length) data.gallery = res.media_gallery;
  renderAll();
  localizeSummaryIfNeeded();
 }).catch((err) => {
  if (token !== loadSeq) return;
  data.loading = false;
  if (append && state.page > 1) state.page -= 1;
  // §4 classification: gating / wrong path / network-5xx.
  var kind = err && err.cxNotLive ? "not_live" : (err && err.cxBadPath ? "bad_path" : "network");
  if (kind === "not_live") { handleNotLive(); return; } // idempotent
  if (data.reviews.length) {
   // Content is already on screen: keep every card, add an inline retry.
   renderPagination();
   renderInlineRetry(append === true);
   return;
  }
  data.error = true;
  data.errorKind = kind;
  renderList();
  renderPagination();
  // Shopper, first load, nothing real to show ⇒ quiet hide (never an error box).
  if (!isMerchantContext && !secList.firstChild) root.hidden = true;
 });
}
function reload() {
 state.page = 1;
 translatedIds = {};
 allTranslated = false;
 showOriginalIds = {}; // v1.8: a fresh list shows translations by default again
 loadPage(false);
}
function localizeSummaryIfNeeded() {
 if (summaryLocalized || cfg.demo || !cfg.showSummary) return;
 if (!data.summary || !data.summary.locale || data.summary.locale === cfg.locale) return;
 summaryLocalized = true;
 apiSummary(cfg.locale).then((res) => {
  if (res && res.summary && res.summary.text) {
   data.summary = res.summary;
   renderSummary();
   renderQna(); // v1.16 §3: localized suggested questions
  }
 }).catch(() => { /* keep the default-locale summary */ });
}

/* ---- init ---- */
function init() {
 if (!isLive && previewToken) renderPreviewBar(t);
 if (cfg.demo && !window.CellexiaDemoData) {
  var tries = 0;
  var timer = setInterval(() => {
   if (window.CellexiaDemoData || ++tries > 40) {
    clearInterval(timer);
    loadPage(false);
   }
  }, 50);
  return;
 }
 loadPage(false);
}
window.CellexiaReviews = {
 version: "1.10.0",
 refresh: reload,
 t: t,
 getState: () => Object.assign({}, state)
};
init();
}

/* ===== v1.5 (SPEC-1.5) app embed + site-wide star badges. Additive: no
   #cx-embed-config ⇒ the v1.4.1 boot path. Every DOM query is guarded. */
function inDesignMode() { return !!(window.Shopify && window.Shopify.designMode); }
function qsSafe(sel) {
 if (!sel) return null;
 try { return document.querySelector(sel); } catch (e) { return null; }
}
function detach(node) {
 try { if (node && node.parentNode) node.parentNode.removeChild(node); } catch (e) {}
}
function insertAfter(node, ref) {
 try {
  if (!ref || !ref.parentNode || node.contains(ref)) return false;
  ref.parentNode.insertBefore(node, ref.nextSibling);
  return true;
 } catch (e) { return false; }
}
// §1.2 config: { pageType, proxy, settings, skin, live, editorToken?, product? }
// Memoised; editorToken exists only in the editor.
var embedCfgCache;
function readEmbedConfig() {
 if (embedCfgCache !== undefined) return embedCfgCache;
 var tag = document.getElementById("cx-embed-config");
 try {
  var parsed = tag ? JSON.parse(tag.textContent) : null;
  embedCfgCache = parsed && typeof parsed === "object" ? parsed : null;
 } catch (e) { embedCfgCache = null; }
 return embedCfgCache;
}
function anyRoot() {
 return document.getElementById("cellexia-reviews") || document.getElementById("cellexia-reviews-embed");
}
// §3.6: block JSON-LD + embed copy coexist → drop the embed one early.
function dedupeEmbedJsonLd() {
 try {
  var embedLd = document.querySelector('script[type="application/ld+json"][data-cx-jsonld="embed"]');
  if (!embedLd) return;
  var others = document.querySelectorAll('script[type="application/ld+json"]:not([data-cx-jsonld])');
  for (var i = 0; i < others.length; i++) {
   if ((others[i].textContent || "").indexOf("#cellexia-product") >= 0) { detach(embedLd); return; }
  }
 } catch (e) {}
}
/* §3.2 cascade (SPEC-1.5.1 Fix 1): placement_selector → cart-form section
   (JS-rendered? watch 4 s + relocate) → end of main/#MainContent/body. */
function cartForm(root) {
 var f = qsSafe('main form[action*="/cart/add"]') || qsSafe('form[action*="/cart/add"]');
 return f && !root.contains(f) ? f : null;
}
function sectionOf(form) {
 try { return form.closest(".shopify-section, section") || form.parentElement; } catch (e) { return null; }
}
function contentWidth(node) {
 try {
  var cs = window.getComputedStyle(node);
  return node.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
 } catch (e) { return 0; }
}
var themeMaxCache = null; // measured .container width, cached
// Fix 1 gutters — runs after mount AND after relocation.
function applyGutters(root) {
 try {
  var parent = root.parentElement;
  if (!parent) return;
  var vw = window.innerWidth || 0;
  var full = vw > 0 && contentWidth(parent) >= vw - 32;
  root.classList.remove("cx--self-contained", "cx--in-container");
  root.classList.add(full ? "cx--self-contained" : "cx--in-container");
  if (full) {
   if (themeMaxCache === null) {
    var c = qsSafe(".container");
    themeMaxCache = c ? Math.round(contentWidth(c)) : 0;
   }
   if (themeMaxCache > 0) root.style.setProperty("--cx-embed-max", themeMaxCache + "px");
  }
 } catch (e) {}
}
// Relocate ≤4 s — never after user scroll past the widget or with a dialog open.
function watchForCartForm(root) {
 if (!window.MutationObserver) return;
 var seen = false;
 function onScroll() {
  try {
   // A hidden root measures 0×0; its rect must not mark it "seen".
   if (root.hidden || !root.getClientRects().length) return;
   // No scroll anchoring in Safari: relocating after a real scroll would jump.
   if (window.scrollY > 200) { seen = true; return; }
   if (root.getBoundingClientRect().top < window.innerHeight) seen = true;
  } catch (e) {}
 }
 function stop() {
  try { mo.disconnect(); window.removeEventListener("scroll", onScroll); } catch (e) {}
 }
 var mo = new MutationObserver(() => {
  var form = cartForm(root);
  if (!form) return;
  stop();
  if (seen || document.querySelector(".cx-overlay, .cx-dialog")) return;
  var ref = sectionOf(form);
  if (ref && insertAfter(root, ref)) applyGutters(root);
 });
 try {
  mo.observe(document.body, { childList: true, subtree: true });
  on(window, "scroll", onScroll, { passive: true });
  window.setTimeout(stop, 4000);
 } catch (e) { stop(); }
}
function mountEmbed(root, settings) {
 var ref = qsSafe(settings.placement_selector);
 if (ref && root.contains(ref)) ref = null;
 var form = ref ? null : cartForm(root);
 if (form) ref = sectionOf(form);
 if (!insertAfter(root, ref)) {
  var main = qsSafe("main") || qsSafe("#MainContent");
  try { ((main && !root.contains(main)) ? main : document.body).appendChild(root); } catch (e) {}
  if (!form) watchForCartForm(root);
 }
 root.hidden = false;
 applyGutters(root);
 // Gutters go stale on rotate/resize: drop the cache and re-measure.
 var reGutter = debounce(() => {
  themeMaxCache = null;
  try { root.style.removeProperty("--cx-embed-max"); } catch (e) {}
  applyGutters(root);
 }, 250);
 on(window, "resize", reGutter, { passive: true });
 on(window, "orientationchange", reGutter, { passive: true });
 return root;
}
/* SPEC-1.12 §1: Amazon displays star icons rounded to the nearest half. */
function halfRound(r) { return Math.round(r * 2) / 2; }
function scrollToTarget(tgt) {
 var rm = false;
 try { rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
 var y0 = window.pageYOffset;
 try { tgt.scrollIntoView(rm ? {} : { behavior: "smooth" }); } catch (e) {}
 if (rm) return;
 // Engines with smooth scrolling unavailable no-op the call — fall back hard.
 setTimeout(function () {
  try {
   if (window.pageYOffset === y0 && Math.abs(tgt.getBoundingClientRect().top) > 8) tgt.scrollIntoView();
  } catch (e) {}
 }, 400);
}
function buildInlineBadge(rating, count, style, skin, I, linkTargetId) {
 var badge = el(linkTargetId ? "a" : "span", "cx cx-badge-inline");
 sa(badge, "data-cx-skin", skin === "cellexia" || skin === "luxe" ? skin : "amazon");
 ap(badge, starRowCore(halfRound(rating), 16, I.t("a11y.stars_label", { rating: I.NF1.format(rating) })));
 if (style !== "stars_only") {
  var c = el("span", "cx-badge-inline__count", "(" + I.fmtNum(count) + ")");
  al(c, I.t("widget.review_count", { count: count }));
  ap(badge, c);
 }
 if (linkTargetId) {
  sa(badge, "href", "#" + linkTargetId);
  on(badge, "click", (ev) => {
   var tgt = document.getElementById(linkTargetId);
   if (!tgt || tgt.hidden) return;
   ev.preventDefault();
   scrollToTarget(tgt);
  });
 }
 return badge;
}
/* SPEC-1.12 §1–2: the PDP title badge — Amazon's exact anatomy: average
   number, half-rounded stars, caret trigger opening the ratings-breakdown
   popover, count as a link to the widget. Distribution arrives SSR'd
   (cfgE.product.distribution) or from the first widget load. */
function buildPdpBadge(cfgE, I, widgetRootId, rating, count, dist) {
 var skin = cfgE.skin === "cellexia" || cfgE.skin === "luxe" ? cfgE.skin : "amazon";
 var wrap = el("span", "cx cx-badge-inline cx-badge--pop");
 sa(wrap, "data-cx-skin", skin);
 var distData = dist || null;
 if (!distData) {
  on(document, "cellexia:loaded", (ev) => {
   try { if (ev.detail && ev.detail.distribution) distData = ev.detail.distribution; } catch (e) {}
  }, { once: true });
 }
 function widgetEl() { return widgetRootId ? document.getElementById(widgetRootId) : null; }
 var ratingLabel = I.t("a11y.stars_label", { rating: I.NF1.format(rating) });

 var trig = el("button", "cx-badge__trigger");
 sa(trig, "type", "button");
 sa(trig, "aria-haspopup", "dialog");
 sa(trig, "aria-expanded", "false");
 al(trig, I.t("a11y.ratings_breakdown") + ": " + ratingLabel);
 ap(trig, el("span", "cx-badge__avg", I.NF1.format(rating)));
 ap(trig, starRowCore(halfRound(rating), 16, ratingLabel));
 var car = ns("svg");
 sa(car, "viewBox", "0 0 10 6"); sa(car, "class", "cx-badge__caret");
 sa(car, "aria-hidden", "true"); sa(car, "width", "10"); sa(car, "height", "6");
 var cp = ns("path");
 sa(cp, "d", "M1 1l4 4 4-4"); sa(cp, "fill", "none");
 sa(cp, "stroke", "currentColor"); sa(cp, "stroke-width", "1.6");
 sa(cp, "stroke-linecap", "round"); sa(cp, "stroke-linejoin", "round");
 ap(car, cp); ap(trig, car);
 ap(wrap, trig);

 if ((cfgE.settings || {}).badge_style !== "stars_only") {
  var w0 = widgetEl();
  var cnt = el(w0 ? "a" : "span", "cx-badge-inline__count", "(" + I.fmtNum(count) + ")");
  al(cnt, I.t("widget.review_count", { count: count }));
  if (w0) {
   sa(cnt, "href", "#" + widgetRootId);
   on(cnt, "click", (ev) => {
    var tgt = widgetEl();
    if (!tgt || tgt.hidden) return;
    ev.preventDefault();
    scrollToTarget(tgt);
   });
  }
  ap(wrap, cnt);
 }

 var pop = el("div", "cx-badge__pop");
 sa(pop, "role", "dialog");
 al(pop, I.t("a11y.ratings_breakdown"));
 pop.hidden = true;
 ap(wrap, pop);
 var isOpen = false, hoverT = null, closeT = null;
 function clearT() {
  if (hoverT) { clearTimeout(hoverT); hoverT = null; }
  if (closeT) { clearTimeout(closeT); closeT = null; }
 }
 function fillPop() {
  clear(pop);
  var x = btn("cx-badge__close", null, () => closePop(true));
  al(x, I.t("a11y.close_dialog"));
  var xs = ns("svg");
  sa(xs, "viewBox", "0 0 12 12"); sa(xs, "aria-hidden", "true");
  sa(xs, "width", "12"); sa(xs, "height", "12");
  var xp = ns("path");
  sa(xp, "d", "M1 1l10 10M11 1L1 11"); sa(xp, "stroke", "currentColor");
  sa(xp, "stroke-width", "1.5"); sa(xp, "stroke-linecap", "round");
  ap(xs, xp); ap(x, xs); ap(pop, x);

  var head = el("div", "cx-badge__pophead");
  ap(head, starRowCore(halfRound(rating), 18, ratingLabel));
  ap(head, el("span", "cx-badge__popavg", I.t("widget.rating_out_of", { rating: I.NF1.format(rating) })));
  ap(pop, head);
  ap(pop, el("div", "cx-badge__popcount", I.t("widget.global_ratings", { count: count })));

  if (distData) {
   var hasW = !!widgetEl();
   var dist = el("div", "cx-dist");
   for (var s5 = 5; s5 >= 1; s5--) {
    ((sv) => {
     var d = distData[String(sv)] || { count: 0, percent: 0 };
     var row;
     if (hasW) {
      row = btn("cx-dist__row", null, () => {
       closePop(false);
       var tgt = widgetEl();
       if (!tgt) return;
       try {
        tgt.dispatchEvent(new CustomEvent("cellexia:set-stars", { bubbles: true, detail: { stars: sv } }));
       } catch (e) {}
       scrollToTarget(tgt);
      });
      al(row, I.t("a11y.filter_row", { stars: sv }));
     } else {
      row = el("div", "cx-dist__row");
     }
     ap(row, el("span", "cx-dist__label", I.t("widget.star_row", { count: sv })));
     var bar = el("span", "cx-dist__bar");
     var f = el("span", "cx-dist__fill");
     f.style.width = Math.max(0, Math.min(100, Number(d.percent) || 0)) + "%";
     ap(bar, f); ap(row, bar);
     ap(row, el("span", "cx-dist__percent", I.t("widget.percent", { percent: Number(d.percent) || 0 })));
     ap(dist, row);
    })(s5);
   }
   ap(pop, dist);
  }
  if (widgetEl()) {
   var foot = el("div", "cx-badge__popfoot");
   var see = el("a", "cx-badge__seelink", I.t("widget.see_reviews") + " ›");
   sa(see, "href", "#" + widgetRootId);
   on(see, "click", (ev) => {
    var tgt = widgetEl();
    if (!tgt) return;
    ev.preventDefault();
    closePop(false);
    scrollToTarget(tgt);
   });
   ap(foot, see); ap(pop, foot);
  }
 }
 function place() {
  pop.style.removeProperty("--cx-pop-shift");
  var r = pop.getBoundingClientRect();
  var vw = window.innerWidth || document.documentElement.clientWidth;
  var shift = 0;
  if (r.right > vw - 16) shift = vw - 16 - r.right;
  if (r.left + shift < 16) shift += 16 - (r.left + shift);
  if (shift) pop.style.setProperty("--cx-pop-shift", shift.toFixed(1) + "px");
 }
 function openPop() {
  if (isOpen) return;
  isOpen = true;
  fillPop();
  pop.hidden = false;
  sa(trig, "aria-expanded", "true");
  place();
 }
 function closePop(focusBack) {
  if (!isOpen) return;
  isOpen = false;
  pop.hidden = true;
  sa(trig, "aria-expanded", "false");
  if (focusBack) { try { trig.focus(); } catch (e) {} }
 }
 on(trig, "click", () => {
  clearT();
  if (isOpen) closePop(false); else openPop();
 });
 var canHover = false;
 try { canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) {}
 if (canHover) {
  // Mouse only: on hybrid touchscreens a tap synthesizes enter/leave pairs
  // that would arm the close timer and self-dismiss the popover.
  on(trig, "pointerenter", (ev) => {
   if (ev.pointerType && ev.pointerType !== "mouse") return;
   clearT();
   if (!isOpen) hoverT = setTimeout(openPop, 100);
  });
  on(wrap, "pointerleave", (ev) => {
   if (ev.pointerType && ev.pointerType !== "mouse") return;
   clearT();
   if (isOpen) closeT = setTimeout(() => closePop(false), 250);
  });
  on(wrap, "pointerenter", (ev) => {
   if (ev.pointerType && ev.pointerType !== "mouse") return;
   if (closeT) { clearTimeout(closeT); closeT = null; }
  });
 }
 on(document, "pointerdown", (ev) => {
  if (isOpen && !wrap.contains(ev.target)) closePop(false);
 });
 on(document, "keydown", (ev) => {
  if (isOpen && (ev.key === "Escape" || ev.key === "Esc")) {
   ev.stopPropagation();
   closePop(true);
  }
 });
 on(window, "resize", () => { if (isOpen) place(); }, { passive: true });
 return wrap;
}
/* §3.3 PDP title badge (SPEC-1.5.1 Fix 2): badge_selector → .pdp__heading →
   block .product__title → h1.product-single__title → main h1 → visible h1. */
function findPdpTitle(s) {
 var target = typeof s.badge_selector === "string" ? qsSafe(s.badge_selector.trim()) : null;
 if (!target) target = qsSafe(".pdp__heading");
 if (!target) {
  var pts;
  try { pts = document.querySelectorAll(".product__title"); } catch (e) { pts = []; }
  for (var i = 0; i < pts.length; i++) {
   try {
    if (!pts[i].closest(".cx") && (pts[i].matches("h1") || pts[i].querySelector("h1"))) { target = pts[i]; break; }
   } catch (e) {}
  }
 }
 if (!target) target = qsSafe("h1.product-single__title") || qsSafe("main h1");
 if (!target) {
  var hs;
  try { hs = document.querySelectorAll("h1"); } catch (e) { hs = []; }
  for (var j = 0; j < hs.length; j++) {
   if (hs[j].offsetParent !== null || hs[j].getClientRects().length) { target = hs[j]; break; }
  }
 }
 try {
  if (!target || target.closest(".cx") || target.hasAttribute("data-cx-badged")) return null;
 } catch (e) { return null; }
 return target;
}
/* v1.16.1: card-scoped tagline lookup — the badge-position setting applies
   to home/collection card badges too. Same preference order as the PDP:
   known tagline classes AFTER the title, else the title's next <p> sibling;
   none ⇒ null (caller falls back to under the title, never a missing badge).
   Scoped to the CARD so one card's blurb can never anchor another's badge. */
function cardTagline(card, titleEl) {
 function ok(n) {
  try { return !!n && n !== titleEl && !n.closest(".cx") && (n.textContent || "").trim(); } catch (e) { return false; }
 }
 var scope = card || titleEl.parentNode;
 if (!scope) return null;
 var sels = [".product__blurb", ".product__subtitle"], i, j, list;
 for (i = 0; i < sels.length; i++) {
  try { list = scope.querySelectorAll(sels[i]); } catch (e) { list = []; }
  for (j = 0; j < list.length; j++) {
   if (!ok(list[j])) continue;
   try { if (titleEl.compareDocumentPosition(list[j]) & 4) return list[j]; } catch (e) {}
  }
 }
 for (var n = titleEl.nextElementSibling; n; n = n.nextElementSibling) {
  if (n.tagName === "P" && ok(n)) return n;
 }
 return null;
}
/* v1.22 card_badge_position=under_price: the card's price container. The
   OUTERMOST matching node wins (themes nest span.money inside div.price and
   the badge belongs after the whole price block, sale + compare-at). Prefers
   a node AFTER the title; none ⇒ null (caller falls back, never no badge). */
function cardPrice(card, titleEl) {
 if (!card) return null;
 var list;
 try { list = card.querySelectorAll('[class*="price"],.money'); } catch (e) { return null; }
 /* A candidate must look like a PRICE, not merely price-adjacent: sale pills
    ("-20%", class price-badge), unit prices and compare-at labels all carry
    price-ish classes and digits. And it must be VISIBLE: themes render the
    price twice for breakpoints, and anchoring the badge inside the hidden
    copy shows it on one viewport and not the other. */
 function priceOk(n) {
  var cls = String(n.className || "");
  if (/badge|label|flash|save|discount|unit|compare/i.test(cls)) return false;
  var txt = (n.textContent || "").trim();
  if (!/[\d\u0660-\u0669\u06F0-\u06F9]/.test(txt)) return false;
  if (/^[\u2212\u2013-]?\s*[\d\u0660-\u0669\u06F0-\u06F9]+\s*%$/.test(txt)) return false;
  return !(n.offsetParent === null && !n.getClientRects().length);
 }
 var best = null;
 for (var i = 0; i < list.length; i++) {
  var n = list[i];
  try {
   if (n.closest(".cx") || !priceOk(n)) continue;
   var top = n, par = n.parentElement;
   while (par && par !== card && (par.matches('[class*="price"]') || par.matches(".money")) &&
    !(titleEl && par.contains(titleEl))) {
    top = par; par = par.parentElement;
   }
   if (!priceOk(top)) continue;
   if (titleEl && (titleEl.compareDocumentPosition(top) & 4)) return top;
   if (!best) best = top;
  } catch (e) {}
 }
 return best;
}
/* v1.10 (SPEC-1.10 §1) pdp_badge_position=under_tagline: .pdp__blurb →
   .product__subtitle → first <p> sibling after the title; none ⇒ under_title
   (never fail). Elements FOLLOWING the title in document order win. */
function findTagline(title) {
 function ok(n) { try { return !!n && !n.closest(".cx") && !n.hasAttribute("data-cx-badged"); } catch (e) { return false; } }
 var sels = [".pdp__blurb", ".product__subtitle"], i, j, list, first, n;
 for (i = 0; i < sels.length; i++) {
  try { list = document.querySelectorAll(sels[i]); } catch (e) { list = []; }
  first = null;
  for (j = 0; j < list.length; j++) {
   if (!ok(list[j])) continue;
   if (!first) first = list[j];
   try { if (title.compareDocumentPosition(list[j]) & 4) return list[j]; } catch (e) {}
  }
  if (first) return first;
 }
 for (n = title.nextElementSibling; n; n = n.nextElementSibling) {
  if (n.tagName === "P" && ok(n)) return n;
 }
 return null;
}
function renderPdpBadge(cfgE, I, widgetRootId, rating, count, dist) {
 if (document.querySelector(".cx.cx-badge-inline--pdp")) return; // v1.5.1 audit: match the class the badge actually gets
 var s = cfgE.settings || {};
 var target = null;
 // v1.10 §1: pdp_badge_selector wins outright (first match, badge_selector's pattern)
 var ov = typeof s.pdp_badge_selector === "string" ? s.pdp_badge_selector.trim() : "";
 if (ov) {
  var m = qsSafe(ov);
  try { if (m && !m.closest(".cx") && !m.hasAttribute("data-cx-badged")) target = m; } catch (e) {}
 }
 if (!target) {
  target = findPdpTitle(s);
  if (!target) return;
  if (s.pdp_badge_position === "under_tagline") target = findTagline(target) || target;
 }
 var badge = buildPdpBadge(cfgE, I, widgetRootId, rating, count, dist);
 badge.className += " cx-badge-inline--pdp";
 if (insertAfter(badge, target)) sa(target, "data-cx-badged", "pdp");
}
function pdpTitleBadge(cfgE, I, widgetRootId) {
 if (!cfgE || cfgE.pageType !== "product" || !cfgE.product) return;
 var s = cfgE.settings || {};
 if (s.show_pdp_title_badge === false) return;
 var rating = Number(cfgE.product.rating) || 0;
 var count = Number(cfgE.product.ratingCount) || 0;
 if (count >= 1 && rating > 0) {
  renderPdpBadge(cfgE, I, widgetRootId, rating, count, cfgE.product.distribution || null);
  return;
 }
 // Fix 2 fallback: first list load fills it (no extra fetch).
 on(document, "cellexia:loaded", (ev) => {
  try {
   var d = (ev && ev.detail) || {};
   if (Number(d.count) > 0 && Number(d.average) > 0) {
    renderPdpBadge(cfgE, I, widgetRootId, Number(d.average), Number(d.count), d.distribution || null);
   }
  } catch (e) {}
 }, { once: true });
}
// §3.4 site-wide badge injector.
function initBadges(cfgE, I) {
 if (!cfgE) return;
 var s = cfgE.settings || {};
 if (s.enable_badges === false) return;
 // (a) gating FIRST; editor: fetch normally when live, else nothing (§8).
 var live = cfgE.live !== false;
 var token = null;
 if (!live) {
  if (inDesignMode()) return;
  token = getPreviewToken(null, cfgE); // v1.10 §5A shared accessor
  if (!token) return;
 }
 var wr = document.getElementById("cellexia-reviews");
 var demo = cfgE.demo === true || !!(wr && wr.getAttribute("data-demo") === "true");
 var selOverride = typeof s.badge_selector === "string" ? s.badge_selector.trim() : "";
 var cache = {};      // handle -> stats | null (fetched, no published reviews)
 var requested = {};  // handle -> true once sent to the API
 var extraFetches = 0, rescans = 0, scans = 0;
 var stopped = false;
 var observer = null;
 /* Fix 3 (SPEC-1.5.1): CARD = first closest() over CARD_SELS (≤6 hops);
    TITLE searched WITHIN the card — image-only anchors are valid. */
 var CARD_SELS = [".product", '[class*="product-item"]', '[class*="product-card"]',
  '[class*="card"]', '[class*="grid__item"]', "li", "article"];
 var TITLE_SEL = '[class*="product__title"],[class*="product-title"],[class*="card__heading"],' +
  '[class*="title"]:not([class*="subtitle"]),h2,h3,h4';
 // (b) /products/x, /xx(-XX)/products/x and /collections/…/products/x resolve.
 function handleFrom(a) {
  var href = a.getAttribute("href");
  if (!href) return null;
  var path;
  try { path = new URL(href, window.location.href).pathname; } catch (e) { return null; }
  var idx = path.lastIndexOf("/products/");
  if (idx < 0) return null;
  var handle = path.slice(idx + 10).split("/")[0].toLowerCase();
  return /^[a-z0-9-]{1,255}$/.test(handle) ? handle : null;
 }
 function cardFor(a) {
  for (var i = 0; i < CARD_SELS.length; i++) {
   var node = a.parentElement, hops = 1;
   while (node && node.nodeType === 1 && hops <= 6) {
    try { if (node.matches(CARD_SELS[i])) return node; } catch (e) { break; }
    node = node.parentElement;
    hops += 1;
   }
  }
  return null;
 }
 function titleFor(card) {
  if (selOverride) {
   try {
    var o = card.querySelector(selOverride);
    return o && !o.closest(".cx") ? o : null;
   } catch (e) { return null; }
  }
  var candidates;
  try { candidates = card.querySelectorAll(TITLE_SEL); } catch (e) { return null; }
  for (var i = 0; i < candidates.length; i++) {
   var h = candidates[i];
   if (h.closest(".cx") || !(h.textContent || "").trim()) continue;
   // Cards may nest name (h3) + blurb in one [class*="title"] container:
   // insert after the heading itself.
   if (!/^H[2-4]$/.test(h.tagName)) {
    try {
     var hd = h.querySelector("h2,h3,h4");
     if (hd && !hd.closest(".cx") && (hd.textContent || "").trim()) return hd;
    } catch (e) {}
   }
   return h;
  }
  return null;
 }
 var pending = []; // collected {handle, card, titleEl, done}
 function collect() {
  var anchors;
  try { anchors = document.querySelectorAll('a[href*="/products/"]'); } catch (e) { return; }
  for (var i = 0; i < anchors.length; i++) {
   try {
    var a = anchors[i];
    if (a.closest('header, nav, footer, [class*="breadcrumb"], .cx, .cx-preview-bar, .cx-dialog, .cx-lightbox')) continue;
    if (a.offsetParent === null && !a.getClientRects().length) continue;
    var handle = handleFrom(a);
    if (!handle) continue;
    var card = cardFor(a);
    // nested matches = same card
    if (!card || card.closest("[data-cx-badged]") || card.querySelector("[data-cx-badged]")) continue;
    // v1.8 audit #5: adopt a cloned badged card — never a second badge.
    if (card.querySelector(".cx-badge-inline--card")) { sa(card, "data-cx-badged", handle); continue; }
    var titleEl = titleFor(card) || a; // fallback: the anchor
    sa(card, "data-cx-badged", handle); // dedupe ON the card
    pending.push({ handle: handle, card: card, titleEl: titleEl, done: false });
   } catch (e) {}
  }
 }
 function fetchStats(handles) {
  handles.forEach((h) => { requested[h] = true; });
  if (demo) { // window.CellexiaDemoData.badges = { handle: {average,count} }
   var src = (window.CellexiaDemoData && window.CellexiaDemoData.badges) || {};
   handles.forEach((h) => { cache[h] = own(src, h) && src[h] ? src[h] : null; });
   return Promise.resolve(true);
  }
  var r0 = anyRoot();
  // Session-proven base (§5 layer 3) wins, then the cleaned config/attribute
  // values (layer 2), then the default (self-heals via discovery retry).
  var base = seedProxyBase() || cleanProxyValue(cfgE.proxy) ||
   cleanProxyValue(r0 ? r0.getAttribute("data-proxy") : "") || "/apps/cellexia-reviews/api";
  // On failure un-mark the handles so a later pass may retry (capped above).
  var unmark = () => { handles.forEach((h) => { if (cache[h] === undefined) delete requested[h]; }); };
  // Badges never surface a failure — a broken path just means no stars.
  var attempt = (from, mayRetry) => {
   var b = from.replace(/\/$/, "");
   var url = b + "/badges?handles=" + encodeURIComponent(handles.join(","));
   if (token) url += "&preview_token=" + encodeURIComponent(token);
   // v1.14 §6: report the Liquid-emitted market handle (admin picker source).
   if (cfgE.market) url += "&market=" + encodeURIComponent(String(cfgE.market).slice(0, 64));
   return window.fetch(url, { credentials: "same-origin" }).then((r) => {
    if (r.status === 403) { // not_live: badges stop; a sent token = merchant → name the expiry (§5D)
     stopped = true; disconnect(); removePreviewBar();
     removeStampedHide(); // v1.14 §5: rejected token must not keep Stamped hidden
     if (token) showExpiredPageNotice(I);
     return false;
    }
    if ((r.status === 404 || r.status === 410) && mayRetry) {
     // Wrong subpath: join the ONE shared discovery sweep, then retry once.
     return runProxyDiscovery(b).then((found) => {
      if (!found || found === b) { unmark(); return false; }
      return attempt(found, false);
     });
    }
    if (!r.ok) { unmark(); return false; }
    return r.json().then((body) => {
     var map = (body && body.badges) || {};
     handles.forEach((h) => { cache[h] = own(map, h) ? map[h] : null; });
     if (token) fireTokenOk(); // v1.14 §5: server accepted this tab's token
     return true;
    }).catch(() => { unmark(); return false; });
   }).catch(() => { unmark(); return false; });
  };
  return attempt(base, true);
 }
 function inject() {
  for (var i = 0; i < pending.length; i++) {
   var en = pending[i];
   if (en.done) continue;
   try {
    var stats = cache[en.handle];
    if (stats === undefined) continue; // not fetched yet — stays pending
    en.done = true;
    if (!stats || !(Number(stats.count) > 0)) continue;
    // v1.8 audit #4/#5: if the theme replaced the title before data arrived,
    // re-resolve within the still-attached card; never insert twice.
    var tEl = en.titleEl && en.titleEl.parentNode ? en.titleEl :
     (en.card && en.card.parentNode ? titleFor(en.card) : null);
    if (!tEl || !tEl.parentNode) continue;
    if (en.card && en.card.querySelector(".cx-badge-inline--card")) continue;
    var b = buildInlineBadge(Number(stats.average) || 0, Number(stats.count) || 0, s.badge_style, cfgE.skin, I, null);
    b.className += " cx-badge-inline--card";
    // v1.22: cards have their own position setting; "inherit" (the default)
    // follows the product-page one — byte-identical to the old behavior.
    var pos = s.card_badge_position;
    if (!pos || pos === "inherit") {
     pos = s.pdp_badge_position === "under_tagline" ? "under_tagline" : "under_title";
    }
    var anchor = tEl;
    if (pos === "under_price") anchor = cardPrice(en.card, tEl) || cardTagline(en.card, tEl) || tEl;
    else if (pos === "under_tagline") anchor = cardTagline(en.card, tEl) || tEl;
    insertAfter(b, anchor);
   } catch (e) { en.done = true; }
  }
 }
 function disconnect() { if (observer) { observer.disconnect(); observer = null; } }
 function pauseMo() { if (observer) observer.disconnect(); }
 function resumeMo() {
  if (!observer || stopped) return;
  try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) { observer = null; }
 }
 // (c) one batched fetch ≤48 doc-order handles; (e) re-scans reuse the cache.
 function pass(isRescan) {
  if (stopped) return;
  pauseMo();
  collect();
  resumeMo();
  if (!pending.length) return;
  var fresh = [], seen = {};
  pending.forEach((en) => {
   if (!en.done && !requested[en.handle] && !seen[en.handle]) { seen[en.handle] = true; fresh.push(en.handle); }
  });
  var finish = () => {
   if (stopped) return;
   pauseMo();
   inject();
   resumeMo();
  };
  if (!fresh.length) { finish(); return; }
  if (isRescan) {
   if (extraFetches >= 2) { finish(); return; }
   extraFetches += 1;
  }
  fetchStats(fresh.slice(0, 48)).then(finish);
 }
 function kickoff() {
  if (stopped) return;
  // (f) ribbon: the v1.10 §5A bootstrap mounts it on every tokenized page
  pass(false);
  if (window.MutationObserver) {
   observer = new MutationObserver(debounce(() => {
    if (stopped || !observer) return;
    // Only PRODUCTIVE passes count toward the cap of 5 — unrelated DOM
    // churn must not consume the budget before late card grids render.
    scans += 1;
    var before = pending.length;
    pass(true);
    if (pending.length > before) rescans += 1;
    if (rescans >= 5 || scans >= 60) disconnect();
   }, 500));
   resumeMo();
  }
 }
 var runIdle = () => {
  if (window.requestIdleCallback) window.requestIdleCallback(kickoff, { timeout: 2000 });
  else window.setTimeout(kickoff, 50);
 };
 if (document.readyState === "loading") on(document, "DOMContentLoaded", runIdle);
 else runIdle();
}
/* ===== v1.9 (SPEC-1.9 §3) "Overall reviews" per-root module. Liquid SSRs;
   JS adds read-more, carousel nav, distribution filter (GET /brand-reviews,
   createElement-only). Gating = badge injector; failures keep SSR cards.
   v1.10 §5C: a data-less shell renders client-side in merchant contexts;
   zero reviews ⇒ notice.overall_pending; shoppers keep the hidden shell. */
function initOverall(root) {
 if (!root || root.getAttribute("data-cx-overall-init") === "true") return;
 sa(root, "data-cx-overall-init", "true");
 // v1.10.2: sections on container-less themes are full-bleed — reuse the
 // v1.5.1 gutter detection (re-applied on debounced resize).
 applyGutters(root);
 var gt = null;
 on(window, "resize", function () {
  if (gt) clearTimeout(gt);
  gt = setTimeout(function () { themeMaxCache = null; root.style.removeProperty("--cx-embed-max"); applyGutters(root); }, 250);
 }, { passive: true });
 function ga(n, d) { var v = root.getAttribute("data-" + n); return v === null || v === "" ? d : v; }
 function each(l, f) { Array.prototype.forEach.call(l, f); }
 var demo = ga("demo", "false") === "true";
 var live = ga("cx-live", "true") !== "false";
 var ed = inDesignMode();
 var cfgE = readEmbedConfig();
 var empty = ga("cx-overall-empty", "false") === "true"; // v1.10 §5C data-less shell
 var token = demo ? null : getPreviewToken(root, cfgE); // v1.10 §5A shared accessor
 var max = Math.min(24, parseInt(ga("max-reviews", "6"), 10) || 6);
 var car = ga("layout", "grid") === "carousel";
 var links = ga("show-product-links", "true") !== "false";
 var loc = ga("locale", "en");
 // v1.15 §2: translated display mode (mirrors the product widget).
 var td = ga("translation-display", "original") === "translated" ? "translated" : "original";
 var I = makeI18n(loc);
 var ot = I.t;
 function oLangName(code) {
  try { return new Intl.DisplayNames([loc], { type: "language" }).of(code) || code; } catch (e) { return code; }
 }
 seedProxyBase();
 function ob() { return resolvedProxyBase || cleanProxyValue(root.getAttribute("data-proxy") || "") || cleanProxyValue(cfgE ? cfgE.proxy : "") || "/apps/cellexia-reviews/api"; }
 var stars = 0, nsync = null, chip = null, note = null;
 var box = root.querySelector("[data-cx-overall-cards]");
 var ssr = box ? Array.prototype.slice.call(box.children) : [];
 function ntxt(k) { return I.str("notice." + k) || NOTICE_FALLBACK[k] || ""; }
 function unnote() { detach(note); note = null; }
 // §1.6 notice — merchant-only (§4).
 function showNote(kind) {
  if (!(ed || token) || !box || !box.parentNode) return;
  unnote();
  var t1, b1, d1;
  if (kind === "not_live") { t1 = ntxt("expired_title"); b1 = ntxt("expired_body"); }
  else if (kind === "pending") { b1 = ntxt("overall_pending"); } // v1.10 §5C
  else if (kind === "bad_path") {
   t1 = ntxt("unconfigured_title"); b1 = ntxt("unconfigured_body");
   d1 = (proxyTried.length ? proxyTried : [ob()]).join("  ·  ");
  } else { t1 = I.str("notice.error_title") || ot("widget.error_loading"); b1 = I.str("notice.error_body") || ""; }
  note = el("div", "cx-notice cx-notice--merchant");
  sa(note, "role", "status");
  if (t1) ap(note, el("strong", "cx-notice__title", t1));
  if (b1) ap(note, el("p", "cx-notice__body", b1));
  if (d1) ap(note, el("p", "cx-notice__detail", d1));
  box.parentNode.insertBefore(note, chip || box);
 }
 function unchip() { detach(chip); chip = null; }
 function rst(row) { return parseInt(row.getAttribute("data-stars"), 10) || 0; }
 function mark() {
  each(root.querySelectorAll(".cx-dist__row"), (row) => {
   var a = stars > 0 && stars === rst(row);
   row.classList.toggle("is-active", a);
   sa(row, "aria-pressed", a ? "true" : "false");
  });
 }
 // Re-measure while collapsed (resize / rotation / font swap).
 function syncMore(c) {
  var b = c.querySelector(".cx-overall__body"), tg = c.querySelector(".cx-read-more");
  if (!b || !tg || tg.getAttribute("aria-expanded") === "true") return;
  try { tg.hidden = !(b.scrollHeight > b.clientHeight + 2); } catch (e) {}
 }
 function syncAll() { each(root.querySelectorAll(".cx-overall__card"), syncMore); }
 function readMore(c) {
  var b = c.querySelector(".cx-overall__body");
  if (!b || c.querySelector(".cx-read-more")) return;
  var tg = btn("cx-link cx-read-more", ot("review.read_more"), () => {
   var cl = b.classList.toggle("cx-clamp");
   tg.textContent = ot(cl ? "review.read_more" : "review.show_less");
   sa(tg, "aria-expanded", cl ? "false" : "true");
  });
  sa(tg, "aria-expanded", "false");
  tg.hidden = true;
  if (!insertAfter(tg, b)) ap(c, tg);
  window.requestAnimationFrame(() => { syncMore(c); });
 }
 // Entry shape or API DTO.
 function card(r) {
  r = r || {};
  var p = r.product || {};
  var c = el("article", "cx-card cx-overall__card");
  var rating = Number(r.rating) || 0;
  var line = ap(c, el("div", "cx-card__titleline"));
  ap(line, starRowCore(rating, 16, ot("a11y.stars_label", { rating: I.NF1.format(rating) })));
  // v1.15 §2: server translation until "See original" (SPEC-1.8 §4 contract).
  var auto = td === "translated" && r.translated && r.translated.body ? r.translated : null;
  var showT = !!auto;
  var titleEl = null;
  if (r.title || (auto && auto.title)) titleEl = ap(line, el("strong", "cx-card__title"));
  var bodyP = ap(ap(c, el("div", "cx-overall__body cx-clamp")), el("p"));
  function paintT() {
   if (titleEl) titleEl.textContent = (showT && auto && auto.title ? auto.title : r.title) || "";
   bodyP.textContent = (showT && auto ? auto.body : r.body) || "";
  }
  paintT();
  if (auto) {
   var tn = el("p", "cx-muted cx-translated-note");
   var tns = ap(tn, el("span", null, ot("review.translated_from", { language: oLangName(auto.from || r.language) })));
   ap(tn, tx(" "));
   var tgl = ap(tn, btn("cx-link", ot("review.see_original"), () => {
    showT = !showT;
    paintT();
    tns.hidden = !showT;
    tgl.textContent = ot(showT ? "review.see_original" : "review.see_translation");
    syncMore(c);
   }));
   ap(c, tn);
  }
  var who = r.author || r.authorName || "";
  var dt = I.fmtDate(r.date || r.createdAt || "");
  var meta = el("p", "cx-card__meta");
  if (who) ap(meta, el("span", "cx-card__author", who));
  if (dt) {
   if (who) sa(ap(meta, el("span", null, " · ")), "aria-hidden", "true");
   ap(meta, el("span", null, dt));
  }
  if (meta.firstChild) ap(c, meta);
  if (r.verified) ap(c, el("p", "cx-badge-verified", ot("review.verified")));
  if (r.hasMedia || (r.media && r.media.length)) {
   var mi = ap(c, el("p", "cx-overall__media"));
   sa(ap(mi, el("span", "cx-overall__mediadot")), "aria-hidden", "true");
   ap(mi, tx(ot("widget.filter_media")));
  }
  var h = r.productHandle || p.handle || "";
  if (links && h) {
   var url = (p.url || "").charAt(0) === "/" ? p.url : "/products/" + h;
   if (url.indexOf("#") < 0) url += "#cellexia-reviews";
   var foot = el("div", "cx-overall__foot");
   var pt = r.productTitle || p.title || "";
   if (pt) sa(ap(foot, el("a", "cx-overall__plink", pt)), "href", url);
   var pc = Number(r.productReviewCount) || 0;
   if (pc > 0) sa(ap(foot, el("a", "cx-link cx-overall__read", ot("overall.read_reviews", { count: pc }))), "href", url);
   if (foot.firstChild) ap(c, foot);
  }
  readMore(c);
  return c;
 }
 function swap(nodes, empty) {
  clear(box);
  for (var i = 0; i < nodes.length; i++) ap(box, nodes[i]);
  if (empty) ap(box, el("p", "cx-muted cx-empty", ot("widget.no_results")));
  box.scrollLeft = 0;
  if (nsync) nsync();
 }
 function filtered(list) {
  unnote();
  swap(list.slice(0, max).map(card), !list.length);
  if (!chip && box.parentNode) {
   chip = btn("cx-btn cx-btn--sm cx-overall__reset", ot("widget.filter_all_stars"), () => { setFilter(0); });
   box.parentNode.insertBefore(chip, box);
  }
 }
 function restore() { unchip(); unnote(); swap(ssr, false); }
 /* v1.10 §5C — data-less shell: build the section from /brand-reviews so
    merchant preview works BEFORE any sync. SSR classes ⇒ skins apply. */
 function renderClientSection(st, list) {
  var hd = el("div", "cx-overall__header");
  var ht = ga("heading", "");
  if (ht) ap(hd, el("h2", "cx-overall__heading", ht));
  var avg = Number(st.average) || 0;
  var sc = ap(hd, el("div", "cx-overall__score"));
  ap(sc, starRowCore(avg, 28, ot("a11y.stars_label", { rating: I.NF1.format(avg) })));
  ap(sc, el("span", "cx-avg-text", ot("widget.rating_out_of", { rating: I.NF1.format(avg) })));
  ap(hd, el("p", "cx-overall__based", ot("overall.based_on", { count: Number(st.count) || 0 })));
  var vp = Math.round(Number(st.verifiedPercent) || 0);
  if (vp >= 60) ap(hd, el("p", "cx-overall__trust", ot("overall.verified_share", { percent: vp })));
  root.insertBefore(hd, box);
  var d = st.distribution;
  if (ga("show-distribution", "true") !== "false" && d) {
   var dist = el("div", "cx-dist cx-overall__dist");
   sa(dist, "role", "group");
   for (var n = 5; n >= 1; n--) {
    var pct = Math.max(0, Math.min(100, Number((d[String(n)] || {}).percent) || 0));
    var b = ap(dist, btn("cx-dist__row"));
    sa(b, "data-stars", String(n));
    sa(b, "aria-pressed", "false");
    al(b, ot("a11y.filter_row", { stars: n }));
    ap(b, el("span", "cx-dist__label", ot("widget.star_row", { count: n })));
    sa(ap(ap(b, el("span", "cx-dist__bar")), el("span", "cx-dist__fill")), "style", "inline-size:" + pct + "%");
    sa(ap(b, el("span", "cx-dist__percent", ot("widget.percent", { percent: pct }))), "aria-hidden", "true");
   }
   root.insertBefore(dist, box);
  }
  clear(box);
  list.slice(0, max).forEach((r) => { ap(box, card(r)); });
  ssr = Array.prototype.slice.call(box.children); // the star filter's restore set
 }
 function emptyBoot() {
  if (demo || !(ed || token)) { root.hidden = true; return; } // shopper: hidden shell, zero fetches
  fetchBrand(0).then((body) => {
   var st = body.stats || {};
   root.hidden = false; // before wire(): the carousel nav measures the box
   if ((Number(st.count) || 0) > 0 && body.reviews.length) { renderClientSection(st, body.reviews); wire(); }
   else showNote("pending"); // genuinely zero reviews (merchant-only)
  }, (kind) => {
   if (kind === "not_live") { removePreviewBar(); removeStampedHide(); } // §5D + v1.14 §5
   root.hidden = false;
   showNote(kind);
  });
 }
 // §2: 404/410 joins the one shared discovery sweep, retries once.
 function fetchBrand(n) {
  return new Promise((res, rej) => {
   if (!window.fetch) { rej("network"); return; }
   var q = "?per_page=" + max + "&locale=" + encodeURIComponent(loc) + (n ? "&stars=" + n : "") + (token ? "&preview_token=" + encodeURIComponent(token) : "");
   var go = (from, retry) => {
    window.fetch(from + "/brand-reviews" + q, { credentials: "same-origin" }).then((r) => {
     if (r.status === 403) { rej("not_live"); return; }
     if (r.status === 404 || r.status === 410) {
      if (!retry) { rej("bad_path"); return; }
      runProxyDiscovery(from).then((found) => {
       if (found && found !== from) go(found, false); else rej("bad_path");
      });
      return;
     }
     if (!r.ok) { rej("network"); return; }
     r.json().then((b) => { if (b && b.reviews) res(b); else rej("network"); }, () => { rej("bad_path"); });
    }, () => { rej("network"); });
   };
   go(ob(), true);
  });
 }
 function setFilter(n) {
  if (!box) return;
  stars = n;
  mark();
  if (!n) { restore(); return; }
  if (demo) {
   var bd = (window.CellexiaDemoData || {}).brand || {};
   filtered((bd.reviews || []).filter((r) => { return Math.round(Number(r.rating) || 0) === n; }));
   return;
  }
  if (!live && !token) { showNote("not_live"); return; } // gating BEFORE any fetch
  fetchBrand(n).then((body) => {
   if (stars === n) filtered(body.reviews);
  }, (kind) => {
   if (!stars) return;
   stars = 0;
   mark();
   restore();
   if (kind === "not_live") { removePreviewBar(); removeStampedHide(); }
   showNote(kind);
  });
 }
 function wire() {
  if (box) each(box.querySelectorAll(".cx-overall__card"), readMore);
  on(window, "resize", debounce(syncAll, 150), { passive: true });
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncAll); } catch (e) {}
  if (car && box && !root.querySelector(".cx-overall__nav")) {
   var nav = el("div", "cx-overall__nav");
   var rtl = (root.getAttribute("dir") || "") === "rtl";
   var mk = (dirn, label, glyph) => {
    var b = ap(nav, btn("cx-overall__navbtn", glyph, () => {
     var amt = Math.max(box.clientWidth * 0.9, 160) * dirn * (rtl ? -1 : 1);
     // behavior:auto defers to the CSS scroll-behavior rules
     try { box.scrollBy({ left: amt, behavior: "auto" }); } catch (e) { box.scrollLeft += amt; }
    }));
    al(b, label);
   };
   mk(-1, ot("a11y.prev"), "‹");
   mk(1, ot("a11y.next"), "›");
   if (!insertAfter(nav, box)) ap(root, nav);
   nsync = () => { try { nav.hidden = box.scrollWidth - box.clientWidth <= 4; } catch (e) {} };
   on(window, "resize", debounce(nsync, 150), { passive: true });
   nsync();
  }
  each(root.querySelectorAll(".cx-dist__row"), (row) => {
   on(row, "click", () => { var n = rst(row); if (n) setFilter(stars === n ? 0 : n); });
  });
 }
 if (!demo && !live && !ed) {
  if (!token) { root.hidden = true; return; } // shopper: zero fetches, zero pixels
  if (!empty) root.hidden = false; // tokenized preview: SSR in the shell (ribbon: §5A bootstrap)
 }
 if (empty) { emptyBoot(); return; } // v1.10 §5C
 wire();
 // v1.15 §2: SSR cards are language-neutral (metafield) — translated mode
 // refreshes once from the API; silent failure keeps the SSR originals.
 // Review fixes: no repaint when nothing translated; a star filter clicked
 // before this resolves stashes the translated cards for restore() instead.
 if (td === "translated" && box && !demo && (live || token || ed)) {
  fetchBrand(0).then((body) => {
   if (!body.reviews || !body.reviews.length) return;
   var anyT = false;
   for (var bi = 0; bi < body.reviews.length; bi++) {
    var bt = body.reviews[bi].translated;
    if (bt && bt.body) { anyT = true; break; }
   }
   if (!anyT) return;
   var nodes = body.reviews.slice(0, max).map(card);
   if (stars) { ssr = nodes; return; }
   swap(nodes, false);
   ssr = Array.prototype.slice.call(box.children);
  }, () => {});
 }
}
function initOverallRoots(scope) {
 var list;
 try { list = (scope || document).querySelectorAll(".cx-overall"); } catch (e) { return; }
 for (var i = 0; i < list.length; i++) {
  try { initOverall(list[i]); } catch (e) { /* never break the theme */ }
 }
}
/* v1.14 §5: preview-tab Stamped hide — one rule per selector, hostile
   characters skipped (server sanitizes too). SECURITY (review fix): only
   called after the server ACCEPTED the tab's preview token (cellexia:tokenok,
   fired by a successful token-carrying widget/badge fetch) — a fabricated
   ?cx_preview= value must never hide Stamped for a shopper. The injected
   style is marked so the invalid-token path can remove it WITHOUT touching a
   Liquid-emitted live-market style. */
function injectStampedHide(selectors) {
 if (!Array.isArray(selectors) || document.getElementById("cx-stamped-hide")) return;
 var bad = /[<{};@\/]/;
 var css = "";
 for (var i = 0; i < selectors.length; i++) {
  var s = String(selectors[i] || "").trim();
  if (!s || s.length > 200 || bad.test(s)) continue;
  css += s + "{display:none !important}\n";
 }
 if (!css) return;
 var st = el("style");
 st.id = "cx-stamped-hide";
 sa(st, "data-cx-injected", "1");
 st.textContent = css;
 try { document.head.appendChild(st); } catch (e) {}
}
function removeStampedHide() {
 var st = document.getElementById("cx-stamped-hide");
 if (st && st.getAttribute("data-cx-injected") === "1") {
  try { st.parentNode.removeChild(st); } catch (e) {}
 }
}
function fireTokenOk() {
 try { document.dispatchEvent(new CustomEvent("cellexia:tokenok")); } catch (e) {}
}
/* ---- start orchestration (§3.1) ---- */
function start() {
 // block + embed both emit the (cached) script tag — run once
 var de = document.documentElement;
 if (de.getAttribute("data-cx-booted") === "true") return;
 sa(de, "data-cx-booted", "true");
 previewBootstrap(); // v1.10 §5A: site-wide capture + ribbon before any surface boots
 var cfgE = readEmbedConfig();
 var blockRoot = document.getElementById("cellexia-reviews");
 var embedRoot = document.getElementById("cellexia-reviews-embed");
 if (blockRoot && embedRoot) { // blocks win — never double-render
  detach(embedRoot);
  embedRoot = null;
 }
 dedupeEmbedJsonLd();
 var es = (cfgE && cfgE.settings) || {};
 var widgetRoot = blockRoot;
 if (!widgetRoot && embedRoot) {
  if (es.enable_product_widget === false) {
   detach(embedRoot);
  } else {
   try { widgetRoot = mountEmbed(embedRoot, es); } catch (e) { widgetRoot = embedRoot; }
  }
 }
 if (widgetRoot) {
  try { boot(widgetRoot); } catch (e) { /* the widget must never break the theme */ }
 }
 initOverallRoots(document); // v1.9 overall-reviews roots
 if (!cfgE) return; // block-only page: v1.4.1 behavior ends here
 try {
  var r0 = anyRoot();
  var I = makeI18n((r0 && r0.getAttribute("data-locale")) || document.documentElement.lang || "en");
  var live = cfgE.live !== false;
  var previewing = !live && !!getPreviewToken(null, cfgE); // v1.10 §5A
  if (live || previewing || inDesignMode()) { // §3.3: gating passed
   pdpTitleBadge(cfgE, I, widgetRoot ? widgetRoot.id : null);
  }
  // v1.14 §5 (review-hardened): preview simulates the Stamped takeover ONLY
  // after the server accepts this tab's token — never on the raw presence of
  // a ?cx_preview= value (when live-in-market, Liquid already emitted the
  // style; the id dedupes).
  if (previewing && cfgE.hideStamped === true) {
   on(document, "cellexia:tokenok", () => injectStampedHide(cfgE.stampedSelectors), { once: true });
  }
  initBadges(cfgE, I);
 } catch (e) { /* never break the theme */ }
}
if (document.readyState === "loading") {
 document.addEventListener("DOMContentLoaded", start);
} else {
 start();
}
// v1.9: hydrate roots re-rendered by the theme editor.
on(document, "shopify:section:load", (ev) => {
 initOverallRoots(ev && ev.target ? ev.target : document);
});
})();