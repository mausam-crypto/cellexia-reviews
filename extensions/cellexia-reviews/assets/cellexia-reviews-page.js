/* Cellexia Reviews — brand page interactive layer (SPEC-1.19 §9).
 * Standalone: the main widget assets are NOT required (and usually not
 * loaded) on /pages/cellexia-reviews. Vanilla ES2018, no dependencies.
 * Progressive enhancement: the SSR'd content (filters aside, top reviews)
 * stays untouched until the FIRST user-initiated filter change — this file
 * never blanks server-rendered content on load, and every failure is quiet
 * for shoppers (SPEC-1.6 failure UX).
 * No innerHTML with user/API content — DOM built via createElement +
 * textContent only (same rule as cellexia-reviews.js). */
(() => {
"use strict";
var SVG_NS = "http://www.w3.org/2000/svg";
function el(tag, cls, text) {
 var e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined && text !== null) e.textContent = text;
 return e;
}
function sa(e, n, v) { e.setAttribute(n, v); }
function ap(p, c) { p.appendChild(c); return c; }
function on(e, n, f) { e.addEventListener(n, f); }
function ns(tag) { return document.createElementNS(SVG_NS, tag); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* ===== preview token — SAME keys + rules as cellexia-reviews.js (v1.10 §5A)
   so a merchant preview session carries over between the widget pages and
   this one: URL param `cx_preview`, sessionStorage key `cx_preview_token`,
   live pages (no [data-cx-live="false"] and not the theme editor) are
   URL-only and never persist. Tokens go into API calls only — NEVER into
   markup or hrefs shown to users. */
function ssGet(key) {
 try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
}
function ssSet(key, val) {
 try { window.sessionStorage.setItem(key, val); } catch (e) {}
}
function urlPreviewToken() {
 try { return new URLSearchParams(window.location.search).get("cx_preview") || null; } catch (e) { return null; }
}
function inDesignMode() { return !!(window.Shopify && window.Shopify.designMode); }
function pageIsLive() {
 var roots, i;
 try { roots = document.querySelectorAll("[data-cx-live]"); } catch (e) { roots = []; }
 for (i = 0; i < roots.length; i++) {
  if (roots[i].getAttribute("data-cx-live") === "false") return false;
 }
 return true;
}
/* v1.6 §3 (RC-A) — design-mode-only editor token: the section emits
   data-cx-editor-token ONLY in design mode; we re-check and never persist it. */
function editorToken(root) {
 if (!inDesignMode()) return null;
 var v = null;
 try { v = root && root.getAttribute ? root.getAttribute("data-cx-editor-token") : null; } catch (e) {}
 return typeof v === "string" && v.trim() ? v.trim() : null;
}
/* Precedence mirrors cellexia-reviews.js getPreviewToken(): live-and-not-editor
   ⇒ URL only; otherwise URL (persisted) → sessionStorage → editor token. */
function getPreviewToken(root) {
 var u = urlPreviewToken();
 if (pageIsLive() && !inDesignMode()) return u; // URL-only, never persisted
 if (u) { ssSet("cx_preview_token", u); return u; }
 return ssGet("cx_preview_token") || editorToken(root);
}

/* ===== transport — quiet by construction: helpers never reject, they
   resolve {ok, status, body} (body null when the payload is not JSON). */
function readResponse(r) {
 return r.text().then((text) => {
  var body = null;
  if (text) { try { body = JSON.parse(text); } catch (e) {} }
  return { ok: r.ok, status: r.status, body: body };
 }, () => { return { ok: false, status: 0, body: null }; });
}
function getJSON(url) {
 if (!window.fetch) return Promise.resolve({ ok: false, status: 0, body: null });
 return window.fetch(url, { credentials: "same-origin" })
  .then(readResponse, () => { return { ok: false, status: 0, body: null }; });
}
function postJSON(url, payload) {
 if (!window.fetch) return Promise.resolve({ ok: false, status: 0, body: null });
 return window.fetch(url, {
  method: "POST", credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
 }).then(readResponse, () => { return { ok: false, status: 0, body: null }; });
}
function qs(params) {
 var parts = [];
 for (var k in params) {
  if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
  var v = params[k];
  if (v === undefined || v === null || v === "" || v === 0 || v === false) continue;
  parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v === true ? 1 : v)));
 }
 return parts.length ? "?" + parts.join("&") : "";
}

/* ===== stars — same #FF6200 star path style as the main widget; the skin
   CSS recolors via the svg.cx-star hooks. Ratings here are integers, so
   full/empty is enough (no gradient defs → smaller + no id collisions). */
var STAR_PATH = "M10 1.4l2.62 5.35 5.88.83-4.26 4.13 1.02 5.85L10 14.8l-5.26 2.76 1.02-5.85L1.5 7.58l5.88-.83L10 1.4z";
function starSvg(filled, size) {
 var s = ns("svg");
 sa(s, "viewBox", "0 0 20 20");
 sa(s, "aria-hidden", "true");
 sa(s, "focusable", "false");
 sa(s, "width", String(size)); sa(s, "height", String(size));
 sa(s, "class", "cx-star");
 var p = ns("path");
 sa(p, "d", STAR_PATH);
 sa(p, "stroke", "#FF6200");
 sa(p, "stroke-width", "1");
 sa(p, "stroke-linejoin", "round");
 sa(p, "fill", filled ? "#FF6200" : "#FFFFFF");
 ap(s, p);
 return s;
}

function boot() {
 var mount = document.querySelector("[data-cx-brand-page]");
 if (!mount) return; // not this page — bail silently
 if (mount.getAttribute("data-cx-bp-hydrated") === "true") return;
 sa(mount, "data-cx-bp-hydrated", "true");
 try { mount.classList.add("cx-brand-page"); } catch (e) {}

 /* ---- config from the mount's data attributes (SPEC-1.19 §7/§9) ---- */
 function attr(name, dflt) {
  var v = mount.getAttribute(name);
  return v === null || v === "" ? dflt : v;
 }
 function jsonAttr(name, dflt) {
  var v = mount.getAttribute(name);
  if (!v) return dflt;
  try {
   var parsed = JSON.parse(v);
   return parsed === null || parsed === undefined ? dflt : parsed;
  } catch (e) { return dflt; }
 }
 var proxy = String(attr("data-proxy", "/apps/cellexia-reviews")).replace(/\s+/g, "").replace(/\/+$/, "") || "/apps/cellexia-reviews";
 /* data-proxy is the base WITHOUT the "/api" suffix (the section's cx_base) —
    we append "/api" ourselves. Tolerate a stale theme still emitting
    cx-proxy's "/apps/<subpath>/api" so we never build ".../api/api"; the
    3-segment test keeps a shop whose subpath IS "api" ("/apps/api") intact. */
 if (/^\/apps\/[^/]+\/api$/.test(proxy)) proxy = proxy.replace(/\/api$/, "");
 var apiBase = proxy + "/api";
 var locale = attr("data-locale", document.documentElement.lang || "en");
 var totalCount = parseInt(attr("data-count", ""), 10);
 var products = jsonAttr("data-products", []);
 var concerns = jsonAttr("data-concerns", []);
 var askOn = attr("data-ask", "0") === "1";
 var recommendOn = attr("data-recommend", "0") === "1";
 var I18N = jsonAttr("data-i18n", {});
 if (!Array.isArray(products)) products = [];
 if (!Array.isArray(concerns)) concerns = [];
 if (typeof I18N !== "object" || Array.isArray(I18N)) I18N = {};
 var previewToken = getPreviewToken(mount);

 /* ---- i18n: flat dict, {name} placeholders ---- */
 function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, name) => {
   return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
  });
 }
 function i(key, vars) {
  var s = I18N[key];
  if (typeof s !== "string" || !s) s = key;
  return vars ? fmt(s, vars) : s;
 }
 var NF, DF;
 try { NF = new Intl.NumberFormat(locale); } catch (e) { NF = new Intl.NumberFormat("en"); }
 try { DF = new Intl.DateTimeFormat(locale, { dateStyle: "long" }); } catch (e) { DF = new Intl.DateTimeFormat("en", { dateStyle: "long" }); }
 function fmtNum(n) { try { return NF.format(n); } catch (e) { return String(n); } }
 function fmtDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  try { return isNaN(d.getTime()) ? "" : DF.format(d); } catch (e) { return ""; }
 }
 function starRow(rating, size) {
  var wrap = el("span", "cx-bp-stars");
  sa(wrap, "role", "img");
  sa(wrap, "aria-label", i("filter_stars", { n: rating }));
  for (var k = 0; k < 5; k++) ap(wrap, starSvg(k < rating, size || 16));
  return wrap;
 }
 function statusP(text) {
  var p = el("p", "cx-bp-status", text);
  sa(p, "role", "status");
  return p;
 }

 /* ================= a) filter bar + list ================= */
 var filtersHost = mount.querySelector("[data-cx-page-filters]");
 var results = mount.querySelector("[data-cx-page-results]");
 var state = { page: 1, product: "", concern: "", stars: 0, active: false };
 var reqSeq = 0;
 var selProduct = null, selConcern = null, selStars = null;

 function makeSelect(id, allLabel, options) {
  var wrap = el("div", "cx-bp-field");
  var lab = el("label", "cx-bp-label", allLabel);
  lab.htmlFor = id;
  ap(wrap, lab);
  var sel = el("select", "cx-bp-select");
  sel.id = id;
  ap(sel, new Option(allLabel, ""));
  for (var k = 0; k < options.length; k++) ap(sel, new Option(options[k].label, options[k].value));
  ap(wrap, sel);
  on(sel, "change", onFilterChange);
  return { wrap: wrap, sel: sel };
 }
 function countLabel(label, count) {
  var n = Number(count) || 0;
  return n > 0 ? label + " (" + fmtNum(n) + ")" : label;
 }
 /* Product / concern / stars only: no sort control — GET /api/brand-reviews
    takes no sort param (listBrandReviews has ONE deterministic ranking). */
 function buildFilters() {
  clear(filtersHost);
  var bar = ap(filtersHost, el("div", "cx-bp-filters"));
  ap(bar, el("strong", "cx-bp-filters__title", i("filter_title")));
  var opts = [], k, p2, c2;
  for (k = 0; k < products.length; k++) {
   p2 = products[k];
   if (!p2 || typeof p2.handle !== "string" || !p2.handle || typeof p2.title !== "string") continue;
   opts.push({ value: p2.handle, label: countLabel(p2.title, p2.count) });
  }
  var mp = makeSelect("cx-bp-f-product", i("filter_all_products"), opts);
  selProduct = mp.sel; ap(bar, mp.wrap);
  opts = [];
  for (k = 0; k < concerns.length; k++) {
   c2 = concerns[k];
   if (!c2 || typeof c2.key !== "string" || !c2.key || typeof c2.label !== "string") continue;
   opts.push({ value: c2.key, label: countLabel(c2.label, c2.count) });
  }
  var mc = makeSelect("cx-bp-f-concern", i("filter_all_concerns"), opts);
  selConcern = mc.sel; ap(bar, mc.wrap);
  opts = [];
  for (k = 5; k >= 1; k--) opts.push({ value: String(k), label: i("filter_stars", { n: k }) });
  var ms = makeSelect("cx-bp-f-stars", i("filter_all_ratings"), opts);
  selStars = ms.sel; ap(bar, ms.wrap);
 }
 function onFilterChange() {
  state.product = selProduct ? selProduct.value : "";
  state.concern = selConcern ? selConcern.value : "";
  state.stars = selStars ? (parseInt(selStars.value, 10) || 0) : 0;
  state.page = 1;
  state.active = true; // FIRST user action: from here on JS owns the list
  loadList();
 }
 function renderResultsStatus(text) {
  clear(results);
  ap(results, statusP(text));
 }
 function loadList() {
  if (!state.active) return;
  var seq = ++reqSeq;
  sa(results, "aria-busy", "true");
  renderResultsStatus(i("loading"));
  var url = apiBase + "/brand-reviews" + qs({
   public: 1, page: state.page, per_page: 12,
   product: state.product, concern: state.concern, stars: state.stars,
   locale: locale, preview_token: previewToken
  });
  getJSON(url).then((res) => {
   if (seq !== reqSeq) return; // a newer filter change superseded this one
   sa(results, "aria-busy", "false");
   if (res.ok && res.body && Array.isArray(res.body.reviews)) renderList(res.body);
   else renderResultsStatus(i("load_error"));
  });
 }
 /* Field fallbacks: coded against the §9 contract (author/date/productTitle/
    productHandle) with the live BrandReviewDTO names (authorName/createdAt/
    product.{title,handle}) accepted too — same data, either spelling. */
 function rvAuthor(r) { return r.author || r.authorName || ""; }
 function rvDate(r) { return r.date || r.createdAt || ""; }
 function rvHandle(r) { return r.productHandle || (r.product && r.product.handle) || ""; }
 function rvProductTitle(r) { return r.productTitle || (r.product && r.product.title) || ""; }
 function renderCard(r, display) {
  var card = el("article", "cx-bp-card");
  var trv = r.translated;
  var hasTr = !!(trv && typeof trv === "object" && typeof trv.body === "string" && trv.body);
  var showTr = hasTr && display === "translated";
  function texts() {
   if (showTr) return { title: trv.title || r.title || "", body: trv.body };
   return { title: r.title || "", body: r.body || "" };
  }
  var tx0 = texts();
  var head = ap(card, el("div", "cx-bp-card__head"));
  var rating = Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0)));
  ap(head, starRow(rating, 16));
  var titleEl = ap(head, el("strong", "cx-bp-card__title", tx0.title));
  titleEl.hidden = !tx0.title;
  var meta = ap(card, el("p", "cx-bp-card__meta"));
  var author = rvAuthor(r);
  if (author) ap(meta, el("span", "cx-bp-card__author", String(author)));
  var dateText = fmtDate(rvDate(r));
  if (dateText) ap(meta, el("span", "cx-bp-card__date", dateText));
  if (r.verified) ap(meta, el("span", "cx-bp-verified", i("verified")));
  var bodyEl = ap(card, el("p", "cx-bp-card__body", tx0.body));
  var handle = rvHandle(r);
  if (handle) {
   var pline = ap(card, el("p", "cx-bp-card__product"));
   var a = el("a", "cx-bp-card__plink", String(rvProductTitle(r) || handle));
   a.href = "/products/" + encodeURIComponent(String(handle));
   ap(pline, a);
  }
  /* No source line: BrandReviewDTO (= ReviewDTO + product) carries no
     `source` field — toBrandReviewDTO never emits one. The SSR cards render
     it from the metafield payload, which the API does not reproduce. */
  if (hasTr) {
   var tgl = el("button", "cx-bp-translate", i(showTr ? "see_original" : "translate"));
   tgl.type = "button";
   on(tgl, "click", () => {
    showTr = !showTr;
    var tx1 = texts();
    titleEl.textContent = tx1.title;
    titleEl.hidden = !tx1.title;
    bodyEl.textContent = tx1.body;
    tgl.textContent = i(showTr ? "see_original" : "translate");
   });
   ap(card, tgl);
  }
  return card;
 }
 function renderList(resp) {
  clear(results);
  var reviews = resp.reviews;
  if (!reviews.length) { ap(results, statusP(i("empty"))); return; }
  var display = resp.translationDisplay === "translated" ? "translated" : "original";
  var listEl = ap(results, el("div", "cx-bp-list"));
  for (var k = 0; k < reviews.length; k++) {
   if (reviews[k]) ap(listEl, renderCard(reviews[k], display));
  }
  var pages = Math.max(1, parseInt(resp.total_pages, 10) || 1);
  var page = Math.min(Math.max(1, parseInt(resp.page, 10) || 1), pages);
  state.page = page;
  if (pages <= 1) return;
  var pager = ap(results, el("nav", "cx-bp-pager"));
  sa(pager, "aria-label", i("page_of", { page: page, pages: pages }));
  var prev = el("button", "cx-bp-pager__btn", i("prev"));
  prev.type = "button";
  prev.disabled = page <= 1;
  on(prev, "click", () => { state.page = page - 1; loadList(); });
  ap(pager, prev);
  ap(pager, el("span", "cx-bp-pager__info", i("page_of", { page: fmtNum(page), pages: fmtNum(pages) })));
  var next = el("button", "cx-bp-pager__btn", i("next"));
  next.type = "button";
  next.disabled = page >= pages;
  on(next, "click", () => { state.page = page + 1; loadList(); });
  ap(pager, next);
 }
 /* ================= b) + c) ask / recommend boxes ================= */
 function buildAskBox(hostSel, mode, titleKey, phKey, btnKey, hintKey) {
  var host = mount.querySelector(hostSel);
  if (!host) return;
  clear(host);
  host.hidden = false;
  var panel = ap(host, el("div", "cx-bp-panel"));
  ap(panel, el("h3", "cx-bp-panel__title", i(titleKey)));
  var form = ap(panel, el("form", "cx-bp-panel__form"));
  var fid = "cx-bp-q-" + mode;
  var lab = el("label", "cx-bp-label", i(phKey));
  lab.htmlFor = fid;
  ap(form, lab);
  var input = el("input", "cx-bp-input");
  input.type = "text";
  input.id = fid;
  sa(input, "maxlength", "200");
  input.placeholder = i(phKey);
  ap(form, input);
  var submit = el("button", "cx-bp-btn", i(btnKey));
  submit.type = "submit";
  ap(form, submit);
  if (hintKey) ap(panel, el("p", "cx-bp-hint", i(hintKey)));
  var out = ap(panel, el("div", "cx-bp-answer"));
  sa(out, "aria-live", "polite");
  on(form, "submit", (ev) => {
   ev.preventDefault();
   var q = String(input.value || "").trim();
   if (q.length < 3 || submit.disabled) return;
   submit.disabled = true;
   clear(out);
   ap(out, statusP(i("loading")));
   var payload = { question: q, mode: mode, locale: locale };
   if (previewToken) payload.preview_token = previewToken;
   postJSON(apiBase + "/brand-ask", payload).then((res) => {
    submit.disabled = false;
    if (res.status === 403) { host.hidden = true; return; } // feature off / not live
    clear(out);
    if (res.status === 429) { // polite rate-limit variant, same quiet copy
     var rl = statusP(i("load_error"));
     rl.className += " cx-bp-status--rate";
     ap(out, rl);
     return;
    }
    var b = res.body;
    if (res.ok && b && typeof b.answer === "string" && b.answer) renderAnswer(out, b, mode);
    else ap(out, statusP(i("load_error")));
   });
  });
 }
 function renderAnswer(out, b, mode) {
  ap(out, el("p", "cx-bp-answer__text", String(b.answer)));
  if (mode === "recommend" && Array.isArray(b.products)) {
   var rowEl = null;
   for (var k = 0; k < b.products.length; k++) {
    var p2 = b.products[k];
    if (!p2 || typeof p2.handle !== "string" || !p2.handle || !p2.title) continue;
    if (!rowEl) rowEl = ap(out, el("div", "cx-bp-products"));
    var a = el("a", "cx-bp-product-btn", String(p2.title));
    a.href = "/products/" + encodeURIComponent(p2.handle);
    ap(rowEl, a);
   }
  }
  var quotes = Array.isArray(b.quotes) ? b.quotes : [];
  var qwrap = null, shown = 0;
  for (var qk = 0; qk < quotes.length && shown < 3; qk++) {
   var qt = quotes[qk];
   if (!qt || typeof qt.excerpt !== "string" || !qt.excerpt) continue;
   if (!qwrap) {
    ap(out, el("h4", "cx-bp-quotes__title", i("quotes_title")));
    qwrap = ap(out, el("div", "cx-bp-quotes"));
   }
   shown++;
   var bq = ap(qwrap, el("blockquote", "cx-bp-quote"));
   ap(bq, el("p", "cx-bp-quote__text", "“" + qt.excerpt + "”"));
   var att = ap(bq, el("p", "cx-bp-quote__attr"));
   var rr = Math.max(0, Math.min(5, Math.round(Number(qt.rating) || 0)));
   if (rr > 0) ap(att, starRow(rr, 12));
   if (qt.author) ap(att, el("span", "cx-bp-quote__author", String(qt.author)));
  }
 }
 function enhance() {
  if (filtersHost && results) {
   sa(results, "aria-live", "polite"); // SSR content untouched until a change
   if (totalCount !== 0) buildFilters(); // data-count 0 ⇒ nothing to filter
  }
  if (askOn) buildAskBox("[data-cx-page-ask]", "ask", "ask_title", "ask_placeholder", "ask_button", "ask_hint");
  if (recommendOn) buildAskBox("[data-cx-page-recommend]", "recommend", "recommend_title", "recommend_placeholder", "recommend_button", null);
 }

 /* ===== not-live gate (v1.10 §5C, the Overall block's rule) =====
    data-cx-live="false" ⇒ the section ships `hidden` and ONLY a token-carrying
    request the server ACCEPTS may un-hide it. No token, or any non-200 ⇒ the
    root stays hidden and nothing else runs: a shopper on a not-live shop sees
    nothing at all, and never an error box. Live pages skip the probe. */
 if (mount.getAttribute("data-cx-live") === "false") {
  if (!previewToken) return; // shopper: zero pixels, zero fetches
  getJSON(apiBase + "/brand-reviews" + qs({ per_page: 1, public: 1, preview_token: previewToken })).then((res) => {
   if (res.status !== 200) return; // rejected/expired token: stay hidden, stay quiet
   mount.removeAttribute("hidden");
   enhance();
  });
  return;
 }
 enhance();
}

function safeBoot() { try { boot(); } catch (e) { /* shopper-quiet by contract */ } }
if (document.readyState === "loading") {
 document.addEventListener("DOMContentLoaded", safeBoot);
} else {
 safeBoot();
}
})();
