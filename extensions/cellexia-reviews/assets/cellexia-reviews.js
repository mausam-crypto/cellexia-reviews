/* Cellexia Reviews storefront widget — vanilla ES2019, no dependencies.
* Contract: SPEC §6/§8/§9/§15, SPEC-1.2 (gating), SPEC-1.5 (embed, badges, JSON-LD dedupe).
* No innerHTML with user content — DOM built via createElement/textContent only.
*/
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
 sa(p, "stroke", "#DE7921");
 sa(p, "stroke-width", "1");
 sa(p, "stroke-linejoin", "round");
 if (frac >= 0.95) {
  sa(p, "fill", "#FFA41C");
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
  sa(s1, "offset", pct); sa(s1, "stop-color", "#FFA41C");
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
function discoverPreviewToken() {
 var urlToken = null;
 try { urlToken = new URLSearchParams(window.location.search).get("cx_preview"); } catch (e) { /* no URLSearchParams */ }
 if (urlToken) {
  ssSet("cx_preview_token", urlToken);
  return urlToken;
 }
 return ssGet("cx_preview_token");
}
/* i18n: flat dict from #cx-i18n + Intl formatters for one locale. */
function makeI18n(locale) {
 var STRINGS = {};
 (function loadDict() {
  var tag = document.getElementById("cx-i18n");
  if (!tag) return;
  var parsed;
  try { parsed = JSON.parse(tag.textContent); } catch (e) { return; }
  (function flatten(obj, prefix) {
   for (var k in obj) {
    if (!own(obj, k)) continue;
    var v = obj[k];
    var p = prefix ? prefix + "." + k : k;
    if (v !== null && typeof v === "object") flatten(v, p);
    else STRINGS[p] = String(v);
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
  return s.replace(/\[\[(\w+)\]\]/g, (m, name) => {
   if (!(name in vars)) return m;
   var v = vars[name];
   return typeof v === "number" ? fmtNum(v) : String(v);
  });
 }
 return { t: t, str: str, fmtNum: fmtNum, fmtDate: fmtDate, NF1: NF1 };
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
 proxy: attr("proxy", "/apps/cellexia-reviews/api").replace(/\/$/, ""),
 perPage: parseInt(attr("per-page", "10"), 10) || 10,
 defaultLocale: attr("shop-default-locale", "en"),
 showSummary: flag("show-summary", true),
 showMediaStrip: flag("show-media-strip", true),
 showForm: flag("show-form", true),
 showTranslate: flag("show-translate", true),
 demo: attr("demo", "false") === "true",
 brand: attr("brand", "Cellexia")
};

/* ---- v1.2 live / preview gating (SPEC-1.2) ---- */
// data-cx-live absent ⇒ live; not live: only a token un-hides; v1.5: embed re-hides sans token, editor short-circuits.
var isLive = attr("cx-live", "true") !== "false";
var designMode = !!(window.Shopify && window.Shopify.designMode);
var isEmbed = root.getAttribute("data-cx-embed") === "true";
var previewToken = null;
if (!isLive) {
 previewToken = discoverPreviewToken();
 if (previewToken) {
  root.hidden = false;
 } else if (isEmbed && designMode) {
  root.hidden = false; // editor stays visible; API 403s stay quiet
 } else {
  if (isEmbed) root.hidden = true; // re-hide the relocated embed shell
  return; // block root stays hidden
 }
}
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
var t = I18N.t, str = I18N.str, fmtNum = I18N.fmtNum, fmtDate = I18N.fmtDate, NF1 = I18N.NF1;
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
// v1.2: 403 not_live without a valid token → transports hide the widget quietly.
function httpError(status, body) {
 var err = new Error("http_" + status);
 if (status === 403 && body && body.errors && body.errors._ === "not_live") err.cxNotLive = true;
 return err;
}
function withPreview(body) {
 if (previewToken) body.preview_token = previewToken;
 return body;
}
function getJSON(url) {
 return window.fetch(url, { credentials: "same-origin" }).then((r) => {
  if (!r.ok) {
   return r.json().catch(() => { return null; }).then((body) => {
    var err = httpError(r.status, body);
    if (err.cxNotLive) handleNotLive();
    throw err;
   });
  }
  return r.json();
 });
}
function postJSON(url, body) {
 return window.fetch(url, {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(withPreview(body))
 }).then((r) => {
  return r.json().catch(() => { throw httpError(r.status, null); }).then((parsed) => {
   var err = httpError(r.status, parsed);
   if (err.cxNotLive) { handleNotLive(); throw err; }
   return parsed;
  });
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
 return getJSON(cfg.proxy + "/reviews" + qs({
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
  locale: cfg.locale,
  preview_token: previewToken
 }));
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
 return postJSON(cfg.proxy + "/reviews/" + encodeURIComponent(reviewId) + "/vote", { token: visitorToken() });
}
function apiReport(reviewId, reason) {
 if (cfg.demo) return demoDelay({ ok: true });
 return postJSON(cfg.proxy + "/reviews/" + encodeURIComponent(reviewId) + "/report", {
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
 return postJSON(cfg.proxy + "/translate", { ids: ids, target: target });
}
function apiSummary(locale) {
 if (cfg.demo) return demoDelay({ summary: demoData().summary || null });
 return getJSON(cfg.proxy + "/summary" + qs({ product_id: cfg.productId, locale: locale, preview_token: previewToken }));
}
function apiSubmit(formData) {
 if (cfg.demo) {
  return demoDelay({ ok: true, status: "PENDING" });
 }
 if (previewToken) formData.append("preview_token", previewToken);
 return window.fetch(cfg.proxy + "/reviews", {
  method: "POST", credentials: "same-origin", body: formData
 }).then((r) => {
  return r.json().catch(() => { throw httpError(r.status, null); }).then((parsed) => {
   var err = httpError(r.status, parsed);
   if (err.cxNotLive) { handleNotLive(); throw err; }
   return parsed;
  });
 });
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
 total: 0, totalPages: 0, loading: false, error: false
};
var activeTerms = [];        // highlight terms of the active topic
var translatedIds = {};      // reviewId -> true when showing translation
var allTranslated = false;
var firstLoadDone = false;
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
 [secHeader, secSummary, secWrite].forEach((s) => { ap(rail, s); });
 [secMedia, secControls, secFilters, secList, secPagination].forEach((s) => { ap(mainCol, s); });
}
if (secFilters.parentNode && secList.parentNode) { // pills sit above the list
 secList.parentNode.insertBefore(secFilters, secList);
}
// v1.2: the editor SSRs the widget even when not live — snapshot to restore.
var ssrListSnapshot = designMode ? Array.prototype.slice.call(secList.children) : null;
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
 st(overlay, { position: "fixed", inset: "0", background: "rgba(15,17,17,0.45)", zIndex: "2147483000",
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

/* ---- v1.2 quiet not-live handling ---- */
// 403 not_live: hide quietly (the theme editor keeps the block visible).
var notLiveHandled = false;
function handleNotLive() {
 if (notLiveHandled) return;
 notLiveHandled = true;
 if (currentDialogClose) currentDialogClose();
 removePreviewBar();
 if (!designMode) root.hidden = true;
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
var topicPanel = null;
function renderSummary() {
 clear(secSummary);
 topicPanel = null;
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
 [["top", tw("sort_top")], ["recent", tw("sort_recent")]].forEach((opt) => {
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
 if (cfg.showTranslate && hasForeignReviews()) {
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
 var tr = translatedIds[r.id] ? trCache[r.id] : null;
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
  var errWrap = el("div", "cx-error-state");
  ap(errWrap, el("p", null, tw("error_loading")));
  ap(errWrap, btn("cx-btn", tw("retry"), () => { reload(); }));
  ap(secList, errWrap);
  return;
 }
 if (data.loading && !data.reviews.length) {
  ap(secList, el("p", "cx-muted cx-loading", tw("loading")));
  return;
 }
 if (!data.reviews.length) {
  ap(secList, el("p", "cx-muted cx-empty",
   anyFilterActive() ? tw("no_results") : tw("no_reviews")));
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
  root.dispatchEvent(new CustomEvent("cellexia:loaded", {
   bubbles: true,
   detail: { productId: cfg.productId, total: data.total }
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
 var brand = own(s, "brandDisplayName") ? s.brandDisplayName :
  (own(res, "brand_display_name") ? res.brand_display_name : undefined);
 if (typeof brand === "string" && brand) cfg.brand = brand;
 var theme = own(s, "designTheme") ? s.designTheme :
  (own(res, "design_theme") ? res.design_theme : undefined);
 if (typeof theme === "string" && theme) applySkin(theme);
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
  if (res.per_page) state.perPage = Number(res.per_page) || state.perPage;
  var incoming = res.reviews || [];
  data.reviews = append ? data.reviews.concat(incoming) : incoming.slice();
  if (res.media_gallery && res.media_gallery.length) data.gallery = res.media_gallery;
  renderAll();
  localizeSummaryIfNeeded();
 }).catch((err) => {
  if (token !== loadSeq) return;
  data.loading = false;
  if (err && err.cxNotLive) {
   // Quiet: handleNotLive() already ran — plain empty state, no error UI.
   if (append && state.page > 1) state.page -= 1;
   if (designMode && ssrListSnapshot && ssrListSnapshot.length) {
    // Theme editor of a not-live store: restore the SSR reviews.
    clear(secList);
    cardRefs = {};
    for (var i = 0; i < ssrListSnapshot.length; i++) ap(secList, ssrListSnapshot[i]);
    return;
   }
   renderList();
   renderPagination();
   return;
  }
  data.error = true;
  if (append && state.page > 1) state.page -= 1;
  renderList();
  renderPagination();
 });
}
function reload() {
 state.page = 1;
 translatedIds = {};
 allTranslated = false;
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
 version: "1.5.0",
 refresh: reload,
 t: t,
 getState: () => Object.assign({}, state)
};
init();
}

/* ===== v1.5 (SPEC-1.5) app embed + site-wide star badges =====
   Additive: without #cx-embed-config this degrades to the v1.4.1 boot path.
   Every DOM query is guarded — never throw on any theme page. */
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
// §1.2 config: { pageType, settings, skin, live, product? }
function readEmbedConfig() {
 var tag = document.getElementById("cx-embed-config");
 try {
  var parsed = tag ? JSON.parse(tag.textContent) : null;
  return parsed && typeof parsed === "object" ? parsed : null;
 } catch (e) { return null; }
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
// §3.2 placement cascade; reveals — boot()'s gating re-hides when not live.
function mountEmbed(root, settings) {
 var ref = qsSafe(settings.placement_selector);
 if (ref && root.contains(ref)) ref = null;
 if (!ref) {
  var form = qsSafe('main form[action*="/cart/add"]') || qsSafe('form[action*="/cart/add"]');
  if (form) {
   try { ref = form.closest(".shopify-section, section") || form.parentElement; } catch (e) { ref = null; }
  }
 }
 if (!ref) ref = qsSafe(".product__info-wrapper") || qsSafe("product-info") || qsSafe("main .product");
 if (!insertAfter(root, ref)) {
  var main = qsSafe("main");
  try { if (main && !root.contains(main)) main.appendChild(root); } catch (e) {}
 }
 root.hidden = false;
 return root;
}
function buildInlineBadge(rating, count, style, skin, I, linkTargetId) {
 var badge = el(linkTargetId ? "a" : "span", "cx cx-badge-inline");
 sa(badge, "data-cx-skin", skin === "cellexia" || skin === "luxe" ? skin : "amazon");
 ap(badge, starRowCore(rating, 16, I.t("a11y.stars_label", { rating: I.NF1.format(rating) })));
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
   var rm = false;
   try { rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
   try { tgt.scrollIntoView(rm ? {} : { behavior: "smooth" }); } catch (e) {}
  });
 }
 return badge;
}
// §3.3 PDP title badge: instant paint from config rating/count (no fetch); none at 0 reviews or with the star-rating block.
function pdpTitleBadge(cfgE, I, widgetRootId) {
 if (!cfgE || cfgE.pageType !== "product" || !cfgE.product) return;
 var s = cfgE.settings || {};
 if (s.show_pdp_title_badge === false) return;
 if (document.querySelector(".cx.cx-badge")) return;
 var rating = Number(cfgE.product.rating) || 0;
 var count = Number(cfgE.product.ratingCount) || 0;
 if (count < 1 || rating <= 0) return;
 var target = qsSafe(".product__title") || qsSafe("h1.product-single__title") || qsSafe("main h1");
 if (!target || target.hasAttribute("data-cx-badged") || target.closest(".cx")) return;
 var badge = buildInlineBadge(rating, count, s.badge_style, cfgE.skin, I, widgetRootId);
 if (insertAfter(badge, target)) sa(target, "data-cx-badged", "pdp");
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
  token = discoverPreviewToken();
  if (!token) return;
 }
 var wr = document.getElementById("cellexia-reviews");
 var demo = cfgE.demo === true || !!(wr && wr.getAttribute("data-demo") === "true");
 var selOverride = typeof s.badge_selector === "string" ? s.badge_selector.trim() : "";
 var cache = {};      // handle -> stats | null (fetched, no published reviews)
 var requested = {};  // handle -> true once sent to the API
 var extraFetches = 0, rescans = 0;
 var stopped = false;
 var observer = null;
 var TITLE_SEL = "h1,h2,h3,h4,h5,.card__heading,.card__title,.card-title,.product-title," +
  ".product-card__title,.product-item__title,.grid-product__title,.grid-view-item__title";
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
 function titleFor(a, card, handle) {
  if (selOverride) { // merchant override is authoritative
   try { return card.querySelector(selOverride); } catch (e) { return null; }
  }
  var within = null;
  try { within = a.closest(TITLE_SEL); } catch (e) {}
  if (within && card.contains(within)) return within;
  var candidates;
  try { candidates = card.querySelectorAll(TITLE_SEL); } catch (e) { return null; }
  var fallback = null;
  for (var i = 0; i < candidates.length; i++) {
   var h = candidates[i];
   if (h.closest(".cx")) continue;
   var link = h.querySelector('a[href*="/products/"]');
   if (link) {
    if (handleFrom(link) === handle) return h;
   } else if (!fallback && (h.textContent || "").trim()) {
    fallback = h; // unlinked heading in a card with an overlay link
   }
  }
  return fallback;
 }
 var pending = []; // collected {handle, titleEl, done}
 function collect() {
  var anchors;
  try { anchors = document.querySelectorAll('a[href*="/products/"]'); } catch (e) { return; }
  for (var i = 0; i < anchors.length; i++) {
   try {
    var a = anchors[i];
    if (a.closest(".cx, .cx-preview-bar, .cx-dialog, .cx-lightbox")) continue;
    if (a.offsetParent === null && !a.getClientRects().length) continue;
    var handle = handleFrom(a);
    if (!handle || cache[handle] === null) continue;
    var card = a.closest("li, article, .card-wrapper, .card, .grid__item, .product-card, .product-item, product-card") || a.parentElement;
    if (!card) continue;
    var titleEl = titleFor(a, card, handle);
    if (!titleEl || titleEl.hasAttribute("data-cx-badged")) continue;
    sa(titleEl, "data-cx-badged", handle); // dedupe per handle+element
    pending.push({ handle: handle, titleEl: titleEl, done: false });
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
  var url = ((r0 && r0.getAttribute("data-proxy")) || "/apps/cellexia-reviews/api").replace(/\/$/, "") +
   "/badges?handles=" + encodeURIComponent(handles.join(","));
  if (token) url += "&preview_token=" + encodeURIComponent(token);
  return window.fetch(url, { credentials: "same-origin" }).then((r) => {
   if (!r.ok) {
    if (r.status === 403) { stopped = true; disconnect(); removePreviewBar(); } // not_live: go quiet
    return false;
   }
   return r.json().then((body) => {
    var map = (body && body.badges) || {};
    handles.forEach((h) => { cache[h] = own(map, h) ? map[h] : null; });
    return true;
   }).catch(() => false);
  }).catch(() => false);
 }
 function inject() {
  for (var i = 0; i < pending.length; i++) {
   var en = pending[i];
   if (en.done) continue;
   try {
    var stats = cache[en.handle];
    if (stats === undefined) continue; // not fetched yet — stays pending
    en.done = true;
    if (!stats || !(Number(stats.count) > 0) || !en.titleEl.parentNode) continue;
    insertAfter(buildInlineBadge(Number(stats.average) || 0, Number(stats.count) || 0, s.badge_style, cfgE.skin, I, null), en.titleEl);
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
  // (f) preview ribbon on badge-only pages (the widget mounts its own)
  if (token && !anyRoot()) {
   try { renderPreviewBar(I.t); } catch (e) {}
  }
  pass(false);
  if (window.MutationObserver) {
   observer = new MutationObserver(debounce(() => {
    if (stopped || !observer) return;
    rescans += 1;
    if (rescans >= 5) disconnect(); // cap: 5 re-scans per page
    if (rescans <= 5) pass(true);
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
/* ---- start orchestration (§3.1) ---- */
function start() {
 // block + embed both emit the (cached) script tag — run once
 var de = document.documentElement;
 if (de.getAttribute("data-cx-booted") === "true") return;
 sa(de, "data-cx-booted", "true");
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
 if (!cfgE) return; // block-only page: v1.4.1 behavior ends here
 try {
  var r0 = anyRoot();
  var I = makeI18n((r0 && r0.getAttribute("data-locale")) || document.documentElement.lang || "en");
  var live = cfgE.live !== false;
  var previewing = !live && !!discoverPreviewToken();
  if (live || previewing || inDesignMode()) { // §3.3: gating passed
   pdpTitleBadge(cfgE, I, widgetRoot ? widgetRoot.id : null);
  }
  initBadges(cfgE, I);
 } catch (e) { /* never break the theme */ }
}
if (document.readyState === "loading") {
 document.addEventListener("DOMContentLoaded", start);
} else {
 start();
}
})();